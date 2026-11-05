import request from 'supertest';
import { clearCollections, idemKey, makeUser, startTestDb, stopTestDb } from './helpers.js';

let app;
let ensureSystemAccounts;
let Account;
let LedgerEntry;
let reconcileSystem;

beforeAll(async () => {
  await startTestDb();
  const appModule = await import('../src/app.js');
  ({ ensureSystemAccounts, reconcileSystem } = await import('../src/services/ledger.service.js'));
  ({ Account, LedgerEntry } = await import('../src/models/index.js'));
  app = appModule.createApp();
});

afterAll(stopTestDb);

beforeEach(async () => {
  await clearCollections();
  await ensureSystemAccounts();
});

/**
 * The headline test.
 *
 * Alice holds ₹500. One hundred requests to send ₹10 fire simultaneously —
 * exactly 50 can succeed. A naive "read balance, check it, then write"
 * implementation lets far more than 50 through, because every request reads the
 * same stale balance before any of them writes. The atomic conditional update
 * in ledger.service.js makes that impossible.
 */
test('100 parallel transfers cannot overdraw the account', async () => {
  const alice = await makeUser(app, { walletTag: 'alice' });
  const bob = await makeUser(app, { walletTag: 'bob' });

  await alice
    .auth(request(app).post('/api/wallet/top-ups'))
    .set('Idempotency-Key', idemKey('seed'))
    .send({ amount: '500.00' })
    .expect(201);

  const attempts = Array.from({ length: 100 }, (_, i) =>
    alice
      .auth(request(app).post('/api/wallet/transfers'))
      .set('Idempotency-Key', idemKey(`race-${i}`))
      .send({ to: 'bob', amount: '10.00' })
  );

  const results = await Promise.all(attempts.map((p) => p.then((r) => r).catch((e) => e.response ?? { status: 500 })));

  const succeeded = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 400).length;

  expect(succeeded).toBe(50);
  expect(succeeded + rejected).toBe(100);

  const aliceAccount = await Account.findOne({ userId: alice.user.id });
  const bobAccount = await Account.findOne({ userId: bob.user.id });

  expect(aliceAccount.balanceMinor).toBe(0);
  expect(bobAccount.balanceMinor).toBe(50_000);
  expect(aliceAccount.balanceMinor).toBeGreaterThanOrEqual(0);

  // The ledger must agree with the cached balances, and the books must balance.
  const reconciliation = await reconcileSystem();
  expect(reconciliation.balanced).toBe(true);
  expect(reconciliation.totalDebitsMinor).toBe(reconciliation.totalCreditsMinor);
});

test('per-account sequence numbers stay contiguous under concurrent writes', async () => {
  const carol = await makeUser(app, { walletTag: 'carol' });
  const dave = await makeUser(app, { walletTag: 'dave' });

  await carol
    .auth(request(app).post('/api/wallet/top-ups'))
    .set('Idempotency-Key', idemKey('seed'))
    .send({ amount: '1000.00' })
    .expect(201);

  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      carol
        .auth(request(app).post('/api/wallet/transfers'))
        .set('Idempotency-Key', idemKey(`seq-${i}`))
        .send({ to: 'dave', amount: '5.00' })
    )
  );

  const account = await Account.findOne({ userId: carol.user.id });
  const entries = await LedgerEntry.find({ accountId: account._id }).sort({ seq: 1 }).lean();

  expect(entries).toHaveLength(26); // 1 top-up + 25 transfers
  entries.forEach((entry, index) => expect(entry.seq).toBe(index + 1));
});
