// Time-zone helpers (workspace time zone, no library): local day keys, local midnight, and the next run of a schedule.
const DTF = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = DTF.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); DTF.set(tz, f); }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd };
}
export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
export function dayKey(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
export function startOfDay(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const guess = Date.UTC(p.y, p.mo - 1, p.d) - tzOffsetMs(ms, tz);
  return guess - (tzOffsetMs(guess, tz) - tzOffsetMs(ms, tz));
}
export function localParts(ms: number, tz: string) { return parts(ms, tz); }

export type Schedule =
  | { kind: 'every'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };   // 0 = Sunday

// The next time a schedule fires after `now` (the n8n instance runs in the workspace time zone).
export function nextRun(s: Schedule, now: number, tz: string): number {
  const MIN = 60000;
  if (s.kind === 'every') { const step = s.minutes * MIN; const local = now + tzOffsetMs(now, tz); return Math.floor(local / step) * step + step - tzOffsetMs(now, tz); }
  const p = parts(now, tz);
  const day0 = startOfDay(now, tz);
  if (s.kind === 'hourly') {
    let t = day0 + p.h * 60 * MIN + s.minute * MIN;
    if (t <= now) t += 60 * MIN;
    return t;
  }
  const at = (dayStart: number) => dayStart + (s.hour * 60 + s.minute) * MIN;
  for (let i = 0; i < 8; i++) {
    const ds = startOfDay(day0 + i * 86400000 + 3600000, tz);
    const wd = (p.wd + i) % 7;
    if (s.kind === 'weekly' && wd !== s.weekday) continue;
    if (at(ds) > now) return at(ds);
  }
  return now;
}
export function scheduleLabel(s: Schedule): string {
  const hh = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (s.kind === 'every') return s.minutes === 1 ? 'Every minute' : `Every ${s.minutes} minutes`;
  if (s.kind === 'hourly') return `Every hour at :${String(s.minute).padStart(2, '0')}`;
  if (s.kind === 'daily') return `Daily at ${hh(s.hour, s.minute)}`;
  return `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][s.weekday]} at ${hh(s.hour, s.minute)}`;
}
export const iso = (sec: unknown): string | null => (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);
export const sec = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
