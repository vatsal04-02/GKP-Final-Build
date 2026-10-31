// The booking service against the in-memory Grist: creation, idempotency, concurrency, verified writes, reschedule, cancel, audit and fail-closed
// behaviour. Synthetic patients only. Nothing here sends a message or touches a real clinic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError, GristClient, memoryGrist, type FetchLike, type GristRecord } from '../src/server/grist';
import { BookingService, type BookingActor } from '../src/server/booking/service';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES } from '../src/server/booking/seed';
import { APPOINTMENT_EXTRA, BT, bookingColNames } from '../src/server/booking/schema';
import { localToEpochSec } from '../src/server/booking/engine';

const NOW = Date.UTC(2026, 9, 7, 6, 30);   // Wed 2026-10-07 12:00 IST
const LEGACY = ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent'];
const AI: BookingActor = { kind: 'service', id: 'n8n-test', name: 'n8n-test', source: 'WhatsApp AI' };
const STAFF: BookingActor = { kind: 'staff', id: 'desk@test', name: 'Front desk', source: 'Staff' };
const P1 = '9876543210'; const P2 = '9123456780'; const P3 = '9000000001';
const THU = '2026-10-08';
const sid = (doctor: string, date: string, start: string) => `${doctor}|${date}|${start}`;
const M09 = sid('DR-001', THU, '09:00'); const M0930 = sid('DR-001', THU, '09:30'); const M10 = sid('DR-001', THU, '10:00'); const E16 = sid('DR-002', THU, '16:00');
let keyN = 0; const key = () => `test-key-${++keyN}-abcdefgh`;
const ist = (date: string, hhmm: string) => localToEpochSec(date, +hhmm.slice(0, 2) * 60 + +hhmm.slice(3), 'Asia/Kolkata');
const fail = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { const b = e as BackendError; return { status: b.status, code: b.code, extra: b.extra as Record<string, unknown> | undefined }; } };
const rows = (list: Array<Record<string, unknown>>): GristRecord[] => list.map((f, i) => ({ id: i + 1, fields: { ...f } as GristRecord['fields'] }));

interface Opts { config?: Record<string, string>; noConfigRows?: boolean; omit?: string[]; blocks?: Array<Record<string, unknown>>; appts?: Array<Record<string, unknown>>; leads?: Array<Record<string, unknown>>; patients?: Array<Record<string, unknown>>; failOn?: (m: string, t: string) => boolean; wrap?: (inner: FetchLike, docs: Record<string, Record<string, GristRecord[]>>) => FetchLike }
function setup(o: Opts = {}) {
  const cfg = SEED_CONFIG.map((r) => ({ ...r })); const over = { booking_enabled: 'on', ...(o.config || {}) };
  for (const [k, v] of Object.entries(over)) { const r = cfg.find((x) => x.Key === k); if (r) r.Value = v; else cfg.push({ Key: k, Value: v }); }
  const all: Record<string, GristRecord[]> = {
    [BT.config]: o.noConfigRows ? [] : rows(cfg), [BT.doctors]: rows(SEED_DOCTORS), [BT.schedules]: rows(SEED_SCHEDULES), [BT.blocks]: rows(o.blocks || []), [BT.audit]: [],
    [BT.appointments]: rows(o.appts || []), LEADS: rows(o.leads || []), Patients: rows(o.patients || []),
  };
  for (const t of o.omit || []) delete all[t];
  const docs = { D: all };
  const columns: Record<string, string[]> = { [BT.appointments]: [...LEGACY, ...APPOINTMENT_EXTRA.map(([n]) => n)], [BT.audit]: bookingColNames(BT.audit), LEADS: ['Name', 'Phone'], Patients: ['Patient_ID', 'Phone', 'Name'] };
  const mem = memoryGrist(docs, { columns, failOn: o.failOn });
  const fetchImpl = (o.wrap ? o.wrap(mem, docs) : mem) as FetchLike;
  const make = () => new BookingService(new GristClient('http://memory', '', fetchImpl), 'D', { tz: 'Asia/Kolkata', now: () => NOW });
  return { svc: make(), make, docs, mem, appts: () => docs.D[BT.appointments]!, audit: () => docs.D[BT.audit]! };
}
const book = (s: BookingService, slot = M09, over: Partial<{ name: string; phone: string; reason: string; key: string }> = {}, actor = AI) =>
  s.create({ slotId: slot, patientName: over.name || 'Test Patient One', patientPhone: over.phone || P1, reason: over.reason || 'Knee pain', idempotencyKey: over.key || key() }, actor);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('creating a booking', () => {
  it('writes a verified, complete appointment and returns its reference', async () => {
    const t = setup(); const r = await book(t.svc);
    expect(r.replayed).toBe(false);
    expect(r.appointment).toMatchObject({ booking_reference: 'wa-GKA-000001', status: 'Confirmed', date: THU, start_time: '09:00', end_time: '09:30', doctor_id: 'DR-001', doctor_name: 'Dr. Mahesh Tiwari', shift: 'morning', slot_id: M09, reason: 'Knee pain', source: 'WhatsApp AI', patient: { name: 'Test Patient One', phone_masked: '+91******3210' } });
    expect(t.appts()).toHaveLength(1);
    expect(t.appts()[0]!.fields).toMatchObject({ Booking_UID: 'wa-GKA-000001', Physio: 'Dr. Mahesh Tiwari', Doctor_ID: 'DR-001', Shift: 'Morning', Status: 'Booked', Appt_Stage: 'Confirmed', Booking_Source: 'WhatsApp AI', Patient_Phone: '+919876543210', Slot_Key: M09, Created_By: 'n8n-test', Start: ist(THU, '09:00'), End: ist(THU, '09:30') });
    expect(JSON.stringify(r)).not.toContain(P1);   // the full number is never echoed back
  });
  it('the slot is then taken, other slots and the other doctor are not', async () => {
    const t = setup(); await book(t.svc);
    const day = await t.svc.availability({ date: THU });
    expect(day.slots.map((s) => s.slot_id)).not.toContain(M09); expect(day.slots).toHaveLength(15); expect(day.slots.map((s) => s.slot_id)).toContain(M0930);
  });
  it('references are sequential and unique; a staff booking has no wa- prefix', async () => {
    const t = setup(); const a = await book(t.svc, M09); const b = await book(t.svc, M0930); const c = await book(t.svc, M10, {}, STAFF);
    expect([a.appointment.booking_reference, b.appointment.booking_reference, c.appointment.booking_reference]).toEqual(['wa-GKA-000001', 'wa-GKA-000002', 'GKA-000003']);
    expect(c.appointment.source).toBe('Staff');
  });
  it('links the lead and the patient by phone, and never creates either', async () => {
    const t = setup({ leads: [{ Name: 'Lead One', Phone: '+919876543210' }], patients: [{ Patient_ID: 'GK-P-000007', Phone: '+919876543210', Name: 'Test Patient One' }] });
    await book(t.svc); expect(t.appts()[0]!.fields).toMatchObject({ Lead: 1, Patient_ID: 'GK-P-000007' });
    await book(t.svc, M0930, { phone: P2, name: 'Walk In' }); expect(t.appts()[1]!.fields.Lead).toBeUndefined(); expect(t.appts()[1]!.fields.Patient_ID).toBe('');
    expect(t.docs.D.LEADS).toHaveLength(1); expect(t.docs.D.Patients).toHaveLength(1);
  });
  it('accepts phone numbers in the usual spellings and refuses bad input', async () => {
    const t = setup(); expect((await book(t.svc, M09, { phone: '+91 98765 43210' })).appointment.patient.phone_masked).toBe('+91******3210');
    for (const [slot, over, code] of [['nope', {}, 'invalid_slot_id'], [`DR-001|2026-02-30|09:00`, {}, 'invalid_slot_id'], [M0930, { phone: '12345' }, 'invalid_phone'], [M0930, { name: '   ' }, 'invalid_patient'], [M0930, { name: 'x'.repeat(121) }, 'invalid_patient']] as const)
      expect((await fail(book(t.svc, slot, over)))?.code).toBe(code);
    expect(t.appts()).toHaveLength(1);
  });
  it('refuses a slot that does not exist, is blocked, is in the past or is in a closed day', async () => {
    const t = setup({ blocks: [{ Block_ID: 'B1', Kind: 'Blocked time', Date_From: Date.UTC(2026, 9, 8) / 1000, Date_To: Date.UTC(2026, 9, 8) / 1000, Start_Time: '10:00', End_Time: '10:30', Active: true }] });
    expect((await fail(book(t.svc, sid('DR-001', THU, '09:15'))))?.extra).toMatchObject({ reason: 'slot_not_found' });
    expect((await fail(book(t.svc, M10)))?.extra).toMatchObject({ reason: 'blocked' });
    expect((await fail(book(t.svc, sid('DR-001', '2026-10-11', '09:00'))))?.extra).toMatchObject({ reason: 'closed', closed: 'not_operating_day' });
    expect((await fail(book(t.svc, sid('DR-002', '2026-10-07', '16:00'), {}, STAFF)))).toBeNull();   // staff, later today: fine
    expect((await fail(book(t.svc, sid('DR-001', '2026-10-07', '12:30'))))?.extra).toMatchObject({ reason: 'in_past' });   // the AI needs 120 minutes' notice
    expect((await fail(book(t.svc, sid('DR-001', '2026-10-07', '09:00'), {}, STAFF)))?.extra).toMatchObject({ reason: 'in_past' });   // staff cannot book the past
  });
  it('a refused booking returns the updated availability for that day', async () => {
    const t = setup(); await book(t.svc);
    const f = await fail(book(t.svc, M09, { phone: P2 }));
    expect(f).toMatchObject({ status: 409, code: 'slot_unavailable', extra: { reason: 'slot_full' } });
    const avail = (f!.extra!.availability as { slots: Array<{ slot_id: string; doctor_id: string }> }).slots;
    expect(avail.map((s) => s.slot_id)).not.toContain(M09); expect(avail.every((s) => s.doctor_id === 'DR-001')).toBe(true); expect(avail).toHaveLength(7);
  });
  it('the same patient cannot take the same slot twice (and is told which booking it is)', async () => {
    const t = setup({ config: { booking_enabled: 'on', capacity: '2' } }); const a = await book(t.svc);
    expect(await fail(book(t.svc))).toMatchObject({ status: 409, code: 'duplicate_booking', extra: { booking_reference: a.appointment.booking_reference } });
    expect((await book(t.svc, M09, { phone: P2 })).replayed).toBe(false);   // a different patient fits (capacity 2)
  });
});

describe('the booking switch and fail-closed configuration', () => {
  it('OFF: availability is empty and says why; the AI cannot book; no row is written', async () => {
    const t = setup({ config: { booking_enabled: 'off' } });
    expect(await t.svc.availability({ date: THU })).toMatchObject({ ai_booking: { available: false, reason: 'disabled' }, slots: [] });
    expect(await fail(book(t.svc))).toMatchObject({ status: 403, code: 'ai_booking_disabled', extra: { reason: 'disabled' } }); expect(t.appts()).toHaveLength(0);
  });
  it('OFF: staff can still book manually, and existing appointments are untouched', async () => {
    const t = setup({ config: { booking_enabled: 'off' }, appts: [{ Booking_UID: 'old-1', Start: ist(THU, '11:00'), End: ist(THU, '11:30'), Status: 'Booked', Physio: 'Dr. Mahesh Tiwari' }] });
    const r = await book(t.svc, M09, {}, STAFF); expect(r.appointment.booking_reference).toBe('GKA-000001'); expect(t.appts()).toHaveLength(2); expect(t.appts()[0]!.fields.Status).toBe('Booked');
  });
  it('a missing, blank or unreadable switch means OFF; "ON" works', async () => {
    for (const config of [{ booking_enabled: '' }, { booking_enabled: 'maybe' }]) expect((await setup({ config }).svc.availability({ date: THU })).ai_booking.available).toBe(false);
    expect((await setup({ noConfigRows: true }).svc.availability({ date: THU })).ai_booking).toEqual({ available: false, reason: 'disabled' });
    expect((await setup({ config: { booking_enabled: ' ON ' } }).svc.availability({ date: THU })).ai_booking.available).toBe(true);
  });
  it('an invalid setting makes the AI fail closed (staff carry on with safe defaults)', async () => {
    const t = setup({ config: { booking_enabled: 'on', slot_minutes: 'abc' } });
    expect(await t.svc.availability({ date: THU })).toMatchObject({ ai_booking: { available: false, reason: 'config_invalid' }, slots: [] });
    expect(await fail(book(t.svc))).toMatchObject({ status: 403, code: 'ai_booking_disabled', extra: { reason: 'config_invalid' } });
    expect((await book(t.svc, M09, {}, STAFF)).appointment.start_time).toBe('09:00');
    expect((await t.svc.config()).config_problems).toHaveLength(1);
  });
  it('a closure or leave row it cannot read also fails closed: it could be hiding a day off', async () => {
    const t = setup({ blocks: [{ Block_ID: 'B1', Kind: 'Doctor leave', Doctor_ID: 'DR-001', Date_From: Date.UTC(2026, 9, 8) / 1000, Start_Time: '10:00' }] });   // a start with no end
    expect((await t.svc.availability({ date: THU })).ai_booking).toEqual({ available: false, reason: 'config_invalid' });
  });
  it('booking tables that are not set up fail closed too (config and availability say so; the AI is refused; staff get 503)', async () => {
    const t = setup({ omit: [BT.config, BT.doctors, BT.schedules, BT.blocks, BT.audit] });
    expect(await t.svc.availability({ date: THU })).toMatchObject({ ai_booking: { available: false, reason: 'config_unavailable' }, slots: [] });
    expect(await t.svc.config()).toMatchObject({ ai_booking: { enabled: false, reason: 'config_unavailable' }, booking_enabled: false });
    expect(await fail(book(t.svc))).toMatchObject({ status: 403, code: 'ai_booking_disabled', extra: { reason: 'config_unavailable' } });
    expect(await fail(book(t.svc, M09, {}, STAFF))).toMatchObject({ status: 503, code: 'booking_unavailable' });
  });
  it('Grist being unreachable is a 503 (not an empty answer that looks like "no slots")', async () => {
    const t = setup({ failOn: (m, tb) => m === 'GET' && tb === BT.config });
    expect(await fail(t.svc.availability({ date: THU }))).toMatchObject({ status: 503, code: 'booking_unavailable' }); expect(await fail(book(t.svc))).toMatchObject({ status: 503 });
  });
  it('a shift switched off, leave and a closure all remove slots live (no restart)', async () => {
    expect((await setup({ config: { booking_enabled: 'on', shift_morning_enabled: 'off' } }).svc.availability({ date: THU })).slots.every((s) => s.shift === 'evening')).toBe(true);
    const leave = setup({ blocks: [{ Block_ID: 'B1', Kind: 'Doctor leave', Doctor_ID: 'DR-002', Date_From: Date.UTC(2026, 9, 8) / 1000, Active: true }] }); expect((await leave.svc.availability({ date: THU })).slots.every((s) => s.doctor_id === 'DR-001')).toBe(true);
    const shut = setup({ blocks: [{ Block_ID: 'B1', Kind: 'Clinic closure', Date_From: Date.UTC(2026, 9, 8) / 1000, Active: true }] }); expect(await shut.svc.availability({ date: THU })).toMatchObject({ closed: 'clinic_closure', slots: [] });
  });
  it('config reports the settings, doctors and schedules the AI needs', async () => {
    const c = await setup().svc.config() as { doctors: unknown[]; schedules: unknown[]; operating_days: string[]; timezone: string; slot_minutes: number; capacity: number; min_notice_minutes: number };
    expect([c.timezone, c.slot_minutes, c.capacity, c.min_notice_minutes, c.operating_days]).toEqual(['Asia/Kolkata', 30, 1, 120, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']]); expect(c.doctors).toHaveLength(2); expect(c.schedules).toHaveLength(12);
  });
  it('availability rejects a bad date and a bad shift', async () => {
    const t = setup(); expect(await fail(t.svc.availability({ date: '2026-02-30' }))).toMatchObject({ status: 400, code: 'invalid_date' }); expect(await fail(t.svc.availability({ date: THU, shift: 'night' }))).toMatchObject({ code: 'invalid_shift' });
    expect((await t.svc.availability({ date: '2026-10-11' })).closed).toBe('not_operating_day');
  });
});

describe('idempotency', () => {
  it('a retry with the same key returns the ORIGINAL booking and creates nothing', async () => {
    const t = setup(); const k = key(); const a = await book(t.svc, M09, { key: k }); const b = await book(t.svc, M09, { key: k });
    expect(b.replayed).toBe(true); expect(b.appointment.booking_reference).toBe(a.appointment.booking_reference); expect(t.appts()).toHaveLength(1);
  });
  it('a retry still returns the original after the slot was taken by someone else, or the switch was turned off', async () => {
    const t = setup(); const k = key(); const a = await book(t.svc, M09, { key: k });
    t.appts()[0]!.fields.Status = 'Cancelled'; await book(t.svc, M09, { phone: P2 });   // the slot is now someone else's
    expect((await book(t.svc, M09, { key: k })).appointment.booking_reference).toBe(a.appointment.booking_reference);
    const off = setup(); const k2 = key(); const first = await book(off.svc, M0930, { key: k2 });
    off.docs.D[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value = 'off';
    expect((await book(off.svc, M0930, { key: k2 })).appointment.booking_reference).toBe(first.appointment.booking_reference);
    expect((await fail(book(off.svc, M10)))?.code).toBe('ai_booking_disabled');
  });
  it('the same key for a DIFFERENT slot or patient is refused, not silently reused', async () => {
    const t = setup(); const k = key(); await book(t.svc, M09, { key: k });
    expect(await fail(book(t.svc, M0930, { key: k }))).toMatchObject({ status: 409, code: 'idempotency_conflict' }); expect(await fail(book(t.svc, M09, { key: k, phone: P2 }))).toMatchObject({ code: 'idempotency_conflict' }); expect(t.appts()).toHaveLength(1);
  });
  it('a key is required and must look like a key', async () => {
    const t = setup(); for (const k of ['', 'short', 'has spaces in it!', 'x'.repeat(65)]) expect((await fail(book(t.svc, M09, { key: k || ' ' })))?.code).toBe('invalid_idempotency_key');
  });
  it('a refused request does NOT burn its key: the retry is judged afresh', async () => {
    const t = setup({ config: { booking_enabled: 'off' } }); const k = key(); expect((await fail(book(t.svc, M09, { key: k })))?.code).toBe('ai_booking_disabled');
    t.docs.D[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value = 'on'; expect((await book(t.svc, M09, { key: k })).replayed).toBe(false);
  });
  it('a retry after an unverified write finds the row that WAS written and returns it', async () => {
    let swallow = true;   // the first POST is written but its answer is "lost" (a timeout): the caller retries with the same key
    const t = setup({ wrap: (inner) => (async (url, init) => { const r = await inner(url, init); if (swallow && /tables\/Appointments\/records/.test(url) && init?.method === 'POST') { swallow = false; throw new Error('timeout'); } return r; }) as FetchLike });
    const k = key(); expect((await fail(book(t.svc, M09, { key: k })))?.status).toBe(502); expect(t.appts()).toHaveLength(1);
    const again = await book(t.svc, M09, { key: k }); expect(again.replayed).toBe(true); expect(t.appts()).toHaveLength(1);
  });
});

describe('concurrency: no two confirmed bookings for one slot', () => {
  it('20 parallel requests, different keys, one slot: exactly one wins, nineteen get a clear conflict', async () => {
    const t = setup(); const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => fail(book(t.svc, M09, { phone: `9${String(100000000 + i).padStart(9, '0')}`, name: `Synthetic ${i}` })).then((f) => f)));
    const won = t.appts().filter((r) => r.fields.Status === 'Booked'); expect(won).toHaveLength(1);
    expect(rs.filter((x) => x === null)).toHaveLength(1); expect(rs.filter((x) => x?.code === 'slot_unavailable' && (x.extra as { reason: string }).reason === 'slot_full')).toHaveLength(19); expect(t.appts()).toHaveLength(1);
  });
  it('capacity 3: exactly three of ten succeed', async () => {
    const t = setup({ config: { booking_enabled: 'on', capacity: '3' } });
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => fail(book(t.svc, M09, { phone: `9${String(200000000 + i).padStart(9, '0')}` })))); expect(rs.filter((x) => x === null)).toHaveLength(3); expect(t.appts()).toHaveLength(3);
  });
  it('10 parallel retries with the SAME key: one booking, ten identical answers', async () => {
    const t = setup(); const k = key(); const rs = await Promise.all(Array.from({ length: 10 }, () => book(t.svc, M09, { key: k })));
    expect(new Set(rs.map((r) => r.appointment.booking_reference)).size).toBe(1); expect(rs.filter((r) => !r.replayed)).toHaveLength(1); expect(t.appts()).toHaveLength(1);
  });
  it('parallel requests for different slots all succeed, with unique references', async () => {
    const t = setup(); const slots = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'].map((s) => sid('DR-001', THU, s));
    const rs = await Promise.all(slots.map((s, i) => book(t.svc, s, { phone: `9${String(300000000 + i).padStart(9, '0')}` })));
    expect(new Set(rs.map((r) => r.appointment.booking_reference)).size).toBe(6); expect(t.appts()).toHaveLength(6);
  });
  it('a booking and a reschedule racing for the same slot: one wins', async () => {
    const t = setup(); const a = await book(t.svc, M09, { phone: P1 });
    const [x, y] = await Promise.all([fail(book(t.svc, M0930, { phone: P2 })), fail(t.svc.reschedule(a.appointment.booking_reference, { slotId: M0930, patientPhone: P1 }, AI))]);
    expect([x, y].filter((r) => r === null)).toHaveLength(1); expect(t.appts().filter((r) => r.fields.Slot_Key === M0930 && r.fields.Status !== 'Cancelled')).toHaveLength(1);
  });
  it('a writer outside the lock (Cal.com, W13 direct, a second process) that grabs the slot between check and write: ours is undone, theirs stands', async () => {
    let injected = false;
    const t = setup({ wrap: (inner, docs) => (async (url, init) => {
      if (!injected && /tables\/Appointments\/records/.test(url) && init?.method === 'POST') { injected = true; docs.D[BT.appointments]!.push({ id: 500, fields: { Booking_UID: 'calcom-xyz', Start: ist(THU, '09:00'), End: ist(THU, '09:30'), Status: 'Booked', Physio: 'Dr. Mahesh Tiwari' } }); }
      return inner(url, init);
    }) as FetchLike });
    const f = await fail(book(t.svc)); expect(f).toMatchObject({ status: 409, code: 'slot_unavailable', extra: { reason: 'slot_full' } });
    expect(t.appts().find((r) => r.fields.Booking_UID === 'calcom-xyz')!.fields.Status).toBe('Booked');
    const ours = t.appts().find((r) => r.id !== 500)!; expect(ours.fields.Status).toBe('Cancelled'); expect(String(ours.fields.Cancel_Reason)).toMatch(/same time/);
    expect(t.appts().filter((r) => r.fields.Status === 'Booked')).toHaveLength(1);
  });
  it('TWO backend instances (the unsupported setup) still cannot confirm two bookings: the later write is undone', async () => {
    let seen = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const t = setup({ wrap: (inner) => (async (url, init) => { if (/tables\/Appointments\/records/.test(url) && (init?.method || 'GET') === 'GET' && seen < 2) { seen++; if (seen === 2) release(); await gate; } return inner(url, init); }) as FetchLike });
    const other = t.make();   // a second process: its own lock, the same Grist
    const [a, b] = await Promise.all([fail(book(t.svc, M09, { phone: P1 })), fail(book(other, M09, { phone: P2 }))]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1); expect([a, b].filter((r) => r?.code === 'slot_unavailable')).toHaveLength(1); expect(t.appts().filter((r) => r.fields.Status === 'Booked')).toHaveLength(1);
  });
});

describe('verified writes', () => {
  it('a write that cannot be read back is NOT reported as a booking', async () => {
    // Grist says 'saved as row 999' but nothing was stored: the read-back finds no such row
    const t = setup({ wrap: (inner) => (async (url, init) => (/tables\/Appointments\/records/.test(url) && init?.method === 'POST' ? { ok: true, status: 200, json: async () => ({ records: [{ id: 999 }] }), text: async () => JSON.stringify({ records: [{ id: 999 }] }) } : inner(url, init))) as FetchLike });
    expect(await fail(book(t.svc))).toMatchObject({ status: 502, code: 'write_unverified' }); expect(t.appts()).toHaveLength(0);
  });
  it('a Grist write that fails outright is an error and leaves nothing behind', async () => {
    const t = setup({ failOn: (m, tb) => m === 'POST' && tb === BT.appointments }); expect((await fail(book(t.svc)))?.status).toBe(502); expect(t.appts()).toHaveLength(0);
  });
  it('a failing audit write never fails or hides a booking that was saved', async () => {
    const t = setup({ failOn: (m, tb) => m === 'POST' && tb === BT.audit }); expect((await book(t.svc)).appointment.booking_reference).toBe('wa-GKA-000001'); expect(t.appts()).toHaveLength(1);
  });
});

describe('looking up, rescheduling and cancelling', () => {
  it('lookup needs the patient\'s phone; a wrong phone or an unknown reference looks identical (404)', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference;
    expect((await t.svc.get(ref, P1, AI)).booking_reference).toBe(ref);
    for (const [r, p] of [[ref, P2], [ref, ''], [ref, undefined], ['wa-GKA-999999', P1]] as const) expect(await fail(t.svc.get(r, p, AI))).toMatchObject({ status: 404, code: 'not_found' });
    expect((await t.svc.get(ref, undefined, STAFF)).booking_reference).toBe(ref);   // staff need no proof
  });
  it('an older Cal.com booking can be found by its uid using the lead\'s phone', async () => {
    const t = setup({ leads: [{ Name: 'Legacy Lead', Phone: '9000000001' }], appts: [{ Booking_UID: 'cal-uid-1', Lead: 1, Service: 'Consultation', Physio: 'Dr. Sandeep Tiwari', Start: ist(THU, '16:30'), End: ist(THU, '17:15'), Status: 'Booked' }] });
    const v = await t.svc.get('cal-uid-1', P3, AI); expect(v).toMatchObject({ status: 'Confirmed', source: 'Cal.com', doctor_id: 'DR-002', date: THU, start_time: '16:30' }); expect(await fail(t.svc.get('cal-uid-1', P1, AI))).toMatchObject({ status: 404 });
  });
  it('reschedule moves the SAME booking, keeps Status Booked (W5 reminders), clears reminder flags, frees the old slot', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference; t.appts()[0]!.fields.R24_Sent = 1; t.appts()[0]!.fields.R2_Sent = 1;
    const r = await t.svc.reschedule(ref, { slotId: M10, patientPhone: P1, reason: 'Work clash' }, AI);
    expect(r.replayed).toBe(false); expect(r.appointment).toMatchObject({ booking_reference: ref, start_time: '10:00', status: 'Confirmed', slot_id: M10, reason: 'Work clash' });
    expect(t.appts()).toHaveLength(1); expect(t.appts()[0]!.fields).toMatchObject({ Status: 'Booked', Slot_Key: M10, Start: ist(THU, '10:00'), R24_Sent: null, R2_Sent: null });
    const slots = (await t.svc.availability({ date: THU })).slots.map((s) => s.slot_id); expect(slots).toContain(M09); expect(slots).not.toContain(M10);
  });
  it('reschedule can change doctor and day; a retry to where it already is changes nothing', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference;
    const r = await t.svc.reschedule(ref, { slotId: E16, patientPhone: P1 }, AI); expect(r.appointment).toMatchObject({ doctor_id: 'DR-002', doctor_name: 'Dr. Sandeep Tiwari', shift: 'evening', start_time: '16:00' });
    expect((await t.svc.reschedule(ref, { slotId: E16, patientPhone: P1 }, AI)).replayed).toBe(true);
  });
  it('reschedule into a full / blocked / invalid slot is refused and the appointment stays put', async () => {
    const t = setup(); const a = await book(t.svc); await book(t.svc, M10, { phone: P2 });
    expect(await fail(t.svc.reschedule(a.appointment.booking_reference, { slotId: M10, patientPhone: P1 }, AI))).toMatchObject({ status: 409, code: 'slot_unavailable', extra: { reason: 'slot_full' } });
    expect(await fail(t.svc.reschedule(a.appointment.booking_reference, { slotId: 'bad', patientPhone: P1 }, AI))).toMatchObject({ code: 'invalid_slot_id' }); expect(t.appts()[0]!.fields.Slot_Key).toBe(M09);
  });
  it('reschedule checks the patient, the status and the AI switch', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference;
    expect(await fail(t.svc.reschedule(ref, { slotId: M10, patientPhone: P2 }, AI))).toMatchObject({ status: 404 });
    t.docs.D[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value = 'off';
    expect(await fail(t.svc.reschedule(ref, { slotId: M10, patientPhone: P1 }, AI))).toMatchObject({ status: 403, code: 'ai_booking_disabled' });
    expect((await t.svc.reschedule(ref, { slotId: M10 }, STAFF)).appointment.start_time).toBe('10:00');   // staff can, with AI off
    await t.svc.cancel(ref, { reason: 'test' }, STAFF); expect(await fail(t.svc.reschedule(ref, { slotId: M09 }, STAFF))).toMatchObject({ status: 409, code: 'not_reschedulable' });
  });
  it('a reschedule that loses a race with an outside writer is rolled back to the old time', async () => {
    let injected = false;
    const t = setup({ wrap: (inner, docs) => (async (url, init) => { if (!injected && /tables\/Appointments\/records/.test(url) && init?.method === 'PATCH') { injected = true; docs.D[BT.appointments]!.push({ id: 600, fields: { Booking_UID: 'calcom-r', Start: ist(THU, '10:00'), End: ist(THU, '10:30'), Status: 'Booked', Physio: 'Dr. Mahesh Tiwari' } }); } return inner(url, init); }) as FetchLike });
    const mine = await book(t.svc);
    expect(await fail(t.svc.reschedule(mine.appointment.booking_reference, { slotId: M10, patientPhone: P1 }, AI))).toMatchObject({ status: 409, code: 'slot_unavailable' });
    expect(t.appts().find((r) => r.fields.Booking_UID === mine.appointment.booking_reference)!.fields).toMatchObject({ Slot_Key: M09, Start: ist(THU, '09:00'), Status: 'Booked' });
  });
  it('cancel frees the slot, is repeatable, and keeps the row (nothing is ever deleted)', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference;
    const c = await t.svc.cancel(ref, { patientPhone: P1, reason: 'Feeling better' }, AI); expect(c.alreadyCancelled).toBe(false); expect(c.appointment.status).toBe('Cancelled');
    expect(t.appts()).toHaveLength(1); expect(t.appts()[0]!.fields).toMatchObject({ Status: 'Cancelled', Cancel_Reason: 'Feeling better' });
    expect((await t.svc.availability({ date: THU })).slots.map((s) => s.slot_id)).toContain(M09);
    expect((await t.svc.cancel(ref, { patientPhone: P1 }, AI)).alreadyCancelled).toBe(true); expect((await book(t.svc, M09, { phone: P2 })).replayed).toBe(false);
  });
  it('cancel: wrong phone is a 404, a finished visit cannot be cancelled, and the AI cannot cancel while AI booking is off (staff still can)', async () => {
    const t = setup(); const a = await book(t.svc); const ref = a.appointment.booking_reference; expect(await fail(t.svc.cancel(ref, { patientPhone: P2 }, AI))).toMatchObject({ status: 404 });
    t.docs.D[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value = 'off';
    expect(await fail(t.svc.cancel(ref, { patientPhone: P1 }, AI))).toMatchObject({ status: 403, code: 'ai_booking_disabled' });
    expect(await fail(t.svc.cancel(ref, { patientPhone: P2 }, AI))).toMatchObject({ status: 403, code: 'ai_booking_disabled' });   // same answer for a stranger: nothing is revealed
    expect(t.appts()[0]!.fields.Status).not.toBe('Cancelled');
    expect((await t.svc.cancel(ref, { reason: 'Patient called' }, STAFF)).appointment.status).toBe('Cancelled');
    const done = setup({ appts: [{ Booking_UID: 'wa-GKA-000050', Patient_Phone: '+919876543210', Start: ist(THU, '09:00'), End: ist(THU, '09:30'), Status: 'Completed' }] });
    expect(await fail(done.svc.cancel('wa-GKA-000050', { patientPhone: P1 }, AI))).toMatchObject({ status: 409, code: 'not_cancellable' });
  });
  it('cancellation policy: the AI must respect the notice period, staff may always cancel, and a started appointment is not cancellable by the AI', async () => {
    const t = setup({ config: { booking_enabled: 'on', cancel_min_notice_minutes: '1500' } });   // 25 hours; the appointment is tomorrow 09:00 = 21 hours ahead
    const a = await book(t.svc, M09, { }, STAFF); const ref = a.appointment.booking_reference;
    const own = t.appts()[0]!; own.fields.Patient_Phone = '+919876543210';
    expect(await fail(t.svc.cancel(ref, { patientPhone: P1 }, AI))).toMatchObject({ status: 409, code: 'cancel_too_late' });
    expect((await t.svc.cancel(ref, { reason: 'Doctor unwell' }, STAFF)).appointment.status).toBe('Cancelled');
    const past = setup({ appts: [{ Booking_UID: 'wa-GKA-000060', Patient_Phone: '+919876543210', Start: ist('2026-10-07', '09:00'), End: ist('2026-10-07', '09:30'), Status: 'Booked' }] });
    expect(await fail(past.svc.cancel('wa-GKA-000060', { patientPhone: P1 }, AI))).toMatchObject({ code: 'not_cancellable' });
  });
});

describe('audit log', () => {
  it('records every create, replay, rejection, reschedule and cancel, with who and what, and no patient details', async () => {
    const t = setup(); const k = key(); const a = await book(t.svc, M09, { key: k, name: 'Secret Name Person', phone: P1 }); const ref = a.appointment.booking_reference;
    await book(t.svc, M09, { key: k, name: 'Secret Name Person', phone: P1 });
    await fail(book(t.svc, M09, { phone: P2, name: 'Other Person' })); await fail(book(t.svc, 'garbage', { name: 'Third Person' }));
    await t.svc.reschedule(ref, { slotId: M10, patientPhone: P1 }, AI); await t.svc.cancel(ref, { patientPhone: P1, reason: 'Private reason text' }, AI);
    const log = t.audit().map((r) => r.fields);
    expect(log.map((l) => `${l.Action}:${l.Outcome}:${l.Reason}`)).toEqual(['create:ok:created', 'create:ok:replayed', 'create:rejected:slot_unavailable', 'create:rejected:invalid_slot_id', 'reschedule:ok:moved', 'cancel:ok:cancelled']);
    expect(log.every((l) => l.Actor === 'token:n8n-test' && l.Source === 'API' && typeof l.At === 'number')).toBe(true);
    expect(log[0]!.Record).toBe(ref); expect(log[2]!.Record).toBe(M09);
    const text = JSON.stringify(log); for (const secret of [P1, P2, '919876543210', 'Secret Name', 'Other Person', 'Third Person', 'Private reason', k]) expect(text).not.toContain(secret);
  });
  it('a staff action is logged as Staff with the staff member as the actor', async () => {
    const t = setup(); await book(t.svc, M09, {}, STAFF); expect(t.audit()[0]!.fields).toMatchObject({ Actor: 'desk@test', Source: 'Staff', Action: 'create', Outcome: 'ok' });
  });
  it('a refusal because AI booking is off is logged as rejected with the reason', async () => {
    const t = setup({ config: { booking_enabled: 'off' } }); await fail(book(t.svc)); expect(t.audit()[0]!.fields).toMatchObject({ Action: 'create', Outcome: 'rejected', Reason: 'ai_booking_disabled' });
  });
  it('lookups are not logged (they change nothing)', async () => {
    const t = setup(); await t.svc.availability({ date: THU }); await t.svc.config(); expect(t.audit()).toHaveLength(0);
  });
});
