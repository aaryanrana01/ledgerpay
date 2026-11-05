import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onSessionExpired, setAccessToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [balanceMinor, setBalanceMinor] = useState(0);
  const [currency, setCurrency] = useState('INR');
  const [booting, setBooting] = useState(true);

  // On a hard refresh the access token is gone (it only lived in memory), but
  // the httpOnly refresh cookie survives — so we trade it for a new session
  // before deciding whether to show the sign-in screen.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await api.restore();
        const me = await api.me();
        if (cancelled) return;
        setUser(me.user);
        setBalanceMinor(me.balanceMinor);
        setCurrency(me.currency);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onSessionExpired(() => {
      setUser(null);
      setAccessToken(null);
    });
  }, []);

  const adopt = useCallback((data) => {
    setAccessToken(data.accessToken);
    setUser(data.user);
    if (typeof data.balanceMinor === 'number') setBalanceMinor(data.balanceMinor);
    if (data.currency) setCurrency(data.currency);
  }, []);

  const signIn = useCallback(async (credentials) => adopt(await api.login(credentials)), [adopt]);
  const signUp = useCallback(async (details) => adopt(await api.register(details)), [adopt]);

  const signOut = useCallback(async () => {
    // We tell the server to revoke the refresh token, but if that call fails
    // (offline, server restarting, token already revoked by "sign out
    // everywhere") we still clear the local session. Leaving the user looking
    // signed in after they pressed Sign out would be worse than a silent
    // server-side failure.
    try {
      await api.logout();
    } catch {
      // ignore - clearing local state below is what actually matters here
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  const refreshBalance = useCallback(async () => {
    const wallet = await api.wallet();
    setBalanceMinor(wallet.balanceMinor);
    setCurrency(wallet.currency);
    return wallet;
  }, []);

  const value = useMemo(
    () => ({ user, balanceMinor, currency, booting, signIn, signUp, signOut, refreshBalance, setBalanceMinor }),
    [user, balanceMinor, currency, booting, signIn, signUp, signOut, refreshBalance]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
