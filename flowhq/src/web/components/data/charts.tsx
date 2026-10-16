// Charts in FLOW HQ blue. Hand-made SVG: crisp at any width, theme-aware through CSS variables, no chart library.
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
const niceMax = (v: number) => { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

export interface ChartSeries { key: string; label: string; tone: 'blue' | 'soft' | 'muted' | 'amber'; values: number[]; area?: boolean }
const STROKE = { blue: 'rgb(var(--blue-bright))', soft: 'rgb(var(--blue-soft))', muted: 'rgb(var(--muted))', amber: 'rgb(var(--warn))' };

export function AreaChart({ labels, series, height = 220, format = (n: number) => String(n) }: { labels: string[]; series: ChartSeries[]; height?: number; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const W = width; const H = height;
  const n = labels.length;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={W} height={H} role="img" aria-label={series.map((s) => s.label).join(', ')} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = e.clientX - r.left; const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1)); setHover(Math.max(0, Math.min(n - 1, i))); }}>
        <defs>
          <linearGradient id="fhq-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="rgb(var(--blue))" stopOpacity="0.32" /><stop offset="1" stopColor="rgb(var(--blue))" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((t) => (<g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="rgb(var(--line))" strokeDasharray={t ? '3 4' : undefined} /><text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted text-[10.5px]">{format(t)}</text></g>))}
        {labels.map((l, i) => (i % every === 0 || i === n - 1) && <text key={l + i} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted text-[10.5px]">{l}</text>)}
        {series.map((s) => s.area && <path key={`${s.key}-a`} d={`${path(s.values)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#fhq-area)" />)}
        {series.map((s) => <path key={s.key} d={path(s.values)} fill="none" stroke={STROKE[s.tone]} strokeWidth={s.area ? 2 : 1.5} strokeDasharray={s.tone === 'muted' ? '4 4' : undefined} strokeLinejoin="round" strokeLinecap="round" className="transition-all duration-300" />)}
        {hover !== null && (<g><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgb(var(--line-2))" />{series.map((s) => <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={3.5} fill="rgb(var(--bg))" stroke={STROKE[s.tone]} strokeWidth={2} />)}</g>)}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-lg border border-line bg-elevated px-3 py-2 text-xs shadow-pop" style={{ left: Math.min(Math.max(0, x(hover) + 12), W - 170) }}>
          <div className="mb-1 font-medium text-fg">{labels[hover]}</div>
          {series.map((s) => <div key={s.key} className="flex items-center gap-2 text-fg-2"><span className="h-2 w-2 rounded-full" style={{ background: STROKE[s.tone] }} /><span className="flex-1">{s.label}</span><span className="num font-medium text-fg">{format(s.values[hover])}</span></div>)}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values); const W = 96; const H = 28;
  const pts = values.map((v, i) => `${((i * W) / (values.length - 1)).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} className={cn('overflow-visible', className)} aria-hidden="true">
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill="rgb(var(--blue) / 0.12)" stroke="none" />
      <polyline points={pts} fill="none" stroke="rgb(var(--blue-bright))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function BarList({ items, format = (n: number) => String(n), empty }: { items: Array<{ label: string; value: number; hint?: string }>; format?: (n: number) => string; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length || items.every((i) => !i.value)) return <p className="py-4 text-[13px] text-muted">{empty || 'No data yet'}</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((it, k) => (
        <li key={it.label + k}>
          <div className="mb-1 flex items-center justify-between gap-3 text-[13px]"><span className="truncate text-fg-2">{it.label}</span><span className="num font-medium text-fg">{format(it.value)}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${(it.value / max) * 100}%`, background: `linear-gradient(90deg, rgb(var(--blue)), rgb(var(--blue-bright)))`, opacity: 1 - Math.min(0.55, k * 0.09) }} /></div>
        </li>
      ))}
    </ul>
  );
}
