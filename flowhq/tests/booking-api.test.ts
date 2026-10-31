// The n8n booking API over HTTP: bearer-token authentication (separate from browser sessions), scopes, the request/response contract,
// the booking switch, and concurrency through the real app. Synthetic patients only; no message is sent anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword, type UserRecord } from '../src/server/auth';
import { memoryGrist, type GristRecord } from '../src/server/grist';
import { ProfileStore } from '../src/server/profiles';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';
import { loadClinicConfig } from '../src/server/clinic';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES } from '../src/server/booking/seed';
import { BT } from '../src/server/booking/schema';
import { SCOPES, TokenStore, loadTokens, newToken, resetTokenFailures, hashSecret, type TokenRecord } from '../src/server/booking/tokens';

const NOW = Date.UTC(2026, 9, 7, 6, 30);   // Wed 2026-10-07 12:00 IST
const THU = '2026-10-08';
const M09 = `DR-001|${THU}|09:00`; const M0930 = `DR-001|${THU}|09:30`; const M10 = `DR-001|${THU}|10:00`;
const P1 = '9876543210'; const P2 = '9123456780';
const rows = (list: Array<Record<string, unknown>>): GristRecord[] => list.map((f, i) => ({ id: i + 1, fields: { ...f } as GristRecord['fields'] }));

const full = newToken('n8n-test', 'demo-physio');
const TOKEN = full.token;
let app: ReturnType<typeof createApp>; let docs: Record<string, Record<string, GristRecord[]>>; let physioDoc = ''; let tokenRecords: TokenRecord[];
let userCookie = '';

function build(over: { bookingOn?: boolean; records?: TokenRecord[] } = {}) {
  const d = demoDocs(NOW); docs = d.docs;
  physioDoc = docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === 'demo-physio')!.fields.Grist_Doc_ID as string;
  const cfg = SEED_CONFIG.map((r) => ({ ...r })); cfg.find((r) => r.Key === 'booking_enabled')!.Value = over.bookingOn === false ? 'off' : 'on';
  Object.assign(docs[physioDoc]!, { [BT.config]: rows(cfg), [BT.doctors]: rows(SEED_DOCTORS), [BT.schedules]: rows(SEED_SCHEDULES), [BT.blocks]: [], [BT.audit]: [] });
  docs[physioDoc]![BT.appointments] = [];   // a clean appointments table for the assertions below
  const mem = memoryGrist(docs);
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, clinic: loadClinicConfig('config/clinic.json'), cacheMs: 0, now: () => NOW });
  tokenRecords = over.records || [full.record];
  const users: UserRecord[] = [{ email: 'owner@test', name: 'Owner', role: 'admin', workspaces: ['*'], passwordHash: hashPassword('correct horse 42') }];
  app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: 'test-session-secret-0123456789abcdef-xyz', secureCookies: true, demo: false, now: () => NOW, bookingTokens: new TokenStore(tokenRecords) });
}
const appts = () => docs[physioDoc]![BT.appointments]!; const audit = () => docs[physioDoc]![BT.audit]!;
const call = async (path: string, o: { method?: string; token?: string | null; headers?: Record<string, string>; body?: unknown; raw?: string } = {}) => {
  const headers: Record<string, string> = { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }), ...(o.body !== undefined || o.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers };
  const r = await app.request(`/api/booking${path}`, { method: o.method || 'GET', headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
  const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
};
let n = 0; const idem = () => `api-key-${++n}-abcdefgh`;
const post = (slot: string, over: { phone?: string; name?: string; key?: string; token?: string } = {}) =>
  call('/appointments', { method: 'POST', token: over.token, headers: { 'idempotency-key': over.key || idem() }, body: { slot_id: slot, patient: { name: over.name || 'Test Patient One', phone: over.phone || P1 }, reason: 'Knee pain' } });

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); build(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('authentication: bearer service tokens only', () => {
  const ROUTES: Array<[string, string]> = [['GET', '/config'], ['GET', `/availability?date=${THU}`], ['POST', '/appointments'], ['GET', '/appointments/x?patient_phone=9876543210'], ['PATCH', '/appointments/x'], ['POST', '/appointments/x/cancel']];
  it('every route refuses a request with no token, a wrong token or a malformed header, with one identical answer', async () => {
    const seen = new Set<string>(); let ip = 0;   // a different address per request, so the failed-attempt limiter (tested below) does not interfere
    for (const [method, path] of ROUTES) for (const token of [null, 'n8n-test.wrong-secret', 'no-such-id.abcdef', 'garbage']) {
      const r = await call(path, { method, token, headers: { 'x-forwarded-for': `198.51.100.${++ip}` }, body: method === 'GET' ? undefined : {} }); expect(r.status, `${method} ${path} ${token}`).toBe(401); seen.add(r.text);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(seen.size).toBe(1); expect([...seen][0]).toBe(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid service token is required' } }));
    expect((await call('/config', { token: null, headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    expect((await call('/config', { token: null, headers: { authorization: TOKEN } })).status).toBe(401);
  });
  it('a revoked token and an expired token are refused; a token with a future expiry works', async () => {
    const ok = newToken('ok-token', 'demo-physio', { days: 30, now: NOW }); const old = newToken('old-token', 'demo-physio', { days: 1, now: NOW - 3 * 86400000 }); const gone = newToken('gone-token', 'demo-physio');
    build({ records: [ok.record, old.record, { ...gone.record, revoked: true }] });
    expect((await call('/config', { token: ok.token })).status).toBe(200); expect((await call('/config', { token: old.token })).status).toBe(401); expect((await call('/config', { token: gone.token })).status).toBe(401);
  });
  it('a browser session (cookie) cannot use this API, and a service token cannot use the browser API', async () => {
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'owner@test', password: 'correct horse 42' }) });
    userCookie = login.headers.get('set-cookie')!.split(';')[0]!; expect(login.status).toBe(200);
    const viaCookie = await app.request('/api/booking/config', { headers: { cookie: userCookie } }); expect(viaCookie.status).toBe(401);
    const viaToken = await app.request('/api/me', { headers: { authorization: `Bearer ${TOKEN}` } }); expect(viaToken.status).toBe(401); expect((await viaToken.json()).error.code).toBe('signed_out');
    const w = await app.request('/api/w/demo-physio/dashboard?days=7', { headers: { authorization: `Bearer ${TOKEN}` } }); expect(w.status).toBe(401);
  });
  it('the token needs neither a cookie nor the CSRF header (n8n sends neither)', async () => { expect((await post(M09)).status).toBe(201); });
  it('no tokens configured at all means the whole API is closed', async () => {
    build({ records: [] }); for (const [method, path] of ROUTES) expect((await call(path, { method, body: method === 'GET' ? undefined : {} })).status).toBe(401);
  });
  it('20 failed attempts from one address are rate limited (429), other addresses are unaffected, and good calls are never counted', async () => {
    for (let i = 0; i < 20; i++) expect((await call('/config', { token: 'x.y', headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(401);
    expect((await call('/config', { token: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(429);
    expect((await call('/config', { token: TOKEN, headers: { 'x-forwarded-for': '203.0.113.10' } })).status).toBe(200);
    for (let i = 0; i < 40; i++) expect((await call('/config', { headers: { 'x-forwarded-for': '203.0.113.11' } })).status).toBe(200);
  });
  it('a token is bound to its own clinic: one for an unknown clinic gets nothing', async () => {
    const other = newToken('other-clinic', 'no-such-clinic'); build({ records: [other.record] }); expect((await call('/config', { token: other.token })).status).toBe(503);
  });
  it('the token file stores only a hash; the hash is not the token and cannot be used as one', () => {
    expect(full.record.hash).toMatch(/^sha256\$[0-9a-f]{64}$/); expect(JSON.stringify(full.record)).not.toContain(full.token.split('.')[1]!); expect(new TokenStore([full.record]).verify(`Bearer n8n-test.${full.record.hash}`)).toBeNull();
    expect(new TokenStore([full.record]).verify(`Bearer ${full.token}`)).toMatchObject({ id: 'n8n-test', workspace: 'demo-physio', source: 'WhatsApp AI' });
  });
  it('the token file loader rejects entries without a hash or a clinic, and ignores unknown scopes', () => {
    expect(() => loadTokens('', JSON.stringify([{ id: 'abc', workspace: 'x-clinic', hash: 'plain' }]))).toThrow(/sha256/); expect(() => loadTokens('', JSON.stringify([{ id: 'abc', hash: hashSecret('s') }]))).toThrow(/workspace/);
    expect(() => loadTokens('', '{}')).toThrow(/array/); expect(loadTokens('', JSON.stringify([{ id: 'abc', workspace: 'x-clinic', hash: hashSecret('s'), scopes: ['config:read', 'root'] }]))[0]!.scopes).toEqual(['config:read']);
    expect(loadTokens('', '')).toEqual([]);   // no file, no env: no tokens
  });
});

describe('scopes', () => {
  it('each route needs its own scope (403 forbidden otherwise)', async () => {
    const cases: Array<[typeof SCOPES[number], () => Promise<{ status: number }>]> = [
      ['config:read', () => call('/config', { token: t.token })], ['availability:read', () => call(`/availability?date=${THU}`, { token: t.token })], ['appointments:create', () => post(M09, { token: t.token })],
      ['appointments:read', () => call('/appointments/x?patient_phone=9876543210', { token: t.token })], ['appointments:update', () => call('/appointments/x', { method: 'PATCH', token: t.token, body: { patient_phone: P1, slot_id: M10 } })],
      ['appointments:cancel', () => call('/appointments/x/cancel', { method: 'POST', token: t.token, body: { patient_phone: P1 } })],
    ];
    let t = newToken('x-0', 'demo-physio');
    for (const [scope, fn] of cases) {
      t = newToken('scoped-token', 'demo-physio', { scopes: SCOPES.filter((s) => s !== scope) }); build({ records: [t.record] });
      const denied = await fn(); expect(denied.status, `without ${scope}`).toBe(403);
      t = newToken('scoped-token', 'demo-physio', { scopes: [scope] }); build({ records: [t.record] });
      expect((await fn()).status, `with only ${scope}`).not.toBe(403);
    }
  });
  it('a read-only token can look but never book', async () => {
    const ro = newToken('read-only', 'demo-physio', { scopes: ['config:read', 'availability:read'] }); build({ records: [ro.record] });
    expect((await call(`/availability?date=${THU}`, { token: ro.token })).status).toBe(200); expect((await post(M09, { token: ro.token })).status).toBe(403); expect(appts()).toHaveLength(0);
  });
});

describe('the contract', () => {
  it('GET /config', async () => {
    const r = await call('/config'); expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ai_booking: { enabled: true, reason: null }, booking_enabled: true, timezone: 'Asia/Kolkata', operating_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], slot_minutes: 30, buffer_minutes: 0, capacity: 1, min_notice_minutes: 120, shifts: { morning: { enabled: true }, evening: { enabled: true } }, config_problems: [] });
    expect(r.json.doctors).toEqual([{ doctor_id: 'DR-001', name: 'Dr. Mahesh Tiwari', qualification: 'MPT (PT)', active: true, default_shift: 'morning' }, { doctor_id: 'DR-002', name: 'Dr. Sandeep Tiwari', qualification: 'MPT (PT)', active: true, default_shift: 'evening' }]);
    expect(r.json.schedules[0]).toEqual({ schedule_id: 'SCH-001', doctor_id: 'DR-001', weekday: 'Mon', shift: 'morning', start_time: '09:00', end_time: '13:00', slot_minutes: null, buffer_minutes: null, capacity: null, effective_from: null, effective_to: null, active: true, is_override: false });
  });
  it('GET /availability: only bookable slots, with the documented fields', async () => {
    const r = await call(`/availability?date=${THU}`); expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ date: THU, timezone: 'Asia/Kolkata', ai_booking: { available: true, reason: null }, closed: null }); expect(r.json.slots).toHaveLength(16); expect(typeof r.json.generated_at).toBe('string');
    expect(r.json.slots[0]).toEqual({ slot_id: M09, date: THU, start_time: '09:00', end_time: '09:30', doctor_id: 'DR-001', doctor_name: 'Dr. Mahesh Tiwari', shift: 'morning', remaining_capacity: 1 });
    expect((await call(`/availability?date=${THU}&doctor_id=DR-002`)).json.slots).toHaveLength(8); expect((await call(`/availability?date=${THU}&shift=morning`)).json.slots).toHaveLength(8);
    expect((await call('/availability?date=2026-10-11')).json).toMatchObject({ closed: 'not_operating_day', slots: [] });
  });
  it('POST /appointments: 201 with the booking, then 200 "replayed" on a retry', async () => {
    const key = idem(); const a = await post(M09, { key }); expect(a.status).toBe(201);
    expect(a.json).toEqual({ replayed: false, appointment: { booking_reference: 'wa-GKA-000001', status: 'Confirmed', date: THU, start_time: '09:00', end_time: '09:30', start: '2026-10-08T03:30:00.000Z', end: '2026-10-08T04:00:00.000Z', doctor_id: 'DR-001', doctor_name: 'Dr. Mahesh Tiwari', shift: 'morning', slot_id: M09, patient: { name: 'Test Patient One', phone_masked: '+91******3210' }, reason: 'Knee pain', service: 'Physiotherapy', source: 'WhatsApp AI', created_at: expect.any(String), updated_at: expect.any(String) } });
    const b = await post(M09, { key }); expect(b.status).toBe(200); expect(b.json.replayed).toBe(true); expect(b.json.appointment.booking_reference).toBe('wa-GKA-000001'); expect(appts()).toHaveLength(1);
    expect(a.text).not.toContain(P1);
  });
  it('the key may come in the body instead of the header, but they must agree', async () => {
    const ok = await call('/appointments', { method: 'POST', body: { slot_id: M09, patient: { name: 'A B', phone: P1 }, idempotency_key: idem() } }); expect(ok.status).toBe(201);
    const both = await call('/appointments', { method: 'POST', headers: { 'idempotency-key': 'header-key-abcdefgh' }, body: { slot_id: M0930, patient: { name: 'A B', phone: P1 }, idempotency_key: 'body-key-differs-abcd' } }); expect(both.status).toBe(400); expect(both.json.error.code).toBe('invalid_idempotency_key');
    expect((await call('/appointments', { method: 'POST', body: { slot_id: M0930, patient: { name: 'A B', phone: P1 } } })).json.error.code).toBe('invalid_idempotency_key');
  });
  it('GET /appointments/{ref}, PATCH (reschedule) and POST .../cancel', async () => {
    const ref = (await post(M09)).json.appointment.booking_reference as string;
    expect((await call(`/appointments/${ref}?patient_phone=${P1}`)).json.appointment).toMatchObject({ booking_reference: ref, status: 'Confirmed', start_time: '09:00' });
    const moved = await call(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: P1, slot_id: M10, reason: 'Work clash' } }); expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ replayed: false, appointment: { booking_reference: ref, start_time: '10:00', slot_id: M10, status: 'Confirmed' } });
    const c = await call(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P1, reason: 'Recovered' } }); expect(c.status).toBe(200); expect(c.json).toMatchObject({ already_cancelled: false, appointment: { status: 'Cancelled' } });
    expect((await call(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P1 } })).json.already_cancelled).toBe(true); expect(appts()).toHaveLength(1);
  });
  it('the patient\'s phone is the proof: missing or wrong looks exactly like "not found"', async () => {
    const ref = (await post(M09)).json.appointment.booking_reference as string;
    expect((await call(`/appointments/${ref}`)).status).toBe(400);
    for (const r of [await call(`/appointments/${ref}?patient_phone=${P2}`), await call('/appointments/wa-GKA-999999?patient_phone=' + P1), await call(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P2 } })]) { expect(r.status).toBe(404); expect(r.json.error.code).toBe('not_found'); }
    expect(appts()[0]!.fields.Status).toBe('Booked');
  });
  it('errors have one shape: { error: { code, message } } plus context', async () => {
    await post(M09); const r = await post(M09, { phone: P2 });
    expect(r.status).toBe(409); expect(r.json.error).toEqual({ code: 'slot_unavailable', message: expect.any(String) }); expect(r.json.reason).toBe('slot_full'); expect(r.json.availability.slots.every((s: { doctor_id: string }) => s.doctor_id === 'DR-001')).toBe(true);
    expect((await post(M09, { phone: '123' })).json.error.code).toBe('invalid_phone'); expect((await post('junk')).json.error.code).toBe('invalid_slot_id');
  });
  it('rejects malformed requests cleanly (400), never a 500', async () => {
    const send = (raw: string) => call('/appointments', { method: 'POST', raw, headers: { 'idempotency-key': idem() } });
    expect((await send('{not json')).json.error.code).toBe('invalid_json');
    for (const raw of ['{}', JSON.stringify({ slot_id: M09 }), JSON.stringify({ slot_id: M09, patient: { name: 'A', phone: P1 }, extra: 1 }), JSON.stringify({ slot_id: 5, patient: { name: 'A', phone: P1 } }), JSON.stringify({ slot_id: M09, patient: 'A B' })]) expect((await send(raw)).status, raw).toBe(400);
    for (const q of ['', '?date=tomorrow', '?date=2026-02-30', `?date=${THU}&shift=night`]) expect([400]).toContain((await call(`/availability${q}`)).status);
    expect((await call('/appointments', { method: 'POST', raw: 'x'.repeat(21000), headers: { 'content-length': '21000', 'idempotency-key': idem() } })).status).toBe(413);
    expect((await call('/appointments/x', { method: 'PATCH', body: { slot_id: M09 } })).status).toBe(400); expect((await call('/appointments/x/cancel', { method: 'POST', body: {} })).status).toBe(400);
  });
});

describe('the booking switch, over HTTP', () => {
  it('OFF: config and availability say so, create, move AND cancel are 403, nothing is written; existing bookings stay and can be read', async () => {
    const ref = (await post(M09)).json.appointment.booking_reference as string;
    docs[physioDoc]![BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!.fields.Value = 'off';   // an admin flips it: effective on the very next call
    expect((await call('/config')).json).toMatchObject({ ai_booking: { enabled: false, reason: 'disabled' }, booking_enabled: false });
    expect((await call(`/availability?date=${THU}`)).json).toMatchObject({ ai_booking: { available: false, reason: 'disabled' }, slots: [] });
    const r = await post(M0930, { phone: P2 }); expect(r.status).toBe(403); expect(r.json).toMatchObject({ error: { code: 'ai_booking_disabled' }, reason: 'disabled' }); expect(appts()).toHaveLength(1);
    const before = JSON.stringify(appts());
    const mv = await call(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: P1, slot_id: M10 } }); expect(mv.status).toBe(403); expect(mv.json.error.code).toBe('ai_booking_disabled');
    for (const body of [{ patient_phone: P1 }, { patient_phone: P2 }, { patient_phone: P1, reason: 'again' }]) {   // the owner or not: the AI path cannot cancel while the switch is off, and it does not reveal whether the booking exists
      const c = await call(`/appointments/${ref}/cancel`, { method: 'POST', body }); expect(c.status).toBe(403); expect(c.json.error.code).toBe('ai_booking_disabled'); expect(c.json).toMatchObject({ reason: 'disabled' });
    }
    expect((await call(`/appointments/${ref}?patient_phone=${P1}`)).json.appointment.status).toBe('Confirmed');   // reading stays allowed
    expect(JSON.stringify(appts())).toBe(before);   // nothing was written by any refused call
    docs[physioDoc]![BT.config]!.find((x) => x.fields.Key === 'booking_enabled')!.fields.Value = 'on'; expect((await post(M0930, { phone: P2 })).status).toBe(201);
    expect((await call(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P1 } })).json.appointment.status).toBe('Cancelled');   // back ON: the owner can cancel again
  });
  it('the demo clinic has no booking tables: everything fails closed', async () => {
    for (const t of [BT.config, BT.doctors, BT.schedules, BT.blocks, BT.audit]) delete docs[physioDoc]![t];
    expect((await call(`/availability?date=${THU}`)).json).toMatchObject({ ai_booking: { available: false, reason: 'config_unavailable' }, slots: [] }); expect((await post(M09)).status).toBe(403);
  });
});

describe('concurrency over HTTP', () => {
  it('12 simultaneous requests for one slot (different keys): one 201, eleven 409, one row', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => post(M09, { phone: `9${String(400000000 + i).padStart(9, '0')}`, name: `Synthetic ${i}` })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409 && r.json.reason === 'slot_full')).toHaveLength(11); expect(appts().filter((r) => r.fields.Status === 'Booked')).toHaveLength(1);
  });
  it('8 simultaneous retries with one key: one 201, seven 200, the same reference', async () => {
    const key = idem(); const rs = await Promise.all(Array.from({ length: 8 }, () => post(M09, { key })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 200)).toHaveLength(7); expect(new Set(rs.map((r) => r.json.appointment.booking_reference)).size).toBe(1); expect(appts()).toHaveLength(1);
  });
});

describe('audit over HTTP', () => {
  it('every operation is logged against the token, and no secret or patient detail reaches the log', async () => {
    const key = idem(); const a = await post(M09, { key, name: 'Private Person', phone: P1 }); await post(M09, { phone: P2, name: 'Second Person' }); await post(M09, { key });
    const ref = a.json.appointment.booking_reference as string; await call(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: P1, slot_id: M10 } }); await call(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: P1 } });
    expect(audit().map((r) => `${r.fields.Action}:${r.fields.Outcome}`)).toEqual(['create:ok', 'create:rejected', 'create:ok', 'reschedule:ok', 'cancel:ok']);
    expect(audit().every((r) => r.fields.Actor === 'token:n8n-test' && r.fields.Source === 'API')).toBe(true);
    const text = JSON.stringify(audit().map((r) => r.fields)); for (const s of [P1, P2, 'Private Person', 'Second Person', TOKEN, TOKEN.split('.')[1]!, full.record.hash, key]) expect(text).not.toContain(s);
  });
});
