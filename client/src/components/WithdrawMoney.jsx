import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { formatMinor } from './format.js';

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** A short list is enough — the IFSC is what actually routes the money. */
const BANKS = [
  'HDFC Bank',
  'ICICI Bank',
  'State Bank of India',
  'Axis Bank',
  'Kotak Mahindra Bank',
  'Punjab National Bank',
  'Bank of Baroda',
  'Canara Bank',
  'IndusInd Bank',
  'Yes Bank',
  'Union Bank of India',
  'IDFC First Bank',
];

/**
 * Withdrawing money back out of the wallet.
 *
 * The important server-side behaviour this triggers: the wallet is debited
 * first, then the payout is sent. If the bank rejects it, a compensating
 * entry credits the money back — the balance is never left in a state where
 * the money is both spent and still there.
 */
export default function WithdrawMoney({ balanceMinor, onClose, onDone }) {
  const [destinationType, setDestinationType] = useState('BANK_ACCOUNT');
  const [form, setForm] = useState({
    amount: '',
    name: '',
    accountNumber: '',
    confirmAccountNumber: '',
    ifsc: '',
    bankName: BANKS[0],
    vpa: '',
    mode: 'IMPS',
  });
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
    api.paymentConfig().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  /** Client-side checks mirror the server's, purely so errors arrive faster. */
  function localErrors() {
    const issues = {};
    if (!form.amount.trim()) issues.amount = 'Enter an amount.';
    if (form.name.trim().length < 2) issues.name = 'Enter the account holder name.';

    if (destinationType === 'BANK_ACCOUNT') {
      if (!/^\d{6,18}$/.test(form.accountNumber)) issues.accountNumber = 'Account numbers are 6–18 digits.';
      else if (form.accountNumber !== form.confirmAccountNumber) {
        issues.confirmAccountNumber = 'The account numbers do not match.';
      }
      if (!IFSC_PATTERN.test(form.ifsc.toUpperCase())) issues.ifsc = 'Looks like: HDFC0001234';
    } else if (!/^[\w.-]{2,}@[a-zA-Z][\w.-]+$/.test(form.vpa)) {
      issues.vpa = 'Looks like: name@bank';
    }

    return issues;
  }

  async function submit(event) {
    event.preventDefault();
    const issues = localErrors();
    setFieldErrors(issues);
    if (Object.keys(issues).length) return;

    setBusy(true);
    setError(null);

    try {
      const result = await api.createPayout({
        amount: form.amount.trim(),
        destinationType,
        name: form.name.trim(),
        mode: destinationType === 'VPA' ? 'UPI' : form.mode,
        ...(destinationType === 'BANK_ACCOUNT'
          ? { accountNumber: form.accountNumber, ifsc: form.ifsc.toUpperCase(), bankName: form.bankName }
          : { vpa: form.vpa.trim() }),
      });
      onDone(result);
    } catch (err) {
      if (Array.isArray(err.details)) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      }
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Withdraw">
        <span className="eyebrow">
          {config?.payoutProvider === 'razorpayx' ? 'RazorpayX payout' : 'Simulated payout rail'}
        </span>
        <h2>Withdraw to bank</h2>
        <p className="sub">
          Available <span className="mono">₹{formatMinor(balanceMinor)}</span>
          {config?.minWithdrawalMinor ? ` · minimum ₹${formatMinor(config.minWithdrawalMinor)}` : ''}
        </p>

        {error && <div className="form-error">{error}</div>}

        <div className="segmented">
          <button
            type="button"
            className={destinationType === 'BANK_ACCOUNT' ? 'on' : ''}
            onClick={() => setDestinationType('BANK_ACCOUNT')}
            disabled={busy}
          >
            Bank account
          </button>
          <button
            type="button"
            className={destinationType === 'VPA' ? 'on' : ''}
            onClick={() => setDestinationType('VPA')}
            disabled={busy}
          >
            UPI ID
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="wd-amount">Amount</label>
            <input
              id="wd-amount"
              ref={firstRef}
              className="mono"
              inputMode="decimal"
              placeholder="1000.00"
              value={form.amount}
              onChange={update('amount')}
              disabled={busy}
            />
            {fieldErrors.amount && <span className="error">{fieldErrors.amount}</span>}
          </div>

          <div className="field">
            <label htmlFor="wd-name">Account holder name</label>
            <input id="wd-name" value={form.name} onChange={update('name')} disabled={busy} />
            {fieldErrors.name && <span className="error">{fieldErrors.name}</span>}
          </div>

          {destinationType === 'BANK_ACCOUNT' ? (
            <>
              <div className="field">
                <label htmlFor="wd-bank">Bank</label>
                <select id="wd-bank" value={form.bankName} onChange={update('bankName')} disabled={busy}>
                  {BANKS.map((bank) => (
                    <option key={bank}>{bank}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="wd-acc">Account number</label>
                <input
                  id="wd-acc"
                  className="mono"
                  inputMode="numeric"
                  value={form.accountNumber}
                  onChange={update('accountNumber')}
                  disabled={busy}
                  autoComplete="off"
                />
                {fieldErrors.accountNumber && <span className="error">{fieldErrors.accountNumber}</span>}
              </div>

              <div className="field">
                <label htmlFor="wd-acc2">Confirm account number</label>
                <input
                  id="wd-acc2"
                  className="mono"
                  inputMode="numeric"
                  value={form.confirmAccountNumber}
                  onChange={update('confirmAccountNumber')}
                  disabled={busy}
                  autoComplete="off"
                  onPaste={(e) => e.preventDefault()}
                />
                <span className="hint">Typed twice on purpose — a wrong digit here sends money to a stranger.</span>
                {fieldErrors.confirmAccountNumber && (
                  <span className="error">{fieldErrors.confirmAccountNumber}</span>
                )}
              </div>

              <div className="field">
                <label htmlFor="wd-ifsc">IFSC</label>
                <input
                  id="wd-ifsc"
                  className="mono"
                  placeholder="HDFC0001234"
                  value={form.ifsc}
                  onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })}
                  disabled={busy}
                  maxLength={11}
                  autoComplete="off"
                />
                {fieldErrors.ifsc && <span className="error">{fieldErrors.ifsc}</span>}
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="wd-vpa">UPI ID</label>
              <input
                id="wd-vpa"
                className="mono"
                placeholder="name@bank"
                value={form.vpa}
                onChange={update('vpa')}
                disabled={busy}
                autoComplete="off"
              />
              {fieldErrors.vpa && <span className="error">{fieldErrors.vpa}</span>}
            </div>
          )}

          {config?.payoutProvider === 'simulated' && (
            <p className="pay-note">
              Simulated rail: the payout settles after a few seconds. An account number ending in{' '}
              <span className="mono">0000</span> is rejected on purpose, so you can watch the money get
              credited back.
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Sending…' : 'Withdraw'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
