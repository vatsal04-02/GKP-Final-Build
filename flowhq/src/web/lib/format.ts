// Dates, numbers and money in the workspace's locale and time zone.
export interface Fmt { locale: string; timezone: string; currency: string | null }
const cache = new Map<string, Intl.DateTimeFormat>();
const dtf = (f: Fmt, o: Intl.DateTimeFormatOptions) => {
  const k = `${f.locale}|${f.timezone}|${JSON.stringify(o)}`;
  let x = cache.get(k);
  if (!x) { x = new Intl.DateTimeFormat(f.locale, { timeZone: f.timezone, ...o }); cache.set(k, x); }
  return x;
};
export const time = (f: Fmt, iso: string | null) => (iso ? dtf(f, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '—');
export const date = (f: Fmt, iso: string | null) => (iso ? dtf(f, { day: 'numeric', month: 'short' }).format(new Date(iso)) : '—');
export const dateTime = (f: Fmt, iso: string | null) => (iso ? `${date(f, iso)}, ${time(f, iso)}` : '—');
export const weekday = (f: Fmt, iso: string) => dtf(f, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const dayKey = (f: Fmt, iso: string) => dtf(f, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const a = Math.abs(s);
  const r = (n: number, u: string) => (s < 0 ? `${n}${u} ago` : `in ${n}${u}`);
  if (a < 45) return s < 0 ? 'just now' : 'in a moment';
  if (a < 3600) return r(Math.round(a / 60), 'm');
  if (a < 86400) return r(Math.round(a / 3600), 'h');
  if (a < 86400 * 30) return r(Math.round(a / 86400), 'd');
  return r(Math.round(a / (86400 * 30)), 'mo');
}
export const number = (f: Fmt, n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '—' : n.toLocaleString(f.locale, { maximumFractionDigits: digits }));
export const percent = (f: Fmt, n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toLocaleString(f.locale, { maximumFractionDigits: 1 })}%`);
export const money = (f: Fmt, n: number | null | undefined) => (n === null || n === undefined ? '—' : f.currency ? n.toLocaleString(f.locale, { style: 'currency', currency: f.currency, maximumFractionDigits: 0 }) : n.toLocaleString(f.locale));
export const initials = (name: string | null | undefined) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
