import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import AuthPitch from '../components/AuthPitch.jsx';

export default function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(form);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <AuthPitch />
      <div className="auth-form">
        <div className="auth-form-inner">
          <span className="eyebrow">Sign in</span>
          <h2>Open your ledger</h2>
          <p className="sub">Balances are derived from entries, not stored as a number someone can edit.</p>

          {error && <div className="form-error">{error}</div>}

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="swap">
            No account yet? <Link to="/sign-up">Create one</Link>
          </p>

          <div className="demo-hint">
            Seeded the database? Sign in with <code>arjun@ledgerpay.dev</code> and <code>DemoPassw0rd</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
