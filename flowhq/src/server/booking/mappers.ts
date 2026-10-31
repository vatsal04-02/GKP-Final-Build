// Grist rows -> the engine's plain types. A row that cannot be read safely is dropped (and counted by the caller), never guessed at.
import type { GristRecord } from '../grist';
import { dateOut } from '../records/ids';
import { WEEKDAY_CHOICES } from './schema';
import type { Appt, Block, Doctor, ScheduleRow, Shift } from './engine';
import { toMin } from './engine';

const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
// REAL Grist returns 0 (not null) for a blank Int cell. In the schedule override columns 0 therefore means "blank = use the Booking_Config value": 0 is never a valid appointment
// length or capacity, and a buffer of 0 inherits the clinic's buffer (an explicit 0 override of a non-zero clinic buffer cannot be expressed; documented in grist/booking-schema.md).
// Found by the real-Grist suite (tests/real-grist): the in-memory Grist the other tests use returns null, which hid it.
const intOrBlank = (v: unknown): number | null => { const n = int(v); return n === 0 ? null : n; };
const shiftOf = (v: unknown): Shift | null => { const s = txt(v).toLowerCase(); return s === 'morning' || s === 'evening' ? s : null; };
const id = (r: GristRecord, col: string) => txt(r.fields[col]);

export function toDoctor(r: GristRecord): Doctor | null {
  const doctorId = id(r, 'Doctor_ID'); if (!doctorId) return null;
  return { id: doctorId, name: txt(r.fields.Name), qualification: txt(r.fields.Qualification), defaultShift: shiftOf(r.fields.Default_Shift), active: r.fields.Active === true };
}
export function toSchedule(r: GristRecord): ScheduleRow | null {
  const f = r.fields; const wd = WEEKDAY_CHOICES.indexOf(txt(f.Weekday)) + 1; const shift = shiftOf(f.Shift);
  if (!id(r, 'Schedule_ID') || !id(r, 'Doctor_ID') || wd < 1 || !shift || toMin(f.Start_Time) === null || toMin(f.End_Time) === null) return null;
  return { id: id(r, 'Schedule_ID'), doctorId: id(r, 'Doctor_ID'), weekday: wd, shift, start: txt(f.Start_Time), end: txt(f.End_Time), slotMinutes: intOrBlank(f.Slot_Minutes), bufferMinutes: intOrBlank(f.Buffer_Minutes), capacity: intOrBlank(f.Capacity),
    from: dateOut(f.Effective_From), to: dateOut(f.Effective_To), active: f.Active === true, isOverride: f.Is_Override === true, reason: txt(f.Override_Reason) };
}
const KIND: Record<string, Block['kind']> = { 'Clinic closure': 'closure', 'Doctor leave': 'leave', 'Blocked time': 'blocked' };
export function toBlock(r: GristRecord): Block | null {
  const f = r.fields; const kind = KIND[txt(f.Kind)]; const from = dateOut(f.Date_From); const to = dateOut(f.Date_To) || from;
  if (!id(r, 'Block_ID') || !kind || !from || !to) return null;
  const s = txt(f.Start_Time); const e = txt(f.End_Time);
  if ((s && toMin(s) === null) || (e && toMin(e) === null) || (!!s !== !!e)) return null;   // half a time range is unreadable: drop it (the caller reports it) rather than guess
  return { id: id(r, 'Block_ID'), kind, doctorId: id(r, 'Doctor_ID') || null, shift: shiftOf(f.Shift), from, to, start: s || null, end: e || null, active: f.Active === true, reason: txt(f.Reason) };
}
export function toAppt(r: GristRecord): Appt | null {
  const f = r.fields; const start = typeof f.Start === 'number' && f.Start > 0 ? f.Start : null; if (!start) return null;
  return { id: String(r.id), doctorId: id(r, 'Doctor_ID') || null, physio: id(r, 'Physio') || null, startSec: start, endSec: typeof f.End === 'number' && f.End > 0 ? f.End : null, status: txt(f.Status), stage: txt(f.Appt_Stage) || null };
}
