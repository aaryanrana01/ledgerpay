import mongoose from 'mongoose';

/**
 * One row per attempt to take money OUT of the wallet to a bank account or UPI.
 *
 *   REQUESTED  wallet already debited, money is being held by us
 *      |
 *      +--> PROCESSING  handed to the payout provider
 *      |        |
 *      |        +--> PROCESSED  the bank confirmed it. Terminal.
 *      |        |
 *      |        +--> REVERSED   it bounced; wallet credited back. Terminal.
 *      |
 *      +--> FAILED     provider rejected it immediately; wallet credited back.
 *
 * Important ordering decision: the wallet is debited FIRST, before the payout
 * is sent. If we called the bank first and debited afterwards, a crash in
 * between would send real money without recording it. Debiting first means the
 * worst case is money held that we later return, which is recoverable.
 */
const payoutRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, required: true, unique: true, index: true },

    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, default: 'INR' },

    // Snapshot of where the money went. Stored on the request rather than
    // referenced, so the record still reads correctly if the user later edits
    // or deletes the saved beneficiary.
    destination: {
      type: { type: String, enum: ['BANK_ACCOUNT', 'VPA'], required: true },
      name: { type: String, required: true },
      // Only the last four digits are kept. There is no reason for this app to
      // store a full account number after the payout has been created.
      accountLast4: { type: String, default: null },
      ifsc: { type: String, default: null },
      bankName: { type: String, default: null },
      vpa: { type: String, default: null },
    },

    mode: { type: String, enum: ['IMPS', 'NEFT', 'UPI'], default: 'IMPS' },

    status: {
      type: String,
      enum: ['REQUESTED', 'PROCESSING', 'PROCESSED', 'REVERSED', 'FAILED'],
      default: 'REQUESTED',
      index: true,
    },

    provider: { type: String, enum: ['simulated', 'razorpayx'], required: true },
    providerPayoutId: { type: String, default: null, index: true },
    // Sent to the provider as X-Payout-Idempotency so a retry cannot pay twice.
    idempotencyKey: { type: String, required: true, unique: true },
    utr: { type: String, default: null }, // bank reference shown to the user

    // The ledger entries for the debit and, if it bounces, the refund.
    debitTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    refundTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

payoutRequestSchema.index({ userId: 1, createdAt: -1 });

export const PayoutRequest = mongoose.model('PayoutRequest', payoutRequestSchema);
