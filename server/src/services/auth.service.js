import bcrypt from 'bcryptjs';
import { AUTH_CONSTANTS, RefreshToken, User, recordAudit } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { ensureUserAccount } from './wallet.service.js';
import { issueRefreshToken, signAccessToken } from './token.service.js';

export async function register({ email, password, fullName, walletTag }, context = {}) {
  const normalisedEmail = email.toLowerCase().trim();
  const normalisedTag = walletTag.toLowerCase().replace(/^@/, '').trim();

  const clash = await User.findOne({ $or: [{ email: normalisedEmail }, { walletTag: normalisedTag }] });
  if (clash) {
    const field = clash.email === normalisedEmail ? 'email' : 'walletTag';
    throw ApiError.conflict(
      field === 'email' ? 'EMAIL_TAKEN' : 'TAG_TAKEN',
      field === 'email' ? 'An account already uses this email.' : 'That wallet tag is taken. Try another.'
    );
  }

  const user = new User({ email: normalisedEmail, walletTag: normalisedTag, fullName: fullName.trim() });
  await user.setPassword(password);
  await user.save();

  await ensureUserAccount(user._id);

  const refresh = await issueRefreshToken(user, { context });
  await recordAudit({
    actorId: user._id,
    action: 'auth.register',
    entity: 'User',
    entityId: String(user._id),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { user, accessToken: signAccessToken(user), refresh };
}

export async function login({ email, password }, context = {}) {
  const normalisedEmail = String(email).toLowerCase().trim();
  const user = await User.findOne({ email: normalisedEmail }).select('+passwordHash +failedLoginAttempts +lockedUntil');

  // Constant-ish work whether or not the account exists, so response timing
  // does not reveal which emails are registered.
  if (!user) {
    await bcrypt.compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu');
    throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  if (user.isLocked()) {
    await recordAudit({ actorId: user._id, action: 'auth.login', outcome: 'FAILURE', meta: { reason: 'LOCKED' }, ip: context.ip });
    throw ApiError.tooMany(
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${AUTH_CONSTANTS.LOCK_MINUTES} minutes.`
    );
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    await User.registerFailedLogin(user._id);
    await recordAudit({ actorId: user._id, action: 'auth.login', outcome: 'FAILURE', meta: { reason: 'BAD_PASSWORD' }, ip: context.ip });
    throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  if (user.status !== 'ACTIVE') {
    throw ApiError.forbidden('ACCOUNT_FROZEN', 'This account is frozen. Contact support.');
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  await ensureUserAccount(user._id);

  const refresh = await issueRefreshToken(user, { context });
  await recordAudit({
    actorId: user._id,
    action: 'auth.login',
    entity: 'User',
    entityId: String(user._id),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { user, accessToken: signAccessToken(user), refresh };
}

/** Active sessions, so a user can see where they are signed in. */
export async function listSessions(userId) {
  const sessions = await RefreshToken.find({
    userId,
    revokedAt: null,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return sessions.map((session) => ({
    id: String(session._id),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ip: session.ip,
    userAgent: session.userAgent,
  }));
}
