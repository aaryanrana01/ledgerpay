import mongoose from 'mongoose';

/**
 * Every webhook Razorpay delivers, recorded once.
 *
 * Razorpay retries failed deliveries with exponential backoff for 24 hours,
 * and can legitimately deliver the same event more than once even on success.
 * Each delivery carries a unique `x-razorpay-event-id` header, so a unique
 * index on it turns "process this event" into "process this event at most
 * once" - the second delivery loses the insert race and is acknowledged
 * without being acted on.
 */
const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    event: { type: String, required: true, index: true },
    processedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['HANDLED', 'IGNORED', 'ERROR'], default: null },
    error: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
