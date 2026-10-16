// Tests for api/enquiry.mjs and src/lib/enquiry-shared.mjs. Synthetic people only; n8n is a fake `fetch`, nothing touches a network.
// Run: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/enquiry.mjs';
import { composeEnquiry, normalizeMobile10, validateEnquiry, CONSENT_VERSION } from '../src/lib/enquiry-shared.mjs';

const SECRET = 'synthetic-test-secret-0123456789';
const ENV = { N8N_WEBHOOK_URL: 'https://n8n.example.test/webhook-test/website-lead', N8N_WEBHOOK_SECRET: SECRET, N8N_WEBHOOK_AUTH_HEADER: 'X-Lead-Secret', CLINIC_SLUG: 'test-clinic', ALLOWED_ORIGINS: 'https://site.example.test', N8N_TIMEOUT_MS: '1000' };
const GOOD = { name: 'Test Patient', phone: '+91 98765 43210', concern: 'Back Pain', visit: 'Home visit', day: 'Mon 6', slot: 'Morning 9 AM–1 PM', consent_whatsapp: false, request_id: 'req-00000001', website: '' };

const call = async (handler, { method = 'POST', body = GOOD, headers = {}, raw } = {}) => {
  const req = { method, headers: { origin: 'https://site.example.test', host: 'site.example.test', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers }, body: raw !== undefined ? raw : body };
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s; } };
  await handler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};
const n8nOk = (status = 'ok') => ({ status: 200, json: async () => ({ status, action: 'created', lead_id: 'L-20261001-0001' }) });
const mk = (impl, env = ENV) => { const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, init, payload: JSON.parse(init.body) }); return impl(url, init, calls.length); }; return { handler: createHandler({ env, fetchImpl, now: () => 1_000_000 }), calls }; };

test('1 valid enquiry: forwarded once to n8n with the header secret and the CRM payload; the visitor gets "received"', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const r = await call(handler);
  assert.deepEqual([r.status, r.json], [200, { ok: true, status: 'received' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENV.N8N_WEBHOOK_URL);
  assert.equal(calls[0].init.headers['X-Lead-Secret'], SECRET);
  const p = calls[0].payload;
  assert.deepEqual([p.clinic_slug, p.name, p.phone, p.consent_whatsapp, p.consent_version, p.request_id], ['test-clinic', 'Test Patient', '+919876543210', false, CONSENT_VERSION, 'req-00000001']);
  assert.equal(p.enquiry, 'Concern: Back Pain · Visit: Home visit · Preferred: Mon 6, Morning 9 AM–1 PM');
  assert(!JSON.stringify(r).includes(SECRET), 'the secret is never returned');
});

test('2 missing name: 422, nothing forwarded', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const r = await call(handler, { body: { ...GOOD, name: '   ' } });
  assert.deepEqual([r.status, r.json.error, r.json.fields], [422, 'invalid', { name: 'required' }]);
  assert.equal(calls.length, 0);
});

test('3 invalid phone numbers are refused and never padded: too short, too long, wrong first digit, letters, empty', async () => {
  const { handler, calls } = mk(() => n8nOk());
  let i = 10;
  for (const phone of ['12345', '+91 98765 4321', '98765432101', '5876543210', 'abcdefghij', '', '+44 7700 900123']) {
    const r = await call(handler, { body: { ...GOOD, phone }, headers: { 'x-forwarded-for': `203.0.113.${i++}` } });   // a different address each time: the rate limit is tested separately
    assert.equal(r.status, 422, phone);
    assert(r.json.fields.phone, phone);
  }
  assert.equal(calls.length, 0);
  for (const [raw, ok] of [['98765 43210', '9876543210'], ['+91 98765 43210', '9876543210'], ['098765 43210', '9876543210'], ['919876543210', '9876543210']]) assert.equal(normalizeMobile10(raw), ok, raw);
});

test('4 optional fields missing: still accepted (name + phone are enough); consent defaults to false', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const r = await call(handler, { body: { name: 'Test Patient', phone: '9876543210' } });
  assert.equal(r.status, 200);
  assert.deepEqual([calls[0].payload.enquiry, calls[0].payload.consent_whatsapp], ['', false]);
  assert.equal(composeEnquiry({ concern: 'Hip Pain' }), 'Concern: Hip Pain');
});

test('4b WhatsApp consent is forwarded exactly as given, separate from submitting', async () => {
  const { handler, calls } = mk(() => n8nOk());
  await call(handler, { body: { ...GOOD, request_id: 'req-consent-no', consent_whatsapp: false } });
  await call(handler, { body: { ...GOOD, request_id: 'req-consent-yes', consent_whatsapp: true } });
  assert.deepEqual(calls.map((c) => c.payload.consent_whatsapp), [false, true]);
});

test('5 duplicate submission (same request id): n8n is called once, both answers are "received"', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const a = await call(handler); const b = await call(handler);
  assert.deepEqual([a.status, b.status, calls.length], [200, 200, 1]);
});

test('6 two simultaneous submissions with the same request id: one call to n8n', async () => {
  const { handler, calls } = mk(async () => { await new Promise((r) => setTimeout(r, 50)); return n8nOk(); });
  const [a, b] = await Promise.all([call(handler), call(handler)]);
  assert.deepEqual([a.status, b.status, calls.length], [200, 200, 1]);
});

test('6b n8n says the lead already exists ("duplicate"): the visitor still sees "received"', async () => {
  const { handler } = mk(() => ({ status: 200, json: async () => ({ status: 'duplicate' }) }));
  assert.deepEqual((await call(handler)).json, { ok: true, status: 'received' });
});

test('7 CRM / n8n failing (500, 404 test webhook not listening, 401, network error): 502 "unavailable", never "received", and a retry is allowed', async () => {
  for (const impl of [() => ({ status: 500, json: async () => ({}) }), () => ({ status: 404, json: async () => ({ message: 'not registered' }) }), () => ({ status: 401, json: async () => ({}) }), () => { throw new TypeError('fetch failed'); }]) {
    const { handler } = mk(impl);
    const r = await call(handler);
    assert.deepEqual([r.status, r.json], [502, { ok: false, error: 'unavailable' }]);
  }
  let n = 0;
  const { handler, calls } = mk(() => (++n === 1 ? { status: 500, json: async () => ({}) } : n8nOk()));
  assert.equal((await call(handler)).status, 502);
  assert.equal((await call(handler)).status, 200, 'the same request id may be retried after a failure');
  assert.equal(calls.length, 2);
});

test('8 n8n does not answer in time: 504 "timeout" (the visitor is told it may not have arrived)', async () => {
  const { handler } = mk((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  const r = await call(handler);
  assert.deepEqual([r.status, r.json], [504, { ok: false, error: 'timeout' }]);
});

test('9 invalid or unexpected payloads: refused without calling n8n', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const cases = [
    ['array body', { body: [1, 2] }, 422], ['null-ish string', { raw: 'not json at all' }, 400], ['number', { raw: 42 }, 422],
    ['wrong content type', { headers: { 'content-type': 'text/plain' } }, 415], ['huge body', { headers: { 'content-length': '999999' } }, 413],
    ['huge body without length', { body: { ...GOOD, name: 'x'.repeat(20_000) } }, 413],
    ['unknown concern', { body: { ...GOOD, concern: '<script>' } }, 422], ['bad day', { body: { ...GOOD, day: 'Someday' } }, 422], ['bad slot', { body: { ...GOOD, slot: 'midnight' } }, 422],
    ['GET', { method: 'GET' }, 405], ['foreign origin', { headers: { origin: 'https://evil.example.test' } }, 403], ['no origin', { headers: { origin: '' } }, 403],
  ];
  for (const [name, o, status] of cases) assert.equal((await call(handler, o)).status, status, name);
  assert.equal(calls.length, 0);
});

test('9b a filled honeypot is a bot: answered as received, nothing stored or forwarded', async () => {
  const { handler, calls } = mk(() => n8nOk());
  const r = await call(handler, { body: { ...GOOD, website: 'http://spam.example' } });
  assert.deepEqual([r.status, r.json.ok, calls.length], [200, true, 0]);
});

test('9c the CRM requires consent and the box was left unticked: the visitor is told so (no silent loss)', async () => {
  const { handler } = mk(() => ({ status: 400, json: async () => ({ status: 'invalid', error: 'consent required' }) }));
  assert.deepEqual((await call(handler)).json, { ok: false, error: 'consent_required' });
});

test('9d not configured (no URL / secret / slug): 503 "unavailable", nothing forwarded', async () => {
  for (const drop of ['N8N_WEBHOOK_URL', 'N8N_WEBHOOK_SECRET', 'CLINIC_SLUG']) {
    const env = { ...ENV }; delete env[drop];
    const { handler, calls } = mk(() => n8nOk(), env);
    assert.equal((await call(handler)).status, 503, drop);
    assert.equal(calls.length, 0);
  }
});

test('9e same-host origin is accepted when ALLOWED_ORIGINS is not set; rate limit: the 7th request in a minute is refused', async () => {
  const env = { ...ENV }; delete env.ALLOWED_ORIGINS;
  const { handler } = mk(() => n8nOk(), env);
  const r = await call(handler, { headers: { origin: 'https://site.example.test', host: 'site.example.test' } });
  assert.equal(r.status, 200);
  let last;
  for (let i = 0; i < 6; i++) last = await call(handler, { body: { ...GOOD, request_id: `req-rate-${i}0000` } });
  assert.equal(last.status, 429);
});

test('12/13 the only outbound call is the configured n8n webhook (no WhatsApp, e-mail or AI endpoint from the website)', async () => {
  const { handler, calls } = mk(() => n8nOk());
  await call(handler);
  assert.deepEqual([...new Set(calls.map((c) => new URL(c.url).host))], ['n8n.example.test']);
});

test('logs never contain the name, phone, concern or secret', async () => {
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    const { handler } = mk(() => ({ status: 500, json: async () => ({}) }));
    await call(handler, { body: { ...GOOD, request_id: 'req-log-0001' } });
    const { handler: h2 } = mk((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
    await call(h2, { body: { ...GOOD, request_id: 'req-log-0002' } });
  } finally { console.log = orig; }
  assert(lines.length >= 2);
  for (const l of lines) assert(!/Test Patient|9876543210|Back Pain|synthetic-test-secret/.test(l), l);
});

test('shared rules: validateEnquiry returns clean values, and rejects non-objects', () => {
  const v = validateEnquiry({ ...GOOD, name: '  Test   Patient\u0007 ' });
  assert.equal(v.ok, true); assert.equal(v.value.name, 'Test Patient'); assert.equal(v.value.mobile, '9876543210');
  assert.equal(validateEnquiry('x').ok, false);
});
