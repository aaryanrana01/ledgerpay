import mongoose from 'mongoose';

/**
 * An account is a balance bucket. Users own one per currency; the platform owns
 * a handful of system accounts so that *every* movement of money has a
 * counterparty and the books stay balanced.
 *
 * `balanceMinor` is a cached projection of the ledger, not the source of truth.
 * scripts/reconcile.js recomputes it from LedgerEntry and shouts if they differ.
 */
const accountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // SETTLEMENT funds top-ups, FEES collects revenue. Both may go negative.
    kind: {
      type: String,
      enum: ['USER', 'SETTLEMENT', 'FEES'],
      default: 'USER',
      index: true,
    },
    // Only system accounts have a systemKey; user accounts leave it null.
    // The uniqueness rule is defined as an explicit index below, because a
    // plain `sparse: true` does not do what you would expect here (see the
    // comment on the index).
    systemKey: { type: String, default: null },

    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    balanceMinor: {
      type: Number,
      required: true,
      default: 0,
      validate: { validator: Number.isInteger, message: 'balanceMinor must be an integer' },
    },
    // Monotonic counter -> gives each ledger entry a per-account sequence number.
    entryCount: { type: Number, required: true, default: 0 },
    allowNegative: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'FROZEN', 'CLOSED'], default: 'ACTIVE' },
    lastEntryAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * There must only ever be one SETTLEMENT account and one FEES account, so
 * systemKey has to be unique - but only among the accounts that actually have
 * one.
 *
 * The obvious way to write that is `unique: true, sparse: true`, and it is
 * wrong. A sparse index skips documents where the field is *missing*, but this
 * schema sets `default: null`, so every user account stores an explicit null.
 * Those nulls all count as the same value, so the second user account created
 * would collide with the first and registration would fail with E11000.
 *
 * A partial index fixes it properly: only index documents where systemKey is
 * actually a string, and ignore the nulls entirely.
 */
accountSchema.index(
  { systemKey: 1 },
  { unique: true, partialFilterExpression: { systemKey: { $type: 'string' } } }
);

accountSchema.index({ userId: 1, currency: 1 }, { unique: true, partialFilterExpression: { kind: 'USER' } });

export const Account = mongoose.model('Account', accountSchema);
