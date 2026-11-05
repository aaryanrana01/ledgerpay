import request from 'supertest';
import { clearCollections, makeUser, startTestDb, stopTestDb, strongPassword } from './helpers.js';

let app;
let ensureSystemAccounts;

beforeAll(async () => {
  await startTestDb();
  const appModule = await import('../src/app.js');
  ({ ensureSystemAccounts } = await import('../src/services/ledger.service.js'));
  app = appModule.createApp();
});

afterAll(stopTestDb);

beforeEach(async () => {
  await clearCollections();
  await ensureSystemAccounts();
});

/** Pull the refresh cookie out of a Set-Cookie header. */
function cookieFrom(res) {
  const raw = res.headers['set-cookie']?.find((c) => c.startsWith('lp_rt='));
  return raw ? raw.split(';')[0] : null;
}

test('refresh rotates the token and issues a fresh access token', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Alice', email: 'alice@example.com', walletTag: 'alice', password: strongPassword })
    .expect(201);

  const cookie = cookieFrom(res);
  expect(cookie).toBeTruthy();

  const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(200);
  expect(refreshed.body.data.accessToken).toBeTruthy();
  expect(cookieFrom(refreshed)).not.toBe(cookie); // rotated
});

test('replaying a used refresh token kills the whole session family', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Alice', email: 'alice@example.com', walletTag: 'alice', password: strongPassword })
    .expect(201);

  const original = cookieFrom(res);
  const rotated = await request(app).post('/api/auth/refresh').set('Cookie', original).expect(200);
  const current = cookieFrom(rotated);

  // An attacker replays the stolen, already-used token.
  const replay = await request(app).post('/api/auth/refresh').set('Cookie', original).expect(401);
  expect(replay.body.error.code).toBe('REFRESH_REUSED');

  // The legitimate user's newer token is revoked too — everyone must sign in again.
  await request(app).post('/api/auth/refresh').set('Cookie', current).expect(401);
});

test('duplicate email and duplicate wallet tag are both rejected', async () => {
  await makeUser(app, { walletTag: 'alice' });

  const dupEmail = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Other', email: 'alice@example.com', walletTag: 'alice2', password: strongPassword })
    .expect(409);
  expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');

  const dupTag = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Other', email: 'other@example.com', walletTag: 'alice', password: strongPassword })
    .expect(409);
  expect(dupTag.body.error.code).toBe('TAG_TAKEN');
});

test('the account is locked after five failed sign-ins', async () => {
  await makeUser(app, { walletTag: 'alice' });

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Wrong123456' }).expect(401);
  }

  const locked = await request(app)
    .post('/api/auth/login')
    .send({ email: 'alice@example.com', password: strongPassword })
    .expect(429);

  expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
});

test('logout revokes the refresh token', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ fullName: 'Alice', email: 'alice@example.com', walletTag: 'alice', password: strongPassword })
    .expect(201);

  const cookie = cookieFrom(res);
  await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
  await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
});
