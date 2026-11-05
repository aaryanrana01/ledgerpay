import mongoose from 'mongoose';

/**
 * The business-level record. One Transaction fans out into two or more
 * LedgerEntry rows that must sum to zero.
 */
const transactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      enum: ['TRANSFER', 'TOP_UP', 'WITHDRAWAL', 'REVERSAL'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['POSTED', 'REVERSED', 'FAILED'],
      default: 'POSTED',
      index: true,
    },
    currency: { type: String, required: true, uppercase: true },
    amountMinor: { type: Number, required: true },
    feeMinor: { type: Number, default: 0 },

    sourceAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null, index: true },
    destAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null, index: true },
    sourceUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    destUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    note: { type: String, maxlength: 140, default: '' },
    idempotencyKey: { type: String, default: null },
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Drives the activity feed: newest first, cursor-paginated, per participant.
transactionSchema.index({ sourceUserId: 1, createdAt: -1, _id: -1 });
transactionSchema.index({ destUserId: 1, createdAt: -1, _id: -1 });

export const Transaction = mongoose.model('Transaction', transactionSchema);
