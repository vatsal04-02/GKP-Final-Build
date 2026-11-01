// Staff attendance on a REAL Grist: the optional tables are created by the real provisioning code (including the production case: an older Staff_Attendance
// that still has the two unused clock-time columns), names are added and removed, marks are saved with the real column types, and the REAL server process
// (src/server/index.ts) serves them again after a restart. Throwaway staging Grist, synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordsService, type Actor, type StaffPerson } from '../../src/server/records/service';
import { provision } from '../../src/server/records/provision';
import { ALL_RECORD_COLUMNS, STAFF_ATT, STAFF_COLUMNS, STAFF_MEMBERS } from '../../src/server/records/schema';
import { PW, REAL_ENABLED, createStaging, deleteStaging, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const ADMIN: Actor = { email: 'admin@test', name: 'Owner', role: 'admin' };
const TEAM: StaffPerson[] = [{ key: 'admin@test', name: 'Owner' }, { key: 'desk@test', name: 'Front desk' }];
const CLINIC = { idPrefix: 'GK', name: 'Staging', tagline: '', address: '', phones: [], timings: '', runBy: '', clinicians: [], tax: null };
const NOW = Date.UTC(2026, 9, 7, 3, 45);   // Wednesday 2026-10-07 09:15 IST

d('staff attendance on a real Grist', () => {
  let s: Staging; let srv: Server | undefined;
  beforeAll(async () => { s = await createStaging('staff-att', { provision: false }); }, 120000);
  afterAll(async () => { if (srv) await srv.stop().catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); });
  const svc = () => new RecordsService(s.client, s.clinicDocId, { tz: 'Asia/Kolkata', clinic: () => CLINIC, now: () => NOW });

  it('PRODUCTION CASE: an older Staff_Attendance (with Check_In / Check_Out) already exists; provisioning adds only Staff_Members, changes nothing else, and is repeatable', async () => {
    // exactly what production has today: the first version of the table, with the two clock-time columns
    await s.client.createTable(s.clinicDocId, STAFF_ATT, [...STAFF_COLUMNS[STAFF_ATT].map(([n]) => n), 'Check_In', 'Check_Out'].map((id) => ({ id, fields: { type: id === 'Att_Date' ? 'Date' : id === 'Status' ? 'Choice' : id === 'Created_At' || id === 'Updated_At' ? 'DateTime:Asia/Kolkata' : 'Text', label: id, ...(id === 'Status' ? { widgetOptions: JSON.stringify({ choices: ['Present', 'Absent', 'Half day', 'Leave'] }) } : {}) } })) as never);
    const before = (await s.client.columnIds(s.clinicDocId, STAFF_ATT)).sort();
    expect(await s.client.tableIds(s.clinicDocId)).not.toContain(STAFF_MEMBERS);
    const lines: string[] = [];
    expect((await provision(s.client, s.clinicDocId, true, (l) => lines.push(l), ALL_RECORD_COLUMNS)).changes).toBe(1);
    expect(lines).toEqual([`creating table ${STAFF_MEMBERS} (${STAFF_COLUMNS[STAFF_MEMBERS].length} columns)`]);
    expect((await s.client.columnIds(s.clinicDocId, STAFF_ATT)).sort()).toEqual(before);                                  // untouched
    expect((await s.client.columnIds(s.clinicDocId, STAFF_MEMBERS)).sort()).toEqual(STAFF_COLUMNS[STAFF_MEMBERS].map(([n]) => n).sort());
    expect((await provision(s.client, s.clinicDocId, true, () => {}, ALL_RECORD_COLUMNS)).changes).toBe(0);
  }, 90000);

  it('names are added and removed with real Bool / DateTime columns; marks keep their real Date type; nothing is lost across new service instances; all audited', async () => {
    const a = await svc().addStaffMember('  Priya   Sharma ', TEAM.map((p) => p.name), ADMIN);
    expect([a.member.key, a.member.name, a.reactivated]).toEqual(['staff:000001', 'Priya Sharma', false]);
    const rawM = (await s.client.records(s.clinicDocId, STAFF_MEMBERS))[0]!.fields;
    expect(rawM).toMatchObject({ Staff_Key: 'staff:000001', Name: 'Priya Sharma', Active: true, Created_By: 'admin@test' }); expect(typeof rawM.Created_At).toBe('number');

    let team = [...TEAM, ...(await svc().activeStaffMembers())];
    expect(team.map((p) => p.name)).toEqual(['Owner', 'Front desk', 'Priya Sharma']);
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-05', status: 'Present', notes: 'on time' }, team, ADMIN);
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-06', status: 'Leave' }, team, ADMIN);
    await svc().setStaffMark({ staffKey: 'desk@test', date: '2026-10-06', status: 'Half day' }, team, ADMIN);                // same day: updated in place
    await svc().setStaffMark({ staffKey: 'staff:000001', date: '2026-10-05', status: 'Absent' }, team, ADMIN);
    const raw = await s.client.records(s.clinicDocId, STAFF_ATT);
    expect(raw).toHaveLength(3);
    const monday = raw.find((r) => r.fields.Staff_Key === 'desk@test' && r.fields.Status === 'Present')!.fields;
    expect(monday).toMatchObject({ Staff_Name: 'Front desk', Notes: 'on time', Recorded_By: 'admin@test', Check_In: '', Check_Out: '' });   // the old time columns stay empty
    expect(monday.Att_Date).toBe(Date.UTC(2026, 9, 5) / 1000);                                                              // a real Grist Date

    // remove, then read through a fresh instance: hidden from the list, past mark kept; add again: back with the same key
    await svc().removeStaffMember('staff:000001', ADMIN);
    expect((await s.client.records(s.clinicDocId, STAFF_MEMBERS))[0]!.fields.Active).toBe(false);
    team = [...TEAM, ...(await svc().activeStaffMembers())];
    expect(team.map((p) => p.key)).toEqual(['admin@test', 'desk@test']);
    const week = await svc().staffWeek('2026-10-07', team, 'x');
    expect(week.rows.find((r) => r.key === 'staff:000001')).toMatchObject({ former: true, name: 'Priya Sharma' });
    expect(week.rows.find((r) => r.key === 'staff:000001')!.cells['2026-10-05']!.status).toBe('Absent');
    expect((await svc().addStaffMember('priya sharma', TEAM.map((p) => p.name), ADMIN)).reactivated).toBe(true);
    expect((await s.client.records(s.clinicDocId, STAFF_MEMBERS))).toHaveLength(1);

    const month = await svc().staffMonth('2026-10', [...TEAM, ...(await svc().activeStaffMembers())]);
    expect(month.rows.find((r) => r.key === 'desk@test')).toMatchObject({ present: 1, halfDay: 1, absent: 0, leave: 0 });
    expect(month.rows.find((r) => r.key === 'staff:000001')).toMatchObject({ absent: 1 });

    const audit = (await s.client.records(s.clinicDocId, 'Audit_Log')).map((r) => String(r.fields.Action));
    expect(audit.filter((x) => x === 'staff.add')).toHaveLength(2); expect(audit.filter((x) => x === 'staff.remove')).toHaveLength(1); expect(audit.filter((x) => x === 'staffatt.set')).toHaveLength(4);
  }, 90000);

  it('through the real server: the page is offered, a name is added and marked over HTTP, and all of it is still there after the server restarts', async () => {
    srv = await startServer(s);
    const login = async (base: string) => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'desk@test', password: PW }) }); return r.headers.get('set-cookie')!.split(';')[0]!; };
    const call = async (base: string, cookie: string, p: string, method = 'GET', body?: unknown) => { const r = await fetch(`${base}/api/w/${s.slug}${p}`, { method, headers: { cookie, 'x-flowhq-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: (await r.json()) as any }; };
    const waitModule = async (base: string, cookie: string) => { let ws = await call(base, cookie, '/workspace'); for (let i = 0; i < 20 && !ws.json.modules.includes('staff_attendance'); i++) { await new Promise((r) => setTimeout(r, 500)); ws = await call(base, cookie, '/workspace'); } return ws; };
    let cookie = await login(srv.base);
    const ws = await waitModule(srv.base, cookie);
    expect(ws.json.modules).toEqual(expect.arrayContaining(['patients', 'staff_attendance']));
    const w = await call(srv.base, cookie, '/staff-attendance'); const today = w.json.today as string;
    expect([w.status, w.json.canManageTeam]).toEqual([200, true]);
    expect((w.json.rows as Array<{ key: string }>).map((r) => r.key)).toEqual(expect.arrayContaining(['admin@test', 'desk@test', 'doctor:dr. sandeep tiwari', 'doctor:dr. mahesh tiwari', 'staff:000001']));   // Priya was added in the previous test
    const add = await call(srv.base, cookie, '/staff-attendance/members', 'POST', { name: 'Ravi Kumar' });
    expect([add.status, add.json.member.key]).toEqual([201, 'staff:000002']);
    expect((await call(srv.base, cookie, '/staff-attendance/members', 'POST', { name: 'ravi  kumar' })).status).toBe(409);
    const put = await call(srv.base, cookie, '/staff-attendance', 'PUT', { staffKey: 'staff:000002', date: today, status: 'Present', notes: 'saved over HTTP' });
    expect([put.status, put.json.mark]).toEqual([200, { status: 'Present', notes: 'saved over HTTP' }]);

    await srv.stop(); srv = await startServer(s, { reuse: srv });                // restart the real server process
    cookie = await login(srv.base); await waitModule(srv.base, cookie);
    const after = await call(srv.base, cookie, '/staff-attendance');
    const ravi = (after.json.rows as Array<{ key: string; name: string; removable: boolean; cells: Record<string, { status: string; notes: string } | null> }>).find((r) => r.key === 'staff:000002')!;
    expect([ravi.name, ravi.removable, ravi.cells[today]]).toEqual(['Ravi Kumar', true, { status: 'Present', notes: 'saved over HTTP' }]);
    expect((await call(srv.base, cookie, `/staff-attendance/members/${encodeURIComponent('staff:000002')}`, 'DELETE')).status).toBe(200);
    expect(((await call(srv.base, cookie, '/staff-attendance')).json.rows as Array<{ key: string; former: boolean }>).find((r) => r.key === 'staff:000002')!.former).toBe(true);   // hidden from the list, today's mark kept
    expect((await s.client.records(s.clinicDocId, STAFF_ATT)).some((r) => r.fields.Staff_Key === 'staff:000002' && r.fields.Notes === 'saved over HTTP')).toBe(true);
  }, 120000);
});
