// The staff / admin booking API over HTTP with real sessions: switch semantics, roles, listing, status, leave, hours, audit, and that staff and the AI share ONE
// writing path. Synthetic people only; nothing here sends a message.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BT } from '../src/server/booking/schema';
import { resetTokenFailures } from '../src/server/booking/tokens';
import { E16, E1630, M09, M0930, M10, THU, buildFixture, ist, slot, type Fixture } from './booking-fixture';

let fx: Fixture; let n = 0; const key = () => `staff-key-${++n}-abcdefgh`;
const P1 = '9876543210'; const P2 = '9123456780'; const P3 = '9000000001';
const book = (who: string, slotId = M09, over: { name?: string; phone?: string; reason?: string; key?: string; stage?: string; patient_id?: string } = {}) =>
  fx.s(who, '/appointments', { method: 'POST', body: { slot_id: slotId, idempotency_key: over.key || key(), patient: { name: over.name || 'Test Patient One', phone: over.phone || P1, ...(over.patient_id ? { patient_id: over.patient_id } : {}) }, reason: over.reason ?? 'Knee pain', ...(over.stage ? { stage: over.stage } : {}) } });
const aiBook = (slotId: string, phone = P2) => fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': key() }, body: { slot_id: slotId, patient: { name: 'Zed AI Patient', phone } } });
const audit = () => fx.doc[BT.audit]!.map((r) => r.fields);
const appts = () => fx.doc[BT.appointments]!;

beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the booking switch is an AI switch, not a staff switch', () => {
  it('AI OFF: staff can create, move, cancel and change status; the AI cannot create or move, but can still look up and cancel with the patient\'s phone', async () => {
    const a = await book('desk'); expect(a.status).toBe(201); const ref = a.json.appointment.booking_reference as string;
    expect(a.json.appointment).toMatchObject({ source: 'Staff', booking_reference: 'GKA-000001', status: 'Confirmed' });
    expect((await fx.s('desk', `/appointments/${ref}`, { method: 'PATCH', body: { slot_id: M10 } })).status).toBe(200);
    expect((await fx.s('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: 'Checked in' } })).json.appointment.status).toBe('Checked in');
    expect((await aiBook(M0930)).status).toBe(403);   // the AI is blocked...
    expect((await fx.api(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: P1, slot_id: M0930 } })).status).toBe(403);   // ...including moving an appointment
    expect((await fx.api(`/appointments/${ref}?patient_phone=${P1}`)).status).toBe(200);   // lookup works (ownership proven by phone)
    expect((await fx.api(`/appointments/${ref}?patient_phone=${P2}`)).status).toBe(404);
    expect((await fx.api(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P1 } })).json.appointment.status).toBe('Cancelled');   // and cancelling
    expect(appts()).toHaveLength(1);
  });
  it('AI ON: staff still work exactly the same; one slot, whoever asks first wins', async () => {
    fx = await buildFixture({ bookingOn: true });
    const [a, b] = await Promise.all([book('desk', M09), aiBook(M09)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]); expect(appts().filter((r) => r.fields.Status === 'Booked')).toHaveLength(1);
  });
  it('staff can book a time sooner than the AI minimum notice (today 16:00), but never a time that has passed', async () => {
    expect((await book('desk', slot('DR-002', '2026-10-07', '16:00'))).status).toBe(201);
    const past = await book('desk', slot('DR-001', '2026-10-07', '09:00')); expect(past).toMatchObject({ status: 409, json: { error: { code: 'slot_unavailable' }, reason: 'in_past' } });
  });
});

describe('who is signed in decides what is allowed (server-side)', () => {
  it('nobody signed in gets 401 on every staff route; writes also need the CSRF header', async () => {
    for (const [method, p] of [['GET', '/overview'], ['GET', '/day?date=' + THU], ['GET', '/appointments'], ['GET', '/doctors'], ['GET', '/settings'], ['GET', '/audit'], ['POST', '/appointments'], ['PUT', '/settings'], ['POST', '/blocks']] as const)
      expect((await fx.s('none', p, { method, body: method === 'GET' ? undefined : {} })).status, `${method} ${p}`).toBe(401);
    expect((await fx.s('desk', '/appointments', { method: 'POST', csrf: false, body: { slot_id: M09 } })).json.error.code).toBe('csrf');
    expect((await fx.s('desk', '/settings', { method: 'PUT', csrf: false, body: { values: {} } })).status).toBe(403);
  });
  it('front desk: cannot change the AI switch, settings, doctors, hours or read the audit log; the refusal is itself recorded', async () => {
    for (const [method, p, body] of [['PUT', '/settings', { values: { booking_enabled: 'on' } }], ['PUT', '/settings', { values: { slot_minutes: '45' } }], ['PATCH', '/doctors/DR-001', { active: false }],
      ['POST', '/schedules', { doctor_id: 'DR-001', weekday: 'Mon', shift: 'morning', start_time: '09:00', end_time: '13:00', slot_minutes: null, buffer_minutes: null, capacity: null, effective_from: null, effective_to: null, active: true, is_override: false, reason: '' }]] as const) {
      const r = await fx.s('desk', p, { method, body }); expect(r.status, `${method} ${p}`).toBe(403); expect(r.json.error.code).toBe('forbidden');
    }
    expect((await fx.s('desk', '/audit')).status).toBe(403);
    expect(fx.doc[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value).toBe('off'); expect(fx.doc[BT.config]!.find((r) => r.fields.Key === 'slot_minutes')!.fields.Value).toBe('30');
    expect(audit().filter((l) => l.Outcome === 'rejected' && l.Reason === 'forbidden' && l.Actor === 'desk@test').length).toBeGreaterThanOrEqual(4);
  });
  it('front desk can see everything they need: overview, day, list, doctors, settings (read only)', async () => {
    for (const p of ['/overview', `/day?date=${THU}`, '/appointments', '/doctors', '/settings']) expect((await fx.s('desk', p)).status, p).toBe(200);
  });
  it('a doctor\'s own login: sees everything, manages only their own doctor\'s appointments, cannot block time or change settings', async () => {
    expect((await book('mahesh', M09)).status).toBe(201);
    const other = await book('mahesh', E16); expect(other).toMatchObject({ status: 403, json: { error: { code: 'forbidden', message: 'You can only manage your own appointments' } }, });
    const theirs = (await book('desk', E1630, { phone: P2 })).json.appointment.booking_reference as string;   // a Dr. Sandeep appointment
    expect((await fx.s('mahesh', `/appointments/${theirs}/cancel`, { method: 'POST', body: {} })).status).toBe(403);
    expect((await fx.s('mahesh', `/appointments/${theirs}/status`, { method: 'POST', body: { status: 'Checked in' } })).status).toBe(403);
    expect((await fx.s('mahesh', `/appointments/${theirs}`, { method: 'PATCH', body: { slot_id: M10 } })).status).toBe(403);   // cannot pull it onto their own list either
    const mine = appts().find((r) => r.fields.Doctor_ID === 'DR-001')!.fields.Booking_UID as string;
    expect((await fx.s('mahesh', `/appointments/${mine}`, { method: 'PATCH', body: { slot_id: E16 } })).status).toBe(403);   // nor push theirs onto the other doctor
    expect((await fx.s('mahesh', `/appointments/${mine}`, { method: 'PATCH', body: { slot_id: M10 } })).status).toBe(200);
    expect((await fx.s('mahesh', '/blocks', { method: 'POST', body: { kind: 'Blocked time', date_from: THU } })).status).toBe(403);
    expect((await fx.s('mahesh', '/settings', { method: 'PUT', body: { values: { slot_minutes: '45' } } })).status).toBe(403);
    expect((await fx.s('mahesh', '/appointments')).json.total).toBe(2);   // but sees both
    expect((await fx.s('sandeep', `/appointments/${theirs}/status`, { method: 'POST', body: { status: 'Checked in' } })).status).toBe(200);   // "dr. sandeep tiwari " matches loosely
  });
  it('the role cannot be claimed in a request: unknown fields are refused', async () => {
    const r = await fx.s('desk', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: key(), patient: { name: 'A B', phone: P1 }, role: 'admin' } }); expect(r.status).toBe(400);
    expect((await fx.s('desk', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' }, role: 'admin' } })).status).toBe(400); expect((await fx.s('desk', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } }, headers: { 'x-role': 'admin' } })).status).toBe(403);
  });
  it('admin turns AI booking on and off; the change is audited with before and after, and applies to the AI at once', async () => {
    expect((await fx.api(`/availability?date=${THU}`)).json.ai_booking.available).toBe(false);
    const on = await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } }); expect(on.status).toBe(200);
    expect((await fx.api(`/availability?date=${THU}`)).json).toMatchObject({ ai_booking: { available: true }, slots: expect.any(Array) });
    expect((await fx.s('desk', '/overview')).json.ai_booking).toMatchObject({ setting: true, available: true });
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'off' } } });
    const logs = audit().filter((l) => l.Action === 'booking_enabled'); expect(logs).toHaveLength(2);
    expect(logs.map((l) => JSON.parse(l.Detail as string))).toEqual([{ key: 'booking_enabled', from: 'off', to: 'on' }, { key: 'booking_enabled', from: 'on', to: 'off' }]); expect(logs.every((l) => l.Actor === 'admin@test' && l.Source === 'Staff')).toBe(true);
    expect(fx.doc[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields).toMatchObject({ Value: 'off', Updated_By: 'admin@test' });
    expect((await fx.s('admin', '/overview')).json.last_config_update).toMatchObject({ by: 'admin@test' });
  });
  it('admin settings are validated, applied immediately, and a bad value is refused without writing anything', async () => {
    for (const values of [{ slot_minutes: 'abc' }, { capacity: '0' }, { operating_days: 'Funday' }, { open_windows: '13:00-09:00' }, { timezone: 'Mars/Base' }, { booking_enabled: 'maybe' }, { evil_key: 'x' }, { slot_minutes: '30000' }]) {
      const r = await fx.s('admin', '/settings', { method: 'PUT', body: { values } }); expect(r.status, JSON.stringify(values)).toBe(400); expect(r.json.error.code).toBe('invalid_setting');
    }
    expect(fx.doc[BT.config]!.find((r) => r.fields.Key === 'slot_minutes')!.fields.Value).toBe('30');
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on', slot_minutes: '45' } } });
    expect((await fx.api(`/availability?date=${THU}&shift=morning`)).json.slots.map((s: { start_time: string }) => s.start_time)).toEqual(['09:00', '09:45', '10:30', '11:15', '12:00']);
    expect((await fx.s('admin', '/settings')).json.values.slot_minutes).toBe('45');
  });
});

describe('listing, searching and the day calendar', () => {
  beforeEach(async () => {
    await book('desk', M09, { name: 'Zed Alpha', phone: P1, reason: 'Knee' }); await book('desk', E16, { name: 'Beta Person', phone: P2, stage: 'Pending confirmation' });
    fx.doc[BT.appointments]!.push({ id: 900, fields: { Booking_UID: 'cal-legacy-1', Service: 'Consultation', Physio: 'Dr. Sandeep Tiwari', Start: ist(THU, '17:00'), End: ist(THU, '17:45'), Status: 'Booked' } });
    fx = Object.assign(fx, {}); fx.docs; // (no-op: the fixture holds the same tables)
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } }); await aiBook(M0930, P3);
  });
  it('lists everything with filters: date range, doctor, shift, status, who booked it, and search by name, phone and reference', async () => {
    const all = (await fx.s('desk', `/appointments?from=${THU}&to=${THU}`)).json; expect(all.total).toBe(4);
    expect(all.rows.map((r: { start_time: string }) => r.start_time)).toEqual(['09:00', '09:30', '16:00', '17:00']);
    const q = async (qs: string) => (await fx.s('desk', `/appointments?${qs}`)).json.rows.map((r: { booking_reference: string }) => r.booking_reference);
    expect((await q('doctor_id=DR-001')).length).toBe(2); expect((await q('doctor_id=DR-002')).length).toBe(2); expect((await q('shift=morning')).length).toBe(2); expect((await q('shift=evening')).length).toBe(2);
    expect(await q('status=Pending%20confirmation')).toHaveLength(1); expect(await q('source=Cal.com')).toEqual(['cal-legacy-1']); expect(await q('source=WhatsApp%20AI')).toHaveLength(1); expect(await q('source=Staff')).toHaveLength(2);
    expect(await q('q=zed')).toHaveLength(2); expect(await q('q=98765')).toHaveLength(1); expect(await q('q=wa-GKA')).toHaveLength(1); expect(await q('q=nobody-here')).toHaveLength(0); expect(await q(`from=2026-10-09`)).toHaveLength(0);
  });
  it('shows who booked each one, with full contact details for staff', async () => {
    const rows = (await fx.s('desk', '/appointments')).json.rows as Array<{ booking_reference: string; source: string; ai_created: boolean; patient: { phone: string; name: string }; doctor_id: string; shift: string }>;
    const ai = rows.find((r) => r.booking_reference.startsWith('wa-'))!; expect(ai).toMatchObject({ source: 'WhatsApp AI', ai_created: true, doctor_id: 'DR-001' });
    const staff = rows.find((r) => r.patient.name === 'Zed Alpha')!; expect(staff).toMatchObject({ source: 'Staff', ai_created: false, patient: { phone: '+919876543210' } });
    expect(rows.find((r) => r.booking_reference === 'cal-legacy-1')).toMatchObject({ source: 'Cal.com', doctor_id: 'DR-002', shift: 'evening', ai_created: false });
  });
  it('rejects bad filters cleanly', async () => {
    for (const qs of ['from=tomorrow', 'shift=night', 'status=Maybe', 'source=Telepathy']) expect((await fx.s('desk', `/appointments?${qs}`)).status, qs).toBe(400);
  });
  it('the day calendar shows every slot, who is in it, and appointments that sit outside any slot', async () => {
    const d = (await fx.s('desk', `/day?date=${THU}`)).json;
    expect(d.slots).toHaveLength(16); expect(d.summary).toMatchObject({ total: 16 });
    const nine = d.slots.find((s: { slot_id: string }) => s.slot_id === M09); expect(nine).toMatchObject({ state: 'full', booked: 1, remaining: 0 }); expect(nine.appointments[0]).toMatchObject({ source: 'Staff', patient: { name: 'Zed Alpha' } });
    expect(d.slots.find((s: { slot_id: string }) => s.slot_id === slot('DR-002', THU, '17:00')).appointments[0].booking_reference).toBe('cal-legacy-1');   // a 45-minute Cal.com visit holds 17:00 and 17:30
    expect(d.slots.find((s: { slot_id: string }) => s.slot_id === slot('DR-002', THU, '17:30')).state).toBe('full');
    expect((await fx.s('desk', '/day?date=2026-10-11')).json).toMatchObject({ closed: 'not_operating_day', slots: [] }); expect((await fx.s('desk', '/day')).status).toBe(400);
  });
  it('the control-panel numbers add up', async () => {
    const o = (await fx.s('desk', `/overview?date=${THU}`)).json;
    expect(o).toMatchObject({ date: THU, today_counts: { appointments: 4, cancelled: 0, available_slots: 11, occupied_slots: 5, blocked_slots: 0 }, tables_ready: true, shifts: { morning: true, evening: true } });
    expect(o.upcoming).toBe(4); expect(o.doctors.map((d: { today: string }) => d.today)).toEqual(['working', 'working']); expect(o.audit_health).toBeUndefined();   // only admins see audit health
    expect((await fx.s('admin', '/overview')).json.audit_health).toMatchObject({ failed_since_start: 0, waiting_to_retry: 0, last_failure_at: null, level: 'ok', durable: false });
  });
});

describe('status changes keep the old Status vocabulary (W4-W9 read it)', () => {
  it('Pending -> Confirmed -> Checked in -> Completed, with Status staying Booked until it is Completed; no-show; reopen; cancelled is final', async () => {
    const ref = (await book('desk', M09, { stage: 'Pending confirmation' })).json.appointment.booking_reference as string; const set = (s: string) => fx.s('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: s } });
    expect(appts()[0]!.fields).toMatchObject({ Status: 'Booked', Appt_Stage: 'Pending confirmation' });
    expect((await set('Confirmed')).json.appointment.status).toBe('Confirmed'); expect(appts()[0]!.fields).toMatchObject({ Status: 'Booked', Appt_Stage: 'Confirmed' });
    expect((await set('Checked in')).json.appointment.status).toBe('Checked in'); expect(appts()[0]!.fields.Status).toBe('Booked');
    expect((await set('Completed')).json.appointment.status).toBe('Completed'); expect(appts()[0]!.fields.Status).toBe('Completed');
    expect((await set('No-show')).json.appointment.status).toBe('No-show'); expect(appts()[0]!.fields.Status).toBe('No-show');
    expect((await set('Confirmed')).json.appointment.status).toBe('Confirmed'); expect(appts()[0]!.fields).toMatchObject({ Status: 'Booked', Appt_Stage: 'Confirmed' });
    expect((await set('Cancelled')).json.error.code).toBe('invalid_status'); expect((await set('Whatever')).json.error.code).toBe('invalid_status');
    await fx.s('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: { reason: 'Moved city' } }); expect((await set('Confirmed')).status).toBe(409);
    expect(appts()[0]!.fields).toMatchObject({ Status: 'Cancelled', Cancel_Reason: 'Moved city' });
  });
  it('staff cancel and reschedule need no patient phone, and an unknown reference is a 404', async () => {
    const ref = (await book('desk', M09)).json.appointment.booking_reference as string;
    expect((await fx.s('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: {} })).json).toMatchObject({ already_cancelled: false, appointment: { status: 'Cancelled' } });
    expect((await fx.s('desk', '/appointments/nope/cancel', { method: 'POST', body: {} })).status).toBe(404); expect((await fx.s('desk', '/appointments/nope/status', { method: 'POST', body: { status: 'Confirmed' } })).status).toBe(404);
  });
  it('a register patient can be linked: it must exist and its phone must match; a new person needs only a name and number', async () => {
    fx.doc.Patients = [{ id: 1, fields: { Patient_ID: 'GK-P-000001', Name: 'Register Person', Phone: '+919876543210' } }];
    expect((await book('desk', M09, { name: 'Register Person', phone: P1, patient_id: 'GK-P-000001' })).status).toBe(201); expect(appts()[0]!.fields.Patient_ID).toBe('GK-P-000001');
    expect((await book('desk', M0930, { phone: P2, patient_id: 'GK-P-000001' })).json.error.code).toBe('patient_mismatch'); expect((await book('desk', M10, { patient_id: 'GK-P-999999' })).json.error.code).toBe('invalid_patient');
    expect(fx.doc.Patients).toHaveLength(1);   // never created from here
  });
});

describe('leave, closures and blocked time (staff and admin)', () => {
  it('leave stops the AI being offered that doctor immediately, lists the appointments inside it WITHOUT touching them, and can be removed', async () => {
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } });
    const ref = (await book('desk', M09)).json.appointment.booking_reference as string;
    const r = await fx.s('desk', '/blocks', { method: 'POST', body: { kind: 'Doctor leave', doctor_id: 'DR-001', date_from: THU, reason: 'Conference' } });
    expect(r.status).toBe(201); expect(r.json.block_id).toBe('BLK-000001'); expect(r.json.affected).toEqual([{ booking_reference: ref, date: THU, start_time: '09:00', doctor_name: 'Dr. Mahesh Tiwari', patient_name: 'Test Patient One' }]);
    expect(appts()[0]!.fields.Status).toBe('Booked');   // untouched
    expect((await fx.api(`/availability?date=${THU}`)).json.slots.every((s: { doctor_id: string }) => s.doctor_id === 'DR-002')).toBe(true);
    expect((await fx.s('desk', '/overview?date=' + THU)).json.doctors[0].today).toBe('on_leave');
    expect((await fx.s('desk', '/blocks/BLK-000001/deactivate', { method: 'POST', body: {} })).json).toEqual({ block_id: 'BLK-000001', already_inactive: false });
    expect((await fx.api(`/availability?date=${THU}`)).json.slots.some((s: { doctor_id: string }) => s.doctor_id === 'DR-001')).toBe(true);
    expect(fx.doc[BT.blocks]).toHaveLength(1); expect(fx.doc[BT.blocks]![0]!.fields.Active).toBe(false);   // switched off, never deleted
    expect((await fx.s('desk', '/blocks/BLK-000001/deactivate', { method: 'POST', body: {} })).json.already_inactive).toBe(true); expect((await fx.s('desk', '/blocks/BLK-999/deactivate', { method: 'POST', body: {} })).status).toBe(404);
  });
  it('a part-day block lists only appointments inside its hours; a closure closes everyone', async () => {
    await book('desk', M09); await book('desk', M10, { phone: P2 });
    const part = await fx.s('desk', '/blocks', { method: 'POST', body: { kind: 'Blocked time', doctor_id: 'DR-001', date_from: THU, start_time: '10:00', end_time: '11:00' } }); expect(part.json.affected.map((a: { start_time: string }) => a.start_time)).toEqual(['10:00']);
    expect((await fx.s('desk', `/day?date=${THU}&shift=morning`)).json.slots.filter((s: { state: string }) => s.state === 'blocked')).toHaveLength(2);
    await fx.s('admin', '/blocks', { method: 'POST', body: { kind: 'Clinic closure', date_from: '2026-10-09', date_to: '2026-10-10', reason: 'Holiday' } }); expect((await fx.s('desk', '/day?date=2026-10-10')).json.closed).toBe('clinic_closure');
  });
  it('bad blocks are refused with a reason', async () => {
    for (const body of [{ kind: 'Weather', date_from: THU }, { kind: 'Doctor leave', date_from: THU }, { kind: 'Clinic closure', doctor_id: 'DR-001', date_from: THU }, { kind: 'Blocked time', date_from: THU, start_time: '10:00' }, { kind: 'Blocked time', date_from: THU, start_time: '11:00', end_time: '10:00' }, { kind: 'Doctor leave', doctor_id: 'DR-009', date_from: THU }, { kind: 'Doctor leave', doctor_id: 'DR-001', date_from: THU, date_to: '2026-10-01' }, { kind: 'Doctor leave', doctor_id: 'DR-001', date_from: '2026-02-30' }]) {
      const r = await fx.s('desk', '/blocks', { method: 'POST', body }); expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(fx.doc[BT.blocks]).toHaveLength(0);
  });
});

describe('doctors and hours (admin)', () => {
  it('the wrong shift needs an explicit, dated, explained override; an override replaces that shift on its dates only', async () => {
    const base = { doctor_id: 'DR-001', weekday: 'Mon', shift: 'evening', start_time: '16:00', end_time: '20:00', slot_minutes: null, buffer_minutes: null, capacity: null, effective_from: null, effective_to: null, active: true, is_override: false, reason: '' };
    const no = await fx.s('admin', '/schedules', { method: 'POST', body: base }); expect(no.status).toBe(400); expect(no.json.error).toMatchObject({ code: 'invalid_schedule', message: expect.stringContaining('explicit override') });
    expect((await fx.s('admin', '/schedules', { method: 'POST', body: { ...base, is_override: true } })).status).toBe(400);   // no reason or dates
    const ok = await fx.s('admin', '/schedules', { method: 'POST', body: { ...base, is_override: true, reason: 'Covering for Dr. Sandeep', effective_from: '2026-10-12', effective_to: '2026-10-12' } });
    expect(ok.status).toBe(201); expect(ok.json.schedule_id).toBe('SCH-013');
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } });
    expect((await fx.api('/availability?date=2026-10-12&shift=evening')).json.slots.every((s: { doctor_id: string }) => s.doctor_id === 'DR-001')).toBe(true);
    expect((await fx.api('/availability?date=2026-10-19&shift=evening')).json.slots.every((s: { doctor_id: string }) => s.doctor_id === 'DR-002')).toBe(true);
  });
  it('hours can be edited and switched off; overlaps, bad times and unknown doctors are refused; nothing is deleted', async () => {
    const row = { doctor_id: 'DR-001', weekday: 'Thu', shift: 'morning', start_time: '09:00', end_time: '12:00', slot_minutes: 20, buffer_minutes: null, capacity: null, effective_from: null, effective_to: null, active: true, is_override: false, reason: '' };
    const sch = fx.doc[BT.schedules]!.find((r) => r.fields.Doctor_ID === 'DR-001' && r.fields.Weekday === 'Thu')!.fields.Schedule_ID as string;
    expect((await fx.s('admin', `/schedules/${sch}`, { method: 'PUT', body: row })).status).toBe(200);
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } }); expect((await fx.api(`/availability?date=${THU}&shift=morning`)).json.slots).toHaveLength(9);   // 20-minute slots, 09:00-12:00
    // refused while the hours are active: a backwards time, an unknown doctor, a silly length, and a second window that overlaps the first
    for (const body of [{ ...row, start_time: '13:00', end_time: '09:00' }, { ...row, doctor_id: 'DR-009' }, { ...row, slot_minutes: 2 }, { ...row, start_time: '10:00', end_time: '14:00' }]) expect([400, 404]).toContain((await fx.s('admin', '/schedules', { method: 'POST', body })).status);
    expect((await fx.s('admin', `/schedules/${sch}`, { method: 'PUT', body: { ...row, active: false } })).status).toBe(200); expect((await fx.api(`/availability?date=${THU}&shift=morning`)).json.slots).toHaveLength(0);
    expect((await fx.s('admin', '/schedules/SCH-999', { method: 'PUT', body: row })).status).toBe(404); expect(fx.doc[BT.schedules]).toHaveLength(12);
  });
  it('switching a doctor off stops all bookings for them (AI and staff); existing appointments stay; switching back works', async () => {
    const ref = (await book('desk', E16)).json.appointment.booking_reference as string;
    expect((await fx.s('admin', '/doctors/DR-002', { method: 'PATCH', body: { active: false } })).json.doctor.active).toBe(false);
    expect((await book('desk', E1630, { phone: P2 })).json).toMatchObject({ error: { code: 'slot_unavailable' }, reason: 'doctor_unavailable' }); expect(appts().find((r) => r.fields.Booking_UID === ref)!.fields.Status).toBe('Booked');
    expect((await fx.s('admin', '/doctors/DR-002', { method: 'PATCH', body: { active: true, qualification: 'MPT (PT)', name: 'Dr. Sandeep Tiwari' } })).status).toBe(200); expect((await book('desk', E1630, { phone: P2 })).status).toBe(201);
    for (const body of [{}, { name: 'X' }, { default_shift: 'night' }]) expect((await fx.s('admin', '/doctors/DR-002', { method: 'PATCH', body })).status).toBe(400); expect((await fx.s('admin', '/doctors/DR-404', { method: 'PATCH', body: { active: true } })).status).toBe(404);
  });
});

describe('audit', () => {
  it('records staff actions with the signed-in user, shows a per-appointment history to staff and the full log to admins only', async () => {
    const ref = (await book('desk', M09, { name: 'Zed Private', phone: P1, reason: 'Secret reason text' })).json.appointment.booking_reference as string;
    await fx.s('desk', `/appointments/${ref}`, { method: 'PATCH', body: { slot_id: M10 } }); await fx.s('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: 'Checked in' } }); await fx.s('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: { reason: 'Private cancel note' } });
    const h = (await fx.s('desk', `/appointments/${ref}`)).json.history as Array<{ action: string; outcome: string; actor: string; source: string }>;
    expect(h.map((x) => x.action).reverse()).toEqual(['create', 'reschedule', 'status', 'cancel']); expect(h.every((x) => x.actor === 'desk@test' && x.source === 'Staff' && x.outcome === 'ok')).toBe(true);
    const log = (await fx.s('admin', '/audit?limit=50')).json; expect(log.total).toBe(4); expect(log.rows[0]).toMatchObject({ action: 'cancel', actor: 'desk@test' }); expect((await fx.s('admin', '/audit?q=reschedule')).json.total).toBe(1);
    const raw = JSON.stringify(audit()); for (const secret of [P1, '919876543210', 'Zed Private', 'Secret reason', 'Private cancel', 'staff-key-']) expect(raw, secret).not.toContain(secret);   // no phone, name, free text or idempotency key
  });
  it('never logs patient details even when the AI is involved or a request is refused', async () => {
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } }); const k = key();
    await fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': k }, body: { slot_id: M09, patient: { name: 'Zed AI Patient', phone: P2, }, reason: 'AI free text' } }); await aiBook(M09, P3);
    const raw = JSON.stringify(audit()); for (const secret of [P2, P3, 'Zed AI', 'AI free text', k, fx.token.split('.')[1]!, fx.tokenRecord.hash]) expect(raw, secret).not.toContain(secret);
  });
  it('an audit write that fails is NOT silent: the booking is saved, the failure is counted and shown to admins, and it is retried with the next write', async () => {
    fx.fail.audit = true;
    expect((await book('desk', M09)).status).toBe(201); expect(appts()).toHaveLength(1); expect(audit()).toHaveLength(0);
    const o = (await fx.s('admin', '/overview')).json; expect(o.audit_health).toMatchObject({ failed_since_start: 1, waiting_to_retry: 1 }); expect(typeof o.audit_health.last_failure_at).toBe('string');
    expect((await fx.s('desk', '/overview')).json.audit_health).toBeUndefined(); expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes('AUDIT WRITE FAILED'))).toBe(true);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join('\n'); expect(logged).not.toContain(P1); expect(logged).not.toContain('Test Patient One');
    fx.fail.audit = false;
    expect((await book('desk', M0930, { phone: P2 })).status).toBe(201);   // the next write flushes the waiting entry too
    expect(audit().map((l) => `${l.Action}:${l.Outcome}`)).toEqual(['create:ok', 'create:ok']); expect((await fx.s('admin', '/overview')).json.audit_health).toMatchObject({ failed_since_start: 1, waiting_to_retry: 0 });
    expect((await fx.s('admin', '/audit')).json.health).toMatchObject({ failed_since_start: 1 });
  });
});

describe('one writing path, and the existing screens keep working', () => {
  it('only the booking service writes appointments (plus the existing Completed / No-show button on the Bookings page)', () => {
    const SRC = path.resolve(__dirname, '../src/server');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : []; });
    const writers = files(SRC).filter((p) => /\.(add|update|addVerified|patchVerified)\([^)]*(TABLES\.appointments|BT\.appointments|'Appointments')/.test(readFileSync(p, 'utf8'))).map((p) => path.relative(SRC, p).split(path.sep).join('/')).sort();
    expect(writers).toEqual(['adapters/autopilot/index.ts', 'booking/service.ts', 'booking/staff-service.ts']);
    const legacy = readFileSync(path.join(SRC, 'adapters/autopilot/index.ts'), 'utf8').match(/\.update\([^)]*TABLES\.appointments[^\n]*/g) || [];
    expect(legacy).toHaveLength(1); expect(legacy[0]).toMatch(/Status: status === 'completed' \? 'Completed' : 'No-show'/);   // the pre-existing button: status only, no create / move / cancel
  });
  it('the Schedule module appears only where the booking tables exist', async () => {
    expect((await (await fx.app.request('/api/w/demo-physio/workspace', { headers: { cookie: fx.cookies.admin! } })).json()).modules).toContain('schedule');
    const bare = await buildFixture({ noBookingTables: true });
    expect((await (await bare.app.request('/api/w/demo-physio/workspace', { headers: { cookie: bare.cookies.admin! } })).json()).modules).not.toContain('schedule');
    expect((await bare.s('admin', '/overview')).json).toMatchObject({ tables_ready: false, ai_booking: { available: false, reason: 'config_unavailable' } });
  });
  it('the existing dashboard and Bookings page still work, show the old and the new appointments, and name a patient who has no lead', async () => {
    fx.doc[BT.appointments]!.push({ id: 900, fields: { Booking_UID: 'cal-legacy-1', Service: 'Consultation', Physio: 'Dr. Sandeep Tiwari', Start: ist(THU, '17:00'), End: ist(THU, '17:45'), Status: 'Booked' } });
    await book('desk', M09, { name: 'Walk In Person' });
    const get = async (p: string) => (await fx.app.request(`/api/w/demo-physio${p}`, { headers: { cookie: fx.cookies.admin! } })).json();
    expect((await get('/dashboard?days=7')).metrics).toBeDefined();
    const list = await get('/bookings?view=all') as Array<{ ref: string; contactName: string | null; source: { kind: string }; status: string }>;
    expect(list.map((b) => b.ref)).toEqual(expect.arrayContaining(['cal-legacy-1', 'GKA-000001'])); expect(list.find((b) => b.ref === 'GKA-000001')).toMatchObject({ contactName: 'Walk In Person', status: 'scheduled' });
  });
});

describe('a doctor login is a stable Doctor_ID, not a name guess', () => {
  it('doctorId decides: the login linked to DR-002 manages Dr. Sandeep\'s appointments only, whatever its name says', async () => {
    expect((await book('linked', E16)).status).toBe(201);
    expect((await book('linked', M09)).json.error.message).toBe('You can only manage your own appointments');
    const mine = fx.doc[BT.appointments]!.find((r) => r.fields.Doctor_ID === 'DR-002')!.fields.Booking_UID as string;
    expect((await fx.s('linked', `/appointments/${mine}/status`, { method: 'POST', body: { status: 'Checked in' } })).status).toBe(200);
    expect((await fx.s('linked', '/overview')).json.me).toMatchObject({ doctor_id: 'DR-002', is_doctor_login: true });
  });
  it('a partial or vague name gets NO booking rights (view only), and says why', async () => {
    const r = await book('vague', M09); expect(r.status).toBe(403); expect(r.json.error.message).toMatch(/not linked to a doctor/);
    expect((await fx.s('vague', '/overview')).json.me).toMatchObject({ doctor_id: null, is_doctor_login: true });
    expect((await fx.s('vague', '/appointments')).status).toBe(200);   // viewing is unaffected
  });
  it('a doctorId that is not a real doctor gets no rights, even if the name would have matched', async () => {
    expect((await book('badlink', M09)).status).toBe(403); expect((await fx.s('badlink', '/overview')).json.me.doctor_id).toBeNull(); expect(fx.doc[BT.appointments]).toHaveLength(0);
  });
  it('the older name-only login still works only for an EXACT, single match (case and spacing ignored)', async () => {
    expect((await fx.s('mahesh', '/overview')).json.me).toMatchObject({ doctor_id: 'DR-001', is_doctor_login: true }); expect((await fx.s('sandeep', '/overview')).json.me.doctor_id).toBe('DR-002');
  });
  it('admins and front desk are not doctor logins', async () => {
    expect((await fx.s('admin', '/overview')).json.me).toMatchObject({ doctor_id: null, is_doctor_login: false }); expect((await fx.s('desk', '/overview')).json.me).toMatchObject({ doctor_id: null, is_doctor_login: false });
  });
});