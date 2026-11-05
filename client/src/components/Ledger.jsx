import LedgerRow from './LedgerRow.jsx';

/** The ruled table itself: column headings, then rows. */
export default function Ledger({ items, onChanged, emptyAction = null }) {
  if (!items.length) {
    return (
      <div className="ledger">
        <div className="empty">
          <p>Nothing on the ledger yet. Every transfer you make will be written here as a pair of entries.</p>
          {emptyAction}
        </div>
      </div>
    );
  }

  return (
    <div className="ledger">
      <div className="ledger-head">
        <span className="col-date">Date</span>
        <span>Particulars</span>
        <span className="num col-amount">Debit</span>
        <span className="num col-credit">Credit</span>
        <span className="num col-running">Reference</span>
      </div>
      {items.map((txn) => (
        <LedgerRow key={txn.id} txn={txn} onReversed={onChanged} />
      ))}
    </div>
  );
}
