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
        // Flat, square-ish buttons: colour changes on hover and press, nothing lifts, glows or scales.
        'press inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-sans font-semibold transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-[13.5px]',
        variant === 'primary' && 'btn-primary text-white hover:bg-accent-strong/90 active:bg-accent-strong/80',
        variant === 'secondary' && 'border border-line-2 bg-surface text-fg hover:bg-surface-2 active:bg-bg-2',
        variant === 'ghost' && 'font-medium text-fg-2 hover:bg-bg-2/60 hover:text-fg active:bg-bg-2',
        variant === 'subtle' && 'bg-sage/70 text-blue-bright hover:bg-sage active:bg-sage',
        variant === 'danger' && 'border border-bad/50 bg-surface text-bad hover:bg-bad/10 active:bg-bad/15',
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

// The one "add" action of a list page: a round plus button in the title row on a phone, a labelled button from tablet up.
export const AddButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }>(({ label, icon, className, ...p }, ref) => (
  <Button ref={ref} variant="primary" icon={icon} aria-label={label} className={cn('max-md:h-11 max-md:w-11 max-md:rounded-full max-md:!px-0', className)} {...p}><span className="max-md:sr-only">{label}</span></Button>
));
AddButton.displayName = 'AddButton';

export function Card({ className, children, hover, ...p }: { className?: string; children: ReactNode; hover?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', hover && 'card-hover', className)} {...p}>{children}</div>;
}
export function CardHeader({ title, subtitle, action, icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="text-fg-2">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-fg">{title}</h3>
          {subtitle && <p className="mt-0.5 truncate text-[12.5px] text-fg-2">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export type Tone = 'neutral' | 'blue' | 'amber' | 'red' | 'green';
const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-2 text-fg-2',
  blue: 'bg-sage text-blue-bright',
  amber: 'bg-warn/15 text-warn',
  red: 'bg-bad/10 text-bad',
  green: 'bg-ok/15 text-ok',
};
// A quiet tag: a soft fill and no outline, so a row of them reads as text with emphasis rather than a row of stickers.
export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return <span className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[12px] font-medium', TONES[tone], className)}>{icon}{children}</span>;
}
export function StatusDot({ tone = 'blue', pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  const c = { neutral: 'bg-muted', blue: 'bg-blue-bright', amber: 'bg-warn', red: 'bg-bad', green: 'bg-ok' }[tone];
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'animate-pulse-dot', className)} />;
}

const field = 'h-9 w-full rounded-lg border border-line-2 bg-field px-3 text-[13.5px] text-fg placeholder:text-muted transition-colors hover:border-fg-2/40 focus:border-blue focus:outline-none focus:ring-2 focus:ring-blue/15 disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(({ className, icon, ...p }, ref) =>
  icon ? (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{icon}</span>
      <input ref={ref} className={cn(field, 'pl-9 max-md:rounded-xl max-md:border-transparent max-md:bg-bg-2/55 max-md:focus:bg-surface', className)} {...p} />
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
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[""] disabled:cursor-not-allowed disabled:opacity-50', checked ? 'border-blue bg-blue' : 'border-line-2 bg-bg-2')}>
      <span className={cn('inline-block h-[18px] w-[18px] rounded-full transition-transform duration-150 ease-out', checked ? 'translate-x-[22px] bg-white' : 'translate-x-[3px] bg-fg-2')} />
    </button>
  );
}
// `pill` is a compact choice group (filters, view switches); `tabs` is an underlined row for the page's main sections.
export function Segmented<T extends string>({ value, onChange, options, size = 'md', variant = 'pill', fill }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; count?: number }>; size?: 'sm' | 'md'; variant?: 'pill' | 'tabs'; fill?: boolean }) {
  if (variant === 'tabs') {
    return (
      <div className="flex max-w-full gap-1 overflow-x-auto border-b border-line" role="tablist">
        {options.map((o) => (
          <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
            className={cn('-mb-px inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13.5px] font-semibold transition-colors duration-150', value === o.value ? 'border-accent-strong text-fg' : 'border-transparent font-medium text-fg-2 hover:text-fg')}>
            {o.label}
            {o.count !== undefined && <span className="num text-[12px] font-medium text-muted">{o.count}</span>}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className={cn('max-w-full overflow-x-auto rounded-[10px] bg-bg-2/55 p-0.5', fill ? 'flex w-full md:inline-flex md:w-auto' : 'inline-flex')} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] font-medium transition-[background-color,color,box-shadow] duration-200', fill && 'max-md:flex-1', size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]', value === o.value ? 'bg-surface font-semibold text-fg shadow-[0_1px_3px_rgb(38_52_49/0.2),0_0_0_0.5px_rgb(38_52_49/0.06)]' : 'text-fg-2 hover:text-fg')}>
          {o.label}
          {o.count !== undefined && <span className="num px-0.5 text-[12px] text-muted">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[11.5px] text-fg-2">{children}</kbd>;
}
export function Avatar({ text, size = 32, tone = 'neutral', src }: { text: string; size?: number; tone?: 'neutral' | 'blue'; src?: string | null }) {
  if (src) return <img src={src} alt="" className="shrink-0 rounded-lg object-cover" style={{ width: size, height: size }} />;
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-lg font-semibold', tone === 'blue' ? 'bg-blue text-white' : 'bg-bg-2 text-fg-2')}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}>{text}</span>
  );
}
export function Progress({ value, tone = 'blue', className }: { value: number; tone?: Tone; className?: string }) {
  const c = { neutral: 'bg-muted', blue: 'bg-blue', amber: 'bg-warn', red: 'bg-bad', green: 'bg-ok' }[tone];
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
