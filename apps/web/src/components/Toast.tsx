import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

type Tone = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

type Notify = (message: string, tone?: Tone) => void;
const ToastContext = createContext<Notify>(() => {});

export function useToast(): Notify {
  return useContext(ToastContext);
}

const LIFETIME_MS: Record<Tone, number> = { info: 3_500, success: 3_500, error: 7_000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const notify = useCallback<Notify>(
    (message, tone = 'info') => {
      const id = nextId.current++;
      setItems((all) => [...all.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS[tone]);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'warn' : t.tone === 'success' ? 'check' : 'dot'} />
            <span>{t.message}</span>
            <button type="button" className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
