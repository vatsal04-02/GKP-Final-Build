// Two doctors and an admin: each doctor writes and sees only their own prescriptions and dues, the admin sees both together,
// and the patient register is shared. Synthetic data only; the doctors are the two in config/clinic.json.
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
const J = { 'content-type': 'application/json', 'x-flowhq-csrf': '1' };
const SANDEEP = 'Dr. Sandeep Tiwari';
const MAHESH = 'Dr. Mahesh Tiwari';
let app: ReturnType<typeof createApp>;
let owner = ''; let sandeep = ''; let mahesh = ''; let ghost = ''; let frontDesk = '';
let patientId = '';

beforeAll(async () => {
  const d = demoDocs(NOW);
  const physioDoc = d.docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === 'demo-physio')!.fields.Grist_Doc_ID as string;
  for (const t of RECORD_TABLE_NAMES) d.docs[physioDoc]![t] = [];
  const clinic = loadClinicConfig('config/clinic.json');
  const mem = memoryGrist(d.docs, { columns: Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, colNames(t)])) });
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, clinic, cacheMs: 0 });
  const h = hashPassword(PW);
  const users: UserRecord[] = [
    { email: 'owner@test', name: 'Owner', role: 'admin', workspaces: ['*'], passwordHash: h },
    { email: 'sandeep@test', name: SANDEEP, role: 'staff', workspaces: ['demo-physio'], passwordHash: h, clinician: SANDEEP },
    { email: 'mahesh@test', name: MAHESH, role: 'staff', workspaces: ['demo-physio'], passwordHash: h, clinician: 'dr. mahesh tiwari ' },   // spelling and case need not be exact
    { email: 'ghost@test', name: 'Dr. Ghost', role: 'staff', workspaces: ['demo-physio'], passwordHash: h, clinician: 'Dr. Nobody' },
    { email: 'desk@test', name: 'Front desk', role: 'staff', workspaces: ['demo-physio'], passwordHash: h },
  ];
  app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: 'test-session-secret-0123456789abcdef-xyz', secureCookies: true, demo: false, now: () => NOW });
  const login = async (email: string) => (await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': email }, body: JSON.stringify({ email, password: PW }) })).headers.get('set-cookie')!.split(';')[0]!;
  [owner, sandeep, mahesh, ghost, frontDesk] = await Promise.all(['owner@test', 'sandeep@test', 'mahesh@test', 'ghost@test', 'desk@test'].map(login));
});
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const r = await app.request(`/api/w/demo-physio${path}`, { method, headers: { cookie, ...J }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t && (t.startsWith('{') || t.startsWith('[')) ? JSON.parse(t) : null };
};
const rx = (over: Record<string, unknown> = {}) => ({ patientId, rxDate: '2026-10-07', treatingPhysio: '', bp: '', vitals: '', history: 'h', examination: 'e', diagnosis: 'Lower back pain', treatmentPlan: 'plan', exercises: '', advice: '', followUpOn: null, ...over });
let n = 0;
const inv = (rupees: number, over: Record<string, unknown> = {}) => ({ patientId, date: '2026-10-07', lines: [{ description: 'Session', qty: 1, unitPaise: rupees * 100 }], discountPaise: 0, applyTax: false, notes: '', idemKey: `idem-key-${++n}-xxxxxxxx`, ...over });

describe('prescriptions: each doctor writes under their own name', () => {
  let rxS = ''; let rxM = ''; let rxAdmin = '';
  it('the shared patient register: either doctor can register or see a patient', async () => {
    const r = await call(sandeep, '/patients', 'POST', { name: 'Shared Patient', phone: '9876500123', mainComplaint: 'Back pain' });
    expect(r.status).toBe(201); patientId = r.json.patientId;
    for (const c of [mahesh, owner, frontDesk]) expect((await call(c, `/patients/${patientId}`)).json.patient.name).toBe('Shared Patient');
    expect((await call(mahesh, '/patients')).json.rows.map((p: { patientId: string }) => p.patientId)).toContain(patientId);
  });
  it('the doctor’s own name is stamped, whatever the form says (even the other doctor’s name)', async () => {
    const a = await call(sandeep, '/prescriptions', 'POST', rx({ treatingPhysio: MAHESH }));
    expect(a.status).toBe(201); expect(a.json.treatingPhysio).toBe(SANDEEP); rxS = a.json.rxId;
    const b = await call(mahesh, '/prescriptions', 'POST', rx({ treatingPhysio: '' }));
    expect(b.json.treatingPhysio).toBe(MAHESH); rxM = b.json.rxId;                 // canonical spelling from clinic.json, not the login's
    const c = await call(owner, '/prescriptions', 'POST', rx({ treatingPhysio: MAHESH, diagnosis: 'Entered by the admin' }));
    expect(c.json.treatingPhysio).toBe(MAHESH); rxAdmin = c.json.rxId;               // the admin may write for either doctor
  });
  it('each doctor sees only their own; the admin sees all of them together', async () => {
    const ids = async (c: string, q = '') => (await call(c, `/prescriptions${q}`)).json.map((r: { rxId: string }) => r.rxId).sort();
    expect(await ids(sandeep)).toEqual([rxS]);
    expect(await ids(mahesh)).toEqual([rxM, rxAdmin].sort());
    expect(await ids(owner)).toEqual([rxS, rxM, rxAdmin].sort());
    expect(await ids(owner, `?doctor=${encodeURIComponent(SANDEEP)}`)).toEqual([rxS]);
    expect(await ids(owner, `?doctor=${encodeURIComponent('dr. mahesh tiwari')}`)).toEqual([rxM, rxAdmin].sort());
    expect(await ids(sandeep, `?doctor=${encodeURIComponent(MAHESH)}`)).toEqual([rxS]);   // a doctor cannot ask for the other doctor
    expect((await call(owner, '/prescriptions?doctor=Dr.%20Nobody')).status).toBe(400);
  });
  it('another doctor’s prescription is not found: read, edit, photos', async () => {
    expect((await call(sandeep, `/prescriptions/${rxM}`)).status).toBe(404);
    expect((await call(mahesh, `/prescriptions/${rxS}`)).status).toBe(404);
    expect((await call(sandeep, `/prescriptions/${rxM}`, 'PUT', rx({ baseVersion: 1, diagnosis: 'hijack' }))).status).toBe(404);
    expect((await call(sandeep, `/prescriptions/${rxM}/images/IMG-000001`)).status).toBe(404);
    expect((await call(sandeep, `/prescriptions/${rxM}/images/IMG-000001`, 'DELETE')).status).toBe(404);
    expect((await call(owner, `/prescriptions/${rxS}`)).status).toBe(200);
    const own = await call(sandeep, `/prescriptions/${rxS}`, 'PUT', rx({ baseVersion: 1, diagnosis: 'updated', treatingPhysio: MAHESH }));
    expect([own.status, own.json.version, own.json.treatingPhysio]).toEqual([200, 2, SANDEEP]);
  });
  it('the print sheet can find the doctor: the stored name matches the clinic details exactly', async () => {
    const names = (await call(owner, '/clinic')).json.clinicians.map((c: { name: string }) => c.name);
    expect(names).toEqual([SANDEEP, MAHESH]);
    for (const id of [rxS, rxM]) expect(names).toContain((await call(owner, `/prescriptions/${id}`)).json.treatingPhysio);
  });
});

describe('dues: the doctor who raises an invoice owns it', () => {
  let invS = ''; let invM = ''; let invAdmin = '';
  it('invoices are stamped with the doctor and separated', async () => {
    const a = await call(sandeep, '/invoices', 'POST', inv(1000)); expect(a.status).toBe(201); invS = a.json.invoice.invoiceNo; expect(a.json.invoice.createdBy).toBe(SANDEEP);
    const b = await call(mahesh, '/invoices', 'POST', inv(600, { payment: { amountPaise: 20000, method: 'Cash', reference: '', paidOn: '2026-10-07' } })); invM = b.json.invoice.invoiceNo; expect(b.json.invoice.createdBy).toBe(MAHESH);
    const c = await call(owner, '/invoices', 'POST', inv(300)); invAdmin = c.json.invoice.invoiceNo;
    const nos = async (cookie: string, q = '') => (await call(cookie, `/invoices${q}`)).json.map((i: { invoiceNo: string }) => i.invoiceNo).sort();
    expect(await nos(sandeep)).toEqual([invS]);
    expect(await nos(mahesh)).toEqual([invM]);
    expect(await nos(owner)).toEqual([invS, invM, invAdmin].sort());
    expect(await nos(owner, `?doctor=${encodeURIComponent(MAHESH)}`)).toEqual([invM]);
    expect(await nos(frontDesk)).toEqual([invS, invM, invAdmin].sort());                 // a login that is not a doctor keeps seeing everything, as before
  });
  it('another doctor’s invoice is not found, and cannot be paid; your own can', async () => {
    expect((await call(sandeep, `/invoices/${invM}`)).status).toBe(404);
    const pay = { amountPaise: 10000, method: 'Cash', reference: '', paidOn: '2026-10-07', idemKey: 'pay-key-0001-xxxx' };
    expect((await call(sandeep, `/invoices/${invM}/payments`, 'POST', pay)).status).toBe(404);
    expect((await call(mahesh, `/invoices/${invM}`)).json.paidPaise).toBe(20000);          // untouched
    const ok = await call(sandeep, `/invoices/${invS}/payments`, 'POST', { ...pay, idemKey: 'pay-key-0002-xxxx' });
    expect([ok.status, ok.json.paidPaise]).toEqual([201, 10000]);
    expect((await call(sandeep, `/invoices/${invS}/void`, 'POST', { reason: 'no' })).status).toBe(403);   // voiding stays admin-only
  });
  it('a duplicate form of another doctor’s invoice is refused, not shown', async () => {
    const first = inv(100); const a = await call(sandeep, '/invoices', 'POST', first);
    expect(a.status).toBe(201);
    expect((await call(mahesh, '/invoices', 'POST', first)).status).toBe(409);
    expect((await call(sandeep, '/invoices', 'POST', first)).status).toBe(200);              // the same doctor re-sending is the normal duplicate answer
  });
  it('the shared patient shows each doctor only their own money; the admin sees the sum', async () => {
    const out = async (cookie: string) => (await call(cookie, `/patients/${patientId}`)).json;
    const s = await out(sandeep); const m = await out(mahesh); const o = await out(owner);
    expect(s.invoices.every((i: { createdBy: string }) => i.createdBy === SANDEEP)).toBe(true);
    expect(m.invoices.every((i: { createdBy: string }) => i.createdBy === MAHESH)).toBe(true);
    expect(o.invoices.length).toBe(s.invoices.length + m.invoices.length + 1);
    expect(s.prescriptions.map((r: { treatingPhysio: string }) => r.treatingPhysio)).toEqual([SANDEEP]);
    expect(o.patient.outstandingPaise).toBe(s.patient.outstandingPaise + m.patient.outstandingPaise + 30000);
    const row = async (cookie: string) => (await call(cookie, '/patients')).json.rows.find((p: { patientId: string }) => p.patientId === patientId).outstandingPaise;
    expect(await row(mahesh)).toBe(m.patient.outstandingPaise);
    expect(await row(owner)).toBe(o.patient.outstandingPaise);
  });
  it('dashboard numbers: a doctor’s are their own; the admin’s add up per doctor and in total', async () => {
    const s = (await call(sandeep, '/clinic-summary?days=30')).json; const m = (await call(mahesh, '/clinic-summary?days=30')).json; const o = (await call(owner, '/clinic-summary?days=30')).json;
    expect(s.byDoctor).toBeUndefined(); expect(m.byDoctor).toBeUndefined();
    expect(o.tiles.outstanding.value).toBe(s.tiles.outstanding.value + m.tiles.outstanding.value + 30000);
    expect(o.tiles.prescriptions.value).toBe(s.tiles.prescriptions.value + m.tiles.prescriptions.value);
    expect(s.recentPrescriptions.every((r: { rxId: string }) => r.rxId)).toBe(true);
    const by = Object.fromEntries(o.byDoctor.map((r: { name: string }) => [r.name, r]));
    expect(Object.keys(by)).toEqual([SANDEEP, MAHESH, 'Other (front desk / admin)']);
    expect(by[SANDEEP].outstandingPaise).toBe(s.tiles.outstanding.value);
    expect(by[MAHESH].outstandingPaise).toBe(m.tiles.outstanding.value);
    expect(by['Other (front desk / admin)'].outstandingPaise).toBe(30000);
    expect(by[MAHESH].collectedPaise).toBe(20000);
    expect(by[SANDEEP].prescriptions).toBe(s.tiles.prescriptions.value);
    expect(o.byDoctor.reduce((t: number, r: { outstandingPaise: number }) => t + r.outstandingPaise, 0)).toBe(o.tiles.outstanding.value);
    const one = (await call(owner, `/clinic-summary?days=30&doctor=${encodeURIComponent(SANDEEP)}`)).json;
    expect(one.byDoctor).toBeUndefined(); expect(one.tiles.outstanding.value).toBe(s.tiles.outstanding.value);
    expect((await call(frontDesk, '/clinic-summary?days=30')).json.byDoctor).toBeUndefined();   // the per-doctor split is for the admin
  });
});

describe('configuration safety', () => {
  it('a doctor login whose name is not in the clinic details is refused, not given everything', async () => {
    for (const p of ['/prescriptions', '/invoices', '/clinic-summary', `/patients/${patientId}`]) {
      const r = await call(ghost, p);
      expect([p, r.status, r.json.error.code]).toEqual([p, 403, 'doctor_not_set_up']);
    }
    expect((await call(ghost, '/prescriptions', 'POST', rx())).status).toBe(403);
  });
  it('/api/me tells the screen which doctor this is, so the form can lock the name', async () => {
    const me = await (await app.request('/api/me', { headers: { cookie: sandeep } })).json() as { user: { clinician?: string; role: string } };
    expect([me.user.clinician, me.user.role]).toEqual([SANDEEP, 'staff']);
    expect(((await (await app.request('/api/me', { headers: { cookie: owner } })).json()) as { user: { clinician?: string } }).user.clinician).toBeUndefined();
  });
});

describe('invoices raised by an admin or the front desk name the doctor', () => {
  it('the chosen doctor owns the invoice; the other doctor never sees it; an unknown name is refused; a doctor login ignores the field', async () => {
    const a = await call(owner, '/invoices', 'POST', { ...inv(450), doctor: 'dr. mahesh tiwari' });
    expect(a.status).toBe(201); expect(a.json.invoice.createdBy).toBe(MAHESH);                    // stored with the exact clinic spelling
    const no = a.json.invoice.invoiceNo;
    expect((await call(mahesh, `/invoices/${no}`)).status).toBe(200);
    expect((await call(sandeep, `/invoices/${no}`)).status).toBe(404);
    expect((await call(owner, '/invoices', 'POST', { ...inv(450), doctor: 'Dr. Nobody' })).status).toBe(400);
    const own = await call(sandeep, '/invoices', 'POST', { ...inv(100), doctor: MAHESH });          // a doctor cannot raise a bill in the other doctor's name
    expect(own.json.invoice.createdBy).toBe(SANDEEP);
  });
});
