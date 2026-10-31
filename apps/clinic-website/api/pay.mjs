// /api/pay  -  the website's "book and pay" backend. It validates a request and forwards it to the clinic's n8n payments webhook (W16S), which talks to FLOW HQ.
// The browser never sees the n8n address, the secret or any token. Nothing patient-related is logged: only an event name, a request id and a status code.
//
//   GET  /api/pay?action=config               is online booking with payment open?  (the page stays as it was while it is closed)
//   POST /api/pay  { action: slots | book | status | qr | screenshot, ... }
//
// Server-only environment variables (Vercel > Project > Settings; never PUBLIC_*):
//   N8N_PAYMENTS_URL         the n8n webhook, e.g. https://n8n.<domain>/webhook/site-payments. UNSET = payments are closed and the page shows nothing new.
//   N8N_WEBHOOK_SECRET       the same website webhook secret /api/enquiry uses (header-auth credential "FlowHQ W1 Webhook Auth").
//   N8N_WEBHOOK_AUTH_HEADER  that credential's header name (default X-Lead-Secret).
//   ALLOWED_ORIGINS          optional, comma separated https origins allowed to POST (default: the request's own host).
//   N8N_TIMEOUT_MS           optional, default 12000.
const MAX_BODY_BYTES = 4_200_000;                 // Vercel's own limit is 4.5 MB: the page shrinks the picture first
const RATE = { windowMs: 60_000, max: 40, shotMax: 8 };
const ACTIONS = ['slots', 'book', 'status', 'qr', 'screenshot'];

const send = (res, status, body, extra = {}) => {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
};
const readConfig = (env) => ({
  url: String(env.N8N_PAYMENTS_URL || '').trim(), secret: String(env.N8N_WEBHOOK_SECRET || ''), header: String(env.N8N_WEBHOOK_AUTH_HEADER || 'X-Lead-Secret').trim(),
  origins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean), timeoutMs: Math.min(30_000, Math.max(1000, Number(env.N8N_TIMEOUT_MS) || 12_000)),
});
const configured = (c) => /^https?:\/\/[^\s/]+\/\S+$/i.test(c.url) && c.secret.length >= 8 && !/^(Bearer\s+)?sk-or-/i.test(c.secret) && /^[A-Za-z0-9-]{1,60}$/.test(c.header);
const originAllowed = (req, c) => {
  const origin = String(req.headers.origin || '').replace(/\/+$/, ''); if (!origin) return false;
  if (c.origins.length) return c.origins.includes(origin);
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
};
const s = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const PHONE = /^[+0-9 ()-]{8,20}$/; const REF = /^[A-Za-z0-9-]{6,40}$/;

/** Only what each action needs is passed on; everything else the browser sent is dropped here. */
export function shape(body) {
  const a = s(body && body.action, 20); if (!ACTIONS.includes(a)) return { error: 'unknown_action' };
  if (a === 'slots') { const date = s(body.date, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'invalid_date' }; return { value: { action: a, date, ...(body.doctor_id ? { doctor_id: s(body.doctor_id, 40) } : {}) } }; }
  if (a === 'book') {
    const slot = s(body.slot_id, 60), name = s(body.patient_name, 120), phone = s(body.patient_phone, 30), rid = s(body.request_id, 64);
    if (!/^[A-Za-z0-9|:._-]{5,60}$/.test(slot)) return { error: 'invalid_slot' }; if (name.length < 2) return { error: 'invalid_name' }; if (!PHONE.test(phone)) return { error: 'invalid_phone' }; if (!/^[A-Za-z0-9._:-]{8,64}$/.test(rid)) return { error: 'invalid_request_id' };
    return { value: { action: a, slot_id: slot, patient_name: name, patient_phone: phone, request_id: rid, ...(body.reason ? { reason: s(body.reason, 300) } : {}) } };
  }
  const ref = s(body.payment_ref, 40), phone = s(body.patient_phone, 30);
  if (!REF.test(ref)) return { error: 'invalid_reference' }; if (!PHONE.test(phone)) return { error: 'invalid_phone' };
  if (a === 'screenshot') {
    const d = s(body.data_base64, 7_000_000).replace(/\s+/g, ''); if (d.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(d)) return { error: 'invalid_image' };
    return { value: { action: a, payment_ref: ref, patient_phone: phone, data_base64: d, mime: s(body.mime, 40), ...(body.utr ? { utr: s(body.utr, 40).replace(/[^A-Za-z0-9]/g, '') } : {}) } };
  }
  return { value: { action: a, payment_ref: ref, patient_phone: phone } };
}

export function createHandler({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const hits = new Map(); const shots = new Map();
  const log = (evt, extra = {}) => console.log(JSON.stringify({ evt, ...extra }));
  const limited = (map, ip, max) => { const t = now(); const r = (map.get(ip) || []).filter((x) => t - x < RATE.windowMs); if (r.length >= max) return true; r.push(t); map.set(ip, r); return false; };
  const forward = async (c, v) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
    try {
      const r = await fetchImpl(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', [c.header]: c.secret }, body: JSON.stringify(v), signal: ctl.signal });
      let data = null; try { data = await r.json(); } catch { /* n8n answered without JSON */ }
      if (data && typeof data === 'object' && r.status >= 200 && r.status < 500 && r.status !== 403) return { status: r.status, body: data };   // n8n already shaped it: patient-safe wording only
      log('upstream_failed', { code: r.status }); return { status: 502, body: { ok: false, error: 'unavailable' } };
    } catch (e) { const timeout = e && e.name === 'AbortError'; log(timeout ? 'upstream_timeout' : 'upstream_error'); return { status: timeout ? 504 : 502, body: { ok: false, error: timeout ? 'timeout' : 'unavailable' } }; }
    finally { clearTimeout(timer); }
  };
  return async function handler(req, res) {
    const c = readConfig(env);
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (req.method === 'GET') {
      if (String((req.query && req.query.action) || new URL(req.url || '/', 'http://x').searchParams.get('action') || '') !== 'config') return send(res, 404, { ok: false, error: 'not_found' });
      if (!configured(c)) return send(res, 200, { ok: true, payments: { open: false } });   // not set up here: the page shows nothing new
      if (limited(hits, ip, RATE.max)) return send(res, 429, { ok: false, error: 'rate_limited' });
      const r = await forward(c, { action: 'config' });
      return send(res, r.status === 200 ? 200 : 200, r.status === 200 && r.body && r.body.payments ? { ok: true, payments: r.body.payments } : { ok: true, payments: { open: false } }, { 'Cache-Control': 'no-store' });   // any problem = closed, never an error page
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { ok: false, error: 'method' }); }
    if (!originAllowed(req, c)) { log('origin_refused'); return send(res, 403, { ok: false, error: 'forbidden' }); }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, error: 'content_type' });
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return send(res, 413, { ok: false, error: 'too_large' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(res, 400, { ok: false, error: 'bad_json' }); } }
    if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'bad_json' });
    if (limited(hits, ip, RATE.max)) return send(res, 429, { ok: false, error: 'rate_limited' });
    const v = shape(body); if (v.error) return send(res, 422, { ok: false, error: v.error });
    if (v.value.action === 'screenshot' && limited(shots, ip, RATE.shotMax)) return send(res, 429, { ok: false, error: 'rate_limited' });
    if (!configured(c)) { log('not_configured'); return send(res, 503, { ok: false, error: 'unavailable' }); }
    const r = await forward(c, v.value);
    return send(res, r.status, r.body);
  };
}
export default createHandler();
