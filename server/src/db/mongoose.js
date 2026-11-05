import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);

/**
 * Note on NoSQL injection: mongoose's global `sanitizeFilter` is deliberately
 * NOT enabled. It wraps any nested object containing `$` keys in `$eq`, which
 * would silently rewrite the `{ balanceMinor: { $gte: amount } }` guard in
 * ledger.service.js into an equality check and break every overdraft test.
 * The defence here is upstream instead: every request body and query string is
 * parsed by a zod schema, so only primitives of a known type ever reach a
 * filter, and no user-supplied object is ever spread into one.
 */

export async function connectDatabase(uri = env.MONGO_URI) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 20,
  });
  logger.info('mongo.connected', { db: mongoose.connection.name });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}

/**
 * Runs `work` inside a multi-document transaction, retrying transient failures.
 *
 * Two concurrent transfers touching the same account will collide at the
 * storage engine and one of them gets a TransientTransactionError. That is
 * normal and expected under load — the correct response is to replay the whole
 * transaction, not to fail the user. Backoff is jittered so retries don't
 * synchronise into a second collision.
 */
export async function withTransaction(work, { maxAttempts = 5 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } catch (error) {
      lastError = error;
      const transient =
        error?.hasErrorLabel?.('TransientTransactionError') ||
        error?.hasErrorLabel?.('UnknownTransactionCommitResult') ||
        error?.code === 112; // WriteConflict

      if (!transient || attempt === maxAttempts) throw error;

      const backoff = Math.floor(Math.random() * 25 * attempt) + 10;
      logger.warn('mongo.transaction.retry', { attempt, backoff });
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      await session.endSession();
    }
  }

  throw lastError;
}
