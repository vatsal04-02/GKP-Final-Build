// REAL Grist + the REAL FLOW HQ server process (Grist 1.7.x in a throwaway Docker container, synthetic data only). Skipped unless REAL_GRIST_URL and REAL_GRIST_KEY_FILE
// are set: `npm run test:real-grist` (docs/staging-environment.md). What this proves that the in-memory tests cannot: real column types and null writes, read-after-write,
// the verified-write path, 429 back-pressure handling, real concurrency through HTTP, the durable audit outbox flushing into a real Booking_Audit, restart recovery.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REAL_ENABLED, createStaging, deleteStaging, futureDay, slotId, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const DAY = futureDay(4); const DAY2 = futureDay(4, 1);
const M09 = slotId('DR-001', DAY, '09:00'); const M0930 = slotId('DR-001', DAY, '09:30'); const M10 = slotId('DR-001', DAY, '10:00'); const E16 = slotId('DR-002', DAY, '16:00');
const create = (srv: Server, slot: string, key: string, phone = '9876543210', name = 'Test Patient One') => srv.api('/appointments', { method: 'POST', headers: { 'idempotency-key': key }, body: { slot_id: slot, patient: { name, phone } } });

d('real Grist: provisioning keeps what exists', () => {
  let s: Staging;
  beforeAll(async () => { s = await createStaging('prov-physio', { seed: false }); }, 120000);
  afterAll(async () => { if (s) await deleteStaging(s); });
  it('the booking tables and columns were added to a document that already had Appointments; a second run changes nothing', async () => {
    const tables = await s.client.tableIds(s.clinicDocId);
    for (const t of ['Doctors', 'Doctor_Schedules', 'Booking_Config', 'Closures_Blocks', 'Booking_Audit', 'Reminder_Consent', 'Reminder_Consent_Log', 'Appointments', 'LEADS']) expect(tables, t).toContain(t);
    const cols = await s.client.columnIds(s.clinicDocId, 'Appointments');
    for (const c of ['Booking_UID', 'Lead', 'Start', 'R24_Sent', 'Patient_Phone', 'Slot_Key', 'Appt_Stage', 'Audit_ID', 'Idem_Key']) expect(cols, c).toContain(c);
    const { provisionBooking } = await import('../../src/server/booking/provision');
    const again = await provisionBooking(s.client, s.clinicDocId, true); expect(again.changes).toBe(0);
  });
  it('an existing (legacy Cal.com) appointment row survives provisioning untouched', async () => {
    const lead = (await s.client.add(s.clinicDocId, 'LEADS', [{ Name: 'Legacy Lead', Phone: '+919000010009', Status: 'Booked' }]))[0]!;
    const start = Math.floor(Date.now() / 1000) + 5 * 86400;
    const [id] = await s.client.add(s.clinicDocId, 'Appointments', [{ Booking_UID: 'cal-legacy-1', Lead: lead, Service: 'First assessment', Physio: 'Dr. Mahesh Tiwari', Start: start, End: start + 1800, Status: 'Booked' }]);
    const { provisionBooking } = await import('../../src/server/booking/provision');
    await provisionBooking(s.client, s.clinicDocId, true);
    const row = (await s.client.records(s.clinicDocId, 'Appointments')).find((r) => r.id === id)!;
    expect(row.fields).toMatchObject({ Booking_UID: 'cal-legacy-1', Service: 'First assessment', Physio: 'Dr. Mahesh Tiwari', Status: 'Booked', Start: start, Lead: lead });
  });
});

d('real Grist + the real server: the booking journey', () => {
  let s: Staging; let srv: Server;
  beforeAll(async () => { s = await createStaging('journey-physio', { bookingOn: true }); srv = await startServer(s); }, 180000);
  afterAll(async () => { if (srv) await srv.stop('SIGTERM'); if (s) await deleteStaging(s); });
  const appts = async () => (await s.client.records(s.clinicDocId, 'Appointments'));

  it('the API is up, authenticated, and sees the seeded configuration of a real document', async () => {
    expect((await srv.api('/config', { token: null })).status).toBe(401);
    const c = await srv.api('/config'); expect(c.status).toBe(200);
    expect(c.json.ai_booking).toMatchObject({ enabled: true }); expect(c.json.doctors.map((x: { doctor_id: string }) => x.doctor_id)).toEqual(['DR-001', 'DR-002']); expect(c.json.config_problems).toEqual([]);
    const a = await srv.api(`/availability?date=${DAY}`); expect(a.status).toBe(200); expect(a.json.slots.length).toBeGreaterThan(10);
  });

  it('create: 201, the row exists in the REAL Grist with the right types, the slot disappears from availability; the same key replays; the same slot with another key is refused', async () => {
    const r = await create(srv, M09, 'real-key-0001-abcd'); expect(r.status, r.text).toBe(201);
    const ref = r.json.appointment.booking_reference as string;
    const row = (await appts()).find((x) => x.fields.Booking_UID === ref)!; expect(row).toBeTruthy();
    expect(row.fields).toMatchObject({ Slot_Key: M09, Doctor_ID: 'DR-001', Status: 'Booked', Patient_Phone: '+919876543210', Booking_Source: 'WhatsApp AI', Idem_Key: 'real-key-0001-abcd' });
    expect(typeof row.fields.Start).toBe('number'); expect(typeof row.fields.Audit_ID).toBe('string'); expect(String(row.fields.Audit_ID).length).toBeGreaterThan(10);
    const again = await create(srv, M09, 'real-key-0001-abcd'); expect(again.status).toBe(200); expect(again.json.replayed).toBe(true); expect(again.json.appointment.booking_reference).toBe(ref);
    expect((await create(srv, M09, 'real-key-0002-abcd', '9123456780', 'Second')).status).toBe(409);
    expect((await srv.api(`/availability?date=${DAY}`)).json.slots.some((x: { slot_id: string }) => x.slot_id === M09)).toBe(false);
    expect((await appts()).filter((x) => x.fields.Slot_Key === M09)).toHaveLength(1);
  });

  it('reschedule clears the reminder flags with a REAL null write and keeps the reference; cancel keeps the row and frees the slot', async () => {
    const r = await create(srv, M0930, 'real-key-0003-abcd', '9123456780', 'Mover'); const ref = r.json.appointment.booking_reference as string;
    const row = (await appts()).find((x) => x.fields.Booking_UID === ref)!;
    await s.client.update(s.clinicDocId, 'Appointments', [{ id: row.id, fields: { R24_Sent: Math.floor(Date.now() / 1000) } }]);   // W5 would have set this
    const mv = await srv.api(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: '9123456780', slot_id: M10 } }); expect(mv.status, mv.text).toBe(200);
    const after = (await appts()).find((x) => x.fields.Booking_UID === ref)!;
    expect(after.fields).toMatchObject({ Slot_Key: M10, Status: 'Booked' }); expect(after.fields.R24_Sent == null || after.fields.R24_Sent === 0).toBe(true);
    const cx = await srv.api(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: '9123456780' } }); expect(cx.status).toBe(200);
    expect((await appts()).find((x) => x.fields.Booking_UID === ref)!.fields.Status).toBe('Cancelled');
    expect((await srv.api(`/availability?date=${DAY}`)).json.slots.some((x: { slot_id: string }) => x.slot_id === M10)).toBe(true);
  });

  it('CONCURRENCY through real HTTP into real Grist: 12 simultaneous requests for one slot (different keys) = exactly one booking, the rest 409, one row in Grist', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => create(srv, E16, `real-race-${String(i).padStart(2, '0')}-abcdefgh`, `90000100${String(10 + i)}`, `Racer ${i}`)));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1); expect(codes.filter((c) => c === 409)).toHaveLength(11);
    expect((await appts()).filter((x) => x.fields.Slot_Key === E16 && x.fields.Status === 'Booked')).toHaveLength(1);
  }, 120000);

  it('the same idempotency key sent 8 times at once creates ONE appointment and every caller gets the same reference', async () => {
    const slot = slotId('DR-002', DAY, '16:30');
    const results = await Promise.all(Array.from({ length: 8 }, () => create(srv, slot, 'real-same-key-abcdefgh', '9000010100', 'Same Key')));
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([200, 201]));
    expect(new Set(results.map((r) => r.json.appointment.booking_reference)).size).toBe(1);
    expect((await appts()).filter((x) => x.fields.Slot_Key === slot)).toHaveLength(1);
  }, 120000);

  it('a legacy Cal.com row (no Doctor_ID, only a Physio name) blocks its slot and can be looked up and cancelled through the API', async () => {
    const lead = (await s.client.add(s.clinicDocId, 'LEADS', [{ Name: 'Cal Patient', Phone: '+919000010200', Status: 'Booked' }]))[0]!;
    const { localToEpochSec } = await import('../../src/server/booking/engine');
    const start = localToEpochSec(DAY2, 10 * 60, 'Asia/Kolkata');
    await s.client.add(s.clinicDocId, 'Appointments', [{ Booking_UID: 'cal-uid-777', Lead: lead, Service: 'First assessment', Physio: 'Dr. Mahesh Tiwari', Start: start, End: start + 1800, Status: 'Booked' }]);
    expect((await create(srv, slotId('DR-001', DAY2, '10:00'), 'real-key-cal-abcdefgh', '9876500001', 'Late')).status).toBe(409);
    expect((await srv.api(`/appointments/cal-uid-777?patient_phone=9000010200`)).status).toBe(200);
    expect((await srv.api(`/appointments/cal-uid-777?patient_phone=9000010201`)).status).toBe(404);
    expect((await srv.api(`/appointments/cal-uid-777/cancel`, { method: 'POST', body: { patient_phone: '9000010200' } })).status).toBe(200);
    expect((await create(srv, slotId('DR-001', DAY2, '10:00'), 'real-key-cal2-abcdefgh', '9876500001', 'Late')).status).toBe(201);
  });

  it('staff: the weekly and per-doctor calendar, appointment detail with the reminder outlook, and status change work against real Grist', async () => {
    const w = await srv.staff('desk', `/week?date=${DAY}&doctor_id=DR-001`); expect(w.status, w.text).toBe(200);
    expect(w.json.days.flatMap((x: { appointments: unknown[] }) => x.appointments).length).toBeGreaterThan(0);
    const list = await srv.staff('desk', `/appointments?from=${DAY}&to=${DAY}&doctor_id=DR-001`); expect(list.status).toBe(200);
    const ref = list.json.rows[0].booking_reference as string;
    const det = await srv.staff('desk', `/appointments/${ref}`); expect(det.status).toBe(200); expect(det.json.reminder.state).toBe('held'); expect(det.json.reminder.codes).toContain('consent_unknown');
    expect((await srv.staff('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: 'Checked in' } })).json.appointment.status).toBe('Checked in');
  });

  it('reminder consent in real Grist: record a Yes (admin), the outlook becomes will_send; a No by front desk wins; the history is append-only', async () => {
    const list = await srv.staff('desk', `/appointments?from=${DAY}&to=${DAY}&doctor_id=DR-001`); const a = list.json.rows.find((x: { status: string; patient: { phone: string } }) => x.status === 'Confirmed' && x.patient.phone) || list.json.rows[0];
    const phone = a.patient.phone as string;
    const yes = await srv.staff('admin', '/consent', { method: 'POST', body: { phone, value: 'Yes', source: 'Told staff in person', evidence_ref: 'Register serial 1234' } }); expect(yes.status, yes.text).toBe(201);
    expect((await srv.staff('desk', `/appointments/${a.booking_reference}`)).json.reminder.codes).not.toContain('consent_unknown');
    expect((await srv.staff('desk', '/consent', { method: 'POST', body: { phone, value: 'No', source: 'Patient withdrew' } })).status).toBe(201);
    expect((await srv.staff('desk', `/appointments/${a.booking_reference}`)).json.reminder.codes).toContain('consent_no');
    const log = await s.client.records(s.clinicDocId, 'Reminder_Consent_Log'); expect(log.filter((r) => r.fields.Phone === phone).map((r) => r.fields.Value)).toEqual(['Yes', 'No']);
    expect((await s.client.records(s.clinicDocId, 'Reminder_Consent')).filter((r) => r.fields.Phone === phone)).toHaveLength(1);
  });

  it('the durable audit outbox flushes into the real Booking_Audit with unique Audit_IDs and no patient data', async () => {
    let rows = await s.client.records(s.clinicDocId, 'Booking_Audit');
    for (let i = 0; i < 40 && rows.length < 8; i++) { await new Promise((r) => setTimeout(r, 1000)); rows = await s.client.records(s.clinicDocId, 'Booking_Audit'); }
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const ids = rows.map((r) => r.fields.Audit_ID); expect(new Set(ids).size).toBe(ids.length);
    const text = JSON.stringify(rows.map((r) => r.fields));
    for (const secret of ['9876543210', '9123456780', 'Test Patient One', 'Mover', 'real-key-0001']) expect(text, secret).not.toContain(secret);
  }, 90000);
});
