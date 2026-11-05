/**
 * The left panel of the auth screens.
 *
 * Rather than a feature list, it prints a fragment of an actual ledger — the
 * same debit/credit shape the app uses everywhere — so the first thing a
 * visitor sees is the idea the product is built on.
 */
export default function AuthPitch() {
  return (
    <aside className="auth-pitch">
      <span className="mark">LedgerPay</span>

      <div>
        <h1>A wallet that shows its books.</h1>
        <p>
          Every rupee that moves is written as two entries — a debit and a matching credit — into an append-only
          ledger. Balances are derived from those entries, and each one is hashed against the entry before it, so a
          quiet edit in the database does not stay quiet.
        </p>

        <div className="pitch-ledger" aria-hidden="true">
          <div>
            <span>@arjun · wallet</span>
            <span className="dr">DR 250.50</span>
            <span>#482</span>
          </div>
          <div>
            <span>@priya · wallet</span>
            <span className="cr">CR 250.50</span>
            <span>#119</span>
          </div>
          <div>
            <span>balance check</span>
            <span>0.00</span>
            <span>✓</span>
          </div>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12.5 }}>
        React · Node.js · Express · MongoDB · JWT
      </p>
    </aside>
  );
}
