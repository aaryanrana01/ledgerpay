import mongoose from 'mongoose';

/**
 * Refresh tokens are stored hashed (a database leak must not yield usable
 * sessions) and grouped into *families*. Rotating a token marks the old one
 * used; presenting a used token means it leaked, so the whole family — every
 * descendant session from that login — is revoked at once.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },

    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },

    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true }
);

// Mongo sweeps expired sessions for us.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
