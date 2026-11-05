import mongoose from 'mongoose';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './db/mongoose.js';
import { ensureSystemAccounts } from './services/ledger.service.js';
import { logger } from './utils/logger.js';

async function start() {
  await connectDatabase();

  // Make the database's indexes match what the schemas declare. Without this,
  // changing an index definition in a model has no effect on a database that
  // was created before the change - the old index just stays there and can
  // cause confusing duplicate-key errors.
  //
  // Fine for a project of this size. A production system would apply index
  // changes through explicit migrations instead, because building an index on
  // a large collection can be slow.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));

  await ensureSystemAccounts();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info('server.listening', { port: env.PORT, env: env.NODE_ENV });
  });

  const shutdown = (signal) => {
    logger.info('server.shutdown', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  logger.error('server.boot_failed', { message: error.message, stack: error.stack });
  process.exit(1);
});
