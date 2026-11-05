import { useState } from 'react';
import { api } from '../api/client.js';
import { describe, formatDate, formatDateTime, formatMinor, shortHash } from './format.js';

/**
 * A row in the ledger, which unfolds to show what the row actually *is*.
 *
 * Most wallet UIs stop at "-₹250.50 to @priya". This one opens up to reveal the
 * two ledger entries the server wrote — a debit on one account and a matching
 * credit on the other, summing to zero — along with each entry's sequence
 * number and its link in the account's hash chain. The double-entry model is
 * the interesting thing about this system, so the interface shows it rather
 * than hiding it behind a friendly abstraction.
 */
export default function LedgerRow({ txn, onReversed }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [error, setError] = useState(null);

  const outgoing = txn.direction === 'OUT';
  const reversible = txn.type === 'TRANSFER' && txn.direction === 'OUT' && txn.status === 'POSTED';

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setLoading(true);
      try {
        setDetail(await api.entries(txn.id));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  }

  async function reverse() {
    setReversing(true);
    setError(null);
    try {
      await api.reverse(txn.id);
      onReversed?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setReversing(false);
    }
  }

  const totalDebits = detail?.entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0) ?? 0;
  const totalCredits = detail?.entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0) ?? 0;

  return (
    <div className="ledger-row">
      <button className="ledger-row-main" onClick={toggle} aria-expanded={open}>
        <span className="date mono col-date">{formatDate(txn.createdAt)}</span>

        <span>
          <span className="who">
            {describe(txn)}
            {txn.status === 'REVERSED' && <span className="tag-reversed">reversed</span>}
          </span>
          {txn.note && <span className="memo"> {txn.note}</span>}
        </span>

        {/* Debits and credits keep their own columns, the way a ledger prints
            them — one of the two cells is always empty. */}
        <span className={`amount num debit ${outgoing ? '' : 'is-empty'}`}>
          {outgoing ? formatMinor(txn.amountMinor) : ''}
        </span>
        <span className={`amount num credit ${outgoing ? 'is-empty' : ''}`}>
          {outgoing ? '' : formatMinor(txn.amountMinor)}
        </span>

        <span className="running num col-running">{txn.reference}</span>
      </button>

      {open && (
        <div className="entry-panel">
          {loading && <div className="loading">Loading ledger entries</div>}
          {error && <div className="form-error">{error}</div>}

          {detail && (
            <>
              <div className="panel-head">
                <span className="eyebrow">Double-entry record</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
                  {formatDateTime(txn.createdAt)} · {txn.reference}
                </span>
              </div>

              <table className="entry-legs">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Seq</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.entries.map((entry) => (
                    <tr key={`${entry.seq}-${entry.direction}-${entry.hash}`} className={entry.mine ? 'mine' : ''}>
                      <td>{entry.mine ? 'Your wallet' : entry.accountKind === 'SYSTEM' ? 'Settlement' : 'Counterparty'}</td>
                      <td>#{entry.seq}</td>
                      <td className="num debit">{entry.direction === 'DEBIT' ? formatMinor(entry.amountMinor) : ''}</td>
                      <td className="num credit">{entry.direction === 'CREDIT' ? formatMinor(entry.amountMinor) : ''}</td>
                      {/* Only the viewer's own running balance is disclosed by the API. */}
                      <td className="num">{entry.mine ? formatMinor(entry.balanceAfterMinor) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Totals</td>
                    <td className="num debit">{formatMinor(totalDebits)}</td>
                    <td className="num credit">{formatMinor(totalCredits)}</td>
                    <td className="num">{totalDebits === totalCredits ? 'balanced' : 'UNBALANCED'}</td>
                  </tr>
                </tfoot>
              </table>

              {detail.entries.filter((e) => e.mine).map((entry) => (
                <p className="hash-link" key={entry.hash}>
                  <b>entry #{entry.seq}</b> · prev {shortHash(entry.prevHash)} → hash {shortHash(entry.hash)}
                </p>
              ))}

              {reversible && (
                <div style={{ marginTop: 14 }}>
                  <button className="btn ghost small" onClick={reverse} disabled={reversing}>
                    {reversing ? 'Reversing…' : 'Reverse this transfer'}
                  </button>
                  <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--ink-faint)' }}>
                    Posts a compensating entry. The original stays on the record.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
