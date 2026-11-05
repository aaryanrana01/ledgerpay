import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { env, paymentsEnabled } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

let client = null;

/** Lazily built so the app boots fine when no keys are configured. */
export function razorpay() {
  if (!paymentsEnabled) {
    throw new ApiError(
      503,
      'PAYMENTS_NOT_CONFIGURED',
      'Online payments are not set up on this server. Add your Razorpay test keys to .env.'
    );
  }
  if (!client) {
    client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }
  return client;
}

/**
 * Compares two hex digests without leaking timing information.
 *
 * A naive `a === b` returns as soon as it finds a differing character, so how
 * long it takes reveals how many leading characters were correct. Given enough
 * attempts that is enough to reconstruct a valid signature one character at a
 * time. timingSafeEqual always compares the full length.
 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verifies the signature Razorpay Checkout hands back to the browser.
 *
 * Formula (from Razorpay's docs):
 *     HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, KEY_SECRET)
 *
 * Why it matters: without this check, anyone could POST an arbitrary order id
 * and payment id to our verify endpoint and claim a deposit succeeded. Only
 * Razorpay can produce this signature, because only Razorpay and we know the
 * key secret.
 */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return safeEqualHex(expected, signature);
}

/**
 * Verifies a webhook delivery.
 *
 * Formula: HMAC_SHA256(RAW_REQUEST_BODY, WEBHOOK_SECRET), sent in the
 * `x-razorpay-signature` header.
 *
 * Two traps here, both of which break the check silently:
 *
 *  1. The webhook secret is NOT the API key secret. It is a value you choose
 *     yourself in the Razorpay dashboard when creating the webhook.
 *
 *  2. It must be computed over the RAW bytes of the request body. Running
 *     JSON.parse and then JSON.stringify produces a byte-for-byte different
 *     string (key order, whitespace, unicode escaping) and the signature will
 *     never match. This is why the webhook route is mounted with
 *     express.raw() BEFORE express.json() in app.js.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;

  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody) // Buffer, not a re-serialised object
    .digest('hex');

  return safeEqualHex(expected, signature);
}

/** The publishable key. Safe to send to the browser; the secret never is. */
export function publicKeyId() {
  return env.RAZORPAY_KEY_ID ?? null;
}
