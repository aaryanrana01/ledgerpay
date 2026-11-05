import mongoose from 'mongoose';

/**
 * Append-only. One row per account per leg of a transaction.
 *
 * The schema deliberately exposes no update path: the model blocks
 * updateOne/updateMany/findOneAndUpdate/deleteOne at the Mongoose layer, and the
 * hash chain makes any edit made *around* Mongoose detectable.
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    transactionRef: { type: String, required: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    direction: { type: String, enum: ['DEBIT', 'CREDIT'], required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true },

    // Balance of this account immediately after the entry was applied.
    balanceAfterMinor: { type: Number, required: true },

    seq: { type: Number, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },

    createdAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// The chain is only well defined if (account, seq) is unique.
ledgerEntrySchema.index({ accountId: 1, seq: -1 }, { unique: true });
ledgerEntrySchema.index({ accountId: 1, createdAt: -1 });

const blockMutation = function blockMutation(next) {
  next(new Error('LedgerEntry is append-only; ledger rows cannot be modified or deleted.'));
};

['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany'].forEach(
  (op) => ledgerEntrySchema.pre(op, blockMutation)
);

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
