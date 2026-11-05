import mongoose from 'mongoose';

/**
 * Exactly-once semantics for money-moving endpoints.
 *
 * The unique index on (userId, endpoint, key) is what actually enforces it:
 * two concurrent retries race to insert, the loser gets E11000 and is told the
 * original request is still in flight or replays its stored response.
 */
const idempotencyKeySchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true },

    // Guards against a client reusing a key with a different payload.
    requestHash: { type: String, required: true },

    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], default: 'IN_PROGRESS' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

idempotencyKeySchema.index({ userId: 1, endpoint: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey = mongoose.model('IdempotencyKey', idempotencyKeySchema);
