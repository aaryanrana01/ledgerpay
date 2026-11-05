import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { formatMinor } from './format.js';

/**
 * One modal covers all three money movements. The interesting bit is tag
 * resolution: before the user commits, we confirm the handle belongs to a real
 * person and show their name, because "I sent it to the wrong @tag" is the
 * failure mode a wallet actually has.
 */
export default function MoveMoney({ mode = 'send', balanceMinor, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [resolved, setResolved] = useState(null);
  const [resolveError, setResolveError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef(null);

  const isSend = mode === 'send';

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced lookup so we aren't firing a request per keystroke.
  useEffect(() => {
    if (!isSend) return undefined;
    const handle = tag.trim().replace(/^@/, '');
    setResolved(null);
    setResolveError(null);
    if (handle.length < 3) return undefined;

    const timer = setTimeout(() => {
      api
        .resolveTag(handle)
        .then((result) => {
          if (result.isSelf) setResolveError('That is your own wallet tag.');
          else setResolved(result);
        })
        .catch(() => setResolveError('No one is using that wallet tag.'));
    }, 300);

    return () => clearTimeout(timer);
  }, [tag, isSend]);

  const title = { send: 'Send money', top: 'Add money', out: 'Withdraw' }[mode];
  const action = { send: 'Send', top: 'Add', out: 'Withdraw' }[mode];

  const canSubmit =
    Boolean(amount.trim()) && !busy && (!isSend || (Boolean(resolved) && !resolveError));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { amount: amount.trim(), note: note.trim() };
      const result = isSend
        ? await api.transfer({ ...payload, to: resolved.walletTag })
        : mode === 'top'
        ? await api.topUp(payload)
        : await api.withdraw(payload);
      onDone(result, mode);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <span className="eyebrow">{isSend ? 'Peer to peer' : 'Simulated bank rail'}</span>
        <h2>{title}</h2>
        <p className="sub">
          Available <span className="mono">₹{formatMinor(balanceMinor)}</span>
        </p>

        {error && <div className="form-error">{error}</div>}

        <form onSubmit={submit}>
          {isSend && (
            <div className="field">
              <label htmlFor="tag">Recipient wallet tag</label>
              <input
                id="tag"
                ref={firstField}
                className="mono"
                placeholder="@priya"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                autoComplete="off"
              />
              {resolveError && <span className="error">{resolveError}</span>}
            </div>
          )}

          {resolved && <div className="resolved">Sending to {resolved.fullName} (@{resolved.walletTag})</div>}

          <div className="field">
            <label htmlFor="amount">Amount</label>
            <input
              id="amount"
              ref={isSend ? undefined : firstField}
              className="mono"
              inputMode="decimal"
              placeholder="250.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
            />
            <span className="hint">Rupees and paise. Parsed to integer paise before it touches the ledger.</span>
          </div>

          <div className="field">
            <label htmlFor="note">Note (optional)</label>
            <input id="note" placeholder="Dinner split" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!canSubmit}>
              {busy ? 'Posting…' : action}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
