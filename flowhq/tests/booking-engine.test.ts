// The slot engine and its Grist mappers. Pure logic, synthetic data only; no Grist, no network, no messages.
import { describe, expect, it } from 'vitest';
import type { GristRecord } from '../src/server/grist';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES } from '../src/server/booking/seed';
import { toAppt, toBlock, toDoctor, toSchedule } from '../src/server/booking/mappers';
import { bookableSlots, checkSlot, dayAvailability, displayStatus, doctorByName, localToEpochSec, parseBookingSettings, parseDays, parseSlotId, parseWindows, slotId, validateScheduleRow, weekdayOf, type Appt, type Block, type EngineInput, type ScheduleRow } from '../src/server/booking/engine';

const NOW = Date.UTC(2026, 9, 7, 6, 30);   // Wed 2026-10-07 12:00 IST
const THU = '2026-10-08'; const SUN = '2026-10-11'; const MON = '2026-10-12';
const MAHESH = 'DR-001'; const SANDEEP = 'DR-002';
const rec = (fields: Record<string, unknown>, id = 1): GristRecord => ({ id, fields: fields as GristRecord['fields'] });
const ist = (date: string, hhmm: string) => localToEpochSec(date, +hhmm.slice(0, 2) * 60 + +hhmm.slice(3), 'Asia/Kolkata');

function build(over: { config?: Record<string, string>; appts?: Appt[]; blocks?: Block[]; schedules?: ScheduleRow[]; doctors?: EngineInput['doctors']; now?: number } = {}): EngineInput {
  const rows = SEED_CONFIG.map((r) => ({ ...r })); for (const [k, v] of Object.entries(over.config || { booking_enabled: 'on' })) { const r = rows.find((x) => x.Key === k); if (r) r.Value = v; else rows.push({ Key: k, Value: v }); }
  return {
    settings: parseBookingSettings(rows).settings,
    doctors: over.doctors || SEED_DOCTORS.map((d, i) => toDoctor(rec(d, i + 1))!),
    schedules: over.schedules || SEED_SCHEDULES.map((s, i) => toSchedule(rec(s, i + 1))!),
    blocks: over.blocks || [], appointments: over.appts || [], now: over.now ?? NOW,
  };
}
const appt = (over: Partial<Appt> & { date?: string; time?: string } = {}): Appt => ({ id: '1', doctorId: MAHESH, physio: null, startSec: ist(over.date || THU, over.time || '09:00'), endSec: null, status: 'Booked', stage: null, ...over });
const block = (over: Partial<Block>): Block => ({ id: 'B1', kind: 'blocked', doctorId: null, shift: null, from: THU, to: THU, start: null, end: null, active: true, reason: '', ...over });
const starts = (input: EngineInput, date: string, o: Parameters<typeof dayAvailability>[2] = {}) => dayAvailability(input, date, o).slots.map((s) => `${s.doctorId}@${s.start}`);

describe('the approved starting values', () => {
  it('parse to 30-minute slots, capacity 1, Asia/Kolkata, Mon-Sat, 9-1 and 4-8, both shifts on', () => {
    const { settings: s, problems } = parseBookingSettings(SEED_CONFIG);
    expect(problems).toEqual([]);
    expect([s.slotMinutes, s.bufferMinutes, s.capacity, s.timezone, s.operatingDays, s.maxAdvanceDays]).toEqual([30, 0, 1, 'Asia/Kolkata', [1, 2, 3, 4, 5, 6], null]);
    expect(s.openWindows).toEqual([{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }]); expect(s.shiftEnabled).toEqual({ morning: true, evening: true });
  });
  it('seed AI booking OFF, and two doctors with 12 schedule rows (no Sunday)', () => {
    expect(parseBookingSettings(SEED_CONFIG).settings.aiBookingEnabled).toBe(false);
    expect(SEED_DOCTORS.map((d) => [d.Name, d.Default_Shift])).toEqual([['Dr. Mahesh Tiwari', 'Morning'], ['Dr. Sandeep Tiwari', 'Evening']]);
    expect(SEED_SCHEDULES).toHaveLength(12); expect(SEED_SCHEDULES.some((s) => s.Weekday === 'Sun')).toBe(false);
  });
});

describe('the booking switch (engine side)', () => {
  it('OFF: the AI is offered nothing and checkSlot refuses with ai_disabled; staff can still book', () => {
    const i = build({ config: { booking_enabled: 'off' } });
    const day = dayAvailability(i, THU, { channel: 'ai' });
    expect(day.aiBookingEnabled).toBe(false); expect(day.aiBookingAvailable).toBe(false); expect(bookableSlots(day)).toEqual([]); expect(day.slots.length).toBe(16);
    expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai')).toEqual({ ok: false, reason: 'ai_disabled' });
    expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'staff').ok).toBe(true);
    expect(bookableSlots(dayAvailability(i, THU, { channel: 'staff' }))).toHaveLength(16);
  });
  it('ON: the AI is offered the real slots', () => {
    const i = build(); expect(bookableSlots(dayAvailability(i, THU))).toHaveLength(16); expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(true);
  });
  it('fails closed: a missing or unreadable switch means OFF', () => {
    expect(parseBookingSettings([]).settings.aiBookingEnabled).toBe(false);
    expect(parseBookingSettings([{ Key: 'booking_enabled', Value: 'maybe' }]).settings.aiBookingEnabled).toBe(false);
    expect(parseBookingSettings([{ Key: 'booking_enabled', Value: ' ON ' }]).settings.aiBookingEnabled).toBe(true);
  });
});

describe('slot generation', () => {
  it('morning: Dr. Mahesh, 09:00-13:00, 30-minute slots, last slot ends at 13:00', () => {
    const m = dayAvailability(build(), THU, { shift: 'morning' }).slots;
    expect(m.map((s) => s.start)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);
    expect(m.every((s) => s.doctorId === MAHESH && s.doctorName === 'Dr. Mahesh Tiwari' && s.shift === 'morning')).toBe(true); expect(m[7]!.end).toBe('13:00');
  });
  it('evening: Dr. Sandeep, 16:00-20:00', () => {
    const e = dayAvailability(build(), THU, { shift: 'evening' }).slots;
    expect(e.map((s) => s.start)).toEqual(['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30']); expect(e.every((s) => s.doctorId === SANDEEP && s.shift === 'evening')).toBe(true); expect(e[7]!.end).toBe('20:00');
  });
  it('each doctor appears only in their own shift, nothing in the 13:00-16:00 gap or after 20:00', () => {
    const all = dayAvailability(build(), THU).slots;
    expect(all.filter((s) => s.shift === 'morning').every((s) => s.doctorId === MAHESH)).toBe(true); expect(all.filter((s) => s.shift === 'evening').every((s) => s.doctorId === SANDEEP)).toBe(true);
    expect(all.some((s) => s.start >= '13:00' && s.start < '16:00')).toBe(false); expect(all.some((s) => s.end > '20:00' || s.start < '09:00')).toBe(false);
  });
  it('filters by doctor and by shift', () => {
    expect(starts(build(), THU, { doctorId: SANDEEP })).toHaveLength(8); expect(starts(build(), THU, { doctorId: SANDEEP }).every((x) => x.startsWith(SANDEEP))).toBe(true);
    expect(starts(build(), THU, { shift: 'morning' })).toHaveLength(8);
  });
  it('Monday to Saturday are open, Sunday is closed', () => {
    for (let d = 5; d <= 10; d++) expect(dayAvailability(build(), `2026-10-${String(d).padStart(2, '0')}`).closed).toBeNull();
    const sun = dayAvailability(build(), SUN); expect(sun.closed).toBe('not_operating_day'); expect(sun.slots).toEqual([]);
    expect(checkSlot(build(), { date: SUN, doctorId: MAHESH, start: '09:00' }, 'staff')).toMatchObject({ ok: false, reason: 'closed', closed: 'not_operating_day' });
  });
  it('applies the buffer: 30 minutes + 10 minutes between = a start every 40 minutes', () => {
    expect(dayAvailability(build({ config: { booking_enabled: 'on', buffer_minutes: '10' } }), THU, { shift: 'morning' }).slots.map((s) => s.start)).toEqual(['09:00', '09:40', '10:20', '11:00', '11:40', '12:20']);
  });
  it('a schedule row can carry its own duration and capacity', () => {
    const sch = build().schedules.map((r) => (r.doctorId === MAHESH ? { ...r, slotMinutes: 20, capacity: 2 } : r));
    const m = dayAvailability(build({ schedules: sch }), THU, { shift: 'morning' }).slots; expect(m).toHaveLength(12); expect(m[1]!.start).toBe('09:20'); expect(m.every((s) => s.capacity === 2 && s.remaining === 2)).toBe(true);
  });
  it('never offers a slot outside the clinic opening hours, even if a schedule row says so', () => {
    const sch = build().schedules.map((r) => (r.doctorId === MAHESH ? { ...r, start: '08:00', end: '13:30' } : r));
    const m = dayAvailability(build({ schedules: sch }), THU, { shift: 'morning' }).slots.map((s) => s.start); expect(m[0]).toBe('09:00'); expect(m.at(-1)).toBe('12:30');
  });
  it('a slot that would run past the end of the shift is not generated', () => {
    expect(dayAvailability(build({ config: { booking_enabled: 'on', slot_minutes: '45' } }), THU, { shift: 'morning' }).slots.map((s) => s.start)).toEqual(['09:00', '09:45', '10:30', '11:15', '12:00']);
  });
  it('two identical windows do not produce duplicate slots', () => {
    const b = build(); const dup = { ...b.schedules.find((r) => r.doctorId === MAHESH && r.weekday === 4)!, id: 'DUP' };
    expect(dayAvailability({ ...b, schedules: [...b.schedules, dup] }, THU, { shift: 'morning' }).slots).toHaveLength(8);
  });
  it('is the same answer for AI, staff and a re-run (no hidden state)', () => {
    const i = build(); expect(starts(i, THU, { channel: 'ai' })).toEqual(starts(i, THU, { channel: 'staff' }).filter((x) => starts(i, THU, { channel: 'ai' }).includes(x))); expect(dayAvailability(i, THU)).toEqual(dayAvailability(i, THU));
  });
});

describe('doctor leave, shifts, closures and blocks', () => {
  it('whole-day doctor leave removes that doctor only', () => {
    const i = build({ blocks: [block({ kind: 'leave', doctorId: MAHESH })] });
    expect(starts(i, THU).filter((x) => x.startsWith(MAHESH))).toEqual([]); expect(starts(i, THU).filter((x) => x.startsWith(SANDEEP))).toHaveLength(8);
    expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai')).toMatchObject({ ok: false, reason: 'doctor_unavailable' }); expect(dayAvailability(i, THU).skips).toContainEqual({ shift: 'morning', doctorId: MAHESH, reason: 'doctor_on_leave' });
  });
  it('leave over several days, and an inactive block, behave', () => {
    const i = build({ blocks: [block({ kind: 'leave', doctorId: MAHESH, from: '2026-10-08', to: '2026-10-10' })] });
    expect(starts(i, '2026-10-10').some((x) => x.startsWith(MAHESH))).toBe(false); expect(starts(i, MON).some((x) => x.startsWith(MAHESH))).toBe(true);
    expect(starts(build({ blocks: [block({ kind: 'leave', doctorId: MAHESH, active: false })] }), THU).some((x) => x.startsWith(MAHESH))).toBe(true);
  });
  it('part-day leave blocks only the slots it overlaps', () => {
    const i = build({ blocks: [block({ kind: 'leave', doctorId: MAHESH, start: '10:00', end: '11:00' })] });
    const m = dayAvailability(i, THU, { shift: 'morning' }).slots; const blocked = m.filter((s) => s.state === 'blocked').map((s) => s.start);
    expect(blocked).toEqual(['10:00', '10:30']); expect(m.filter((s) => s.state === 'open')).toHaveLength(6); expect(bookableSlots(dayAvailability(i, THU, { shift: 'morning' })).map((s) => s.start)).not.toContain('10:00');
    expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '10:30' }, 'staff')).toMatchObject({ ok: false, reason: 'blocked' }); expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '11:00' }, 'staff').ok).toBe(true);
  });
  it('a blocked slot at the edge of a range is exact (end is exclusive)', () => {
    const i = build({ blocks: [block({ start: '09:30', end: '10:00' })] }); expect(dayAvailability(i, THU, { shift: 'morning' }).slots.filter((s) => s.state === 'blocked').map((s) => s.start)).toEqual(['09:30']);
  });
  it('a shift that is switched off offers nothing, the other shift is unaffected', () => {
    const i = build({ config: { booking_enabled: 'on', shift_morning_enabled: 'off' } });
    expect(starts(i, THU).every((x) => x.startsWith(SANDEEP))).toBe(true); expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai')).toMatchObject({ ok: false, reason: 'shift_disabled' });
    expect(checkSlot(i, { date: THU, doctorId: SANDEEP, start: '16:00' }, 'ai').ok).toBe(true);
  });
  it('a clinic closure closes the whole day (single day and range); a one-shift closure closes only that shift', () => {
    expect(dayAvailability(build({ blocks: [block({ kind: 'closure' })] }), THU)).toMatchObject({ closed: 'clinic_closure', slots: [] });
    const range = build({ blocks: [block({ kind: 'closure', from: '2026-10-08', to: '2026-10-09' })] });
    expect(dayAvailability(range, '2026-10-09').closed).toBe('clinic_closure'); expect(dayAvailability(range, '2026-10-10').closed).toBeNull();
    const eve = build({ blocks: [block({ kind: 'closure', shift: 'evening' })] }); expect(starts(eve, THU).every((x) => x.startsWith(MAHESH))).toBe(true);
    expect(checkSlot(build({ blocks: [block({ kind: 'closure' })] }), { date: THU, doctorId: MAHESH, start: '09:00' }, 'staff')).toMatchObject({ ok: false, reason: 'closed', closed: 'clinic_closure' });
  });
  it('an inactive doctor offers nothing', () => {
    const docs = build().doctors.map((d) => (d.id === SANDEEP ? { ...d, active: false } : d)); const i = build({ doctors: docs });
    expect(starts(i, THU).every((x) => x.startsWith(MAHESH))).toBe(true); expect(checkSlot(i, { date: THU, doctorId: SANDEEP, start: '16:00' }, 'ai')).toMatchObject({ ok: false, reason: 'doctor_unavailable' });
  });
});

describe('occupied slots and capacity', () => {
  it('a booked slot is full and not bookable; the next one is still open', () => {
    const i = build({ appts: [appt()] }); const m = dayAvailability(i, THU, { shift: 'morning' }).slots;
    expect(m[0]).toMatchObject({ state: 'full', booked: 1, remaining: 0, bookable: false }); expect(m[1]).toMatchObject({ state: 'open', remaining: 1 });
    expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai')).toMatchObject({ ok: false, reason: 'slot_full' }); expect(dayAvailability(i, THU).summary).toMatchObject({ occupied: 1, available: 15, total: 16 });
  });
  it('a cancelled appointment frees its slot; completed and no-show keep it', () => {
    expect(checkSlot(build({ appts: [appt({ status: 'Cancelled' })] }), { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(true);
    for (const status of ['Booked', 'Rescheduled', 'Completed', 'No-show', 'something new']) expect(checkSlot(build({ appts: [appt({ status })] }), { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(false);
  });
  it('capacity 2 takes two bookings, then is full', () => {
    const cfg = { booking_enabled: 'on', capacity: '2' };
    const one = checkSlot(build({ config: cfg, appts: [appt()] }), { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai'); expect(one).toMatchObject({ ok: true, slot: { booked: 1, remaining: 1 } });
    expect(checkSlot(build({ config: cfg, appts: [appt(), appt({ id: '2' })] }), { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai')).toMatchObject({ ok: false, reason: 'slot_full' });
  });
  it("one doctor's booking never fills another doctor's slot", () => {
    const i = build({ appts: [appt({ doctorId: SANDEEP, time: '16:00' })] }); expect(checkSlot(i, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(true); expect(checkSlot(i, { date: THU, doctorId: SANDEEP, start: '16:00' }, 'ai').ok).toBe(false);
  });
  it('a longer existing appointment holds every slot it overlaps', () => {
    const i = build({ appts: [appt({ endSec: ist(THU, '09:45') })] }); expect(dayAvailability(i, THU, { shift: 'morning' }).slots.slice(0, 3).map((s) => s.state)).toEqual(['full', 'full', 'open']);
  });
  it('a Cal.com / W4 row (no Doctor_ID) is matched by the Physio name, and an unplaceable one holds the time for everyone', () => {
    const byName = build({ appts: [appt({ doctorId: null, physio: 'Dr Mahesh' })] }); expect(checkSlot(byName, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(false);
    const evening = build({ appts: [appt({ doctorId: null, physio: 'Dr. Mahesh Tiwari', time: '16:00' })] }); expect(checkSlot(evening, { date: THU, doctorId: SANDEEP, start: '16:00' }, 'ai').ok).toBe(true);   // placed on Mahesh, who is not on in the evening
    const nobody = build({ appts: [appt({ doctorId: null, physio: null })] }); expect(checkSlot(nobody, { date: THU, doctorId: MAHESH, start: '09:00' }, 'ai').ok).toBe(false);
    expect(doctorByName('Dr. Tiwari', build().doctors)).toBeNull();   // two Tiwaris: ambiguous = unresolved
  });
});

describe('time: notice, booking window, past', () => {
  it('the AI needs the minimum notice (120 min); staff only need the slot to be in the future', () => {
    const ai = dayAvailability(build(), '2026-10-07', { channel: 'ai' }).slots; const staff = dayAvailability(build(), '2026-10-07', { channel: 'staff' }).slots;   // now = 12:00 IST
    expect(ai.filter((s) => s.shift === 'morning').every((s) => s.state === 'past')).toBe(true); expect(ai.find((s) => s.start === '16:00')!.state).toBe('open'); expect(ai.find((s) => s.start === '14:00')).toBeUndefined();
    expect(staff.filter((s) => s.shift === 'morning').map((s) => `${s.start}:${s.state}`)).toEqual(['09:00:past', '09:30:past', '10:00:past', '10:30:past', '11:00:past', '11:30:past', '12:00:open', '12:30:open']);
  });
  it('past days offer nothing and checkSlot says in_past', () => {
    expect(bookableSlots(dayAvailability(build(), '2026-10-05'))).toEqual([]); expect(checkSlot(build(), { date: '2026-10-05', doctorId: MAHESH, start: '09:00' }, 'staff')).toMatchObject({ ok: false, reason: 'in_past' });
  });
  it('max_advance_days limits the AI, not staff', () => {
    const i = build({ config: { booking_enabled: 'on', max_advance_days: '7' } });
    expect(dayAvailability(i, '2026-10-20', { channel: 'ai' }).closed).toBe('beyond_booking_window'); expect(checkSlot(i, { date: '2026-10-20', doctorId: MAHESH, start: '09:00' }, 'ai')).toMatchObject({ ok: false, reason: 'beyond_booking_window' });
    expect(checkSlot(i, { date: '2026-10-20', doctorId: MAHESH, start: '09:00' }, 'staff').ok).toBe(true); expect(dayAvailability(i, '2026-10-14', { channel: 'ai' }).closed).toBeNull();
  });
  it('rejects things that are not dates', () => {
    for (const d of ['2026-02-30', '2026-13-01', 'tomorrow', '', '2026-1-1']) { expect(dayAvailability(build(), d).closed).toBe('invalid_date'); expect(checkSlot(build(), { date: d, doctorId: MAHESH, start: '09:00' }, 'staff')).toMatchObject({ ok: false, reason: 'invalid_date' }); }
  });
  it('knows the clinic wall clock: 09:00 IST is 03:30 UTC, and the weekday is Monday-based', () => {
    expect(ist(THU, '09:00')).toBe(Date.UTC(2026, 9, 8, 3, 30) / 1000); expect(weekdayOf(THU)).toBe(4); expect(weekdayOf(SUN)).toBe(7); expect(weekdayOf(MON)).toBe(1);
  });
  it('a time that is not on the slot grid or outside any shift is slot_not_found', () => {
    for (const start of ['09:15', '13:00', '08:30', '20:00']) expect(checkSlot(build(), { date: THU, doctorId: MAHESH, start }, 'staff')).toMatchObject({ ok: false, reason: 'slot_not_found' });
    expect(checkSlot(build(), { date: THU, doctorId: 'DR-999', start: '09:00' }, 'staff')).toMatchObject({ ok: false, reason: 'slot_not_found' });
  });
});

describe('doctor / shift rules and overrides', () => {
  const doctors = build().doctors; const mahesh = doctors[0]!;
  const row = (o: Partial<ScheduleRow> = {}): ScheduleRow => ({ id: 'X', doctorId: MAHESH, weekday: 4, shift: 'morning', start: '09:00', end: '13:00', slotMinutes: null, bufferMinutes: null, capacity: null, from: null, to: null, active: true, isOverride: false, reason: '', ...o });
  it('a normal row for the doctor\'s own shift is valid', () => { expect(validateScheduleRow(row(), mahesh)).toEqual([]); });
  it('the wrong shift is refused unless it is an explicit, dated, explained override', () => {
    expect(validateScheduleRow(row({ shift: 'evening', start: '16:00', end: '20:00' }), mahesh).map((p) => p.code)).toEqual(['doctor_shift_mismatch']);
    expect(validateScheduleRow(row({ shift: 'evening', start: '16:00', end: '20:00', isOverride: true }), mahesh).map((p) => p.code)).toEqual(['override_incomplete']);
    expect(validateScheduleRow(row({ shift: 'evening', start: '16:00', end: '20:00', isOverride: true, reason: 'Covering for Dr. Sandeep', from: THU, to: THU }), mahesh)).toEqual([]);
  });
  it('rejects bad weekday, times, ranges, duration, buffer, capacity, dates and overlaps', () => {
    const codes = (o: Partial<ScheduleRow>, others: ScheduleRow[] = []) => validateScheduleRow(row(o), mahesh, others).map((p) => p.code);
    expect(codes({ weekday: 8 })).toContain('bad_weekday'); expect(codes({ start: '9am' })).toContain('bad_time'); expect(codes({ start: '13:00', end: '09:00' })).toContain('bad_range');
    expect(codes({ slotMinutes: 2 })).toContain('bad_duration'); expect(codes({ bufferMinutes: -1 })).toContain('bad_buffer'); expect(codes({ capacity: 0 })).toContain('bad_capacity');
    expect(codes({ from: '2026-10-09', to: '2026-10-01' })).toContain('bad_range'); expect(codes({ from: 'soon' })).toContain('bad_date');
    expect(codes({ start: '12:00', end: '14:00' }, [row({ id: 'Y' })])).toContain('overlap'); expect(codes({ start: '13:00', end: '14:00' }, [row({ id: 'Y' })])).not.toContain('overlap');
    expect(validateScheduleRow(row(), null).map((p) => p.code)).toEqual(['doctor_missing']);
  });
  it('an override replaces the normal rows for that shift, on its dates only', () => {
    const ov = row({ id: 'OV', doctorId: SANDEEP, shift: 'morning', isOverride: true, reason: 'Covering', from: THU, to: THU });
    const i = build({ schedules: [...build().schedules, ov] });
    expect(starts(i, THU, { shift: 'morning' }).every((x) => x.startsWith(SANDEEP))).toBe(true); expect(starts(i, THU, { shift: 'morning' })).toHaveLength(8);
    expect(starts(i, '2026-10-09', { shift: 'morning' }).every((x) => x.startsWith(MAHESH))).toBe(true);
  });
  it('effective dates and inactive rows are respected', () => {
    const sch = build().schedules.map((r) => (r.doctorId === MAHESH && r.weekday === 4 ? { ...r, from: '2026-10-15' } : r));
    expect(starts(build({ schedules: sch }), THU, { shift: 'morning' })).toEqual([]); expect(starts(build({ schedules: sch }), '2026-10-15', { shift: 'morning' })).toHaveLength(8);
    expect(starts(build({ schedules: build().schedules.map((r) => ({ ...r, active: false })) }), THU)).toEqual([]);
  });
});

describe('statuses, ids and settings', () => {
  it('derives the six staff statuses without touching Appointments.Status', () => {
    expect([['Booked', null], ['Booked', 'Pending confirmation'], ['Rescheduled', 'Checked in'], ['Booked', 'Confirmed'], ['', null], ['Completed', 'Checked in'], ['Cancelled', null], ['No-show', null]].map(([s, g]) => displayStatus(s, g)))
      .toEqual(['Confirmed', 'Pending confirmation', 'Checked in', 'Confirmed', 'Confirmed', 'Completed', 'Cancelled', 'No-show']);
  });
  it('slot ids round-trip and garbage is rejected', () => {
    expect(slotId(MAHESH, THU, '09:00')).toBe('DR-001|2026-10-08|09:00'); expect(parseSlotId('DR-001|2026-10-08|09:00')).toEqual({ doctorId: MAHESH, date: THU, start: '09:00' });
    for (const bad of ['', 'x', 'DR-001|2026-10-08', 'DR-001|2026-02-30|09:00', 'DR-001|2026-10-08|9:00', 'a|2026-10-08|09:00|extra']) expect(parseSlotId(bad)).toBeNull();
  });
  it('bad Booking_Config values fall back to the default and are reported, never thrown', () => {
    const r = parseBookingSettings([{ Key: 'slot_minutes', Value: 'abc' }, { Key: 'capacity', Value: '0' }, { Key: 'operating_days', Value: 'Funday' }, { Key: 'open_windows', Value: '13:00-09:00' }, { Key: 'timezone', Value: 'Mars/Base' }, { Key: 'booking_enabled', Value: 'on' }]);
    expect([r.settings.slotMinutes, r.settings.capacity, r.settings.operatingDays, r.settings.timezone]).toEqual([30, 1, [1, 2, 3, 4, 5, 6], 'Asia/Kolkata']); expect(r.problems).toHaveLength(5); expect(r.settings.aiBookingEnabled).toBe(true);
  });
  it('reads working days and opening windows in the usual spellings', () => {
    expect(parseDays('Mon-Sat')).toEqual([1, 2, 3, 4, 5, 6]); expect(parseDays('Mon,Tue,Thu')).toEqual([1, 2, 4]); expect(parseDays('daily')).toEqual([1, 2, 3, 4, 5, 6, 7]); expect(parseDays('Sat-Mon')).toEqual([1, 6, 7]); expect(parseDays('nonsense')).toBeNull();
    expect(parseWindows('09:00-13:00, 16:00-20:00')).toEqual([{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }]); expect(parseWindows('9-1')).toBeNull();
  });
});

describe('Grist rows -> engine types', () => {
  it('maps a doctor, a schedule row, a block and an appointment', () => {
    expect(toDoctor(rec({ Doctor_ID: 'DR-001', Name: ' Dr. A ', Qualification: 'MPT (PT)', Default_Shift: 'Morning', Active: true }))).toEqual({ id: 'DR-001', name: 'Dr. A', qualification: 'MPT (PT)', defaultShift: 'morning', active: true });
    expect(toSchedule(rec({ Schedule_ID: 'S1', Doctor_ID: 'DR-001', Weekday: 'Thu', Shift: 'Morning', Start_Time: '09:00', End_Time: '13:00', Slot_Minutes: 20, Effective_From: Date.UTC(2026, 9, 1) / 1000, Active: true, Is_Override: false })))
      .toMatchObject({ weekday: 4, shift: 'morning', slotMinutes: 20, bufferMinutes: null, from: '2026-10-01', to: null, active: true });
    expect(toBlock(rec({ Block_ID: 'B1', Kind: 'Doctor leave', Doctor_ID: 'DR-001', Date_From: Date.UTC(2026, 9, 8) / 1000, Active: true }))).toMatchObject({ kind: 'leave', doctorId: 'DR-001', from: '2026-10-08', to: '2026-10-08', start: null, end: null });
    expect(toAppt(rec({ Start: ist(THU, '09:00'), End: ist(THU, '09:30'), Status: 'Booked', Physio: 'Dr Mahesh', Doctor_ID: '' }, 7))).toEqual({ id: '7', doctorId: null, physio: 'Dr Mahesh', startSec: ist(THU, '09:00'), endSec: ist(THU, '09:30'), status: 'Booked', stage: null });
  });
  it('drops rows it cannot read safely (it never guesses)', () => {
    expect(toDoctor(rec({ Name: 'No id' }))).toBeNull(); expect(toSchedule(rec({ Schedule_ID: 'S', Doctor_ID: 'D', Weekday: 'Funday', Shift: 'Morning', Start_Time: '09:00', End_Time: '13:00' }))).toBeNull();
    expect(toSchedule(rec({ Schedule_ID: 'S', Doctor_ID: 'D', Weekday: 'Mon', Shift: 'Morning', Start_Time: '9am', End_Time: '13:00' }))).toBeNull();
    expect(toBlock(rec({ Block_ID: 'B', Kind: 'Blocked time', Date_From: Date.UTC(2026, 9, 8) / 1000, Start_Time: '10:00' }))).toBeNull();   // a start with no end
    expect(toBlock(rec({ Block_ID: 'B', Kind: 'Weather', Date_From: Date.UTC(2026, 9, 8) / 1000 }))).toBeNull(); expect(toAppt(rec({ Status: 'Booked' }))).toBeNull();
  });
});
