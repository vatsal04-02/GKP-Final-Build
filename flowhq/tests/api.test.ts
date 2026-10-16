// The BFF over HTTP: sessions, CSRF, roles, workspace access, and what may (and may never) reach the browser.
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword, type UserRecord } from '../src/server/auth';
import { memoryGrist } from '../src/server/grist';
import { ProfileStore } from '../src/server/profiles';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';

const NOW = Date.UTC(2026, 9, 7, 6, 30);
const KEY = 'test-grist-key-0123456789abcdef';
const SECRET = 'test-session-secret-0123456789abcdef-xyz';
const PW = 'correct horse 42';
const SECRETS = /test-grist-key|DEMO_PHYSIO|DEMO_SALON|DEMO_REALTY|Grist_Doc_ID|WA_Phone_Number_ID|10000000000000\d|test-session-secret|scrypt\$/;

let app: ReturnType<typeof createApp>;
let docs: ReturnType<typeof demoDocs>['docs'];
beforeAll(() => {
  const d = demoDocs(NOW);
  docs = d.docs;
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: KEY, registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: memoryGrist(docs), cacheMs: 0 });
  const h = hashPassword(PW);
  const users: UserRecord[] = [
    { email: 'admin@test', name: 'Alex', role: 'admin', workspaces: ['*'], passwordHash: h },
    { email: 'staff@test', name: 'Sam', role: 'staff', workspaces: ['demo-salon'], passwordHash: h },
  ];
  app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: SECRET, secureCookies: true, demo: false, now: () => NOW });
});

const J = { 'content-type': 'application/json', 'x-flowhq-csrf': '1' };
async function login(email: string, ip = '10.0.0.1') {
  const r = await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: PW }) });
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0];
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown, csrf = true) => {
  const r = await app.request(path, { method, headers: { cookie, ...(csrf ? J : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
};

describe('sessions and CSRF', () => {
  it('everything but health and login needs a session', async () => {
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/w/demo-physio/contacts')).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
  });
  it('state-changing calls need the CSRF header', async () => {
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: PW }) });
    expect(r.status).toBe(403);
    const cookie = await login('admin@test');
    const conv = (await call(cookie, '/api/w/demo-physio/conversations')).json[0];
    expect((await call(cookie, `/api/w/demo-physio/conversations/${conv.id}/reply`, 'POST', { body: 'x' }, false)).status).toBe(403);
  });
  it('wrong passwords are refused, then rate limited', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ email: 'admin@test', password: 'nope' }) });
      expect(r.status).toBe(401);
    }
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ email: 'admin@test', password: PW }) });
    expect(r.status).toBe(429);
  });
  it('the session cookie is HttpOnly, Secure, SameSite and tamper-proof', async () => {
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': '10.0.0.2' }, body: JSON.stringify({ email: 'admin@test', password: PW }) });
    const c = r.headers.get('set-cookie')!;
    expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/Secure/); expect(c).toMatch(/SameSite=Lax/);
    const forged = c.split(';')[0].replace(/\.[^.]+$/, '.AAAA');
    expect((await call(forged, '/api/me')).status).toBe(401);
  });
});

describe('workspace access and roles', () => {
  it('a user only sees the workspaces they were given', async () => {
    const cookie = await login('staff@test');
    const me = (await call(cookie, '/api/me')).json;
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual(['demo-salon']);
    expect((await call(cookie, '/api/w/demo-physio/workspace')).status).toBe(404);
    expect((await call(cookie, '/api/w/demo-salon/workspace')).json.terminology.contact.plural).toBe('Clients');
  });
  it('staff cannot change settings, automations, the profile or knowledge', async () => {
    const cookie = await login('staff@test');
    expect((await call(cookie, '/api/w/demo-salon/settings', 'PATCH', { values: { open_time: '07:00' } })).status).toBe(403);
    expect((await call(cookie, '/api/w/demo-salon/automations/review_requests', 'PATCH', { value: 'off' })).status).toBe(403);
    expect((await call(cookie, '/api/w/demo-salon/profile', 'PATCH', { industry: 'gym' })).status).toBe(403);
    expect((await call(cookie, '/api/w/demo-salon/knowledge', 'POST', { title: 'x', content: 'y' })).status).toBe(403);
  });
  it('an admin changes industry, words and modules; the UI contract follows', async () => {
    const cookie = await login('admin@test');
    let w = (await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { industry: 'agency' })).json;
    expect(w.terminology.contact.plural).toBe('Prospects');
    w = (await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { terminology: { contact: { singular: 'Buyer', plural: 'Buyers' }, ai: { name: 'Harbor AI' } } })).json;
    expect(w.terminology.contact.plural).toBe('Buyers');
    expect(w.terminology.ai.name).toBe('Harbor AI');
    w = (await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { modules: { disable: ['ai', 'inbox'] } })).json;
    expect(w.modules).not.toContain('ai');
    expect(w.modules).toContain('inbox');                       // core modules stay
    expect(w.automations).not.toContain('ai_assistant');
    const autos = (await call(cookie, '/api/w/demo-realty/automations')).json.map((a: { key: string }) => a.key);
    expect(autos).not.toContain('ai_assistant');
    expect((await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { industry: 'spaceship' })).status).toBe(400);
    expect((await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { logoUrl: 'javascript:alert(1)' })).status).toBe(400);
    await call(cookie, '/api/w/demo-realty/profile', 'PATCH', { industry: 'real_estate', terminology: {}, modules: {} });
  });
});

describe('flows through the API', () => {
  it('a staff reply becomes one Send row for W10 and comes back pending', async () => {
    const cookie = await login('admin@test');
    const list = (await call(cookie, '/api/w/demo-physio/conversations')).json;
    const c = list.find((x: { replyWindow: { open: boolean }; optedOut: boolean }) => x.replyWindow.open && !x.optedOut);
    const r = await call(cookie, `/api/w/demo-physio/conversations/${c.id}/reply`, 'POST', { body: 'API reply' });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('pending');
    const row = docs.DEMO_PHYSIO.Messages.find((m) => m.fields.Body === 'API reply')!;
    expect(row.fields).toMatchObject({ Direction: 'Out', Send: true, Sent_By: 'Alex', Conversation: Number(c.id) });
    const opted = list.find((x: { optedOut: boolean }) => x.optedOut);
    const o = await call(cookie, `/api/w/demo-physio/conversations/${opted.id}/reply`, 'POST', { body: 'hi' });
    expect(o.status).toBe(409);
    expect(o.json.error.code).toBe('opted_out');
  });
  it('bookings accept completed / no-show only', async () => {
    const cookie = await login('admin@test');
    const b = (await call(cookie, '/api/w/demo-physio/bookings?view=needs_outcome')).json[0];
    expect((await call(cookie, `/api/w/demo-physio/bookings/${b.id}`, 'PATCH', { status: 'cancelled' })).status).toBe(400);
    expect((await call(cookie, `/api/w/demo-physio/bookings/${b.id}`, 'PATCH', { status: 'completed' })).json.status).toBe('completed');
  });
  it('unknown routes answer JSON 404', async () => {
    const cookie = await login('admin@test');
    const r = await call(cookie, '/api/nothing-here');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });
});

describe('nothing secret reaches the browser', () => {
  it('no response carries the backend key, document ids, phone-number ids or password hashes', async () => {
    const cookie = await login('admin@test');
    const paths = ['/api/health', '/api/me'];
    for (const w of ['demo-physio', 'demo-salon', 'demo-realty']) {
      for (const p of ['workspace', 'dashboard?days=7', 'dashboard?days=30', 'contacts', 'conversations', 'bookings?view=all', 'automations', 'tasks', 'activity', 'reports', 'analytics', 'analytics?week=this', 'ai', 'knowledge', 'settings']) paths.push(`/api/w/${w}/${p}`);
      const convs = (await call(cookie, `/api/w/${w}/conversations`)).json;
      paths.push(`/api/w/${w}/conversations/${convs[0].id}`, `/api/w/${w}/contacts/${convs[0].contactId}`);
    }
    for (const p of paths) {
      const r = await call(cookie, p);
      expect(r.status, p).toBe(200);
      expect(r.text.match(SECRETS)?.[0] ?? null, p).toBeNull();
    }
  });
  it('API responses are not cached and carry safe headers', async () => {
    const cookie = await login('admin@test');
    const r = await app.request('/api/me', { headers: { cookie } });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
