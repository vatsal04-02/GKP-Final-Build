// Staff attendance on a REAL Grist: the optional table is created by the real provisioning code, marks are saved with the real column types,
// and the REAL server process (src/server/index.ts) serves them again after a restart. Throwaway staging Grist, synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordsService, type Actor, type StaffPerson } from '../../src/server/records/service';
import { provision } from '../../src/server/records/provision';
import { ALL_RECORD_COLUMNS, STAFF_ATT } from '../../src/server/records/schema';
import { PW, REAL_ENABLED, createStaging, deleteStaging, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const ADMIN: Actor = { email: 'admin@test', name: 'Owner', role: 'admin' };
const TEAM: StaffPerson[] = [{ key: 'admin@test', name: 'Owner' }, { key: 'desk@test', name: 'Front desk' }];
const CLINIC = { idPrefix: 'GK', name: 'Staging', tagline: '', address: '', phones: [], timings: '', runBy: '', clinicians: [], tax: null };

d('staff attendance on a real Grist', () => {
  let s: Staging; let srv: Server | undefined;
  beforeAll(async () => { s = await createStaging('staff-att', { provision: false }); }, 120000);
  afterAll(async () => { if (srv) await srv.stop().catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); });

  it('the provisioning tool creates the table with real Date / DateTime / Choice columns, adds nothing on a second run, and never touches the other tables', async () => {
    expect(await s.client.tableIds(s.clinicDocId)).not.toContain(STAFF_ATT);
    const lines: string[] = [];
    expect((await provision(s.client, s.clinicDocId, true, (l) => lines.push(l), ALL_RECORD_COLUMNS)).changes).toBe(1);
    expect(lines).toEqual([`creating table ${STAFF_ATT} (${ALL_RECORD_COLUMNS[STAFF_ATT]!.length} columns)`]);
    expect((await s.client.columnIds(s.clinicDocId, STAFF_ATT)).sort()).toEqual(ALL_RECORD_COLUMNS[STAFF_ATT]!.map(([n]) => n).sort());
    expect((await provision(s.client, s.clinicDocId, true, () => {}, ALL_RECORD_COLUMNS)).changes).toBe(0);
  }, 60000);

  it('marks are stored with the right types, survive a new service instance, and every change is in the audit log', async () => {
    const now = Date.UTC(2026, 9, 7, 3, 45);   // 09:15 IST on Wednesday 2026-10-07
    const svc = () => new RecordsService(s.client, s.clinicDocId, { tz: 'Asia/Kolkata', clinic: () => CLINIC, now: () => now });
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-05', status: 'Present', checkIn: '09:10', checkOut: '17:30', notes: 'on time' }, TEAM, ADMIN);
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-06', status: 'Leave' }, TEAM, ADMIN);
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-06', status: 'Half day', checkIn: '09:00', checkOut: '13:00' }, TEAM, ADMIN);   // same day: updated in place
    const inn = await svc().clockStaff('admin@test', 'in', TEAM, ADMIN);
    expect(inn.mark).toMatchObject({ status: 'Present', checkIn: '09:15' });
    expect((await svc().clockStaff('admin@test', 'in', TEAM, ADMIN)).duplicate).toBe(true);

    const raw = await s.client.records(s.clinicDocId, STAFF_ATT);
    expect(raw).toHaveLength(3);                                                   // 2 for desk (the 6th was updated, not duplicated) + 1 for admin
    const monday = raw.find((r) => r.fields.Staff_Key === 'desk@test' && r.fields.Status === 'Present')!.fields;
    expect(monday).toMatchObject({ Staff_Name: 'Front desk', Check_In: '09:10', Check_Out: '17:30', Notes: 'on time', Recorded_By: 'admin@test' });
    expect(monday.Att_Date).toBe(Date.UTC(2026, 9, 5) / 1000);                    // a real Grist Date: UTC-midnight epoch seconds
    expect(typeof monday.Created_At).toBe('number'); expect(typeof monday.Updated_At).toBe('number');

    const week = await svc().staffWeek('2026-10-07', TEAM, 'admin@test');         // a fresh instance reads it all back from Grist
    expect(week.rows.find((r) => r.key === 'desk@test')!.cells['2026-10-06']).toMatchObject({ status: 'Half day', checkIn: '09:00', checkOut: '13:00' });
    expect(week.rows.find((r) => r.key === 'admin@test')!.cells['2026-10-07']).toMatchObject({ status: 'Present', checkIn: '09:15', checkOut: '' });
    const month = await svc().staffMonth('2026-10', TEAM);
    expect(month.rows.find((r) => r.key === 'desk@test')).toMatchObject({ present: 1, halfDay: 1, workedMinutes: 8 * 60 + 20 + 4 * 60 });

    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-06', status: null }, TEAM, ADMIN);   // clearing keeps the row
    expect((await s.client.records(s.clinicDocId, STAFF_ATT))).toHaveLength(3);
    const audit = (await s.client.records(s.clinicDocId, 'Audit_Log')).map((r) => String(r.fields.Action));
    expect(audit.filter((a) => a === 'staffatt.set')).toHaveLength(4); expect(audit.filter((a) => a === 'staffatt.checkin')).toHaveLength(1);
  }, 90000);

  it('through the real server: the page is offered, a mark is saved over HTTP, and it is still there after the server restarts', async () => {
    srv = await startServer(s);
    const login = async (base: string) => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'desk@test', password: PW }) }); return r.headers.get('set-cookie')!.split(';')[0]!; };
    const call = async (base: string, cookie: string, p: string, method = 'GET', body?: unknown) => { const r = await fetch(`${base}/api/w/${s.slug}${p}`, { method, headers: { cookie, 'x-flowhq-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: (await r.json()) as any }; };
    let cookie = await login(srv.base);
    let ws = await call(srv.base, cookie, '/workspace');
    for (let i = 0; i < 20 && !ws.json.modules.includes('staff_attendance'); i++) { await new Promise((r) => setTimeout(r, 500)); ws = await call(srv.base, cookie, '/workspace'); }   // the table probe refreshes within seconds
    expect(ws.json.modules).toEqual(expect.arrayContaining(['patients', 'staff_attendance']));
    const w = await call(srv.base, cookie, '/staff-attendance'); const today = w.json.today as string;
    expect(w.status).toBe(200);
    const keys = (w.json.rows as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['admin@test', 'desk@test', 'doctor:dr. sandeep tiwari', 'doctor:dr. mahesh tiwari']));   // the two doctors in config/clinic.json have no login here
    const put = await call(srv.base, cookie, '/staff-attendance', 'PUT', { staffKey: 'doctor:dr. mahesh tiwari', date: today, status: 'Present', checkIn: '09:05', notes: 'saved over HTTP' });
    expect([put.status, put.json.mark.status]).toEqual([200, 'Present']);

    await srv.stop(); srv = await startServer(s, { reuse: srv });                // restart the real server process
    cookie = await login(srv.base);
    for (let i = 0; i < 20; i++) { const m = await call(srv.base, cookie, '/workspace'); if (m.json.modules?.includes('staff_attendance')) break; await new Promise((r) => setTimeout(r, 500)); }
    const after = await call(srv.base, cookie, '/staff-attendance');
    const mahesh = (after.json.rows as Array<{ key: string; cells: Record<string, { status: string; checkIn: string; notes: string } | null> }>).find((r) => r.key === 'doctor:dr. mahesh tiwari')!;
    expect(mahesh.cells[today]).toMatchObject({ status: 'Present', checkIn: '09:05', notes: 'saved over HTTP' });
    expect((await s.client.records(s.clinicDocId, STAFF_ATT)).some((r) => r.fields.Staff_Key === 'doctor:dr. mahesh tiwari' && r.fields.Notes === 'saved over HTTP')).toBe(true);
  }, 120000);
});
