import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Public handle used to send money without sharing an email address.
    walletTag: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_]{3,20}$/,
      index: true,
    },
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['USER', 'ADMIN'], default: 'USER', index: true },
    status: { type: String, enum: ['ACTIVE', 'FROZEN'], default: 'ACTIVE' },

    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil.getTime() > Date.now());
};

/**
 * Progressive lockout. Credential stuffing gets expensive after five misses;
 * a legitimate typo costs the user nothing because the counter resets on
 * the first successful sign-in.
 */
userSchema.statics.registerFailedLogin = async function registerFailedLogin(userId) {
  const user = await this.findById(userId).select('+failedLoginAttempts +lockedUntil');
  if (!user) return;
  user.failedLoginAttempts += 1;
  if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
    user.failedLoginAttempts = 0;
  }
  await user.save();
};

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    walletTag: this.walletTag,
    fullName: this.fullName,
    role: this.role,
    status: this.status,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
export const AUTH_CONSTANTS = { MAX_FAILED_ATTEMPTS, LOCK_MINUTES };
