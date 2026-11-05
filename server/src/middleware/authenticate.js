import { User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../services/token.service.js';

/** Requires a valid access token; attaches req.user. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw ApiError.unauthorized();

    const payload = verifyAccessToken(header.slice(7).trim());
    const user = await User.findById(payload.sub);
    if (!user) throw ApiError.unauthorized('USER_NOT_FOUND', 'Sign in to continue.');
    if (user.status !== 'ACTIVE') throw ApiError.forbidden('ACCOUNT_FROZEN', 'This account is frozen.');

    req.user = { id: String(user._id), role: user.role, walletTag: user.walletTag, doc: user };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('INSUFFICIENT_ROLE', 'You do not have access to this.'));
    }
    return next();
  };
}
