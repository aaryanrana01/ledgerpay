/**
 * The only place in the client that talks to the network.
 *
 * Two things worth pointing at:
 *
 * 1. The access token lives in a module-scoped variable — not localStorage.
 *    A stolen localStorage entry is a working credential; a variable dies with
 *    the tab. The long-lived refresh token is an httpOnly cookie the browser
 *    attaches automatically and JavaScript cannot read at all.
 *
 * 2. Refresh is single-flight. If six requests 401 at the same moment, they
 *    queue behind one refresh call and then replay — instead of firing six
 *    refreshes, five of which present an already-rotated token and trip the
 *    server's reuse detection, logging the user out for no reason.
 */

let accessToken = null;
let refreshInFlight = null;
let onSessionLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onSessionExpired(handler) {
  onSessionLost = handler;
}

export class ApiClientError extends Error {
  constructor({ status, code, message, details }) {
    super(message || 'Something went wrong.');
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Every money-moving request carries one, so a retry can never double-send. */
export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

async function parse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'BAD_RESPONSE', message: 'The server sent an unreadable response.' } };
  }
}

async function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (response) => {
        const body = await parse(response);
        if (!response.ok) throw new ApiClientError({ status: response.status, ...body.error });
        accessToken = body.data.accessToken;
        return body.data;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function send(path, { method = 'GET', body, headers = {}, retryOn401 = true } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && retryOn401) {
    try {
      await refreshSession();
    } catch (error) {
      accessToken = null;
      onSessionLost();
      throw error;
    }
    return send(path, { method, body, headers, retryOn401: false });
  }

  const payload = await parse(response);

  if (!response.ok) {
    throw new ApiClientError({ status: response.status, ...payload.error });
  }

  return payload.data;
}

export const api = {
  // auth
  // retryOn401 is off for the credential endpoints: a 401 from /login means
  // "wrong password", and silently trying to refresh would swallow that message
  // and surface "sign in to continue" instead.
  register: (payload) => send('/auth/register', { method: 'POST', body: payload, retryOn401: false }),
  login: (payload) => send('/auth/login', { method: 'POST', body: payload, retryOn401: false }),
  logout: () => send('/auth/logout', { method: 'POST', retryOn401: false }),
  logoutEverywhere: () => send('/auth/logout-all', { method: 'POST' }),
  me: () => send('/auth/me'),
  sessions: () => send('/auth/sessions'),
  restore: refreshSession,

  // wallet
  wallet: () => send('/wallet'),
  summary: () => send('/wallet/summary'),
  resolveTag: (tag) => send(`/wallet/resolve/${encodeURIComponent(tag)}`),
  integrity: () => send('/wallet/integrity'),

  transactions: ({ limit = 15, cursor, type, direction } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (type) params.set('type', type);
    if (direction) params.set('direction', direction);
    return send(`/wallet/transactions?${params.toString()}`);
  },
  entries: (id) => send(`/wallet/transactions/${id}/entries`),

  transfer: ({ to, amount, note }) =>
    send('/wallet/transfers', {
      method: 'POST',
      body: { to, amount, note },
      headers: { 'Idempotency-Key': newIdempotencyKey() },
    }),
  topUp: ({ amount, note }) =>
    send('/wallet/top-ups', {
      method: 'POST',
      body: { amount, note },
      headers: { 'Idempotency-Key': newIdempotencyKey() },
    }),
  withdraw: ({ amount, note }) =>
    send('/wallet/withdrawals', {
      method: 'POST',
      body: { amount, note },
      headers: { 'Idempotency-Key': newIdempotencyKey() },
    }),
  reverse: (id) => send(`/wallet/transactions/${id}/reverse`, { method: 'POST' }),

  // payments (Razorpay)
  paymentConfig: () => send('/payments/config'),
  createDeposit: (amount) => send('/payments/deposits', { method: 'POST', body: { amount } }),
  verifyDeposit: (payload) => send('/payments/deposits/verify', { method: 'POST', body: payload }),
  abandonDeposit: (orderId, reason) =>
    send('/payments/deposits/abandon', { method: 'POST', body: { orderId, reason } }),
  createPayout: (payload) =>
    send('/payments/payouts', {
      method: 'POST',
      body: payload,
      headers: { 'Idempotency-Key': newIdempotencyKey() },
    }),
  paymentHistory: () => send('/payments'),
};

/**
 * Loads Razorpay's checkout script once, on demand.
 *
 * Not in index.html: there is no reason to make every visitor download a
 * payment SDK just to look at their balance. It is fetched the first time
 * someone actually opens Add money, and cached after that.
 */
let checkoutScriptPromise = null;

export function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve(true);

  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => {
        checkoutScriptPromise = null; // allow a retry
        reject(new Error('Could not load the payment window. Check your connection.'));
      };
      document.body.appendChild(script);
    });
  }

  return checkoutScriptPromise;
}
