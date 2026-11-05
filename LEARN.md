# Understanding this codebase

A guided tour, written to be read in order. Budget about 4–6 hours to get
through it properly, with the code open beside you.

If you only have one hour, read **Part 2** and **Part 3**. Those two ideas are
what make this project different from a normal CRUD app, and they are what an
interviewer will ask about.

---

## Part 0 — Get it running first

Reading code you have never executed is much harder than reading code you have
watched work. Follow the setup in `README.md` first, sign up two users, send
money between them, then come back here.

---

## Part 1 — Follow one request all the way through

Trace `POST /api/wallet/transfers`. Open these files in this order:

| # | File | What happens there |
|---|------|--------------------|
| 1 | `src/server.js` | Connects to MongoDB, creates system accounts, starts listening |
| 2 | `src/app.js` | Builds the Express app and the middleware stack |
| 3 | `src/routes/wallet.routes.js` | Defines the route and the chain of middleware it runs through |
| 4 | `src/middleware/authenticate.js` | Reads the JWT, loads the user, attaches `req.user` |
| 5 | `src/middleware/validate.js` | Runs the zod schema, replaces `req.body` with clean data |
| 6 | `src/middleware/idempotency.js` | Blocks duplicate submissions |
| 7 | `src/services/wallet.service.js` → `transfer()` | Business rules: limits, self-transfer, recipient lookup |
| 8 | `src/services/ledger.service.js` → `postTransaction()` | Actually moves the money |

The important habit: **routes decide *whether* something is allowed, services
decide *how* it happens.** Routes never touch the database directly.

### Why the order of middleware matters

```js
router.post('/transfers',
  moneyLimiter,                  // 1. cheap check first - reject floods early
  validate(transferSchema),      // 2. clean the input before anyone uses it
  idempotency('wallet.transfer'),// 3. now the body is final, so we can hash it
  handler                        // 4. do the work
);
```

Idempotency runs *after* validation on purpose. It fingerprints the request
body by hashing it, and it needs the final, normalised body — otherwise
`"250.00"` and `250` would produce different fingerprints for the same request.

---

## Part 2 — Double-entry bookkeeping

**The idea:** never edit a balance directly. Record *movements*, and calculate
balances from them.

A normal student project stores:

```
users: { name: "Arjun", balance: 5000 }
```

and a transfer does `arjun.balance -= 250; priya.balance += 250`.

Two problems with that:
1. If the second write fails, money vanishes.
2. There is no history. If a balance is wrong, you cannot tell why.

This project stores movements instead, in `ledgerentries`:

| accountId | direction | amount | balanceAfter | seq |
|-----------|-----------|--------|--------------|-----|
| Arjun     | DEBIT     | 250.00 | 4750.00      | 12  |
| Priya     | CREDIT    | 250.00 | 1250.00      | 7   |

The rule enforced by `assertLegsAreBalanced()` in `ledger.service.js`:

> **total debits must equal total credits, in every single transaction**

Because that holds for every transaction, it holds for the whole database. That
is what `reconcileSystem()` checks, and what `npm run reconcile` prints.

### Where does money come from?

If a user tops up ₹1000, that is a CREDIT to them — so something must be
DEBITed, or the books break. That something is the **settlement account**
(`SYSTEM:SETTLEMENT`), which represents money held at the platform's bank. It is
allowed to go negative, because it is the other side of every deposit.

**Exercise:** run `npm run seed`, then `npm run reconcile`. The settlement
account will be deeply negative and the sum of every account will be exactly
zero. Convince yourself why that has to be true.

---

## Part 3 — The concurrency problem (the interview question)

This is the single most important thing in the project.

### The bug that isn't obvious

Imagine Arjun has ₹500 and taps "send ₹500" twice at the same instant:

```
time  request A                      request B
----  ---------------------------    ---------------------------
 1    read balance -> 500
 2                                   read balance -> 500
 3    500 >= 500, OK                 500 >= 500, OK
 4    write balance = 0
 5                                   write balance = 0
```

Both succeeded. ₹1000 left an account holding ₹500. The check passed twice
because both requests read the balance *before* either one wrote.

This is a **race condition**, and it is why "read, check, write" is wrong for
money.

### The fix

In `applyLeg()` (`ledger.service.js`), the check is part of the update query:

```js
const filter = { _id: leg.accountId, status: 'ACTIVE' };

if (balanceChange < 0) {
  filter.$or = [
    { allowNegative: true },
    { balanceMinor: { $gte: leg.amountMinor } },   // <-- the check
  ];
}

const account = await Account.findOneAndUpdate(
  filter,
  { $inc: { balanceMinor: balanceChange, entryCount: 1 } },
  { session, new: true }
);

if (!account) { /* not enough money */ }
```

`findOneAndUpdate` is a **single atomic operation** in MongoDB. The database
finds the matching document and modifies it without letting anything else in
between. So the second request's filter simply does not match — the balance is
already 0 — and it gets back `null`.

There is no window. That is the whole trick.

**Exercise:** open `tests/concurrency.test.js`. It funds an account with ₹500
and fires 100 parallel ₹10 transfers, asserting exactly 50 succeed. Then break
it on purpose: remove the `$or` block, run the test again, and watch the
account go negative. Do this. Watching it fail teaches more than reading about it.

### Transactions and retries

A transfer touches four documents (two accounts, two ledger entries) plus the
transaction record. They must all land or none of them. That is what
`withTransaction()` in `src/db/mongoose.js` provides.

When two transactions touch the same account simultaneously, MongoDB aborts one
with a `TransientTransactionError`. That is **normal and expected** — the right
response is to replay the whole transaction, not to show the user an error.
`withTransaction()` retries up to five times with jittered backoff (a small
random delay, so retries do not all collide again at the same moment).

> This is also why MongoDB must run as a **replica set**. Multi-document
> transactions do not exist on a standalone `mongod`. A standalone server will
> start fine and then fail every single transfer, which is a confusing way to
> lose an afternoon.

---

## Part 4 — Money is never a float

Open `src/utils/money.js`.

```js
0.1 + 0.2 === 0.30000000000000004   // JavaScript, and every other language
```

Floating point cannot represent most decimal fractions exactly. Over thousands
of transactions those tiny errors accumulate into real, visible discrepancies.

So this project stores **paise as whole numbers**. ₹12.34 is stored as `1234`.
Conversion happens exactly twice:

- `parseAmountToMinor("12.34")` → `1234`, once, at the edge, on input
- `formatMinor(1234)` → `"12.34"`, once, at the edge, on output

Everything in between is integer arithmetic, which is exact.

Notice the parser *rejects* input it cannot represent — `10.999` returns `null`
rather than rounding to `11.00`. Silently changing a user's amount is worse
than asking them to retype it.

---

## Part 5 — Idempotency (safe retries)

Open `src/middleware/idempotency.js`.

The problem: a user taps Send, the network stalls, they tap again. Or their
phone retries the request automatically. Without protection, money moves twice.

The solution: the client generates a unique `Idempotency-Key` per *intent* (not
per attempt) and sends it as a header. The server:

1. Tries to `INSERT` a row with that key. The **unique index** on
   `(userId, endpoint, key)` is what actually enforces safety — two racing
   requests both try to insert, and the database lets exactly one win.
2. The winner runs the transfer and stores its response on that row.
3. A later retry with the same key finds a completed row and replays the stored
   response without touching the ledger.

Three cases the naive version gets wrong, all handled here:

| Situation | Response | Why |
|-----------|----------|-----|
| Same key, same body, already finished | `201` + stored response | The safe replay |
| Same key, **different** body | `422` | Almost certainly a client bug; hiding it would be worse |
| Same key, original still running | `409` | Cannot answer yet; the client should retry shortly |

If the first attempt failed, the key row is deleted so the user can genuinely
try again.

---

## Part 6 — The hash chain

Open `src/utils/hash.js` and `verifyAccountChain()` in `ledger.service.js`.

Each ledger entry stores a SHA-256 hash of its own contents **plus the hash of
the previous entry on the same account**:

```
entry #1   hash = H(GENESIS + contents₁)
entry #2   hash = H(hash₁    + contents₂)
entry #3   hash = H(hash₂    + contents₃)
```

If someone edits entry #1 directly in the database, its hash no longer matches
its contents, *and* entry #2's `prevHash` no longer matches entry #1's new hash.
The damage is detectable and its position is pinpointed.

This does not *prevent* tampering — a determined attacker with database access
could recompute the whole chain. It makes tampering **detectable**, which is the
realistic goal for an audit trail.

`GET /api/wallet/integrity` runs this check live; the frontend shows the result
in the strip above the ledger.

---

## Part 7 — Authentication

Two tokens, doing different jobs:

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (self-describing) | Random string (meaningless on its own) |
| Lifetime | 15 minutes | 30 days |
| Stored | React memory only | httpOnly cookie |
| Purpose | Sent with every API call | Used only to get a new access token |

**Why not put the access token in `localStorage`?** Any JavaScript on the page
can read `localStorage`. If an XSS bug ever lands, the attacker steals a working
credential. A variable dies when the tab closes, and an `httpOnly` cookie is
invisible to JavaScript entirely.

**Why is the refresh token not a JWT?** A JWT is valid until it expires — you
cannot easily un-issue one. A random string is only meaningful as a lookup into
the database, so revoking it is a single `UPDATE`.

### Rotation and reuse detection

Every time a refresh token is used it is marked used and replaced. If a token
that was *already used* comes back, one of two things happened: the user
replayed an old request, or someone stole the token. The server cannot tell
which, so it takes the safe option and revokes the **entire token family** —
every session descended from that login. See `rotateRefreshToken()` in
`src/services/token.service.js`, and the test that proves it in
`tests/auth.test.js`.

### Single-flight refresh on the client

In `client/src/api/client.js`, if six API calls all get a `401` at once, they
queue behind **one** refresh call rather than firing six. Six refreshes would
mean five of them presenting an already-rotated token — which would trip the
server's reuse detection and log the user out for no reason.

---

## Part 8 — The frontend

Smaller and simpler than the backend. Worth understanding:

- `context/AuthContext.jsx` — holds the user and balance; on page load it tries
  a silent refresh before deciding whether to show the sign-in screen (that is
  why a hard refresh does not log you out even though the access token was only
  in memory).
- `api/client.js` — the only file that talks to the network.
- `components/LedgerRow.jsx` — the signature UI piece. Clicking a row calls
  `/transactions/:id/entries` and unfolds to show the actual debit and credit.
- `components/Sparkline.jsx` — a hand-drawn SVG chart. Worth reading if you have
  only ever used charting libraries; it is about 20 lines of arithmetic.

---

## Part 9 — Questions to be able to answer

If you can answer these without looking, you understand the project.

1. Why does `balanceMinor` exist at all if the ledger is the source of truth?
2. What exactly breaks if MongoDB runs standalone instead of as a replica set?
3. Two people send money to the same person at the same instant. Walk through
   what MongoDB does.
4. Why is the overdraft check inside the query filter instead of an `if`?
5. Why does a reversal create a new transaction instead of deleting the old one?
6. Why `422` and not `200` when an idempotency key is reused with a new body?
7. What does the hash chain protect against, and what does it *not* protect against?
8. Why is the access token short-lived if the refresh token lasts 30 days?
9. Where does the money come from when a user tops up?
10. Why must `Σ(all account balances) === 0`?

Suggested answers are deliberately not included. Work them out from the code —
that is the part that actually sticks.

---

## Suggested study order

| Session | Focus | Time |
|---------|-------|------|
| 1 | Run it, click everything, read Part 1 | 2 hrs |
| 2 | Part 2 + Part 4, read `money.js` and the models | 2 hrs |
| 3 | **Part 3**, break the concurrency test on purpose | 3 hrs |
| 4 | Part 5 + Part 6 | 2 hrs |
| 5 | Part 7, trace a login and a refresh in the browser network tab | 3 hrs |
| 6 | Frontend, then answer the Part 9 questions out loud | 2 hrs |
