import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import SignIn from './pages/SignIn.jsx';
import SignUp from './pages/SignUp.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Activity from './pages/Activity.jsx';
import Security from './pages/Security.jsx';
import Payments from './pages/Payments.jsx';

function Rail() {
  const { user, signOut } = useAuth();

  return (
    <aside className="rail">
      <span className="mark">LedgerPay</span>

      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Statement
        </NavLink>
        <NavLink to="/activity" className={({ isActive }) => (isActive ? 'active' : '')}>
          Ledger
        </NavLink>
        <NavLink to="/payments" className={({ isActive }) => (isActive ? 'active' : '')}>
          Payments
        </NavLink>
        <NavLink to="/security" className={({ isActive }) => (isActive ? 'active' : '')}>
          Security
        </NavLink>
      </nav>

      <div className="whoami">
        <div className="tag">@{user.walletTag}</div>
        <div className="name">{user.fullName}</div>
        <button className="btn ghost small" onClick={signOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

function RequireAuth({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();

  // Wait for the silent refresh to finish before deciding — otherwise a page
  // reload would bounce a signed-in user to the sign-in screen for a moment.
  if (booting) return <div className="loading">Restoring session</div>;
  if (!user) return <Navigate to="/sign-in" state={{ from: location }} replace />;
  return children;
}

function RedirectIfSignedIn({ children }) {
  const { user, booting } = useAuth();
  if (booting) return <div className="loading">Loading</div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route
          path="/sign-in"
          element={
            <RedirectIfSignedIn>
              <SignIn />
            </RedirectIfSignedIn>
          }
        />
        <Route
          path="/sign-up"
          element={
            <RedirectIfSignedIn>
              <SignUp />
            </RedirectIfSignedIn>
          }
        />

        <Route
          path="*"
          element={
            <RequireAuth>
              <div className="shell">
                <Rail />
                <main className="canvas">
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/activity" element={<Activity />} />
                    <Route path="/payments" element={<Payments />} />
                    <Route path="/security" element={<Security />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </main>
              </div>
            </RequireAuth>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
