import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { formatDateTime, formatMinor } from '../components/format.js';

const DEPOSIT_TONE = { SETTLED: 'credit', FAILED: 'debit', CREATED: '', SETTLING: '' };
const PAYOUT_TONE = { PROCESSED: 'credit', REVERSED: 'debit', FAILED: 'debit', REQUESTED: '', PROCESSING: '' };

const DEPOSIT_LABEL = {
  CREATED: 'awaiting payment',
  SETTLING: 'crediting…',
  SETTLED: 'credited',
  FAILED: 'not completed',
};

const PAYOUT_LABEL = {
  REQUESTED: 'queued',
  PROCESSING: 'sending to bank',
  PROCESSED: 'paid out',
  REVERSED: 'returned',
  FAILED: 'failed',
};

export default function Payments() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.paymentHistory());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Payouts settle asynchronously, so poll while the page is open. A
    // production build would use websockets or server-sent events instead.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <div className="loading">Loading payments</div>;

  const deposits = data?.deposits ?? [];
  const payouts = data?.payouts ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Bank rails</span>
          <h1>Payments</h1>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Money added</h3>
          <p className="card-sub">
            Every attempt to top up, including ones that were never completed. `Credited via` shows whether the
            browser callback or the webhook actually settled it.
          </p>

          {deposits.length === 0 ? (
            <p className="empty-inline">No top-ups yet.</p>
          ) : (
            deposits.map((row) => (
              <div className="payment-row" key={row.id}>
                <div>
                  <div className="payment-main">
                    <span className="mono">₹{formatMinor(row.amountMinor)}</span>
                    <span className={`payment-status ${DEPOSIT_TONE[row.status]}`}>
                      {DEPOSIT_LABEL[row.status]}
                    </span>
                  </div>
                  <div className="payment-meta">
                    {formatDateTime(row.createdAt)}
                    {row.method && ` · ${row.bank ?? row.method}`}
                    {row.settledVia && ` · credited via ${row.settledVia.toLowerCase()}`}
                    {row.failureReason && ` · ${row.failureReason}`}
                  </div>
                </div>
                {row.reference && <span className="mono payment-ref">{row.reference}</span>}
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h3>Money withdrawn</h3>
          <p className="card-sub">
            The wallet is debited the moment a withdrawal starts. If the bank returns it, a compensating entry
            puts the money back.
          </p>

          {payouts.length === 0 ? (
            <p className="empty-inline">No withdrawals yet.</p>
          ) : (
            payouts.map((row) => (
              <div className="payment-row" key={row.id}>
                <div>
                  <div className="payment-main">
                    <span className="mono">₹{formatMinor(row.amountMinor)}</span>
                    <span className={`payment-status ${PAYOUT_TONE[row.status]}`}>
                      {PAYOUT_LABEL[row.status]}
                    </span>
                  </div>
                  <div className="payment-meta">
                    {formatDateTime(row.createdAt)} · {row.destination.label} · {row.mode}
                    {row.utr && ` · UTR ${row.utr}`}
                    {row.failureReason && ` · ${row.failureReason}`}
                  </div>
                </div>
                <span className="mono payment-ref">{row.reference}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
