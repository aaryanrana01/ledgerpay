import { IdempotencyKey } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { sha256 } from '../utils/hash.js';

const TTL_HOURS = 24;

/**
 * Makes a money-moving POST safe to retry.
 *
 * The client sends `Idempotency-Key: <uuid>`. The first request inserts a row
 * and proceeds; the response is written back onto that row. A retry with the
 * same key returns the stored response without touching the ledger — the user
 * double-tapping "Send", or a mobile network replaying a request, cannot move
 * money twice.
 *
 * Three cases the naive version gets wrong, handled here:
 *   1. Same key, *different* body      -> 422, because it is almost certainly a
 *                                         client bug and silently replaying the
 *                                         old response would hide it.
 *   2. Retry while the first is still  -> 409 IDEMPOTENT_REPLAY_IN_PROGRESS.
 *      in flight
 *   3. First attempt failed 4xx/5xx    -> the row is deleted so the user can
 *                                         legitimately try again.
 */
export function idempotency(endpointName) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.headers['idempotency-key'];

    if (!key) {
      return next(
        ApiError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header.')
      );
    }
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      return next(ApiError.badRequest('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8–128 characters.'));
    }

    const requestHash = sha256(JSON.stringify(req.body ?? {}));
    const userId = req.user.id;

    let record;
    try {
      record = await IdempotencyKey.create({
        key,
        userId,
        endpoint: endpointName,
        requestHash,
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
      });
    } catch (error) {
      if (error?.code !== 11000) return next(error);

      const existing = await IdempotencyKey.findOne({ key, userId, endpoint: endpointName });
      if (!existing) return next(ApiError.internal('Could not resolve idempotency key.'));

      if (existing.requestHash !== requestHash) {
        return next(
          new ApiError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used with a different request body.'
          )
        );
      }

      if (existing.status === 'COMPLETED') {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.responseStatus).json(existing.responseBody);
      }

      return next(
        ApiError.conflict('IDEMPOTENT_REPLAY_IN_PROGRESS', 'The original request is still being processed.')
      );
    }

    // Capture the response so a later retry can replay it verbatim.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const persist =
        status >= 200 && status < 300
          ? IdempotencyKey.updateOne(
              { _id: record._id },
              { $set: { status: 'COMPLETED', responseStatus: status, responseBody: body } }
            )
          : IdempotencyKey.deleteOne({ _id: record._id }); // let the caller retry

      persist.catch(() => {});
      return originalJson(body);
    };

    return next();
  };
}
