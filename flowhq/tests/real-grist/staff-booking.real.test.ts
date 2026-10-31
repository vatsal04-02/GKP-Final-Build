// STAFF-MANAGED BOOKING with the AI switch OFF (booking_enabled = off), exactly production's state: a REAL Grist, the REAL FLOW HQ server process (the production code),
// synthetic people only. Proves: staff can book, look up, move and cancel; the doctor and shift are right; duplicates and double-booking are refused; every step is audited;
// the wrong people cannot do it; and the AI / service-token path cannot create an appointment while the switch is off.
// Run: $env:REAL_GRIST_URL=...; $env:REAL_GRIST_KEY_FILE=...; npx vitest run tests/real-grist/staff-booking   (skipped when no real Grist is configured)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PW, REAL_ENABLED, createStaging, deleteStaging, futureDay, slotId, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('STAFF-MANAGED BOOKING (AI booking switch OFF): real Grist + real FLOW HQ server', () => {
  let s: Staging; let srv: Server; const DAY = futureDay(4); const rows = (t: string) => s.client.records(s.clinicDocId, t);
  const MORNING = slotId('DR-001', DAY, '10:00'); const MORNING2 = slotId('DR-001', DAY, '10:30'); const EVENING = slotId('DR-002', DAY, '16:30');
  const P1 = '+919000040001'; const P2 = '+919000040002'; let ref = ''; let eveRef = '';
  const raw = (path: string, o: { method?: string; body?: unknown; cookie?: string } = {}) => fetch(`${srv.base}/api/w/${s.slug}/schedule${path}`, { method: o.method || 'GET', headers: { 'x-flowhq-csrf': '1', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const waitFor = async <T,>(fn: () => Promise<T> | T, ms = 40000, what = 'condition'): Promise<NonNullable<T>> => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await sleep(400); } throw new Error(`timed out waiting for ${what}`); };

  beforeAll(async () => { s = await createStaging('staff-booking-physio', { bookingOn: false }); srv = await startServer(s); }, 240000);
  afterAll(async () => { await srv?.stop('SIGKILL').catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); }, 120000);

  it('0. the AI switch is OFF, yet staff see the schedule and free slots (the switch limits the AI only)', async () => {
    const ov = await srv.staff('desk', '/overview'); expect(ov.status, ov.text).toBe(200);
    expect(ov.json.ai_booking.setting).toBe(false); expect(ov.json.ai_booking.available).toBe(false);
    const day = await srv.staff('desk', `/day?date=${DAY}`); expect(day.status, day.text).toBe(200);
    const open = day.json.slots.filter((x: { state: string }) => x.state === 'open'); expect(open.length).toBeGreaterThan(10);
    expect(new Set(day.json.slots.map((x: { doctor_id: string; shift: string }) => `${x.doctor_id}:${x.shift}`))).toEqual(new Set(['DR-001:morning', 'DR-002:evening']));   // the right doctor in the right shift only
  });

  it('1. staff create appointments: ONE per request; doctor, shift, time and source are right; read-back matches', async () => {
    const a = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: MORNING, idempotency_key: 'zz-staff-key-0001', patient: { name: 'ZZ Staff Synthetic One', phone: P1 }, reason: 'synthetic staff test' } });
    expect(a.status, a.text).toBe(201); ref = a.json.appointment.booking_reference; expect(ref).toBeTruthy();
    expect(a.json.appointment).toMatchObject({ doctor_id: 'DR-001', shift: 'morning', date: DAY, start_time: '10:00', source: 'Staff' });
    const e = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: EVENING, idempotency_key: 'zz-staff-key-0002', patient: { name: 'ZZ Staff Synthetic Two', phone: P2 } } });
    expect(e.status, e.text).toBe(201); eveRef = e.json.appointment.booking_reference; expect(e.json.appointment).toMatchObject({ doctor_id: 'DR-002', shift: 'evening', start_time: '16:30' });
    const det = await srv.staff('desk', `/appointments/${ref}`); expect(det.status).toBe(200); expect(det.json.appointment).toMatchObject({ booking_reference: ref, doctor_id: 'DR-001', shift: 'morning', date: DAY, start_time: '10:00' });
    const list = await srv.staff('desk', `/appointments?from=${DAY}&to=${DAY}`); expect(list.json.rows.map((x: { booking_reference: string }) => x.booking_reference).sort()).toEqual([ref, eveRef].sort());
    const grist = (await rows('Appointments')).filter((r) => [ref, eveRef].includes(String(r.fields.Booking_UID))); expect(grist).toHaveLength(2);
    for (const r of grist) { expect(r.fields.Audit_ID).toBeTruthy(); expect(String(r.fields.Created_By)).toMatch(/desk@test/); }   // written by FLOW HQ with an audit id, by the signed-in user
  });

  it('2. duplicate and double-booking protection: same key replays; same patient again = refused; another patient in the full slot = refused; exactly one row for the slot', async () => {
    const replay = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: MORNING, idempotency_key: 'zz-staff-key-0001', patient: { name: 'ZZ Staff Synthetic One', phone: P1 }, reason: 'synthetic staff test' } });
    expect(replay.status).toBe(200); expect(replay.json.appointment.booking_reference).toBe(ref); expect(replay.json.replayed).toBe(true);
    const twin = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: MORNING, idempotency_key: 'zz-staff-key-0003', patient: { name: 'ZZ Staff Synthetic One', phone: P1 } } });
    expect(twin.status, twin.text).toBe(409); expect(['duplicate_booking', 'slot_unavailable']).toContain(twin.json.error.code);   // capacity 1: the full slot is reported first; duplicate_booking applies to slots with spare capacity
    const other = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: MORNING, idempotency_key: 'zz-staff-key-0004', patient: { name: 'ZZ Someone Else', phone: '+919000040003' } } });
    expect(other.status, other.text).toBe(409); expect(other.json.error.code).toBe('slot_unavailable');
    const wrongShift = await srv.staff('desk', '/appointments', { method: 'POST', body: { slot_id: slotId('DR-002', DAY, '10:00'), idempotency_key: 'zz-staff-key-0005', patient: { name: 'ZZ Wrong Shift', phone: '+919000040004' } } });
    expect(wrongShift.status).toBe(409);   // Dr Sandeep has no morning slot: a time that does not exist cannot be booked
    expect((await rows('Appointments')).filter((r) => String(r.fields.Slot_Key) === MORNING)).toHaveLength(1);
  });

  it('3. reschedule keeps the SAME reference, frees the old slot and takes the new one', async () => {
    const mv = await srv.staff('desk', `/appointments/${ref}`, { method: 'PATCH', body: { slot_id: MORNING2, reason: 'synthetic move' } }); expect(mv.status, mv.text).toBe(200);
    expect(mv.json.appointment).toMatchObject({ booking_reference: ref, start_time: '10:30', doctor_id: 'DR-001', shift: 'morning' });
    const day = await srv.staff('desk', `/day?date=${DAY}&doctor_id=DR-001`); const st = (t: string) => day.json.slots.find((x: { start_time: string }) => x.start_time === t).state;
    expect(st('10:00')).toBe('open'); expect(st('10:30')).toBe('full');
    const into = await srv.staff('desk', `/appointments/${eveRef}`, { method: 'PATCH', body: { slot_id: MORNING2 } }); expect(into.status).toBe(409);   // cannot move onto a taken slot
  });

  it('4. cancel frees the slot and is idempotent; the record is kept (never deleted)', async () => {
    const c1 = await srv.staff('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: { reason: 'synthetic cancel' } }); expect(c1.status, c1.text).toBe(200); expect(c1.json.already_cancelled).toBe(false); expect(c1.json.appointment.status).toBe('Cancelled');
    const c2 = await srv.staff('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: {} }); expect(c2.json.already_cancelled).toBe(true);
    expect((await rows('Appointments')).some((r) => r.fields.Booking_UID === ref && r.fields.Status === 'Cancelled')).toBe(true);
    const day = await srv.staff('desk', `/day?date=${DAY}&doctor_id=DR-001`); expect(day.json.slots.find((x: { start_time: string }) => x.start_time === '10:30').state).toBe('open');
  });

  it('5. audit: every operation is recorded (who, what, outcome), refusals too; only an admin can read the log', async () => {
    await waitFor(async () => (await rows('Booking_Audit')).length >= 6, 40000, 'the audit outbox to flush');
    const log = await rows('Booking_Audit'); const text = JSON.stringify(log.map((r) => r.fields));
    expect(text).toContain('desk@test'); for (const x of [ref, eveRef]) expect(text).toContain(x);
    expect(log.some((r) => r.fields.Outcome === 'ok')).toBe(true); expect(log.some((r) => r.fields.Outcome === 'rejected')).toBe(true);
    expect((await srv.staff('desk', '/audit')).status).toBe(403);
    const adm = await srv.staff('admin', '/audit'); expect(adm.status, adm.text).toBe(200);
    // the recovery state of the outbox (this staging server has no persistent volume, so its health colour is not asserted): nothing lost, nothing waiting, no corrupt line
    const ah = (await srv.staff('admin', '/overview')).json.audit_health; expect([ah.failed_since_start, ah.corrupt_lines, ah.open_intents, ah.unsaved_outcomes, ah.waiting_to_flush], JSON.stringify(ah)).toEqual([0, 0, 0, 0, 0]);
  });

  it('6. the wrong people cannot manage appointments: signed-out = 401 everywhere; front desk cannot change settings or the AI switch; a service token cannot use the staff routes', async () => {
    for (const [m, p, b] of [['GET', '/overview'], ['GET', '/appointments'], ['POST', '/appointments', { slot_id: MORNING, idempotency_key: 'zz-nobody-0001', patient: { name: 'X', phone: P1 } }], ['PATCH', `/appointments/${eveRef}`, { slot_id: MORNING }], ['POST', `/appointments/${eveRef}/cancel`, {}]] as Array<[string, string, unknown?]>) {
      const r = await raw(p, { method: m, body: b }); expect(r.status, `${m} ${p}`).toBe(401);
    }
    const sw = await srv.staff('desk', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } }); expect(sw.status, sw.text).toBe(403);
    expect((await srv.staff('desk', '/settings', { method: 'PUT', body: { values: { slot_minutes: '15' } } })).status).toBe(403);
    const tok = await fetch(`${srv.base}/api/w/${s.slug}/schedule/appointments`, { headers: { authorization: `Bearer ${srv.token}` } }); expect(tok.status).toBe(401);
    const ov = await srv.staff('admin', '/overview'); expect(ov.json.ai_booking.setting).toBe(false);   // nothing above changed the switch
  });

  it('7. THE AI CANNOT BOOK while the switch is off: availability for the AI is empty, create / move / cancel through the service token are refused (403), and nothing is written', async () => {
    const before = (await rows('Appointments')).length;
    const cfg = await srv.api('/config'); expect(cfg.status).toBe(200); expect(cfg.json.ai_booking.enabled).toBe(false); expect(cfg.json.booking_enabled).toBe(false);
    const av = await srv.api(`/availability?date=${DAY}`); expect(av.status).toBe(200); expect(av.json.ai_booking.available).toBe(false); expect(av.json.slots).toEqual([]);
    const mk = await srv.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'zz-ai-key-00001' }, body: { slot_id: MORNING, patient: { name: 'ZZ AI Attempt', phone: '+919000040009' } } });
    expect(mk.status, mk.text).toBe(403); expect(mk.json.error.code).toBe('ai_booking_disabled');
    const mv = await srv.api(`/appointments/${eveRef}`, { method: 'PATCH', body: { patient_phone: P2, slot_id: MORNING2 } }); expect(mv.status, mv.text).toBe(403);
    expect((await rows('Appointments')).length).toBe(before);   // create and move wrote nothing
    // Owner decision (1 Nov 2026): the AI path is read-only while the switch is off, so it cannot cancel either (the owner's phone or a stranger's: the same 403).
    for (const phone of ['+919000049999', P2]) { const c = await srv.api(`/appointments/${eveRef}/cancel`, { method: 'POST', body: { patient_phone: phone } }); expect(c.status, c.text).toBe(403); expect(c.json.error.code).toBe('ai_booking_disabled'); }
    expect((await rows('Appointments')).find((r) => r.fields.Booking_UID === eveRef)!.fields.Status).not.toBe('Cancelled');
    expect((await rows('Appointments')).length).toBe(before);
    // staff cancellation is not gated by the AI switch
    const staffCx = await srv.staff('desk', `/appointments/${eveRef}/cancel`, { method: 'POST', body: { reason: 'synthetic cleanup' } }); expect(staffCx.status, staffCx.text).toBe(200);
    expect((await rows('Appointments')).find((r) => r.fields.Booking_UID === eveRef)!.fields.Status).toBe('Cancelled');
  });

  it('8. the permissions table: front desk and admin may book; settings, the AI switch and the audit log are admin only', async () => {
    const mine = await srv.staff('admin', '/appointments', { method: 'POST', body: { slot_id: slotId('DR-001', DAY, '11:00'), idempotency_key: 'zz-admin-key-001', patient: { name: 'ZZ Admin Synthetic', phone: '+919000040005' } } }); expect(mine.status, mine.text).toBe(201);
    const ok = await srv.staff('desk', `/appointments/${mine.json.appointment.booking_reference}/cancel`, { method: 'POST', body: {} }); expect(ok.status).toBe(200);
    void PW;
  });
});
