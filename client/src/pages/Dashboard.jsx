import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatMinor, splitMinor } from '../components/format.js';
import Ledger from '../components/Ledger.jsx';
import ChainStrip from '../components/ChainStrip.jsx';
import Sparkline from '../components/Sparkline.jsx';
import MoveMoney from '../components/MoveMoney.jsx';
import AddMoney from '../components/AddMoney.jsx';
import WithdrawMoney from '../components/WithdrawMoney.jsx';

export default function Dashboard() {
  const { user, balanceMinor, refreshBalance } = useAuth();
  const toast = useToast();

  const [wallet, setWallet] = useState(null);
  const [summary, setSummary] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const [walletData, summaryData, history] = await Promise.all([
      refreshBalance(),
      api.summary(),
      api.transactions({ limit: 8 }),
    ]);
    setWallet(walletData);
    setSummary(summaryData);
    setRecent(history.items);
    setLoading(false);
  }, [refreshBalance]);

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, [load, version]);

  function afterMove(result, mode) {
    setModal(null);
    setVersion((v) => v + 1);
    const verb = { send: 'Sent', top: 'Added', out: 'Withdrew' }[mode];
    toast(`${verb} ₹${formatMinor(result.amountMinor)}`, { reference: result.reference });
  }

  function afterDeposit(result) {
    setModal(null);
    setVersion((v) => v + 1);
    toast(
      result.alreadySettled
        ? 'That payment was already credited.'
        : `Added ₹${formatMinor(result.amountMinor)}`,
      { reference: result.transactionRef }
    );
  }

  function afterWithdrawal(result) {
    setModal(null);
    setVersion((v) => v + 1);
    toast(`Withdrawal of ₹${formatMinor(result.amountMinor)} started`, { reference: result.reference });
  }

  const figure = splitMinor(balanceMinor);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Statement of account</span>
          <h1>Good to see you, {user.fullName.split(' ')[0]}</h1>
        </div>
        <Link to="/activity" className="btn ghost small">
          Full ledger
        </Link>
      </div>

      <section className="statement">
        <span className="eyebrow">Balance, derived from {wallet?.entryCount ?? 0} ledger entries</span>
        <div className="balance-figure">
          <span className="currency">₹</span>
          {figure.whole}
          <span className="paise">.{figure.paise}</span>
        </div>

        <div className="statement-actions">
          <button className="btn" onClick={() => setModal('send')}>
            Send money
          </button>
          <button className="btn ghost" onClick={() => setModal('top')}>
            Add money
          </button>
          <button className="btn ghost" onClick={() => setModal('out')}>
            Withdraw
          </button>
        </div>

        <div className="statement-meta">
          <span>
            Wallet tag <b>@{user.walletTag}</b>
          </span>
          <span>
            Daily send limit <b>₹{formatMinor(wallet?.limits?.dailyLimitMinor ?? 0)}</b>
          </span>
          <span>
            Per-transfer cap <b>₹{formatMinor(wallet?.limits?.maxTransferMinor ?? 0)}</b>
          </span>
        </div>
      </section>

      <ChainStrip refreshToken={version} />

      <div className="grid-2">
        <div className="card">
          <h3>Recent entries</h3>
          <p className="card-sub">Open any row to see the debit and credit the server actually wrote.</p>
          {loading ? (
            <div className="loading">Loading</div>
          ) : (
            <Ledger
              items={recent}
              onChanged={() => setVersion((v) => v + 1)}
              emptyAction={
                <button className="btn small" onClick={() => setModal('top')}>
                  Add money to start
                </button>
              }
            />
          )}
        </div>

        <div className="card">
          <h3>Last 14 days</h3>
          <p className="card-sub">Money in and out, by day.</p>
          {summary ? <Sparkline series={summary.dailySeries} /> : <div className="loading">Loading</div>}

          <div style={{ marginTop: 20 }}>
            <div className="stat-row">
              <span>Received · 30 days</span>
              <span className="value credit">₹{formatMinor(summary?.receivedMinor ?? 0)}</span>
            </div>
            <div className="stat-row">
              <span>Sent · 30 days</span>
              <span className="value debit">₹{formatMinor(summary?.sentMinor ?? 0)}</span>
            </div>
            <div className="stat-row">
              <span>Transactions</span>
              <span className="value">{summary?.transactionCount ?? 0}</span>
            </div>
            <div className="stat-row">
              <span>Net</span>
              <span className="value">
                ₹{formatMinor((summary?.receivedMinor ?? 0) - (summary?.sentMinor ?? 0), { sign: true })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {modal === 'send' && (
        <MoveMoney mode="send" balanceMinor={balanceMinor} onClose={() => setModal(null)} onDone={afterMove} />
      )}
      {modal === 'top' && <AddMoney onClose={() => setModal(null)} onDone={afterDeposit} />}
      {modal === 'out' && (
        <WithdrawMoney balanceMinor={balanceMinor} onClose={() => setModal(null)} onDone={afterWithdrawal} />
      )}
    </>
  );
}
