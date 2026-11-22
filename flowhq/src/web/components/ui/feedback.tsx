// Loading, empty, error, drawers, dialogs, bottom sheets and toasts.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
        <div className="fhq-float relative flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-blue-bright">{icon}</div>
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

// Swipe a bottom sheet down to dismiss it. The handlers go on the grab handle and header only, so the sheet's own content still scrolls.
function useSheetDrag(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const y0 = useRef<number | null>(null);
  const dy = useRef(0);
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => { y0.current = e.touches[0]!.clientY; dy.current = 0; if (ref.current) ref.current.style.transition = 'none'; },
    onTouchMove: (e: React.TouchEvent) => { if (y0.current === null || !ref.current) return; dy.current = Math.max(0, e.touches[0]!.clientY - y0.current); ref.current.style.transform = `translateY(${dy.current}px)`; },
    onTouchEnd: () => {
      if (y0.current === null || !ref.current) return;
      y0.current = null;
      ref.current.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1)';
      if (dy.current > 100) onClose(); else ref.current.style.transform = '';
    },
  };
  return { ref, handlers };
}
const Grabber = () => <div aria-hidden="true" className="mx-auto mb-1 mt-2 h-1 w-10 shrink-0 rounded-full bg-line-2 sm:hidden" />;

// While a sheet is open the page behind it does not scroll.
function useScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const main = document.querySelector('main') as HTMLElement | null;
    const prev = main?.style.overflow;
    if (main) main.style.overflow = 'hidden';
    return () => { if (main) main.style.overflow = prev || ''; };
  }, [open]);
}

// Wide screens: a panel from the right. Phones: a bottom sheet that fills most of the screen and swipes down to close.
export function Drawer({ open, onClose, title, subtitle, children, width = 520, footer }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEscape(open, onClose);
  useScrollLock(open);
  const drag = useSheetDrag(onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="fhq-fade absolute inset-0 bg-black/50" onClick={onClose} />
      <aside ref={drag.ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className="fhq-drawer absolute bottom-0 right-0 flex h-[92dvh] w-full max-w-full flex-col rounded-t-2xl border-t border-line bg-bg shadow-pop sm:bg-bg-2 sm:top-0 sm:h-full sm:w-[var(--w)] sm:rounded-none sm:border-l sm:border-t-0"
        style={{ ['--w' as string]: `${width}px` }}>
        <div {...drag.handlers}>
          <Grabber />
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5 sm:py-4">
            <div className="min-w-0"><h2 className="truncate text-base font-semibold">{title}</h2>{subtitle && <div className="mt-0.5 text-[13px] text-fg-2">{subtitle}</div>}</div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
          </header>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && <footer className="border-t border-line bg-bg-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">{footer}</footer>}
      </aside>
    </div>, document.body);
}

// A dialog on a wide screen; on a phone it rises from the bottom as a sheet (or, with `full`, fills the screen: used by search).
export function Modal({ open, onClose, children, className, label, full }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; label: string; full?: boolean }) {
  useEscape(open, onClose);
  useScrollLock(open);
  const drag = useSheetDrag(onClose);
  if (!open) return null;
  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex justify-center sm:items-start sm:p-4 sm:pt-[12vh]', full ? 'items-stretch' : 'items-end')}>
      <div className="fhq-fade absolute inset-0 bg-black/60 sm:backdrop-blur-sm" onClick={onClose} />
      <div ref={drag.ref} role="dialog" aria-modal="true" aria-label={label}
        className={cn('fhq-modal relative w-full max-w-xl bg-bg shadow-pop sm:bg-bg-2 max-sm:!w-full max-sm:!max-w-none sm:rounded-2xl sm:border sm:border-line',
          full ? 'flex flex-col max-sm:h-[100dvh]' : 'max-sm:max-h-[92dvh] max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:rounded-t-2xl max-sm:pb-[env(safe-area-inset-bottom)]', className)}>
        {!full && <div {...drag.handlers} className="sm:hidden"><Grabber /></div>}
        {children}
      </div>
    </div>, document.body);
}

// A bottom sheet for phones: a title, a close button, scrolling content and an optional pinned footer. Swipe down to close.
export function Sheet({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEscape(open, onClose);
  useScrollLock(open);
  const drag = useSheetDrag(onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="fhq-fade absolute inset-0 bg-black/50" onClick={onClose} />
      <div ref={drag.ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className="fhq-sheet-up relative flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-2xl bg-bg shadow-pop">
        <div {...drag.handlers}>
          <div aria-hidden="true" className="mx-auto mb-1 mt-2 h-1 w-10 rounded-full bg-line-2" />
          <header className="flex items-start justify-between gap-3 px-4 pb-2 pt-1">
            <div className="min-w-0"><h2 className="truncate font-display text-[17px] font-semibold">{title}</h2>{subtitle && <div className="mt-0.5 truncate text-[13px] text-fg-2">{subtitle}</div>}</div>
            <button type="button" onClick={onClose} aria-label="Close" className="press -mr-2 flex h-10 w-10 items-center justify-center rounded-full text-fg-2 hover:bg-surface"><X className="h-5 w-5" /></button>
          </header>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        {footer ? <footer className="border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer> : <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" />}
      </div>
    </div>, document.body);
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; tone: 'ok' | 'bad'; text: string; leaving?: boolean };
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, tone, text }]);
    setTimeout(() => setList((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 3900);   // slide out first, then remove
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* On a phone the toast sits just above the tab bar and spans the width; on a wide screen it is a small card at the corner. */}
      <div className="pointer-events-none fixed inset-x-4 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+12px)] z-[60] flex flex-col gap-2 sm:left-auto sm:right-4 lg:bottom-4" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-line bg-elevated px-3.5 py-3 text-[13px] shadow-pop sm:w-auto sm:max-w-sm', t.leaving ? 'fhq-toast-out' : 'fhq-toast-in')}>
            {t.tone === 'ok' ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-ok" /> : <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-bad" />}
            <span className="text-fg">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
