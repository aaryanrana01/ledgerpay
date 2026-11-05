import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';

import { env } from './config/env.js';
import routes from './routes/index.js';
import webhookRoutes from './routes/webhooks.routes.js';
import { requestId } from './middleware/requestId.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Correct client IPs behind a proxy — rate limiting and audit logs depend on it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true, // required for the refresh-token cookie
      exposedHeaders: ['x-request-id', 'idempotent-replay'],
    })
  );
  app.use(requestId);

  /**
   * ORDER IS LOAD-BEARING.
   *
   * The Razorpay webhook route is mounted BEFORE express.json(), because it
   * needs the untouched request bytes to verify the HMAC signature. Once a
   * JSON parser has consumed the body, the original bytes are unrecoverable -
   * re-serialising the parsed object produces different bytes (key order,
   * whitespace, unicode escaping) and the signature will never match.
   *
   * Moving this line below express.json() silently breaks every webhook.
   */
  app.use('/api/webhooks', webhookRoutes);

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(globalLimiter);

  app.get('/api/health', (_req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
      ok: true,
      data: {
        service: 'ledgerpay-api',
        uptimeSeconds: Math.round(process.uptime()),
        database: states[mongoose.connection.readyState] ?? 'unknown',
      },
    });
  });

  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
