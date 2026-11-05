import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';

const skip = () => isTest; // limits would make the test suite flaky

const handler = (_req, res) => {
  res.status(429).json({
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
  });
};

/** Broad protection for the whole API surface. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  skip,
});

/** Tight limit on credential endpoints, keyed by IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  skip,
});

/** Per-user ceiling on money movement, independent of IP. */
export const moneyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  // Keyed by user id, not IP: two people behind the same office router each
  // get their own budget, and one user cannot dodge the limit by switching
  // network. This middleware is only ever mounted after authenticate(), so
  // req.user is guaranteed to exist by the time it runs.
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  skip,
});
