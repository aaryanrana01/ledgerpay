import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  let normalised = error;

  if (!(error instanceof ApiError)) {
    if (error?.code === 11000) {
      normalised = ApiError.conflict('DUPLICATE_KEY', 'That value is already in use.', {
        keys: Object.keys(error.keyPattern ?? {}),
      });
    } else if (error?.name === 'ValidationError') {
      normalised = ApiError.badRequest('VALIDATION_FAILED', 'Check the highlighted fields.', {
        fields: Object.keys(error.errors ?? {}),
      });
    } else if (error?.name === 'CastError') {
      normalised = ApiError.badRequest('BAD_IDENTIFIER', 'That identifier is not valid.');
    } else {
      normalised = ApiError.internal();
    }
  }

  if (normalised.status >= 500) {
    logger.error('request.failed', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      message: error?.message,
      stack: isProd ? undefined : error?.stack,
    });
  }

  res.status(normalised.status).json({
    ok: false,
    error: {
      code: normalised.code,
      message: normalised.message,
      details: normalised.details,
    },
    requestId: req.id,
  });
}
