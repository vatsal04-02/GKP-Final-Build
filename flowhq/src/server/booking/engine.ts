// The slot engine. PURE: no Grist, no clock, no network. Everything it needs is passed in, so every rule below is unit-tested.
// One engine answers every question about availability (the WhatsApp AI API, Cal.com sync, staff booking, the calendar), so they can
// never disagree. The booking service (Slice 2) calls checkSlot() again INSIDE the lock, immediately before it writes.
//
// Times: dates are 'YYYY-MM-DD' and times 'HH:MM' on the CLINIC'S wall clock (Booking_Config timezone, Asia/Kolkata). Appointments carry
// epoch seconds (Grist DateTime). Weekdays are 1 = Monday ... 7 = Sunday.
import { addDays, validDate } from '../records/ids';
import { dayKey, tzOffsetMs } from '../time';

export type Shift = 'morning' | 'evening';
export type Channel = 'ai' | 'staff';
export const SHIFTS: Shift[] = ['morning', 'evening'];

export interface Doctor { id: string; name: string; qualification: string; defaultShift: Shift | null; active: boolean }
export interface ScheduleRow {
  id: string; doctorId: string; weekday: number; shift: Shift; start: string; end: string;
  slotMinutes: number | null; bufferMinutes: number | null; capacity: number | null;   // null = the Booking_Config value
  from: string | null; to: string | null;                                               // effective dates, inclusive; null = no limit
  active: boolean; isOverride: boolean; reason: string;
}
export interface Block {
  id: string; kind: 'closure' | 'leave' | 'blocked'; doctorId: string | null; shift: Shift | null;
  from: string; to: string; start: string | null; end: string | null;                  // null times = the whole day
  active: boolean; reason: string;
}
export interface BookingSettings {
  aiBookingEnabled: boolean; timezone: string; slotMinutes: number; bufferMinutes: number; capacity: number; minNoticeMinutes: number; cancelNoticeMinutes: number;
  maxAdvanceDays: number | null; operatingDays: number[]; openWindows: Array<{ start: string; end: string }>; shiftEnabled: Record<Shift, boolean>;
}
export interface Appt { id: string; doctorId: string | null; physio: string | null; startSec: number; endSec: number | null; status: string; stage: string | null }
export interface EngineInput { settings: BookingSettings; doctors: Doctor[]; schedules: ScheduleRow[]; blocks: Block[]; appointments: Appt[]; now: number }   // now = epoch ms

export type ClosedReason = 'invalid_date' | 'not_operating_day' | 'clinic_closure' | 'beyond_booking_window';
export type SkipReason = 'shift_disabled' | 'doctor_missing' | 'doctor_inactive' | 'doctor_on_leave' | 'blocked_all_day' | 'invalid_config';
export type SlotState = 'open' | 'full' | 'blocked' | 'past';
export interface Slot {
  slotId: string; date: string; start: string; end: string; startSec: number; endSec: number;
  doctorId: string; doctorName: string; shift: Shift; capacity: number; booked: number; remaining: number;
  state: SlotState; bookable: boolean; blockedBy?: string;
}
export interface DayAvailability {
  date: string; aiBookingEnabled: boolean; aiBookingAvailable: boolean; closed: ClosedReason | null;
  skips: Array<{ shift: Shift; doctorId: string | null; reason: SkipReason }>;
  slots: Slot[];
  summary: { total: number; available: number; occupied: number; blocked: number; past: number };
}

// ---- small helpers -------------------------------------------------------------------------------------------------------------
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMin = (t: unknown): number | null => { const m = typeof t === 'string' ? TIME_RE.exec(t.trim()) : null; return m ? +m[1]! * 60 + +m[2]! : null; };
export const fmtMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** Clinic wall-clock date + minutes-after-midnight -> epoch seconds (works in any time zone; two passes cover a DST edge). */
export function localToEpochSec(date: string, minutes: number, tz: string): number {
  const naive = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + minutes * 60000;
  const t1 = naive - tzOffsetMs(naive, tz);
  return Math.floor((naive - tzOffsetMs(t1, tz)) / 1000);
}
export const slotId = (doctorId: string, date: string, start: string) => `${doctorId}|${date}|${start}`;
export function parseSlotId(id: string): { doctorId: string; date: string; start: string } | null {
  const [doctorId, date, start, extra] = String(id).split('|');
  return doctorId && validDate(date) && toMin(start) !== null && extra === undefined ? { doctorId, date, start: start! } : null;
}
const normName = (s: string) => s.toLowerCase().replace(/\bdr\b\.?/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** The doctor a legacy row (Cal.com / W4, which only knew the Physio's name) belongs to; null when it cannot be told. */
export function doctorByName(name: string | null | undefined, doctors: Doctor[]): Doctor | null {
  const n = normName(String(name || '')); if (n.length < 3) return null;
  const hit = doctors.filter((d) => { const x = normName(d.name); return x === n || x.includes(n) || n.includes(x); });
  return hit.length === 1 ? hit[0]! : null;   // two matches = ambiguous = unresolved
}

export type DisplayStatus = 'Pending confirmation' | 'Confirmed' | 'Checked in' | 'Completed' | 'Cancelled' | 'No-show';
/** Appointments.Status (what Cal.com, W4 and W5-W9 read and write) + Appointments.Appt_Stage -> the six statuses staff see. */
export function displayStatus(status: string | null | undefined, stage: string | null | undefined): DisplayStatus {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
  if (s === 'completed') return 'Completed';
  if (s === 'no-show' || s === 'no_show' || s === 'noshow') return 'No-show';
  return stage === 'Pending confirmation' || stage === 'Checked in' ? stage : 'Confirmed';   // Booked / Rescheduled / blank; no stage = Confirmed
}
/** A cancelled appointment frees its slot; everything else (including an unknown status) keeps it taken. */
export const occupiesSlot = (status: string | null | undefined) => displayStatus(status, null) !== 'Cancelled';

// ---- settings (Booking_Config rows) --------------------------------------------------------------------------------------------
export const DEFAULT_SETTINGS: BookingSettings = {
  aiBookingEnabled: false,   // FAIL CLOSED: a missing or unreadable switch means AI booking is OFF
  timezone: 'Asia/Kolkata', slotMinutes: 30, bufferMinutes: 0, capacity: 1, minNoticeMinutes: 120, cancelNoticeMinutes: 0, maxAdvanceDays: null,
  operatingDays: [1, 2, 3, 4, 5, 6], openWindows: [{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }], shiftEnabled: { morning: true, evening: true },
};
const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export function parseDays(v: string): number[] | null {
  const s = v.trim().toLowerCase(); if (!s) return null;
  if (s === 'daily' || s === 'all') return [1, 2, 3, 4, 5, 6, 7];
  const out = new Set<number>();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const r = /^([a-z]{3})-([a-z]{3})$/.exec(part);
    if (r) { const a = DAY_NAMES.indexOf(r[1]!); const b = DAY_NAMES.indexOf(r[2]!); if (a < 0 || b < 0) return null; for (let i = a; ; i = (i + 1) % 7) { out.add(i + 1); if (i === b) break; } continue; }
    const i = DAY_NAMES.indexOf(part.slice(0, 3)); if (i < 0) return null; out.add(i + 1);
  }
  return [...out].sort((x, y) => x - y);
}
export function parseWindows(v: string): Array<{ start: string; end: string }> | null {
  const out: Array<{ start: string; end: string }> = [];
  for (const part of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => x.trim()); const s = toMin(a); const e = toMin(b);
    if (s === null || e === null || e <= s) return null; out.push({ start: a!, end: b! });
  }
  return out.length ? out : null;
}
const onOff = (v: string | undefined, dflt: boolean) => { const s = String(v ?? '').trim().toLowerCase(); return ['on', 'true', 'yes', '1'].includes(s) ? true : ['off', 'false', 'no', '0'].includes(s) ? false : dflt; };
/** Booking_Config rows -> typed settings. Never throws: a bad value falls back to the default and is reported in `problems`. */
export function parseBookingSettings(rows: Array<{ Key?: unknown; Value?: unknown }>): { settings: BookingSettings; problems: string[] } {
  const m = new Map<string, string>(); for (const r of rows) m.set(String(r.Key ?? '').trim(), String(r.Value ?? '').trim());
  const problems: string[] = []; const d = DEFAULT_SETTINGS;
  const int = (key: string, dflt: number, min: number, max: number) => { const v = m.get(key); if (v === undefined || v === '') return dflt; const n = Number(v); if (Number.isInteger(n) && n >= min && n <= max) return n; problems.push(`${key}: "${v}" is not a whole number from ${min} to ${max}; using ${dflt}`); return dflt; };
  const days = m.has('operating_days') ? parseDays(m.get('operating_days')!) : d.operatingDays; if (!days) problems.push(`operating_days: "${m.get('operating_days')}" is not readable; using Mon-Sat`);
  const wins = m.has('open_windows') && m.get('open_windows') !== '' ? parseWindows(m.get('open_windows')!) : d.openWindows; if (!wins) problems.push(`open_windows: "${m.get('open_windows')}" is not readable; using the default hours`);
  const tz = m.get('timezone') || d.timezone; let tzOk = true; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tzOk = false; problems.push(`timezone: "${tz}" is not a time zone; using ${d.timezone}`); }
  const be = m.get('booking_enabled'); if (be !== undefined && be !== '' && !['on', 'true', 'yes', '1', 'off', 'false', 'no', '0'].includes(be.toLowerCase())) problems.push(`booking_enabled: "${be}" is not on or off; AI booking stays off`);
  for (const k of ['shift_morning_enabled', 'shift_evening_enabled']) { const v = m.get(k); if (v !== undefined && v !== '' && !['on', 'true', 'yes', '1', 'off', 'false', 'no', '0'].includes(v.toLowerCase())) problems.push(`${k}: "${v}" is not on or off; using on`); }
  const adv = m.get('max_advance_days');
  return {
    problems,
    settings: {
      aiBookingEnabled: onOff(m.get('booking_enabled'), false),
      timezone: tzOk ? tz : d.timezone,
      slotMinutes: int('slot_minutes', d.slotMinutes, 5, 240), bufferMinutes: int('buffer_minutes', d.bufferMinutes, 0, 120), capacity: int('capacity', d.capacity, 1, 50),
      minNoticeMinutes: int('min_notice_minutes', d.minNoticeMinutes, 0, 10080), cancelNoticeMinutes: int('cancel_min_notice_minutes', d.cancelNoticeMinutes, 0, 10080), maxAdvanceDays: adv === undefined || adv === '' ? null : int('max_advance_days', 60, 1, 730),
      operatingDays: days || d.operatingDays, openWindows: wins || d.openWindows,
      shiftEnabled: { morning: onOff(m.get('shift_morning_enabled'), true), evening: onOff(m.get('shift_evening_enabled'), true) },
    },
  };
}

// ---- validation of schedule rows (used by the staff API in Slice 3; pure so it is tested here) ---------------------------------
export interface Problem { code: string; message: string }
/** A doctor works their own shift. The other shift is allowed only as an explicit, dated, explained override. */
export function validateScheduleRow(row: ScheduleRow, doctor: Doctor | null, others: ScheduleRow[] = []): Problem[] {
  const p: Problem[] = []; const add = (code: string, message: string) => p.push({ code, message });
  if (!doctor) { add('doctor_missing', 'The doctor does not exist'); return p; }
  if (!Number.isInteger(row.weekday) || row.weekday < 1 || row.weekday > 7) add('bad_weekday', 'Weekday must be Monday to Sunday');
  const s = toMin(row.start); const e = toMin(row.end);
  if (s === null || e === null) add('bad_time', 'Start and end must be times like 09:00');
  else if (e <= s) add('bad_range', 'The end time must be after the start time');
  if (row.slotMinutes !== null && !(Number.isInteger(row.slotMinutes) && row.slotMinutes >= 5 && row.slotMinutes <= 240)) add('bad_duration', 'Appointment length must be 5 to 240 minutes');
  if (row.bufferMinutes !== null && !(Number.isInteger(row.bufferMinutes) && row.bufferMinutes >= 0 && row.bufferMinutes <= 120)) add('bad_buffer', 'Buffer must be 0 to 120 minutes');
  if (row.capacity !== null && !(Number.isInteger(row.capacity) && row.capacity >= 1 && row.capacity <= 50)) add('bad_capacity', 'Capacity must be 1 to 50');
  if (row.from && !validDate(row.from)) add('bad_date', 'Effective-from is not a date'); if (row.to && !validDate(row.to)) add('bad_date', 'Effective-to is not a date');
  if (row.from && row.to && validDate(row.from) && validDate(row.to) && row.to < row.from) add('bad_range', 'Effective-to is before effective-from');
  if (doctor.defaultShift && row.shift !== doctor.defaultShift) {
    if (!row.isOverride) add('doctor_shift_mismatch', `${doctor.name} works the ${doctor.defaultShift} shift; the ${row.shift} shift needs an explicit override`);
    else if (!row.reason.trim() || !row.from || !row.to) add('override_incomplete', 'An override needs a reason and both effective dates');
  }
  if (s !== null && e !== null) {
    for (const o of others) {
      if (o.id === row.id || !o.active || o.doctorId !== row.doctorId || o.weekday !== row.weekday) continue;
      const os = toMin(o.start); const oe = toMin(o.end); if (os === null || oe === null) continue;
      const datesTouch = (!row.from || !o.to || row.from <= o.to) && (!o.from || !row.to || o.from <= row.to);
      if (datesTouch && s < oe && os < e && o.isOverride === row.isOverride) add('overlap', `Overlaps another window for ${doctor.name} on the same day`);
    }
  }
  return p;
}

// ---- availability ----------------------------------------------------------------------------------------------------------------
const covers = (b: Block, date: string) => b.active && b.from <= date && date <= b.to;
function blockApplies(b: Block, doctorId: string, shift: Shift) { return (b.doctorId === null || b.doctorId === doctorId) && (b.shift === null || b.shift === shift); }

/** The appointments that take up the time [startSec, endSec) for one doctor: not cancelled, overlapping, and either theirs or unplaceable
 *  (a legacy row nobody can place holds the time for every doctor). The one rule behind ooked, emaining and the post-write check. */
export function appointmentsInSlot(input: Pick<EngineInput, 'doctors' | 'appointments'>, doctorId: string, startSec: number, endSec: number): Appt[] {
  const dur = endSec - startSec;
  return input.appointments.filter((ap) => {
    if (!occupiesSlot(ap.status)) return false;
    const owner = ap.doctorId ?? doctorByName(ap.physio, input.doctors)?.id ?? null;
    if (owner !== null && owner !== doctorId) return false;
    const apEnd = ap.endSec && ap.endSec > ap.startSec ? ap.endSec : ap.startSec + dur;
    return ap.startSec < endSec && startSec < apEnd;
  });
}

/** Every slot of one day (open, full, blocked and past), plus why anything was skipped. `channel` 'ai' applies the AI switch, the minimum
 *  notice and the booking window; 'staff' ignores all three (staff can always book a slot that is still ahead of now). */
export function dayAvailability(input: EngineInput, date: string, opts: { channel?: Channel; doctorId?: string; shift?: Shift } = {}): DayAvailability {
  const { settings: s } = input; const channel = opts.channel || 'ai';
  const aiOk = channel === 'staff' || s.aiBookingEnabled;
  const out: DayAvailability = { date, aiBookingEnabled: s.aiBookingEnabled, aiBookingAvailable: aiOk, closed: null, skips: [], slots: [], summary: { total: 0, available: 0, occupied: 0, blocked: 0, past: 0 } };
  const close = (r: ClosedReason) => { out.closed = r; return out; };
  if (!validDate(date)) return close('invalid_date');
  const wd = weekdayOf(date);
  if (!s.operatingDays.includes(wd)) return close('not_operating_day');
  if (input.blocks.some((b) => covers(b, date) && b.kind === 'closure' && b.doctorId === null && b.shift === null && b.start === null && b.end === null)) return close('clinic_closure');
  const today = dayKey(input.now, s.timezone);
  if (channel === 'ai' && s.maxAdvanceDays !== null && date > addDays(today, s.maxAdvanceDays)) return close('beyond_booking_window');

  const nowSec = Math.floor(input.now / 1000); const noticeSec = channel === 'ai' ? s.minNoticeMinutes * 60 : 0;
  const seen = new Set<string>();
  for (const shift of SHIFTS) {
    if (opts.shift && opts.shift !== shift) continue;
    if (!s.shiftEnabled[shift]) { out.skips.push({ shift, doctorId: null, reason: 'shift_disabled' }); continue; }
    const cands = input.schedules.filter((r) => r.active && r.weekday === wd && r.shift === shift && (!r.from || r.from <= date) && (!r.to || r.to >= date));
    const rows = cands.some((r) => r.isOverride) ? cands.filter((r) => r.isOverride) : cands;   // an override replaces the normal rows for its shift
    for (const row of rows) {
      if (opts.doctorId && opts.doctorId !== row.doctorId) continue;
      const doc = input.doctors.find((d) => d.id === row.doctorId);
      if (!doc) { out.skips.push({ shift, doctorId: row.doctorId, reason: 'doctor_missing' }); continue; }
      if (!doc.active) { out.skips.push({ shift, doctorId: doc.id, reason: 'doctor_inactive' }); continue; }
      const mine = input.blocks.filter((b) => covers(b, date) && blockApplies(b, doc.id, shift));
      const wholeDay = mine.find((b) => b.start === null || b.end === null);
      if (wholeDay) { out.skips.push({ shift, doctorId: doc.id, reason: wholeDay.kind === 'leave' ? 'doctor_on_leave' : 'blocked_all_day' }); continue; }
      const dur = row.slotMinutes ?? s.slotMinutes; const buf = row.bufferMinutes ?? s.bufferMinutes; const cap = row.capacity ?? s.capacity;
      const a = toMin(row.start); const z = toMin(row.end);
      if (a === null || z === null || z <= a || !(dur > 0) || buf < 0 || !(cap >= 1)) { out.skips.push({ shift, doctorId: doc.id, reason: 'invalid_config' }); continue; }
      for (let t = a; t + dur <= z; t += dur + buf) {
        if (s.openWindows.length && !s.openWindows.some((w) => t >= toMin(w.start)! && t + dur <= toMin(w.end)!)) continue;   // never outside the clinic's opening hours
        const id = slotId(doc.id, date, fmtMin(t)); if (seen.has(id)) continue; seen.add(id);
        const startSec = localToEpochSec(date, t, s.timezone); const endSec = startSec + dur * 60;
        const booked = appointmentsInSlot(input, doc.id, startSec, endSec).length;
        const hit = mine.find((b) => { const bs = toMin(b.start); const be = toMin(b.end); return bs !== null && be !== null && t < be && bs < t + dur; });
        const state: SlotState = hit ? 'blocked' : startSec < nowSec + noticeSec ? 'past' : booked >= cap ? 'full' : 'open';
        out.slots.push({ slotId: id, date, start: fmtMin(t), end: fmtMin(t + dur), startSec, endSec, doctorId: doc.id, doctorName: doc.name, shift, capacity: cap, booked, remaining: Math.max(0, cap - booked), state, bookable: state === 'open' && aiOk, ...(hit ? { blockedBy: hit.kind } : {}) });
      }
    }
  }
  out.slots.sort((x, y) => x.startSec - y.startSec || x.doctorName.localeCompare(y.doctorName));
  for (const sl of out.slots) { out.summary.total++; if (sl.state === 'open') out.summary.available++; else if (sl.state === 'full') out.summary.occupied++; else if (sl.state === 'blocked') out.summary.blocked++; else out.summary.past++; }
  return out;
}
/** Only what a patient may actually be offered. Empty when AI booking is off. */
export const bookableSlots = (day: DayAvailability): Slot[] => day.slots.filter((x) => x.bookable);

export type Refusal = 'ai_disabled' | 'invalid_date' | 'closed' | 'beyond_booking_window' | 'shift_disabled' | 'doctor_unavailable' | 'slot_not_found' | 'blocked' | 'slot_full' | 'in_past';
export type SlotCheck = { ok: true; slot: Slot } | { ok: false; reason: Refusal; slot?: Slot; closed?: ClosedReason };
/** Can this exact slot be booked right now, by this channel? Call it again inside the lock right before writing. */
export function checkSlot(input: EngineInput, ref: { date: string; doctorId: string; start: string }, channel: Channel): SlotCheck {
  if (channel === 'ai' && !input.settings.aiBookingEnabled) return { ok: false, reason: 'ai_disabled' };
  const day = dayAvailability(input, ref.date, { channel, doctorId: ref.doctorId });
  if (day.closed === 'invalid_date') return { ok: false, reason: 'invalid_date', closed: day.closed };
  if (day.closed === 'beyond_booking_window') return { ok: false, reason: 'beyond_booking_window', closed: day.closed };
  if (day.closed) return { ok: false, reason: 'closed', closed: day.closed };
  const slot = day.slots.find((x) => x.slotId === slotId(ref.doctorId, ref.date, ref.start));
  if (slot) return slot.state === 'open' ? { ok: true, slot } : { ok: false, reason: slot.state === 'full' ? 'slot_full' : slot.state === 'blocked' ? 'blocked' : 'in_past', slot };
  const wd = weekdayOf(ref.date);
  const works = new Set(input.schedules.filter((r) => r.active && r.doctorId === ref.doctorId && r.weekday === wd).map((r) => r.shift));   // a disabled shift only matters to a doctor who works it that day
  const skip = day.skips.find((k) => k.doctorId === ref.doctorId) || day.skips.find((k) => k.doctorId === null && works.has(k.shift));
  if (skip) return { ok: false, reason: skip.reason === 'shift_disabled' ? 'shift_disabled' : skip.reason === 'blocked_all_day' ? 'blocked' : 'doctor_unavailable' };
  return { ok: false, reason: 'slot_not_found' };
}
