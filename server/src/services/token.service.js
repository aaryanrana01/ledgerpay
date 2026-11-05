import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env, isProd } from '../config/env.js';
import { RefreshToken } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { randomId, sha256 } from '../utils/hash.js';

export const REFRESH_COOKIE = 'lp_rt';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, tag: user.walletTag, typ: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL, issuer: 'ledgerpay', audience: 'ledgerpay-client' }
  );
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'ledgerpay',
      audience: 'ledgerpay-client',
    });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('TOKEN_EXPIRED', 'Your session expired. Refreshing…');
    }
    throw ApiError.unauthorized('TOKEN_INVALID', 'Sign in to continue.');
  }
}

/**
 * Refresh tokens are opaque random strings, not JWTs — they carry no claims and
 * are only meaningful as a lookup into the database, so revocation is instant.
 */
export async function issueRefreshToken(user, { familyId = randomId(16), context = {} } = {}) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(raw),
    expiresAt,
    userAgent: context.userAgent ?? '',
    ip: context.ip ?? '',
  });

  return { raw, familyId, expiresAt };
}

/**
 * Rotation with reuse detection.
 *
 * A refresh token is single-use. If a token that has already been rotated comes
 * back, either the user replayed an old request or someone stole it — we cannot
 * tell which, so the safe move is to revoke the entire token family and force a
 * fresh sign-in.
 */
export async function rotateRefreshToken(rawToken, context = {}) {
  if (!rawToken) throw ApiError.unauthorized('NO_REFRESH_TOKEN', 'Sign in to continue.');

  const tokenHash = sha256(rawToken);
  const stored = await RefreshToken.findOne({ tokenHash }).populate('userId');

  if (!stored) throw ApiError.unauthorized('REFRESH_INVALID', 'Sign in to continue.');

  if (stored.usedAt || stored.revokedAt) {
    await RefreshToken.updateMany(
      { familyId: stored.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw ApiError.unauthorized('REFRESH_REUSED', 'Your session was ended for security. Sign in again.');
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized('REFRESH_EXPIRED', 'Your session expired. Sign in again.');
  }

  const user = stored.userId;
  if (!user || user.status !== 'ACTIVE') {
    throw ApiError.unauthorized('ACCOUNT_UNAVAILABLE', 'This account is not available.');
  }

  const next = await issueRefreshToken(user, { familyId: stored.familyId, context });

  stored.usedAt = new Date();
  stored.replacedByHash = sha256(next.raw);
  await stored.save();

  return { user, refresh: next, accessToken: signAccessToken(user) };
}

export async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await RefreshToken.updateOne({ tokenHash: sha256(rawToken) }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/**
 * httpOnly + sameSite means the refresh token is unreadable to JavaScript, so an
 * XSS bug cannot exfiltrate a long-lived credential. The short-lived access
 * token is held in React state only — never in localStorage.
 */
export function setRefreshCookie(res, raw, expiresAt) {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    expires: expiresAt,
    path: '/api/auth',
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}
