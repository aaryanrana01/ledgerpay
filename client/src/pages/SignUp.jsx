import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import AuthPitch from '../components/AuthPitch.jsx';

export default function SignUp() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', walletTag: '', password: '' });
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  function update(key) {
    return (event) => setForm({ ...form, [key]: event.target.value });
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await signUp({ ...form, walletTag: form.walletTag.replace(/^@/, '') });
      navigate('/', { replace: true });
    } catch (err) {
      // The API returns per-field messages for validation failures.
      if (Array.isArray(err.details)) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      }
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <AuthPitch />
      <div className="auth-form">
        <div className="auth-form-inner">
          <span className="eyebrow">Create account</span>
          <h2>Start a ledger</h2>
          <p className="sub">Your wallet tag is how other people send you money without sharing an email address.</p>

          {error && <div className="form-error">{error}</div>}

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="fullName">Full name</label>
              <input id="fullName" value={form.fullName} onChange={update('fullName')} required />
              {fieldErrors.fullName && <span className="error">{fieldErrors.fullName}</span>}
            </div>

            <div className="field">
              <label htmlFor="walletTag">Wallet tag</label>
              <input id="walletTag" className="mono" placeholder="@arjun" value={form.walletTag} onChange={update('walletTag')} required />
              <span className="hint">3–20 letters, numbers or underscores.</span>
              {fieldErrors.walletTag && <span className="error">{fieldErrors.walletTag}</span>}
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" value={form.email} onChange={update('email')} required />
              {fieldErrors.email && <span className="error">{fieldErrors.email}</span>}
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={update('password')}
                required
              />
              <span className="hint">At least 10 characters, with upper case, lower case and a number.</span>
              {fieldErrors.password && <span className="error">{fieldErrors.password}</span>}
            </div>

            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>

          <p className="swap">
            Already have one? <Link to="/sign-in">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
