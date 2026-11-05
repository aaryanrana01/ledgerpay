import { ApiError } from '../utils/ApiError.js';

/**
 * Validates and *replaces* the request part with the parsed result, so handlers
 * only ever see data that matched the schema — no unknown keys, correct types.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      return next(ApiError.badRequest('VALIDATION_FAILED', 'Check the highlighted fields.', details));
    }
    if (source === 'query') req.validatedQuery = result.data;
    else req[source] = result.data;
    return next();
  };
}
