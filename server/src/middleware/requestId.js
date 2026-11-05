import { randomId } from '../utils/hash.js';

/** Correlates a client-visible error with a server log line. */
export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomId(8);
  res.setHeader('x-request-id', req.id);
  next();
}
