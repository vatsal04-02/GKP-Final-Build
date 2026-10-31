// /api/pay: validation, origin and rate rules, that nothing but the shaped request leaves the site, and that any trouble makes payments look CLOSED (never an error page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, shape } from '../api/pay.mjs';

const ENV = { N8N_PAYMENTS_URL: 'https://n8n.example.test/webhook/site-payments', N8N_WEBHOOK_SECRET: 'site-secret-0123456789abcdef', ALLOWED_ORIGINS: 'https://site.example.test' };
const mkRes = () => { const r = { headers: {}, statusCode: 0, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } }; return r; };
const call = async (h, { method = 'POST', body, origin = 'https://site.example.test', headers = {}, url = '/api/pay' } = {}) => { const res = mkRes(); await h({ method, url, headers: { origin, host: 'site.example.test', 'content-type': 'application/json', ...headers }, body, socket: { remoteAddress: '1.2.3.4' } }, res); return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers }; };
const up = (status, body) => { const calls = []; const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { status, json: async () => body }; }; f.calls = calls; return f; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 7)]).toString('base64');

test('config: closed (no call to n8n) when the site has no payments URL; closed on any upstream trouble; open only when n8n says so', async () => {
  const f0 = up(200, {}); const closed = await call(createHandler({ env: {}, fetchImpl: f0 }), { method: 'GET', url: '/api/pay?action=config' }); assert.deepEqual(closed.json, { ok: true, payments: { open: false } }); assert.equal(f0.calls.length, 0);
  const bad = await call(createHandler({ env: ENV, fetchImpl: up(502, { x: 1 }) }), { method: 'GET', url: '/api/pay?action=config' }); assert.deepEqual(bad.json.payments, { open: false });
  const boom = await call(createHandler({ env: ENV, fetchImpl: async () => { throw new Error('down'); } }), { method: 'GET', url: '/api/pay?action=config' }); assert.equal(boom.status, 200); assert.deepEqual(boom.json.payments, { open: false });
  const ok = await call(createHandler({ env: ENV, fetchImpl: up(200, { ok: true, payments: { open: true, fee_inr: '500', payee_name: 'VATSAL TRIPATHI', expiry_minutes: 30 } }) }), { method: 'GET', url: '/api/pay?action=config' }); assert.equal(ok.json.payments.open, true); assert.equal(ok.headers['Cache-Control'], 'no-store');
  assert.equal((await call(createHandler({ env: ENV }), { method: 'GET', url: '/api/pay?action=other' })).status, 404);
});
test('POST: only same-origin JSON; unknown actions and malformed fields are refused before n8n is called', async () => {
  const f = up(200, { ok: true }); const h = createHandler({ env: ENV, fetchImpl: f });
  assert.equal((await call(h, { origin: 'https://evil.example', body: { action: 'slots', date: '2026-11-03' } })).status, 403); assert.equal((await call(h, { origin: '', body: { action: 'slots', date: '2026-11-03' } })).status, 403);
  assert.equal((await call(h, { headers: { 'content-type': 'text/plain' }, body: {} })).status, 415); assert.equal((await call(h, { body: 'not json' })).status, 400);
  for (const [b, err] of [[{ action: 'nope' }, 'unknown_action'], [{ action: 'slots', date: 'x' }, 'invalid_date'], [{ action: 'book', slot_id: '!', patient_name: 'Asha', patient_phone: '9876543210', request_id: 'abcdefgh1' }, 'invalid_slot'], [{ action: 'book', slot_id: 'DR-001|2026-11-03|10:00', patient_name: 'A', patient_phone: '9876543210', request_id: 'abcdefgh1' }, 'invalid_name'], [{ action: 'status', payment_ref: '!!', patient_phone: '9876543210' }, 'invalid_reference'], [{ action: 'screenshot', payment_ref: 'GKA-000001', patient_phone: '9876543210', data_base64: '$$$$$$$$$$$$$$$$$' }, 'invalid_image']]) { const r = await call(h, { body: b }); assert.equal(r.status, 422, JSON.stringify(b)); assert.equal(r.json.error, err); }
  assert.equal(f.calls.length, 0);
});
test('a valid request is forwarded with the secret header, only the fields that action needs, and the browser sees only n8n\'s shaped answer', async () => {
  const f = up(201, { ok: true, payment_ref: 'wa-GKA-000001', status: 'awaiting_payment', amount_inr: '500' }); const h = createHandler({ env: ENV, fetchImpl: f });
  const r = await call(h, { body: { action: 'book', slot_id: 'DR-001|2026-11-03|10:00', patient_name: 'Asha Test', patient_phone: '+91 98765 43210', request_id: 'req-abcdefgh-1', extra: 'dropped', secret: 'dropped' } });
  assert.equal(r.status, 201); assert.equal(r.json.payment_ref, 'wa-GKA-000001'); assert.equal(f.calls[0].url, ENV.N8N_PAYMENTS_URL); assert.equal(f.calls[0].init.headers['X-Lead-Secret'], ENV.N8N_WEBHOOK_SECRET);
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['action', 'patient_name', 'patient_phone', 'request_id', 'slot_id']); assert.ok(!JSON.stringify(r).includes(ENV.N8N_WEBHOOK_SECRET)); assert.ok(!JSON.stringify(r).includes('n8n.example.test'));
});
test('a screenshot is forwarded with its UTR (letters and digits only); 6 pictures a minute per visitor at most', async () => {
  const f = up(200, { ok: true, status: 'received' }); const h = createHandler({ env: ENV, fetchImpl: f });
  const b = { action: 'screenshot', payment_ref: 'wa-GKA-000001', patient_phone: '9876543210', data_base64: PNG, mime: 'image/png', utr: '4123 4567-8901' };
  assert.equal((await call(h, { body: b })).status, 200); assert.equal(f.calls[0].body.utr, '412345678901');
  let last; for (let i = 0; i < 9; i++) last = await call(h, { body: b }); assert.equal(last.status, 429);
});
test('n8n refusing the secret (403) or failing never leaks: the visitor gets a plain "unavailable"; unset config is 503', async () => {
  const b = { action: 'status', payment_ref: 'wa-GKA-000001', patient_phone: '9876543210' };
  assert.deepEqual((await call(createHandler({ env: ENV, fetchImpl: up(403, { message: 'Authorization data is wrong!' }) }), { body: b })).json, { ok: false, error: 'unavailable' });
  assert.equal((await call(createHandler({ env: ENV, fetchImpl: up(500, { message: 'Error in workflow' }) }), { body: b })).json.error, 'unavailable');
  assert.equal((await call(createHandler({ env: { ...ENV, N8N_PAYMENTS_URL: '' } }), { body: b })).status, 503);
  assert.equal((await call(createHandler({ env: { ...ENV, N8N_WEBHOOK_SECRET: 'sk-or-v1-abcdefghijkl' } }), { body: b })).status, 503);   // an AI key is never accepted as the website secret
});
test('shape() keeps nothing the action does not need', () => { assert.deepEqual(shape({ action: 'qr', payment_ref: 'GKA-000123', patient_phone: '9876543210', data_base64: 'x'.repeat(50), junk: 1 }).value, { action: 'qr', payment_ref: 'GKA-000123', patient_phone: '9876543210' }); });
