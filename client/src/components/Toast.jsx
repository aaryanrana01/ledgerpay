import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, { tone = 'good', reference = null, ttl = 4200 } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, message, tone, reference }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), ttl);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === 'bad' ? 'bad' : ''}`}>
            {toast.message}
            {toast.reference && <span className="ref">{toast.reference}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context.push;
}
