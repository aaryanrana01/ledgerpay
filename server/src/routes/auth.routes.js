import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { login, register, listSessions } from '../services/auth.service.js';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  setRefreshCookie,
} from '../services/token.service.js';
import { getAccountForUser } from '../services/wallet.service.js';
import { recordAudit } from '../models/index.js';

const router = Router();

const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128, 'That password is too long.')
  .refine((value) => /[a-z]/.test(value), 'Include a lowercase letter.')
  .refine((value) => /[A-Z]/.test(value), 'Include an uppercase letter.')
  .refine((value) => /[0-9]/.test(value), 'Include a number.');

const registerSchema = z.object({
  fullName: z.string().min(2, 'Tell us your name.').max(80),
  email: z.string().email('Enter a valid email address.'),
  walletTag: z
    .string()
    .transform((value) => value.toLowerCase().replace(/^@/, ''))
    .pipe(z.string().regex(/^[a-z0-9_]{3,20}$/, 'Use 3–20 letters, numbers or underscores.')),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

function context(req) {
  return { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200) };
}

router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const { user, accessToken, refresh } = await register(req.body, context(req));
    setRefreshCookie(res, refresh.raw, refresh.expiresAt);
    const account = await getAccountForUser(user._id);
    res.status(201).json({
      ok: true,
      data: { user: user.toPublic(), accessToken, balanceMinor: account.balanceMinor, currency: account.currency },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { user, accessToken, refresh } = await login(req.body, context(req));
    setRefreshCookie(res, refresh.raw, refresh.expiresAt);
    const account = await getAccountForUser(user._id);
    res.json({
      ok: true,
      data: { user: user.toPublic(), accessToken, balanceMinor: account.balanceMinor, currency: account.currency },
    });
  } catch (error) {
    next(error);
  }
});

/** Silent re-auth. The browser sends the httpOnly cookie; JS never sees it. */
router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const { user, accessToken, refresh } = await rotateRefreshToken(raw, context(req));
    setRefreshCookie(res, refresh.raw, refresh.expiresAt);
    res.json({ ok: true, data: { user: user.toPublic(), accessToken } });
  } catch (error) {
    clearRefreshCookie(res);
    next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await revokeRefreshToken(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    res.json({ ok: true, data: { signedOut: true } });
  } catch (error) {
    next(error);
  }
});

router.post('/logout-all', authenticate, async (req, res, next) => {
  try {
    await revokeAllSessions(req.user.id);
    clearRefreshCookie(res);
    await recordAudit({ actorId: req.user.id, action: 'auth.logout_all', ip: req.ip });
    res.json({ ok: true, data: { signedOutEverywhere: true } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const account = await getAccountForUser(req.user.id);
    res.json({
      ok: true,
      data: {
        user: req.user.doc.toPublic(),
        balanceMinor: account.balanceMinor,
        currency: account.currency,
        entryCount: account.entryCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/sessions', authenticate, async (req, res, next) => {
  try {
    res.json({ ok: true, data: { sessions: await listSessions(req.user.id) } });
  } catch (error) {
    next(error);
  }
});

export default router;
