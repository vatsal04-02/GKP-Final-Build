// The clinic records over HTTP: login, CSRF, roles, module gating, photo upload and download. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword, type UserRecord } from '../src/server/auth';
import { memoryGrist } from '../src/server/grist';
import { ProfileStore } from '../src/server/profiles';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';
import { RECORD_TABLE_NAMES, colNames } from '../src/server/records/schema';
import { loadClinicConfig } from '../src/server/clinic';

const NOW = Date.UTC(2026, 9, 7, 6, 30);
const PW = 'correct horse 42';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const J = { 'content-type': 'application/json', 'x-flowhq-csrf': '1' };
let app: ReturnType<typeof createApp>; let admin = ''; let staff = '';

beforeAll(async () => {
  const d = demoDocs(NOW);
  const physioDoc = (d.docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === 'demo-physio')!.fields.Grist_Doc_ID) as string;
  for (const t of RECORD_TABLE_NAMES) d.docs[physioDoc]![t] = [];            // only the physio clinic has the records tables
  const clinic = loadClinicConfig('config/clinic.json');
  const mem = memoryGrist(d.docs, { columns: Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, colNames(t)])) });
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, clinic, cacheMs: 0 });
  const h = hashPassword(PW);
  const users: UserRecord[] = [{ email: 'admin@test', name: 'Alex', role: 'admin', workspaces: ['*'], passwordHash: h }, { email: 'staff@test', name: 'Sam', role: 'staff', workspaces: ['demo-physio'], passwordHash: h }, { email: 'salon@test', name: 'Sal', role: 'staff', workspaces: ['demo-salon'], passwordHash: h }];
  app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: 'test-session-secret-0123456789abcdef-xyz', secureCookies: true, demo: false, now: () => NOW });
  const login = async (email: string) => (await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': email }, body: JSON.stringify({ email, password: PW }) })).headers.get('set-cookie')!.split(';')[0]!;
  admin = await login('admin@test'); staff = await login('staff@test');
});
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const r = await app.request(`/api/w/demo-physio${path}`, { method, headers: { cookie, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, json: t && t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : null, text: t };
};

describe('modules appear only where the records tables exist', () => {
  it('physio workspace gets the clinical modules; others do not; leads read as Enquiries', async () => {
    const w = (await call(admin, '/workspace')).json;
    expect(w.modules).toEqual(expect.arrayContaining(['patients', 'prescriptions', 'invoices', 'visits', 'contacts', 'bookings']));
    expect(w.terminology.contact.plural).toBe('Enquiries');
    const salon = await (await app.request('/api/w/demo-salon/workspace', { headers: { cookie: admin } })).json() as { modules: string[] };
    expect(salon.modules).not.toContain('patients');
    expect((await app.request('/api/w/demo-salon/patients', { headers: { cookie: admin } })).status).toBe(404);   // records_unavailable
  });
  it('existing endpoints still work', async () => { expect((await call(admin, '/contacts')).status).toBe(200); expect((await call(admin, '/dashboard')).status).toBe(200); });
});

describe('access control', () => {
  it('needs a session and the CSRF header; respects workspace access', async () => {
    expect((await app.request('/api/w/demo-physio/patients')).status).toBe(401);
    expect((await app.request('/api/w/demo-physio/patients', { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{"name":"X"}' })).status).toBe(403);
    const salon = (await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': 's' }, body: JSON.stringify({ email: 'salon@test', password: PW }) })).headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/api/w/demo-physio/patients', { headers: { cookie: salon } })).status).toBe(404);
  });
});

describe('end to end over HTTP', () => {
  let rxId = ''; let imageId = ''; let invoiceNo = ''; let patientId = '';
  it('register a patient; a duplicate is warned about', async () => {
    const r = await call(staff, '/patients', 'POST', { name: 'Http Test Patient', phone: '9876500001', mainComplaint: 'Back pain' });
    expect(r.status).toBe(201); patientId = r.json.patientId; expect(patientId).toBe('GK-P-000001');
    const dup = await call(staff, '/patients', 'POST', { name: 'Someone Else', phone: '+91 98765 00001' });
    expect([dup.status, dup.json.error.code, dup.json.matches[0].patientId]).toEqual([409, 'possible_duplicate', patientId]);
    expect((await call(staff, '/patients', 'POST', { name: '' })).status).toBe(400);
    expect((await call(staff, '/patients?q=http')).json.rows).toHaveLength(1);
  });
  it('prescription with a photo: saved, reopened, served only to a signed-in user', async () => {
    const p = await call(staff, '/prescriptions', 'POST', { patientId, rxDate: '2026-10-07', treatingPhysio: 'Dr Test', bp: '120/80', vitals: '', history: 'h', examination: 'e', diagnosis: 'd', treatmentPlan: 't', exercises: '', advice: 'a', followUpOn: null });
    expect(p.status).toBe(201); rxId = p.json.rxId;
    const fd = new FormData(); fd.append('file', new File([JPEG], 'x.jpg', { type: 'image/jpeg' })); fd.append('caption', 'front');
    const up = await app.request(`/api/w/demo-physio/prescriptions/${rxId}/images`, { method: 'POST', headers: { cookie: staff, 'x-flowhq-csrf': '1' }, body: fd });
    expect(up.status).toBe(201); imageId = (await up.json() as { imageId: string }).imageId;
    const bad = new FormData(); bad.append('file', new File([new TextEncoder().encode('not an image')], 'x.jpg', { type: 'image/jpeg' }));
    expect((await app.request(`/api/w/demo-physio/prescriptions/${rxId}/images`, { method: 'POST', headers: { cookie: staff, 'x-flowhq-csrf': '1' }, body: bad })).status).toBe(415);
    const again = await call(staff, `/prescriptions/${rxId}`);
    expect(again.json.images).toHaveLength(1);
    const img = await app.request(`/api/w/demo-physio/prescriptions/${rxId}/images/${imageId}`, { headers: { cookie: staff } });
    expect([img.status, img.headers.get('content-type'), img.headers.get('cache-control')]).toEqual([200, 'image/jpeg', expect.stringContaining('no-store')]);
    expect(Array.from(new Uint8Array(await img.arrayBuffer()))).toEqual(Array.from(JPEG));
    expect((await app.request(`/api/w/demo-physio/prescriptions/${rxId}/images/${imageId}`)).status).toBe(401);   // not public
    expect((await call(staff, `/prescriptions/${rxId}`, 'PUT', { patientId, rxDate: '2026-10-07', treatingPhysio: 'Dr Test', bp: '', vitals: '', history: '', examination: '', diagnosis: 'd2', treatmentPlan: '', exercises: '', advice: '', followUpOn: null, baseVersion: 1 })).json.version).toBe(2);
    expect((await call(staff, `/prescriptions/${rxId}`)).json.images).toHaveLength(1);   // photos follow the prescription across versions
  });
  it('invoice, payment, balance, double submit, void permissions', async () => {
    const body = { patientId, date: '2026-10-07', lines: [{ description: 'Physiotherapy session', qty: 4, unitPaise: 50000 }], discountPaise: 0, applyTax: false, notes: '', idemKey: 'http-form-0001', payment: { amountPaise: 50000, method: 'Cash', reference: '', paidOn: '2026-10-07' } };
    const a = await call(staff, '/invoices', 'POST', body); const b = await call(staff, '/invoices', 'POST', body);
    expect([a.status, b.status, a.json.invoice.invoiceNo === b.json.invoice.invoiceNo, b.json.duplicate]).toEqual([201, 200, true, true]);
    invoiceNo = a.json.invoice.invoiceNo; expect([a.json.invoice.totalPaise, a.json.invoice.paidPaise, a.json.invoice.balancePaise]).toEqual([200000, 50000, 150000]);
    expect((await call(staff, `/invoices/${invoiceNo}/payments`, 'POST', { amountPaise: 150001, method: 'UPI', reference: '', paidOn: '2026-10-07', idemKey: 'http-pay-0001' })).json.error.code).toBe('overpayment');
    expect((await call(staff, `/invoices/${invoiceNo}/payments`, 'POST', { amountPaise: 150000, method: 'UPI', reference: 'r', paidOn: '2026-10-07', idemKey: 'http-pay-0002' })).json.paymentStatus).toBe('paid');
    expect((await call(staff, `/invoices/${invoiceNo}/void`, 'POST', { reason: 'mistake' })).status).toBe(403);     // staff cannot void
    expect((await call(admin, `/payments/PAY-000002/void`, 'POST', { reason: 'bounced' })).json.paymentStatus).toBe('partial');
    expect((await call(staff, `/patients/${patientId}`)).json.patient).toMatchObject({ billedPaise: 200000, paidPaise: 50000, outstandingPaise: 150000 });
  });
  it('attendance', async () => {
    expect((await call(staff, '/visits', 'PUT', { patientId, date: '2026-10-07', status: 'Attended' })).json.visit.status).toBe('Attended');
    expect((await call(staff, '/visits?week=2026-10-07')).json.rows[0].cells['2026-10-07'].status).toBe('Attended');
    expect((await call(staff, '/visits', 'PUT', { patientId, date: '2026-10-07', status: 'Nope' })).status).toBe(400);
  });
  it('clinic letterhead comes from config; no key, doc id or password hash reaches the browser', async () => {
    const c = (await call(staff, '/clinic')).json;
    expect(c.name).toBe('Geeta Krishna Physiotherapy Centre'); expect(c.clinicians.map((x: { regNo: string }) => x.regNo)).toEqual(['0143', '0144']); expect(c.tax).toBeNull(); expect(c).not.toHaveProperty('idPrefix');
    for (const path of ['/patients', `/patients/${patientId}`, '/prescriptions', '/invoices', '/clinic', '/visits']) expect((await call(staff, path)).text).not.toMatch(/DEMO_PHYSIO|Grist_Doc_ID|scrypt\$|"k"/);
  });
});

describe('prescription suggestions: the clinic remembers what it treats', () => {
  const rx = (pid: string, diagnosis: string, over: Record<string, unknown> = {}) => call(staff, '/prescriptions', 'POST', { patientId: pid, rxDate: '2026-10-07', treatingPhysio: 'Dr Test', bp: '', vitals: '', history: '', examination: '', diagnosis, treatmentPlan: '', exercises: '', advice: '', followUpOn: null, ...over });
  it('learns conditions from saved prescriptions: most used first, the newest wording and plan as the template, no patient data', async () => {
    const before = (await call(staff, '/prescriptions/suggestions')).json as Array<{ diagnosis: string }>; expect(before.every((x) => x.diagnosis !== 'frozen shoulder')).toBe(true);   // only what was actually written (an earlier test left 'd2')
    const pid = (await call(staff, '/patients', 'POST', { name: 'Suggest Patient One', phone: '9876500777', mainComplaint: 'x' })).json.patientId as string;
    await rx(pid, 'Frozen shoulder', { rxDate: '2026-09-01', treatmentPlan: 'old plan', advice: 'old advice' });
    await rx(pid, 'frozen  shoulder ', { rxDate: '2026-10-05', treatmentPlan: 'new plan', exercises: 'pendulum', advice: 'new advice' });
    await rx(pid, 'Low back pain', { rxDate: '2026-10-06', treatmentPlan: 'back plan' });
    await rx(pid, '', { rxDate: '2026-10-06' });   // no diagnosis: nothing to learn
    const s = (await call(staff, '/prescriptions/suggestions')).json as Array<{ diagnosis: string; count: number; lastUsed: string; treatmentPlan: string; advice: string }>;
    const mine = s.filter((x) => /shoulder|back pain/i.test(x.diagnosis)); expect(mine.map((x) => [x.diagnosis, x.count])).toEqual([['frozen shoulder', 2], ['Low back pain', 1]]);
    expect(mine[0]).toMatchObject({ treatmentPlan: 'new plan\n\npendulum', advice: 'new advice', lastUsed: '2026-10-05' });
    expect(JSON.stringify(s)).not.toMatch(/Suggest Patient|9876500777|GK-P-|GK-RX/);
  });
  it('needs a signed-in user', async () => { expect((await app.request('/api/w/demo-physio/prescriptions/suggestions')).status).toBe(401); });
});