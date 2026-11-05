import request from 'supertest';
import { clearCollections, idemKey, makeUser, startTestDb, stopTestDb, strongPassword } from './helpers.js';

let app;
let ensureSystemAccounts;
let verifyAccountChain;
let Account;
let LedgerEntry;

beforeAll(async () => {
  await startTestDb();
  const appModule = await import('../src/app.js');
  ({ ensureSystemAccounts, verifyAccountChain } = await import('../src/services/ledger.service.js'));
  ({ Account, LedgerEntry } = await import('../src/models/index.js'));
  app = appModule.createApp();
});

afterAll(stopTestDb);

beforeEach(async () => {
  await clearCollections();
  await ensureSystemAccounts();
});

async function fundedUser(tag, amount = '1000.00') {
  const user = await makeUser(app, { walletTag: tag });
  await user
    .auth(request(app).post('/api/wallet/top-ups'))
    .set('Idempotency-Key', idemKey(`fund-${tag}`))
    .send({ amount })
    .expect(201);
  return user;
}

describe('transfers', () => {
  test('moves money and records two balanced ledger legs', async () => {
    const alice = await fundedUser('alice');
    const bob = await makeUser(app, { walletTag: 'bob' });

    const res = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('t1'))
      .send({ to: 'bob', amount: '250.50', note: 'Dinner' })
      .expect(201);

    expect(res.body.data.balanceMinor).toBe(74_950);

    const entries = await LedgerEntry.find({ transactionRef: res.body.data.reference }).lean();
    expect(entries).toHaveLength(2);

    const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0);
    const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0);
    expect(debits).toBe(credits);

    const bobAccount = await Account.findOne({ userId: bob.user.id });
    expect(bobAccount.balanceMinor).toBe(25_050);
  });

  test('rejects a transfer larger than the balance', async () => {
    const alice = await fundedUser('alice', '50.00');
    await makeUser(app, { walletTag: 'bob' });

    const res = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('t2'))
      .send({ to: 'bob', amount: '80.00' })
      .expect(400);

    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

    const account = await Account.findOne({ userId: alice.user.id });
    expect(account.balanceMinor).toBe(5_000); // untouched
  });

  test('rejects sending to yourself', async () => {
    const alice = await fundedUser('alice');
    const res = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('t3'))
      .send({ to: 'alice', amount: '10.00' })
      .expect(400);
    expect(res.body.error.code).toBe('SELF_TRANSFER');
  });

  test('rejects floating point precision attacks', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });

    await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('t4'))
      .send({ to: 'bob', amount: '10.999' })
      .expect(400);

    await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('t5'))
      .send({ to: 'bob', amount: '-10.00' })
      .expect(400);
  });
});

describe('idempotency', () => {
  test('replaying the same key does not move money twice', async () => {
    const alice = await fundedUser('alice');
    const bob = await makeUser(app, { walletTag: 'bob' });
    const key = idemKey('dup');

    const first = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', key)
      .send({ to: 'bob', amount: '100.00' })
      .expect(201);

    const second = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', key)
      .send({ to: 'bob', amount: '100.00' })
      .expect(201);

    expect(second.body.data.reference).toBe(first.body.data.reference);
    expect(second.headers['idempotent-replay']).toBe('true');

    const bobAccount = await Account.findOne({ userId: bob.user.id });
    expect(bobAccount.balanceMinor).toBe(10_000); // credited once, not twice
  });

  test('same key with a different body is refused', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });
    const key = idemKey('mismatch');

    await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', key)
      .send({ to: 'bob', amount: '10.00' })
      .expect(201);

    const res = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', key)
      .send({ to: 'bob', amount: '999.00' })
      .expect(422);

    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('a missing key is rejected outright', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });

    const res = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .send({ to: 'bob', amount: '10.00' })
      .expect(400);

    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('ledger integrity', () => {
  test('the hash chain validates after a series of transactions', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await alice
        .auth(request(app).post('/api/wallet/transfers'))
        .set('Idempotency-Key', idemKey(`chain-${i}`))
        .send({ to: 'bob', amount: '20.00' })
        .expect(201);
    }

    const res = await alice.auth(request(app).get('/api/wallet/integrity')).expect(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.checked).toBe(6);
  });

  test('tampering with a historic row is detected', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });

    await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('tamper'))
      .send({ to: 'bob', amount: '20.00' })
      .expect(201);

    const account = await Account.findOne({ userId: alice.user.id });

    // Go around Mongoose entirely, the way an attacker with database access would.
    await LedgerEntry.collection.updateOne(
      { accountId: account._id, seq: 1 },
      { $set: { amountMinor: 1 } }
    );

    const result = await verifyAccountChain(account._id);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(1);
  });

  test('the model refuses to update a ledger entry', async () => {
    const alice = await fundedUser('alice');
    const account = await Account.findOne({ userId: alice.user.id });
    await expect(
      LedgerEntry.updateOne({ accountId: account._id, seq: 1 }, { $set: { amountMinor: 999 } })
    ).rejects.toThrow(/append-only/);
  });
});

describe('reversals', () => {
  test('a reversal restores both balances and links the transactions', async () => {
    const alice = await fundedUser('alice');
    const bob = await makeUser(app, { walletTag: 'bob' });

    const transfer = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('rev'))
      .send({ to: 'bob', amount: '300.00' })
      .expect(201);

    const list = await alice.auth(request(app).get('/api/wallet/transactions')).expect(200);
    const target = list.body.data.items.find((t) => t.reference === transfer.body.data.reference);

    await alice.auth(request(app).post(`/api/wallet/transactions/${target.id}/reverse`)).expect(201);

    const aliceAccount = await Account.findOne({ userId: alice.user.id });
    const bobAccount = await Account.findOne({ userId: bob.user.id });
    expect(aliceAccount.balanceMinor).toBe(100_000);
    expect(bobAccount.balanceMinor).toBe(0);

    // Reversing twice is refused.
    await alice.auth(request(app).post(`/api/wallet/transactions/${target.id}/reverse`)).expect(409);
  });

  test('a stranger cannot reverse someone else\'s transfer', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });
    const mallory = await makeUser(app, { walletTag: 'mallory' });

    const transfer = await alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey('rev2'))
      .send({ to: 'bob', amount: '30.00' })
      .expect(201);

    const list = await alice.auth(request(app).get('/api/wallet/transactions')).expect(200);
    const target = list.body.data.items.find((t) => t.reference === transfer.body.data.reference);

    await mallory.auth(request(app).post(`/api/wallet/transactions/${target.id}/reverse`)).expect(403);
  });
});

describe('history', () => {
  test('cursor pagination walks the full history without duplicates', async () => {
    const alice = await fundedUser('alice');
    await makeUser(app, { walletTag: 'bob' });

    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await alice
        .auth(request(app).post('/api/wallet/transfers'))
        .set('Idempotency-Key', idemKey(`page-${i}`))
        .send({ to: 'bob', amount: '5.00' })
        .expect(201);
    }

    const seen = new Set();
    let cursor = null;
    let pages = 0;

    do {
      const url = `/api/wallet/transactions?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await alice.auth(request(app).get(url)).expect(200);
      res.body.data.items.forEach((item) => seen.add(item.id));
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen.size).toBe(13); // 12 transfers + 1 top-up
  });
});

describe('access control', () => {
  test('wallet endpoints require a token', async () => {
    await request(app).get('/api/wallet').expect(401);
  });

  test('a forged token is rejected', async () => {
    await request(app).get('/api/wallet').set('Authorization', 'Bearer not.a.jwt').expect(401);
  });

  test('non-admins cannot read reconciliation', async () => {
    const alice = await makeUser(app, { walletTag: 'alice' });
    await alice.auth(request(app).get('/api/admin/reconciliation')).expect(403);
  });

  test('password policy is enforced at registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'Weak User', email: 'weak@example.com', walletTag: 'weak', password: 'password' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('login works and rejects a wrong password', async () => {
    await makeUser(app, { walletTag: 'alice' });

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: strongPassword })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'WrongPassword1' })
      .expect(401);
  });
});
