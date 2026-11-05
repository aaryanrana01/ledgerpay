# Setting up payments

The wallet works fine without this — **Add money** just shows a "not configured"
message. Follow this to switch on real net banking, card and UPI flows.

Everything here uses **Razorpay Test Mode**. The checkout window, the bank
list, the card form and the webhooks are all genuinely Razorpay's. The only
thing that is not real is the money.

---

## 1. Get your test keys

1. Sign up at [dashboard.razorpay.com](https://dashboard.razorpay.com) — free,
   no business registration needed for test mode
2. Confirm the **Test Mode** toggle at the top is ON
3. Go to **Settings → API Keys → Generate Test Key**
4. Copy both values. The secret is shown **once** — if you lose it, regenerate

Test keys always start with `rzp_test_`. If yours starts with `rzp_live_`, stop:
you are about to charge real cards.

Put them in `server/.env`:

```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Restart the server. **Add money** now opens the real Razorpay checkout.

---

## 2. Pay with a test card

Razorpay accepts specific fake cards in test mode:

| Card number | Result |
|---|---|
| `4111 1111 1111 1111` | Success |
| `5104 0600 0000 0008` | Success (Mastercard) |
| `4000 0000 0000 0002` | Declined — use this to see the failure path |

Any future expiry, any CVV, any name. On the 3-D Secure page that follows,
click **Success** or **Failure** to choose the outcome.

For **net banking**, pick any bank from the list — a fake bank page opens with
Success and Failure buttons. For **UPI**, use `success@razorpay` or
`failure@razorpay`.

---

## 3. Webhooks (the part that matters)

Without a webhook, a deposit only settles if the user's browser survives long
enough to report back. Close the tab at the wrong moment and the money is taken
but never credited. The webhook is what makes the system correct.

Razorpay has to reach your machine, so you need a public URL. `ngrok` is the
usual tool:

```bash
brew install ngrok
ngrok http 4000
```

It prints something like `https://a1b2-49-36-x-x.ngrok-free.app`.

Then in the Razorpay dashboard: **Settings → Webhooks → Add New Webhook**

- **URL** — `https://YOUR-NGROK-URL/api/webhooks/razorpay`
- **Secret** — invent one, e.g. `whsec_my_local_secret_123`.
  This is **not** your API key secret; it is a value you choose.
- **Active events** — tick `payment.captured`, `payment.failed`, `order.paid`

Add the same secret to `server/.env`:

```
RAZORPAY_WEBHOOK_SECRET=whsec_my_local_secret_123
```

Restart the server.

### Proving it works

Make a payment, then check the server logs. You will see two settlement
attempts arrive and exactly one of them win:

```json
{"message":"deposit.settled","via":"CHECKOUT","reference":"LP-..."}
{"message":"webhook.received","event":"payment.captured","outcome":"IGNORED"}
```

The webhook arrived, found the deposit already settled, and did nothing. That
is the design working — not a bug.

**Better demo:** pay, and close the browser tab the instant the modal
disappears, before it can call `/verify`. The wallet still gets credited a few
seconds later, entirely by the webhook. The **Payments** page will show
`credited via webhook`. That is the single most convincing thing you can
demonstrate about this feature.

---

## 4. Withdrawals

Withdrawals default to `PAYOUT_PROVIDER=simulated`, which needs no setup. The
full lifecycle runs locally: the wallet is debited immediately, the payout moves
to `PROCESSING`, and settles a few seconds later.

**To see a payout bounce and the money come back**, use an account number
ending in `0000`. It is rejected on purpose, and a compensating ledger entry
credits your wallet. Watch it happen on the Payments page.

### Real payouts

`PAYOUT_PROVIDER=razorpayx` calls the actual Payouts API. Be aware of what it
needs: a RazorpayX account with **completed business KYC** — business PAN,
registration proof, a business bank account. A personal account cannot get one.

The code path is written and follows Razorpay's documented Composite Payout
API, including the `X-Payout-Idempotency` header that has been mandatory since
March 2025. It is not something I could test without a RazorpayX account, so
treat it as reviewed-but-unrun.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `PAYMENTS_NOT_CONFIGURED` | Keys missing from `.env`, or the server was not restarted |
| Checkout opens, payment succeeds, balance unchanged | Webhook not set up and the verify call failed. Check the server log |
| `SIGNATURE_INVALID` on webhooks | Wrong secret, or the webhook route got moved below `express.json()` in `app.js` |
| Webhook never arrives | ngrok URL changed (it does on every restart) — update it in the dashboard |
| `AMOUNT_MISMATCH` | The payment amount differs from the recorded intent. This is the tamper check firing |
| Payout stuck on `PROCESSING` | With the simulated provider, wait `SIMULATED_PAYOUT_DELAY_MS`. It settles in the background |

---

## What to say about this in an interview

The interesting engineering is not "I integrated a payment gateway" — plenty of
people have. It is the failure handling:

- **Two settlement paths race.** The browser callback and the webhook both try
  to credit the wallet. A conditional update on the `CREATED → SETTLING`
  transition means exactly one wins, and the loser reports success rather than
  erroring, because the deposit *is* being handled.

- **The amount comes from the server, never the browser.** The intent records
  what was asked for; settlement credits that figure and additionally re-fetches
  the payment from Razorpay to confirm it matches.

- **Webhook signatures are computed over raw bytes.** Parsing the body first
  and re-serialising it changes the bytes and breaks the HMAC — which is why
  the webhook route is mounted before `express.json()`.

- **Webhooks are deduplicated by a unique index** on Razorpay's event id, not
  by application logic. Razorpay retries for 24 hours, so duplicates are normal.

- **Withdrawals debit before sending.** Sending first and debiting after means a
  crash in between gives money away for free. Debiting first means the worst
  case is money we hold and later return, which a compensating entry fixes.
