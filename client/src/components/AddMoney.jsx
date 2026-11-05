import { useEffect, useRef, useState } from 'react';
import { api, loadRazorpayCheckout } from '../api/client.js';
import { formatMinor } from './format.js';

const QUICK_AMOUNTS = [500, 1000, 2500, 5000];

/**
 * Payment methods. `method` maps to Razorpay's checkout config so the modal
 * opens straight onto the right tab instead of making the user hunt for it.
 */
const METHODS = [
  {
    id: 'netbanking',
    label: 'Net banking',
    hint: 'Pay from your bank account',
    config: { netbanking: true },
  },
  {
    id: 'card',
    label: 'Card',
    hint: 'Debit or credit card',
    config: { card: true },
  },
  {
    id: 'upi',
    label: 'UPI',
    hint: 'Any UPI app or ID',
    config: { upi: true },
  },
];

/**
 * Adding money to the wallet.
 *
 * The flow is deliberately three server round-trips rather than one:
 *
 *   1. POST /payments/deposits   -> we create a Razorpay order server-side and
 *                                   record the amount we expect
 *   2. Razorpay Checkout opens   -> the user pays. Real bank list, real card
 *                                   form, all hosted by Razorpay, so no card
 *                                   details ever touch this application
 *   3. POST /payments/deposits/verify -> we check the signature and credit
 *
 * Step 1 exists so the browser cannot choose the amount. Step 3 exists so the
 * browser cannot fake a success. Both are the whole point.
 */
export default function AddMoney({ onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('netbanking');
  const [config, setConfig] = useState(null);
  const [stage, setStage] = useState('idle'); // idle | creating | waiting | verifying
  const [error, setError] = useState(null);
  const amountRef = useRef(null);

  useEffect(() => {
    amountRef.current?.focus();
    api.paymentConfig().then(setConfig).catch(() => setConfig({ enabled: false }));
  }, []);

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && stage === 'idle' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stage]);

  const busy = stage !== 'idle';

  async function start(event) {
    event.preventDefault();
    setError(null);
    setStage('creating');

    try {
      await loadRazorpayCheckout();
      const order = await api.createDeposit(amount.trim());

      setStage('waiting');

      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amountMinor,
        currency: order.currency,
        name: 'LedgerPay',
        description: 'Add money to wallet',
        prefill: order.prefill,
        theme: { color: '#14594b' },
        // Opens the modal on the tab the user already chose.
        config: {
          display: {
            blocks: {},
            preferences: { show_default_blocks: true },
          },
        },
        method: METHODS.find((m) => m.id === method)?.config,

        handler: async (response) => {
          setStage('verifying');
          try {
            // The browser saying "it worked" means nothing until the server
            // verifies the signature against its own key secret.
            const result = await api.verifyDeposit({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            onDone(result);
          } catch (err) {
            setError(
              `${err.message} If money left your account, the webhook will still credit it within a minute.`
            );
            setStage('idle');
          }
        },

        modal: {
          ondismiss: () => {
            // Tell the server the user walked away, so the history shows an
            // abandoned attempt rather than an eternally pending one.
            api.abandonDeposit(order.orderId, 'Closed the payment window').catch(() => {});
            setStage('idle');
          },
        },
      });

      checkout.on('payment.failed', (response) => {
        setError(response.error?.description ?? 'The payment did not go through.');
        api.abandonDeposit(order.orderId, response.error?.description).catch(() => {});
        setStage('idle');
      });

      checkout.open();
    } catch (err) {
      setError(err.message);
      setStage('idle');
    }
  }

  if (config && config.enabled === false) {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal" role="dialog" aria-modal="true">
          <span className="eyebrow">Not configured</span>
          <h2>Online payments are off</h2>
          <p className="sub">
            This server has no Razorpay keys set. Add <code className="mono">RAZORPAY_KEY_ID</code> and{' '}
            <code className="mono">RAZORPAY_KEY_SECRET</code> to <code className="mono">server/.env</code> to
            enable net banking, cards and UPI.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add money">
        <span className="eyebrow">Razorpay · test mode</span>
        <h2>Add money</h2>
        <p className="sub">Money lands in your wallet as a credit entry once the payment is verified.</p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={start}>
          <div className="field">
            <label htmlFor="add-amount">Amount</label>
            <input
              id="add-amount"
              ref={amountRef}
              className="mono"
              inputMode="decimal"
              placeholder="500.00"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="quick-amounts">
            {QUICK_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setAmount(String(value))}
              >
                ₹{formatMinor(value * 100).replace('.00', '')}
              </button>
            ))}
          </div>

          <fieldset className="method-picker" disabled={busy}>
            <legend className="eyebrow">Pay using</legend>
            {METHODS.map((option) => (
              <label key={option.id} className={`method ${method === option.id ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="method"
                  value={option.id}
                  checked={method === option.id}
                  onChange={() => setMethod(option.id)}
                />
                <span className="method-label">{option.label}</span>
                <span className="method-hint">{option.hint}</span>
              </label>
            ))}
          </fieldset>

          <p className="pay-note">
            The bank list and card form are hosted by Razorpay — no card or netbanking credentials ever reach
            this application.
          </p>

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!amount.trim() || busy}>
              {stage === 'creating' && 'Preparing…'}
              {stage === 'waiting' && 'Complete the payment…'}
              {stage === 'verifying' && 'Verifying…'}
              {stage === 'idle' && 'Continue to pay'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
