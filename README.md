# LedgerPay

A digital wallet built on a **double-entry ledger**. Money is never simply subtracted from one row and added to another — every transfer posts a balanced set of entries into an append-only ledger, each entry hashed against the one before it, and account balances are a *derived* value that a reconciliation job checks against the ledger.

React · Node.js · Express.js · MongoDB · JWT

```
┌── React (Vite) ──────────────┐        ┌── Express API ─────────────────────────┐
│  access token in memory      │  HTTPS │  zod validation → rate limit →         │
│  refresh token = httpOnly    │ ─────► │  JWT auth → idempotency → service      │
│  single-flight silent refresh│        │                                        │
└──────────────────────────────┘        │  ledger.service: balanced legs,        │
                                        │  atomic balance guard, hash chain      │
                                        └──────────────┬─────────────────────────┘
                                                       │ multi-document txn
                                        ┌──────────────▼─────────────────────────┐
                                        │ MongoDB (replica set)                  │
                                        │ accounts · ledgerentries (append-only) │
                                        │ transactions · refreshtokens · audit   │
                                        └────────────────────────────────────────┘
```

---

## The five design decisions worth reading

### 1. Double-entry, not balance arithmetic

A transfer writes a `Transaction` plus two or more `LedgerEntry` rows whose amounts sum to zero — a debit on the sender, a matching credit on the recipient. Top-ups and withdrawals move against a system **settlement account**, so money entering or leaving the platform still has a counterparty and the grand total across all accounts stays at exactly zero.

`Account.balanceMinor` is a cached projection for fast reads. `npm run reconcile` recomputes every balance from the ledger and exits non-zero if any of them has drifted.

### 2. The overdraft guard lives in the query

```js
const filter = { _id: leg.accountId, status: 'ACTIVE' };
if (delta < 0) {
  filter.$or = [{ allowNegative: true }, { balanceMinor: { $gte: leg.amountMinor } }];
}
const account = await Account.findOneAndUpdate(filter, { $inc: { balanceMinor: delta } }, { session, new: true });
if (!account) throw insufficientFunds();
```

The check and the write are a single atomic operation, so two concurrent transfers cannot both observe a sufficient balance and both succeed. `tests/concurrency.test.js` fires **100 parallel ₹10 transfers against a ₹500 balance and asserts exactly 50 succeed** — a read-then-write implementation lets far more through.

Everything runs inside a MongoDB multi-document transaction, with `TransientTransactionError` retried under jittered backoff, because write conflicts are the *expected* outcome of contention, not a failure to show the user.

### 3. Tamper-evident ledger

Each entry stores `prevHash` and a SHA-256 `hash` covering its own contents, forming a chain per account. `GET /api/wallet/integrity` walks the chain, recomputes every hash and the running balance, and reports the exact sequence number where they stop agreeing. The Mongoose model additionally blocks every update and delete path, so ledger rows are append-only by construction.

A test edits a historic row through the raw driver — bypassing Mongoose entirely, the way someone with database access would — and asserts detection.

### 4. Idempotency keys

Every money-moving `POST` requires an `Idempotency-Key` header. The first request inserts a key row, runs, and stores its response; a retry replays that response without touching the ledger. A double-tapped Send button, or a mobile network replaying a request, cannot move money twice.

Three cases handled that the naive version gets wrong: same key with a *different* body returns `422` rather than silently replaying; a retry arriving while the original is still in flight returns `409`; and a first attempt that failed deletes the key so the user can legitimately try again.

### 5. Refresh-token rotation with reuse detection

Access tokens are short-lived JWTs held in React state — never `localStorage`, so an XSS bug cannot exfiltrate a working credential. Refresh tokens are opaque random strings stored **hashed** in an httpOnly cookie, grouped into families, and rotated on every use. Presenting an already-rotated token means it leaked, so the entire family is revoked and everyone signs in again.

The client refreshes **single-flight**: six simultaneous 401s queue behind one refresh call instead of firing six, five of which would present a rotated token and trip the server's own reuse detection.

---

## Running it

**Prerequisites:** Node 18 or newer, and Docker (or your own MongoDB replica set).

### 1. Start MongoDB

```bash
docker compose up -d
```

This runs MongoDB as a **single-node replica set**. Replication is not optional
here — multi-document transactions only exist on a replica set, and the ledger
depends on them. A standalone `mongod` will start happily and then fail every
transfer.

Give it ~15 seconds to elect itself, then confirm it's ready:

```bash
docker compose exec mongo mongosh --quiet --eval "rs.status().ok"
# should print: 1
```

### 2. Start the API

```bash
cd server
cp .env.example .env
npm install
```

Generate two different secrets and paste them into `.env` as
`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then:

```bash
npm run seed    # optional: 5 demo users, funded wallets, ~70 transfers
npm run dev     # http://localhost:4000
```

Check it's alive: `curl http://localhost:4000/api/health` — `database` should
read `connected`.

### 3. Start the frontend

```bash
cd ../client
npm install
npm run dev     # http://localhost:5173
```

Seeded sign-ins (all password `DemoPassw0rd`): `arjun@ledgerpay.dev`,
`priya@`, `rohan@`, `sara@`, and `admin@` (who has the `ADMIN` role).

### 4. Confirm it actually works

```bash
cd server
npm test           # unit + integration + the 100-parallel-transfer test
npm run reconcile  # prints the books; exits non-zero if they don't balance
```

The test suite starts its own in-memory replica set through
`mongodb-memory-server`, so it doesn't need the Docker container — but it does
download a `mongod` binary the first time, which needs internet access and takes
a minute.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Transfers fail with a transaction error | MongoDB is running standalone, not as a replica set | Use `docker compose up -d` rather than a local `mongod`; verify with the `rs.status()` command above |
| `Invalid environment configuration` on boot | A required value in `.env` is missing or too short | Both JWT secrets must be at least 24 characters |
| `MongooseServerSelectionError` | The database isn't up yet, or `MONGO_URI` is wrong | Wait for the container, check the URI keeps `?replicaSet=rs0&directConnection=true` |
| Login works, then everything 401s on refresh | The refresh cookie isn't reaching the server | Use the Vite dev server on `localhost:5173` (it proxies `/api`), not the API port directly |
| Tests hang or fail to start | `mongodb-memory-server` couldn't download `mongod` | Check your internet/proxy; the rest of the app still runs fine without it |
| `EADDRINUSE` | Port 4000 or 5173 already taken | Change `PORT` in `.env`, or stop the other process |

### Online payments (optional)

Add money via real Razorpay net banking, card or UPI flows in test mode, and
withdraw to a bank account or UPI ID. Needs free Razorpay test keys —
see **[PAYMENTS.md](./PAYMENTS.md)**. Without keys the wallet works exactly as
before; the Add money button just explains that payments are not configured.

### New to the codebase?

Read **[LEARN.md](./LEARN.md)** — a guided walkthrough of the ideas in this
project, in the order they make sense, with exercises. Start there rather than
reading files alphabetically.

---

## API

All responses are `{ ok, data }` or `{ ok: false, error: { code, message, details }, requestId }`. Error `code` is stable and machine-readable; `message` is human copy.

| Method | Route | Notes |
|---|---|---|
| `POST` | `/api/auth/register` | Creates user + wallet, sets refresh cookie |
| `POST` | `/api/auth/login` | Locks the account for 15 min after 5 failures |
| `POST` | `/api/auth/refresh` | Rotates the refresh token, returns a new access token |
| `POST` | `/api/auth/logout` · `/logout-all` | Revokes one session or every session |
| `GET` | `/api/auth/me` · `/sessions` | Profile; active sessions |
| `GET` | `/api/wallet` | Balance, entry count, policy limits |
| `GET` | `/api/wallet/summary` | 30-day totals + 14-day daily series |
| `GET` | `/api/wallet/resolve/:walletTag` | Confirm a handle before sending |
| `POST` | `/api/wallet/transfers` | **Idempotency-Key required** |
| `POST` | `/api/wallet/top-ups` · `/withdrawals` | **Idempotency-Key required** |
| `GET` | `/api/wallet/transactions` | Cursor-paginated, filterable |
| `GET` | `/api/wallet/transactions/:id/entries` | The double-entry legs + chain hashes |
| `POST` | `/api/wallet/transactions/:id/reverse` | Posts a compensating transaction |
| `GET` | `/api/wallet/integrity` | Verifies the caller's hash chain |
| `GET` | `/api/payments/config` | Whether payments are on, plus the publishable key |
| `POST` | `/api/payments/deposits` | Creates a Razorpay order for a top-up |
| `POST` | `/api/payments/deposits/verify` | Verifies the checkout signature and credits |
| `POST` | `/api/payments/payouts` | Withdraw to a bank account or UPI ID |
| `GET` | `/api/payments` | Deposit and withdrawal history |
| `POST` | `/api/webhooks/razorpay` | Signed webhook; **public**, raw-body verified |
| `GET` | `/api/admin/reconciliation` · `/accounts` · `/audit` | `ADMIN` only |

History uses **keyset pagination** — the cursor encodes `(createdAt, _id)` and hits the compound index directly, so transactions arriving mid-scroll can't duplicate or drop rows the way `skip` does.

### A transfer, end to end

```bash
curl -X POST http://localhost:4000/api/wallet/transfers \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"to":"priya","amount":"250.50","note":"Dinner split"}'
```

```json
{ "ok": true, "data": { "reference": "LP-M8X2K1-4A9F", "amountMinor": 25050, "balanceMinor": 74950 } }
```

Repeat that command with the same key and the ledger does not move; you get the identical response plus an `Idempotent-Replay: true` header.

---

## Money is never a float

Amounts are integer **minor units** (paise) end to end. Parsing happens once at the edge (`"1,240.50"` → `124050`) and formatting once on the way out. `0.1 + 0.2` problems are structurally impossible because no float is ever added.

The input parser rejects `10.999`, `-5`, `1e5`, `.5` and `10.` rather than coercing them — a wallet that silently rounds a user's amount is worse than one that asks again.

---

## Other things in here

- **Zod validation** on every body and query string, replacing the request object with the parsed result so handlers only see well-typed data.
- **Reversals, not deletes.** Undoing a transfer posts a mirrored compensating transaction and links the two. The original is never edited — that's the whole point of an append-only ledger.
- **Rate limiting** at three tiers: global, per-IP on credential endpoints, per-*user* on money movement.
- **Audit log** on every security-relevant action, with request IDs correlating a user-visible error to a server log line.
- **Structured JSON logging**, graceful shutdown, fail-fast environment validation on boot.
- Daily send limits, per-transfer caps, and basis-point fee support (three-leg transactions where the fee credits a system revenue account).

## Interface

The client is styled after a columnar accounting pad, because that's what it is. The signature interaction: **click any row in the ledger and it unfolds** to show the actual debit and credit the server wrote, their per-account sequence numbers, the balance after each, and the entry's link in the hash chain. Most wallets stop at "−₹250.50 to @priya"; this one shows you the record underneath.

A verification strip at the top of the ledger calls `/api/wallet/integrity` and reports the chain state live.

---

## Project layout

```
server/
  src/
    models/       User · Account · Transaction · LedgerEntry · RefreshToken
                  IdempotencyKey · AuditLog
    services/     ledger (the engine) · wallet · auth · token
    middleware/   authenticate · idempotency · validate · rateLimit · errorHandler
    routes/       auth · wallet · admin
    db/           connection + transaction retry wrapper
    utils/        money (integer paise) · hash (chain) · ApiError · logger
  scripts/        seed · reconcile
  tests/          concurrency · wallet · auth · money
client/
  src/
    api/          fetch wrapper: silent refresh, idempotency keys
    context/      AuthContext
    components/   Ledger · LedgerRow (the unfoldable one) · ChainStrip
                  MoveMoney · Sparkline · Toast
    pages/        Dashboard · Activity · Security · SignIn · SignUp
```

## Known limits

Deliberately out of scope, and worth naming rather than pretending otherwise: payments run against Razorpay **test mode**, so the checkout, bank list and webhooks are real but no money moves. Real withdrawals need a RazorpayX account with business KYC, so the default payout provider is a local simulation of the same state machine. There is no KYC, no multi-currency FX, and no 2FA. Reconciliation runs on demand rather than on a scheduler. The ledger is single-node; sharding it would mean giving up cross-account transactions and moving to a saga.
