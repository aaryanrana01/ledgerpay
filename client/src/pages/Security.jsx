import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDateTime, shortHash } from '../components/format.js';

export default function Security() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState([]);
  const [integrity, setIntegrity] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.sessions(), api.integrity()])
      .then(([sessionData, integrityData]) => {
        setSessions(sessionData.sessions);
        setIntegrity(integrityData);
      })
      .finally(() => setLoading(false));
  }, []);

  async function endEverywhere() {
    await api.logoutEverywhere();
    toast('Signed out of every device.');
    await signOut();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Account</span>
          <h1>Security</h1>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Active sessions</h3>
          <p className="card-sub">
            Each sign-in starts a token family. Refresh tokens rotate on every use — if an old one is ever replayed,
            the whole family is revoked automatically.
          </p>

          {loading ? (
            <div className="loading">Loading</div>
          ) : sessions.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No other active sessions.</p>
          ) : (
            sessions.map((session) => (
              <div className="session-row" key={session.id}>
                <div>
                  <div className="mono" style={{ fontSize: 12 }}>
                    {session.ip || 'unknown ip'}
                  </div>
                  <div className="ua">{session.userAgent || 'unknown device'}</div>
                </div>
                <div style={{ textAlign: 'right', color: 'var(--ink-faint)', fontSize: 12 }}>
                  {formatDateTime(session.createdAt)}
                </div>
              </div>
            ))
          )}

          <button className="btn ghost small" style={{ marginTop: 18 }} onClick={endEverywhere}>
            Sign out everywhere
          </button>
        </div>

        <div className="card">
          <h3>Ledger integrity</h3>
          <p className="card-sub">
            Your entries are re-hashed from the first one forward and compared against what is stored.
          </p>

          {integrity ? (
            <>
              <div className="stat-row">
                <span>Entries checked</span>
                <span className="value">{integrity.checked}</span>
              </div>
              <div className="stat-row">
                <span>Chain state</span>
                <span className={`value ${integrity.valid ? 'credit' : 'debit'}`}>
                  {integrity.valid ? 'intact' : `broken at #${integrity.brokenAtSeq}`}
                </span>
              </div>
              <div className="stat-row">
                <span>Head hash</span>
                <span className="value" title={integrity.headHash}>
                  {shortHash(integrity.headHash)}
                </span>
              </div>
            </>
          ) : (
            <div className="loading">Verifying</div>
          )}

          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 16, marginBottom: 0 }}>
            Signed in as <span className="mono">@{user.walletTag}</span> · {user.email}
          </p>
        </div>
      </div>
    </>
  );
}
