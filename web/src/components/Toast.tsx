import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Toasts.
 *
 * Confirmations used to appear as a banner wherever the card happened to be,
 * which on a long screen is often out of view — you pressed Save and nothing
 * visibly happened. A toast always appears in the same place, so the answer to
 * "did that work?" is always in the same place too.
 *
 * Errors do not auto-dismiss. A success can be missed harmlessly; a refusal is
 * the one thing the user has to read.
 */

export type ToastTone = 'good' | 'error' | 'warn' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

interface ToastApi {
  show: (tone: ToastTone, message: string, detail?: string) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  warn: (message: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      const id = nextId++;
      setToasts((current) => [...current.slice(-3), { id, tone, message, detail }]);
      if (tone !== 'error') {
        setTimeout(() => dismiss(id), tone === 'warn' ? 7000 : 4200);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m, d) => show('good', m, d),
      error: (m, d) => show('error', m, d),
      warn: (m, d) => show('warn', m, d),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <span className="toast-mark" aria-hidden="true" />
            <div className="toast-body">
              <strong>{toast.message}</strong>
              {toast.detail && <div className="toast-detail">{toast.detail}</div>}
            </div>
            <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside a ToastProvider');
  return ctx;
}
