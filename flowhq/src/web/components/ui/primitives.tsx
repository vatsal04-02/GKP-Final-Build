// UI primitives. No business words in here: every label is passed in by the caller.
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...p }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'btn-primary text-white shadow-[0_6px_16px_-8px_rgb(var(--accent)/0.7)] hover:brightness-110 active:brightness-95',
        variant === 'secondary' && 'border border-line bg-surface-2 text-fg hover:border-line-2 hover:bg-elevated',
        variant === 'ghost' && 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        variant === 'subtle' && 'bg-blue/10 text-blue-soft hover:bg-blue/15',
        variant === 'danger' && 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/15',
        className,
      )}
      {...p}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export function Card({ className, children, hover, ...p }: { className?: string; children: ReactNode; hover?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', hover && 'card-hover', className)} {...p}>{children}</div>;
}
export function CardHeader({ title, subtitle, action, icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="text-blue-bright">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
          {subtitle && <p className="mt-0.5 truncate text-xs text-fg-2">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export type Tone = 'neutral' | 'blue' | 'amber' | 'red' | 'green';
const TONES: Record<Tone, string> = {
  neutral: 'border-line bg-surface-2 text-fg-2',
  blue: 'border-blue/30 bg-blue/10 text-blue-soft',
  amber: 'border-warn/30 bg-warn/10 text-warn',
  red: 'border-bad/30 bg-bad/10 text-bad',
  green: 'border-ok/30 bg-ok/10 text-ok',
};
export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return <span className={cn('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11.5px] font-medium', TONES[tone], className)}>{icon}{children}</span>;
}
export function StatusDot({ tone = 'blue', pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  const c = { neutral: 'bg-muted', blue: 'bg-blue-bright', amber: 'bg-warn', red: 'bg-bad', green: 'bg-ok' }[tone];
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'animate-pulse-dot', tone === 'blue' && 'shadow-[0_0_8px_rgb(var(--blue-bright)/0.8)]', className)} />;
}

const field = 'h-9 w-full rounded-lg border border-line-2 bg-field px-3 text-sm text-fg placeholder:text-muted transition-colors focus:border-blue/60 focus:outline-none focus:ring-2 focus:ring-blue/20 disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(({ className, icon, ...p }, ref) =>
  icon ? (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{icon}</span>
      <input ref={ref} className={cn(field, 'pl-9', className)} {...p} />
    </div>
  ) : <input ref={ref} className={cn(field, className)} {...p} />);
Input.displayName = 'Input';
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, 'h-auto min-h-[80px] py-2 leading-relaxed', className)} {...p} />);
Textarea.displayName = 'Textarea';
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, 'cursor-pointer appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23667085' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} {...p}>{children}</select>;
}
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50', checked ? 'border-blue/60 bg-blue glow-blue' : 'border-line-2 bg-surface-2')}>
      <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
    </button>
  );
}
export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; count?: number }>; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-bg-2 p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all duration-150', size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]', value === o.value ? 'bg-elevated text-fg shadow-[0_0_0_1px_rgb(var(--line-2))]' : 'text-fg-2 hover:text-fg')}>
          {o.label}
          {o.count !== undefined && <span className={cn('num rounded px-1 text-[11px]', value === o.value ? 'bg-blue/15 text-blue-soft' : 'text-muted')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[10.5px] text-fg-2">{children}</kbd>;
}
export function Avatar({ text, size = 32, tone = 'neutral', src }: { text: string; size?: number; tone?: 'neutral' | 'blue'; src?: string | null }) {
  if (src) return <img src={src} alt="" className="shrink-0 rounded-lg object-cover" style={{ width: size, height: size }} />;
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-lg font-semibold', tone === 'blue' ? 'bg-gradient-to-br from-blue-bright to-blue text-white' : 'border border-line bg-surface-2 text-fg-2')}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}>{text}</span>
  );
}
export function Progress({ value, tone = 'blue', className }: { value: number; tone?: Tone; className?: string }) {
  const c = { neutral: 'bg-muted', blue: 'bg-gradient-to-r from-blue to-blue-bright', amber: 'bg-warn', red: 'bg-bad', green: 'bg-ok' }[tone];
  return <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}><div className={cn('h-full rounded-full transition-[width] duration-500', c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

// Numbers that glide to their new value (150-600 ms), respecting reduced motion.
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from.current === value) { setShown(value); from.current = value; return; }
    const start = performance.now(); const a = from.current; const dur = 550;
    let raf = 0;
    const step = (t: number) => { const k = Math.min(1, (t - start) / dur); const e = 1 - Math.pow(1 - k, 3); setShown(a + (value - a) * e); if (k < 1) raf = requestAnimationFrame(step); else from.current = value; };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(Math.abs(value - shown) < 0.05 ? value : shown)}</>;
}
