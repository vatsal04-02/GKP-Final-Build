// Security review of the booking API, as tests: the namespace exemption, authentication and scope on every route, no token in the browser,
// staff sessions, and rate limiting behind the production reverse proxy.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '../src/server/auth';
import { clientKey } from '../src/server/net';
import { SCOPES, newToken, resetTokenFailures } from '../src/server/booking/tokens';
import { M09, NOW, THU, buildFixture, type Fixture } from './booking-fixture';

let fx: Fixture;
beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture({ bookingOn: true }); });
afterEach(() => { vi.restoreAllMocks(); });
const raw = (url: string, init: RequestInit = {}) => Promise.resolve(fx.app.request(url, init)).then(async (r) => { const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, headers: r.headers }; });
const fill = (p: string) => p.replace(':ws', 'demo-physio').replace(/:[A-Za-z]+\??/g, 'x');

describe('only /api/booking/* is exempt from the cookie and CSRF checks', () => {
  it('look-alike paths are NOT exempt: they need a session (401) and the CSRF header (403)', async () => {
    for (const p of ['/api/bookingx/config', '/api/booking-admin', '/api/bookings', '/api/Booking/config', '/api/booking.json', '/api/w/demo-physio/booking/config']) {
      const get = await raw(p); expect(get.status, `GET ${p}`).toBe(401); expect(get.json?.error?.code, `GET ${p}`).toBe('signed_out');
      const post = await raw(p, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); expect(post.json?.error?.code, `POST ${p}`).toBe('csrf');   // the CSRF rule still applies
    }
  });
  it('a service token is not a session, and a session is not a service token', async () => {
    for (const p of ['/api/me', '/api/w/demo-physio/schedule/overview', '/api/w/demo-physio/dashboard', '/api/w/demo-physio/patients']) { const r = await raw(p, { headers: { authorization: `Bearer ${fx.token}` } }); expect(r.status, p).toBe(401); expect(r.json.error.code).toBe('signed_out'); }
    for (const p of ['/api/booking/config', `/api/booking/availability?date=${THU}`]) expect((await raw(p, { headers: { cookie: fx.cookies.admin! } })).json.error.code, p).toBe('unauthorized');
  });
  it('path tricks cannot carry a token into the rest of the API', async () => {
    for (const p of ['/api/booking/../me', '/api/booking/%2e%2e/me', '/api/booking/..%2fme', '/api//booking/../me']) { const r = await raw(p, { headers: { authorization: `Bearer ${fx.token}` } }); expect(r.text, p).not.toContain('admin@test'); expect([401, 404]).toContain(r.status); }
  });
  it('every route the app registers is protected: booking routes by token, everything else by a session (generated from the real route table)', async () => {
    const routes = fx.app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !/\/\*$/.test(r.path));
    expect(routes.length).toBeGreaterThan(40);   // not an empty loop
    const open = ['/api/health', '/api/auth/login', '/api/auth/logout'];
    let booking = 0; let staff = 0;
    for (const r of routes) {
      if (open.includes(r.path)) continue;
      const p = fill(r.path); const isBooking = r.path.startsWith('/api/booking/');
      const res = await raw(p, { method: r.method, ...(r.method === 'GET' ? {} : { body: '{}', headers: { 'content-type': 'application/json' } }) });
      if (isBooking) { booking++; expect(res.status, `${r.method} ${r.path}`).toBe(401); expect(res.json.error.code).toBe('unauthorized'); }
      else { staff++; expect([401, 403], `${r.method} ${r.path}`).toContain(res.status); expect(['signed_out', 'csrf']).toContain(res.json.error.code); }
    }
    expect(booking).toBe(16); expect(staff).toBeGreaterThan(30);
  });
  it('an unknown path under /api/booking needs the token too (it never reveals what exists)', async () => {
    expect((await raw('/api/booking/nope')).status).toBe(401); expect((await raw('/api/booking/')).status).toBe(401);
    const ok = await raw('/api/booking/nope', { headers: { authorization: `Bearer ${fx.token}` } }); expect([401, 404]).toContain(ok.status); expect(ok.text).not.toContain('slots');
  });
});

describe('scopes are enforced on every booking route', () => {
  it('a token with no scopes can do nothing at all', async () => {
    const none = newToken('empty-scopes', 'demo-physio', { scopes: [] }); fx = await buildFixture({ bookingOn: true, tokens: [none.record] });
    const calls: Array<[string, string, unknown?]> = [['GET', '/config'], ['GET', `/availability?date=${THU}`], ['POST', '/appointments', { slot_id: M09, patient: { name: 'A B', phone: '9876543210' }, idempotency_key: 'abcdefgh-12345' }], ['GET', '/appointments/x?patient_phone=9876543210'], ['PATCH', '/appointments/x', { patient_phone: '9876543210', slot_id: M09 }], ['POST', '/appointments/x/cancel', { patient_phone: '9876543210' }]];
    for (const [method, p, body] of calls) { const r = await fx.api(p, { method, token: none.token, ...(body ? { body } : {}) }); expect(r.status, `${method} ${p}`).toBe(403); expect(r.json.error.code).toBe('forbidden'); }
    expect(fx.doc.Appointments).toHaveLength(0);
  });
  it('the set of scopes is exactly the six booking scopes plus the two payment scopes the contract documents', () => { expect([...SCOPES]).toEqual(['config:read', 'availability:read', 'appointments:read', 'appointments:create', 'appointments:update', 'appointments:cancel', 'payments:read', 'payments:write']); });
});

describe('the service token never reaches the browser', () => {
  const WEB = path.resolve(__dirname, '../src/web');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|js|html)$/.test(f) ? [p] : []; });
  const NEEDLES = ['booking-token', 'booking-tokens', 'FLOWHQ_BOOKING', 'Bearer ', '/api/booking', 'sha256$'];
  it('no web source file knows the token, the token file, the bearer scheme or the service API path', () => {
    for (const p of files(WEB)) { const c = readFileSync(p, 'utf8'); for (const n of NEEDLES) expect(c.includes(n), `${path.relative(WEB, p)} mentions ${n}`).toBe(false); }
  });
  it('the built web bundle (if there is one) has none of them either', () => {
    const dist = path.resolve(__dirname, '../dist/web'); if (!existsSync(dist)) return;
    for (const p of files(dist)) { const c = readFileSync(p, 'utf8'); for (const n of ['booking-tokens', 'FLOWHQ_BOOKING', '/api/booking']) expect(c.includes(n), `${path.relative(dist, p)} mentions ${n}`).toBe(false); }
  });
  it('no staff or admin API response contains a token, a token hash or the token file name', async () => {
    const secret = fx.token.split('.')[1]!; await fx.s('admin', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: 'abcdefgh-98765', patient: { name: 'Test Patient One', phone: '9876543210' } } });
    const bodies: string[] = [];
    for (const p of ['/overview', `/day?date=${THU}`, '/appointments', '/doctors', '/settings', '/audit']) bodies.push((await fx.s('admin', p)).text);
    for (const p of ['/api/me', '/api/w/demo-physio/workspace', '/api/w/demo-physio/settings', '/api/health']) bodies.push((await raw(p, { headers: { cookie: fx.cookies.admin! } })).text);
    for (const b of bodies) { expect(b).not.toContain(secret); expect(b).not.toContain(fx.tokenRecord.hash); expect(b).not.toContain('sha256$'); expect(b).not.toContain('booking-tokens'); }
  });
  it('the token file is git-ignored and the example holds no real hash', () => {
    expect(readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8')).toMatch(/^config\/booking-tokens\.json$/m);
    const ex = readFileSync(path.resolve(__dirname, '../config/booking-tokens.example.json'), 'utf8'); expect(ex).toContain('REPLACE'); expect(ex).not.toMatch(/sha256\$[0-9a-f]{64}/);
  });
});

describe('staff sessions', () => {
  it('an expired, tampered or unknown-user session is refused', async () => {
    const secret = 'test-session-secret-0123456789abcdef-xyz'; const get = (cookie: string) => raw('/api/w/demo-physio/schedule/overview', { headers: { cookie: `fhq_session=${cookie}` } });
    expect((await get(signSession('admin@test', secret, NOW - 13 * 3600000))).status).toBe(401);          // older than the 12-hour session
    expect((await get(signSession('ghost@test', secret, NOW))).status).toBe(401);                          // a validly signed cookie for a user that does not exist
    expect((await get(signSession('admin@test', 'a-different-secret-0123456789abcdef-xx', NOW))).status).toBe(401);   // signed with the wrong secret
    const good = signSession('admin@test', secret, NOW); expect((await get(good)).status).toBe(200); expect((await get(good.slice(0, -2) + 'xx')).status).toBe(401);
  });
  it('a signed-in user outside the workspace gets nothing', async () => {
    const r = await raw('/api/w/no-such-clinic/schedule/overview', { headers: { cookie: fx.cookies.admin! } }); expect(r.status).toBe(404); expect(r.text).not.toContain('slots');
  });
  it('responses carry no-store and the usual security headers', async () => {
    const r = await raw('/api/booking/config', { headers: { authorization: `Bearer ${fx.token}` } }); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await raw('/api/w/demo-physio/schedule/overview', { headers: { cookie: fx.cookies.admin! } })).headers.get('cache-control')).toBe('no-store');
  });
});

describe('rate limiting behind the production reverse proxy', () => {
  const ctx = (headers: Record<string, string>, remote?: string) => ({ req: { header: (n: string) => headers[n.toLowerCase()] }, env: remote ? { incoming: { socket: { remoteAddress: remote } } } : undefined }) as unknown as Context;
  it('uses the address the proxy appended (the LAST entry), ignores what a client typed before it, trims, and falls back to the socket', () => {
    expect(clientKey(ctx({ 'x-forwarded-for': '203.0.113.7' }), true)).toBe('203.0.113.7');
    expect(clientKey(ctx({ 'x-forwarded-for': 'fake-1, fake-2 ,  203.0.113.7 ' }), true)).toBe('203.0.113.7');
    expect(clientKey(ctx({}, '172.18.0.9'), true)).toBe('172.18.0.9');                       // n8n -> flowhq inside the Docker network: no header, the container address
    expect(clientKey(ctx({ 'x-forwarded-for': '' }, '172.18.0.9'), true)).toBe('172.18.0.9');
    expect(clientKey(ctx({ 'x-forwarded-for': '203.0.113.7' }, '172.18.0.9'), false)).toBe('172.18.0.9');   // no proxy in front: the header is ignored
    expect(clientKey(ctx({}), false)).toBe('local'); expect(clientKey(ctx({ 'x-forwarded-for': 'x'.repeat(500) }), true).length).toBeLessThanOrEqual(64);
  });
  it('a caller cannot dodge the limit by rotating a fake leading address; another real address is unaffected', async () => {
    for (let i = 0; i < 20; i++) expect((await fx.api('/config', { token: 'x.y', headers: { 'x-forwarded-for': `spoof-${i}, 198.51.100.77` } })).status).toBe(401);
    expect((await fx.api('/config', { headers: { 'x-forwarded-for': 'another-spoof, 198.51.100.77' } })).status).toBe(429);   // same real client: blocked, even with a valid token
    expect((await fx.api('/config', { headers: { 'x-forwarded-for': 'spoof-0, 198.51.100.78' } })).status).toBe(200);          // a different real client: fine
  });
  it('with no proxy in front (trust off) the header is ignored entirely, so it cannot be used to dodge or to frame someone', async () => {
    fx = await buildFixture({ bookingOn: true, trustProxy: false });
    for (let i = 0; i < 20; i++) await fx.api('/config', { token: 'x.y', headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    expect((await fx.api('/config', { headers: { 'x-forwarded-for': '198.51.100.250' } })).status).toBe(429);
  });
  it('the sign-in limiter uses the same real-client rule (10 failures, then 429, even for the right password)', async () => {
    const login = (password: string, xff: string) => raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1', 'x-forwarded-for': xff }, body: JSON.stringify({ email: 'admin@test', password }) });
    for (let i = 0; i < 10; i++) expect((await login('wrong password', `fake-${i}, 203.0.113.99`)).status).toBe(401);
    expect((await login('correct horse 42', 'fake-x, 203.0.113.99')).status).toBe(429);
    expect((await login('correct horse 42', 'fake-x, 203.0.113.98')).status).toBe(200);
  });
  it('good calls are never counted, so n8n sharing one container address cannot lock itself out', async () => {
    for (let i = 0; i < 60; i++) expect((await fx.api('/config')).status).toBe(200);
  });
});
