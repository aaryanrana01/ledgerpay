import { Router } from 'express';
import express from 'express';
import { WebhookEvent } from '../models/index.js';
import { logger } from '../utils/logger.js';
import { webhooksEnabled } from '../config/env.js';
import { verifyWebhookSignature } from '../services/razorpay.client.js';
import { markIntentFailed, settleFromWebhook } from '../services/deposit.service.js';
import { handlePayoutWebhook } from '../services/payout.service.js';

const router = Router();

/**
 * Razorpay -> us. This endpoint is public, so everything about it is defensive.
 *
 * express.raw() gives us the untouched request bytes. This route is mounted in
 * app.js BEFORE express.json(), because once the JSON parser has run, the
 * original bytes are gone and the signature can never be reproduced: re-
 * serialising a parsed object changes key order, whitespace and unicode
 * escaping, so the HMAC comes out different every time. This is the single
 * most common reason webhook verification "mysteriously" fails.
 */
router.post('/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  if (!webhooksEnabled) {
    return res.status(503).json({ ok: false, error: { code: 'WEBHOOKS_NOT_CONFIGURED' } });
  }

  const signature = req.headers['x-razorpay-signature'];
  const eventId = req.headers['x-razorpay-event-id'];

  // 1. Authenticity. Reject anything not signed with our webhook secret.
  if (!signature || !verifyWebhookSignature(req.body, signature)) {
    logger.warn('webhook.signature_invalid', { eventId });
    return res.status(400).json({ ok: false, error: { code: 'SIGNATURE_INVALID' } });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: { code: 'MALFORMED_PAYLOAD' } });
  }

  const event = payload.event;

  // 2. Deduplication. Razorpay retries for 24 hours and can deliver the same
  //    event more than once even on success. The unique index on eventId means
  //    the second delivery loses the insert and is acknowledged without being
  //    acted on - the database enforces at-most-once, not our code.
  let record;
  try {
    record = await WebhookEvent.create({ eventId: eventId ?? `no-id-${Date.now()}`, event, payload });
  } catch (error) {
    if (error?.code === 11000) {
      logger.info('webhook.duplicate_ignored', { eventId, event });
      return res.status(200).json({ ok: true, data: { duplicate: true } });
    }
    throw error;
  }

  // 3. Handle it. We always answer 200 once the signature checks out, even if
  //    our own processing fails - a non-2xx makes Razorpay retry, and retrying
  //    will not fix a bug on our side. The failure is recorded for us to fix.
  let outcome = 'IGNORED';
  let errorMessage = null;

  try {
    switch (event) {
      case 'payment.captured':
      case 'order.paid': {
        const entity = payload.payload?.payment?.entity;
        if (entity) {
          const result = await settleFromWebhook(entity);
          outcome = result.ignored ? 'IGNORED' : 'HANDLED';
        }
        break;
      }

      case 'payment.failed': {
        const entity = payload.payload?.payment?.entity;
        if (entity?.order_id) {
          await markIntentFailed(entity.order_id, entity.error_description ?? 'The payment failed.');
          outcome = 'HANDLED';
        }
        break;
      }

      case 'payout.processed':
      case 'payout.reversed':
      case 'payout.failed': {
        const entity = payload.payload?.payout?.entity;
        if (entity) {
          const result = await handlePayoutWebhook(entity, event);
          outcome = result.ignored ? 'IGNORED' : 'HANDLED';
        }
        break;
      }

      default:
        outcome = 'IGNORED';
    }
  } catch (error) {
    outcome = 'ERROR';
    errorMessage = error.message;
    logger.error('webhook.handler_failed', { eventId, event, message: error.message });
  }

  await WebhookEvent.updateOne(
    { _id: record._id },
    { $set: { processedAt: new Date(), outcome, error: errorMessage } }
  );

  logger.info('webhook.received', { eventId, event, outcome });
  return res.status(200).json({ ok: true, data: { event, outcome } });
});

export default router;
