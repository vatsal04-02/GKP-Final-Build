// Shared test setup for the staff / security suites: the real app, the real adapter, an in-memory Grist, a fixed clock, synthetic people only.
import { hashPassword, type UserRecord } from '../src/server/auth';
import { createApp } from '../src/server/app';
import { memoryGrist, type GristRecord } from '../src/server/grist';
import { ProfileStore } from '../src/server/profiles';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';
import { loadClinicConfig } from '../src/server/clinic';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES } from '../src/server/booking/seed';
import { BT } from '../src/server/booking/schema';
import { TokenStore, newToken, type TokenRecord } from '../src/server/booking/tokens';
import { localToEpochSec } from '../src/server/booking/engine';

export const NOW = Date.UTC(2026, 9, 7, 6, 30);   // Wed 2026-10-07 12:00 IST
export const THU = '2026-10-08';
export const slot = (doctor: string, date: string, start: string) => `${doctor}|${date}|${start}`;
export const M09 = slot('DR-001', THU, '09:00'); export const M0930 = slot('DR-001', THU, '09:30'); export const M10 = slot('DR-001', THU, '10:00'); export const E16 = slot('DR-002', THU, '16:00'); export const E1630 = slot('DR-002', THU, '16:30');
export const ist = (date: string, hhmm: string) => localToEpochSec(date, +hhmm.slice(0, 2) * 60 + +hhmm.slice(3), 'Asia/Kolkata');
export const rows = (list: Array<Record<string, unknown>>): GristRecord[] => list.map((f, i) => ({ id: i + 1, fields: { ...f } as GristRecord['fields'] }));
export const PW = 'correct horse 42';

export interface Fixture {
  app: ReturnType<typeof createApp>; docs: Record<string, Record<string, GristRecord[]>>; doc: Record<string, GristRecord[]>;
  token: string; tokenRecord: TokenRecord; cookies: Record<string, string>;
  s: (who: string, path: string, o?: { method?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean }) => Promise<{ status: number; json: any; text: string }>;
  api: (path: string, o?: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> }) => Promise<{ status: number; json: any; text: string }>;
  fail: { audit: boolean; grist: null | ((method: string, table: string) => boolean) };
  booking: () => Promise<import('../src/server/booking/staff-service').StaffBooking>;
}

/** `who` is one of: admin, desk (front desk), mahesh / sandeep (a doctor's own login), linked (doctorId DR-002), vague (partial name), badlink (doctorId that is not a doctor). */
export async function buildFixture(o: { bookingOn?: boolean; noBookingTables?: boolean; trustProxy?: boolean; tokens?: TokenRecord[]; outboxDir?: string } = {}): Promise<Fixture> {
  const d = demoDocs(NOW); const docs = d.docs;
  const physio = docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === 'demo-physio')!.fields.Grist_Doc_ID as string;
  const doc = docs[physio]!;
  for (const t of [BT.config, BT.doctors, BT.schedules, BT.blocks, BT.audit, BT.consent, BT.consentLog]) delete doc[t];
  if (!o.noBookingTables) {
    const cfg = SEED_CONFIG.map((r) => ({ ...r })); cfg.find((r) => r.Key === 'booking_enabled')!.Value = o.bookingOn ? 'on' : 'off';
    Object.assign(doc, { [BT.config]: rows(cfg), [BT.doctors]: rows(SEED_DOCTORS), [BT.schedules]: rows(SEED_SCHEDULES), [BT.blocks]: [], [BT.audit]: [], [BT.consent]: [], [BT.consentLog]: [] });
  }
  doc[BT.appointments] = [];   // a clean appointments table for the assertions
  const fail: Fixture['fail'] = { audit: false, grist: null };
  const mem = memoryGrist(docs, { failOn: (m, t) => (fail.audit && m === 'POST' && t === BT.audit) || !!fail.grist?.(m, t) });
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, clinic: loadClinicConfig('config/clinic.json'), cacheMs: 0, now: () => NOW, ...(o.outboxDir ? { auditOutbox: { dir: o.outboxDir, staleMs: 200, waitMs: 1500 } } : {}) });
  const full = newToken('n8n-test', 'demo-physio'); const records = o.tokens || [full.record];
  const h = hashPassword(PW);
  const users: UserRecord[] = [
    { email: 'admin@test', name: 'Owner', role: 'admin', workspaces: ['*'], passwordHash: h },
    { email: 'desk@test', name: 'Front desk', role: 'staff', workspaces: ['*'], passwordHash: h },
    { email: 'mahesh@test', name: 'Dr. Mahesh Tiwari', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'Dr. Mahesh Tiwari' },
    { email: 'sandeep@test', name: 'Dr. Sandeep Tiwari', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'dr. sandeep tiwari ' },
    { email: 'linked@test', name: 'Linked Doctor', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'Dr. Somebody Else', doctorId: 'DR-002' },    // the stable id wins over the name
    { email: 'vague@test', name: 'Vague Doctor', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'Mahesh' },                                  // a partial name gets no booking rights
    { email: 'granted@test', name: 'Granted Desk', role: 'staff', workspaces: ['*'], passwordHash: h, grants: ['consent:write'] },                                                       // front desk WITH the explicit consent grant
    { email: 'grantdoc@test', name: 'Granted Doctor', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'Dr. Mahesh Tiwari', doctorId: 'DR-001', grants: ['consent:write'] },   // a doctor with the grant
    { email: 'badlink@test', name: 'Bad Link', role: 'staff', workspaces: ['*'], passwordHash: h, clinician: 'Dr. Mahesh Tiwari', doctorId: 'DR-999' },   // an id that is not a doctor: no rights, even though the name would match
  ];
  const app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: 'test-session-secret-0123456789abcdef-xyz', secureCookies: true, demo: false, now: () => NOW, bookingTokens: new TokenStore(records), trustProxy: o.trustProxy });
  const cookies: Record<string, string> = {};
  for (const [who, email] of [['admin', 'admin@test'], ['desk', 'desk@test'], ['mahesh', 'mahesh@test'], ['sandeep', 'sandeep@test'], ['linked', 'linked@test'], ['vague', 'vague@test'], ['badlink', 'badlink@test'], ['granted', 'granted@test'], ['grantdoc', 'grantdoc@test']] as const) {
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1', 'x-forwarded-for': `10.0.0.${email.length}` }, body: JSON.stringify({ email, password: PW }) });
    cookies[who] = r.headers.get('set-cookie')!.split(';')[0]!;
  }
  const parse = async (r: Response) => { const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ } return { status: r.status, json, text }; };
  const s: Fixture['s'] = async (who, path, x = {}) => parse(await app.request(`/api/w/demo-physio/schedule${path}`, { method: x.method || 'GET', headers: { ...(who === 'none' ? {} : { cookie: cookies[who]! }), ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(x.csrf === false ? {} : { 'x-flowhq-csrf': '1' }), ...x.headers }, body: x.body === undefined ? undefined : JSON.stringify(x.body) }));
  const api: Fixture['api'] = async (path, x = {}) => parse(await app.request(`/api/booking${path}`, { method: x.method || 'GET', headers: { ...(x.token === null ? {} : { authorization: `Bearer ${x.token ?? full.token}` }), ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}), ...x.headers }, body: x.body === undefined ? undefined : JSON.stringify(x.body) }));
  return { app, docs, doc, token: full.token, tokenRecord: full.record, cookies, s, api, fail, booking: async () => (await adapter.workspace('demo-physio'))!.booking!()! };
}
