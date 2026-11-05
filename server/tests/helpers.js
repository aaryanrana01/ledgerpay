import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';

// Transactions need a replica set, so the in-memory server runs as rs0.
let replSet;

export async function startTestDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri('ledgerpay_test');
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'test_access_secret_that_is_long_enough_1234';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_that_is_long_enough_5678';
  await mongoose.connect(process.env.MONGO_URI);
}

export async function stopTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet?.stop();
}

export async function clearCollections() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export const strongPassword = 'Passw0rdStrong';

/** Registers a user and returns an authenticated request helper. */
export async function makeUser(app, { walletTag, fullName = 'Test User', email }) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ walletTag, fullName, email: email ?? `${walletTag}@example.com`, password: strongPassword })
    .expect(201);

  const { accessToken, user } = res.body.data;
  return {
    user,
    accessToken,
    auth: (req) => req.set('Authorization', `Bearer ${accessToken}`),
  };
}

export function idemKey(label) {
  return `${label}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
