/**
 * Every failure the client is allowed to see goes through this class.
 * `code` is a stable machine-readable string the frontend switches on;
 * `message` is human copy that can change without breaking clients.
 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(code = 'UNAUTHENTICATED', message = 'Sign in to continue.') {
    return new ApiError(401, code, message);
  }
  static forbidden(code = 'FORBIDDEN', message = 'You do not have access to this.') {
    return new ApiError(403, code, message);
  }
  static notFound(code = 'NOT_FOUND', message = 'That resource does not exist.') {
    return new ApiError(404, code, message);
  }
  static conflict(code, message, details) {
    return new ApiError(409, code, message, details);
  }
  static tooMany(code = 'RATE_LIMITED', message = 'Too many requests. Try again shortly.') {
    return new ApiError(429, code, message);
  }
  static internal(message = 'Something went wrong on our side.') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}
