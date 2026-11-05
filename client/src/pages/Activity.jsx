import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Ledger from '../components/Ledger.jsx';
import ChainStrip from '../components/ChainStrip.jsx';

const FILTERS = [
  { label: 'Everything', value: {} },
  { label: 'Money in', value: { direction: 'in' } },
  { label: 'Money out', value: { direction: 'out' } },
  { label: 'Transfers', value: { type: 'TRANSFER' } },
  { label: 'Top-ups', value: { type: 'TOP_UP' } },
  { label: 'Reversals', value: { type: 'REVERSAL' } },
];

export default function Activity() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [filterIndex, setFilterIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [version, setVersion] = useState(0);

  const filter = FILTERS[filterIndex].value;

  // Reset and reload whenever the filter changes.
  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    const page = await api.transactions({ limit: 15, ...filter });
    setItems(page.items);
    setCursor(page.nextCursor);
    setLoading(false);
  }, [filterIndex, version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadFirstPage().catch(() => setLoading(false));
  }, [loadFirstPage]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.transactions({ limit: 15, cursor, ...filter });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Append-only record</span>
          <h1>Ledger</h1>
        </div>
      </div>

      <ChainStrip refreshToken={version} />

      <div className="filters">
        {FILTERS.map((option, index) => (
          <button
            key={option.label}
            className={`chip ${index === filterIndex ? 'on' : ''}`}
            onClick={() => setFilterIndex(index)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Loading ledger</div>
      ) : (
        <>
          <Ledger items={items} onChanged={() => setVersion((v) => v + 1)} />
          {cursor && (
            <div style={{ marginTop: 18, textAlign: 'center' }}>
              <button className="btn ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load older entries'}
              </button>
              {/* Keyset pagination: the cursor encodes (createdAt, _id), so new
                  transactions arriving mid-scroll cannot shift the page. */}
            </div>
          )}
        </>
      )}
    </>
  );
}
