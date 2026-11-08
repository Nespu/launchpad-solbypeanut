'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { WireToastInput, WireToastTone } from './toastEvents';

type ActiveToast = WireToastInput & { id: number };

const TONE_STYLES: Record<WireToastTone, { border: string; icon: string }> = {
  error: { border: 'border-[var(--danger)]/45', icon: 'text-[var(--danger)]' },
  success: { border: 'border-[var(--success)]/45', icon: 'text-[var(--success)]' },
  info: { border: 'border-[var(--wire-violet)]/50', icon: 'text-[var(--wire-violet)]' },
};

export default function ToastViewport() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    const dismiss = (id: number) => {
      const timer = timers.current.get(id);
      if (timer) window.clearTimeout(timer);
      timers.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    };

    const handleToast = (event: Event) => {
      const detail = (event as CustomEvent<WireToastInput>).detail;
      if (!detail?.title || !detail.message) return;
      const id = ++sequence.current;
      const toast: ActiveToast = { ...detail, id };
      setToasts((current) => [...current.slice(-2), toast]);
      const timer = window.setTimeout(() => dismiss(id), detail.duration ?? 8000);
      timers.current.set(id, timer);
    };

    window.addEventListener('wire:toast', handleToast);
    return () => {
      window.removeEventListener('wire:toast', handleToast);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-3 sm:right-6 sm:top-6" aria-label="Notificaciones">
      {toasts.map((toast) => {
        const tone = toast.tone ?? 'error';
        const Icon = tone === 'error' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info;
        return (
          <section
            key={toast.id}
            role={tone === 'error' ? 'alert' : 'status'}
            aria-live={tone === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            className={`wire-toast pointer-events-auto rounded-xl border ${TONE_STYLES[tone].border} bg-[var(--surface)] p-4 shadow-[0_16px_52px_rgba(0,0,0,0.55)]`}
          >
            <div className="flex items-start gap-3">
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${TONE_STYLES[tone].icon}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 className="pr-2 text-sm font-semibold text-[var(--text)]">{toast.title}</h2>
                <p className="mt-1 break-words text-sm leading-relaxed text-[var(--muted)]">{toast.message}</p>
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => { toast.action?.onClick(); dismiss(toast.id); }}
                    className="wire-button wire-button-secondary mt-3 min-h-11 px-3 py-2 text-xs"
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="wire-button wire-button-quiet -mr-2 -mt-2 h-10 w-10 shrink-0 p-0"
                aria-label={`Cerrar notificación: ${toast.title}`}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
