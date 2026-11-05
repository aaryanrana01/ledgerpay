import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { shortHash } from './format.js';

/**
 * Runs the server's hash-chain verification and reports the result.
 *
 * This is the interface admitting it can be audited: the ledger is append-only
 * and every entry commits to the one before it, so if a row were edited in the
 * database this strip would name the exact sequence number where the chain
 * stops adding up.
 */
export default function ChainStrip({ refreshToken = 0 }) {
  const [state, setState] = useState({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'checking' });

    api
      .integrity()
      .then((result) => !cancelled && setState({ status: result.valid ? 'ok' : 'bad', result }))
      .catch(() => !cancelled && setState({ status: 'bad', result: null }));

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const { status, result } = state;

  return (
    <div className={`chain ${status}`}>
      <span className="dot" aria-hidden="true" />
      {status === 'checking' && <span>Recomputing the hash chain…</span>}

      {status === 'ok' && (
        <span>
          Chain verified through entry <b className="mono">#{result.checked}</b> — every entry hashes the one before it,
          and the running balance matches the ledger.
        </span>
      )}

      {status === 'bad' && (
        <span className="debit">
          {result
            ? `Chain verification failed at entry #${result.brokenAtSeq ?? '—'} (${result.reason}).`
            : 'Chain verification could not run.'}
        </span>
      )}

      {status === 'ok' && result.headHash && (
        <span className="head-hash" title={result.headHash}>
          head {shortHash(result.headHash)}
        </span>
      )}
    </div>
  );
}
