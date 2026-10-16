// Loading, empty, error, drawers, dialogs and toasts.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './primitives';

export function Skeleton({ className }: { className?: string }) { return <div className={cn('skeleton h-4', className)} />; }
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return <div className={cn('space-y-3 p-5', className)}>{Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-2/3" /></div></div>)}</div>;
}

export function EmptyState({ icon, title, body, action, className }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="relative mb-4">
        <div className="absolute inset-0 -m-3 rounded-full bg-blue/10 blur-xl" />
        <div className="relative flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-blue-bright">{icon}</div>
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {body && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-2">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, retry, className }: { error: unknown; retry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)} role="alert">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-bad/30 bg-bad/10 text-bad"><AlertTriangle className="h-5 w-5" /></div>
      <p className="text-sm font-semibold text-fg">Could not load this</p>
      <p className="mt-1 max-w-sm text-[13px] text-fg-2">{msg}</p>
      {retry && <Button size="sm" className="mt-4" onClick={retry}>Try again</Button>}
    </div>
  );
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
}
export function Drawer({ open, onClose, title, subtitle, children, width = 520, footer }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-[fade-up_150ms_ease-out_both]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className="absolute right-0 top-0 flex h-full max-w-full flex-col border-l border-line bg-bg-2 shadow-pop animate-[fade-up_200ms_ease-out_both]" style={{ width }}>
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0"><h2 className="truncate text-base font-semibold">{title}</h2>{subtitle && <div className="mt-0.5 text-[13px] text-fg-2">{subtitle}</div>}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </aside>
    </div>, document.body);
}
export function Modal({ open, onClose, children, className, label }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; label: string }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={label} className={cn('relative w-full max-w-xl rounded-2xl border border-line bg-bg-2 shadow-pop animate-fade-up', className)}>{children}</div>
    </div>, document.body);
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; tone: 'ok' | 'bad'; text: string };
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, tone, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-line bg-elevated px-3.5 py-3 text-[13px] shadow-pop animate-fade-up">
            {t.tone === 'ok' ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-ok" /> : <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-bad" />}
            <span className="text-fg">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
