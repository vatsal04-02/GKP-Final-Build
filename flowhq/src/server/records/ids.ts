import { BackendError } from '../grist';
// A tiny in-process mutex: id generation and "check, then write" steps for one workspace never interleave.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { const r = this.tail.then(fn, fn); this.tail = r.catch(() => undefined); return r; }
}
export const pad = (n: number, w = 6) => String(n).padStart(w, '0');
// highest numeric suffix among ids that start with `prefix` (e.g. "GK-P-" or "GK-2026-")
export function maxSeq(ids: Iterable<unknown>, prefix: string): number {
  let m = 0;
  for (const v of ids) { const s = String(v ?? ''); if (s.startsWith(prefix)) { const n = Number(s.slice(prefix.length)); if (Number.isInteger(n) && n > m) m = n; } }
  return m;
}
export const bad = (code: string, message: string, status = 400, extra?: Record<string, unknown>) => new BackendError(status, code, message, extra);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const dateIn = (s: string | null | undefined): number | null => (s && validDate(s) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 1000 : null);
export const dateOut = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString().slice(0, 10) : null);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const mondayOf = (d: string) => { const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; return addDays(d, -wd); };
