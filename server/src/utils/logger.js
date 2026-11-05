import { isTest } from '../config/env.js';

/** Structured single-line JSON logs — greppable, and ready for any log shipper. */
function emit(level, message, meta = {}) {
  if (isTest && level !== 'error') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
