import mongoose from 'mongoose';

/**
 * One row per attempt to put money INTO the wallet.
 *
 * The lifecycle exists because a deposit is not a single event - it is a
 * conversation with an external system that can be interrupted at any point:
 *
 *   CREATED   we made a Razorpay order, the user has not paid yet
 *      |
 *      +--> SETTLING  something is currently crediting the wallet
 *      |        |
 *      |        +--> SETTLED   money is in the ledger. Terminal.
 *      |
 *      +--> FAILED    the user abandoned it or the bank declined. Terminal.
 *
 * SETTLING looks unnecessary until you realise two things race to settle the
 * same deposit: the browser callback after checkout closes, and Razorpay's
 * webhook. Both are legitimate, either can arrive first, and one can arrive
 * while the other is still running. The CREATED -> SETTLING transition is done
 * with an atomic conditional update, so exactly one of them proceeds.
 */
const paymentIntentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // What we asked Razorpay to collect. The wallet is ALWAYS credited with
    // this amount, never with a figure sent by the browser.
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, default: 'INR' },

    razorpayOrderId: { type: String, required: true, unique: true, index: true },
    razorpayPaymentId: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ['CREATED', 'SETTLING', 'SETTLED', 'FAILED'],
      default: 'CREATED',
      index: true,
    },

    // Which of the two paths actually credited the wallet. Useful in an
    // interview: "the webhook settled 40% of my test deposits" is a real
    // observation about why you cannot rely on the browser callback alone.
    settledVia: { type: String, enum: ['CHECKOUT', 'WEBHOOK', null], default: null },

    // Link to the ledger. If this is set, the money is in the wallet.
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    transactionRef: { type: String, default: null },

    method: { type: String, default: null }, // card | netbanking | upi | wallet
    bank: { type: String, default: null },   // e.g. HDFC, when netbanking
    failureReason: { type: String, default: null },

    receipt: { type: String, required: true },
    notes: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

paymentIntentSchema.index({ userId: 1, createdAt: -1 });

export const PaymentIntent = mongoose.model('PaymentIntent', paymentIntentSchema);
