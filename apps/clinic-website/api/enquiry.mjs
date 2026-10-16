// POST /api/enquiry  -  the website's booking-request form posts here; this function checks it and forwards it to the clinic's n8n
// "website lead" webhook (workflow W1), which stores it in the Grist CRM. It runs on the server (Vercel Function), so the n8n URL and
// the webhook secret never reach the browser.
//
// Server-only environment variables (Vercel > Project > Settings > Environment Variables; never PUBLIC_*):
//   N8N_WEBHOOK_URL          the n8n webhook. Start with the TEST url (.../webhook-test/website-lead); switch to .../webhook/website-lead
//                            only when the clinic has approved go-live.
//   N8N_WEBHOOK_SECRET       the value n8n's header-auth credential for that webhook expects: a secret made for this webhook only, NEVER an OpenRouter
//                            or Grist key (a value that looks like an OpenRouter key, sk-or-..., is refused).
//   N8N_WEBHOOK_AUTH_HEADER  that credential's header NAME (default X-Lead-Secret).
//   CLINIC_SLUG              the clinic's Clinic_Slug in the Agency Registry (table Clinics). Not guessed anywhere in the code.
//   ALLOWED_ORIGINS          optional, comma separated https origins allowed to post (default: the request's own host).
//   N8N_TIMEOUT_MS           optional, default 8000.
// Nothing patient-related is logged: only an event name, a request id and a status code.
import { CONSENT_VERSION, composeEnquiry, validateEnquiry } from '../src/lib/enquiry-shared.mjs';

const MAX_BODY_BYTES = 10_000;
const RATE_LIMIT = { windowMs: 60_000, max: 6 };
const DEDUPE_TTL_MS = 10 * 60_000;

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const readConfig = (env) => ({
  url: String(env.N8N_WEBHOOK_URL || '').trim(),
  secret: String(env.N8N_WEBHOOK_SECRET || ''),
  header: String(env.N8N_WEBHOOK_AUTH_HEADER || 'X-Lead-Secret').trim(),
  slug: String(env.CLINIC_SLUG || '').trim().toLowerCase(),
  origins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  timeoutMs: Math.min(30_000, Math.max(1000, Number(env.N8N_TIMEOUT_MS) || 8000)),
});

const configProblem = (c, env = {}) => {
  if (!/^https?:\/\/[^\s/]+\/\S+$/i.test(c.url)) return 'N8N_WEBHOOK_URL';
  if (c.secret.length < 8) return 'N8N_WEBHOOK_SECRET';
  // the website secret is its own secret: an OpenRouter API key (sk-or-...) must never be used for it
  if (/^(Bearer\s+)?sk-or-/i.test(c.secret) || (env.OPENROUTER_API_KEY && c.secret === String(env.OPENROUTER_API_KEY))) return 'N8N_WEBHOOK_SECRET (looks like an OpenRouter key)';
  if (!/^[A-Za-z0-9-]{1,60}$/.test(c.header)) return 'N8N_WEBHOOK_AUTH_HEADER';
  if (!/^[a-z0-9-]{2,40}$/.test(c.slug)) return 'CLINIC_SLUG';
  return '';
};

const originAllowed = (req, c) => {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (!origin) return false;                                   // browsers always send Origin on a cross-page POST
  if (c.origins.length) return c.origins.includes(origin);
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
};

const bodyOf = (req) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY_BYTES) return { error: 413 };
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return { error: 415 };
  let body;
  try { body = req.body; } catch { return { error: 400 }; }
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return { error: 400 }; } }
  if (body === undefined || body === null) return { error: 400 };
  if (JSON.stringify(body).length > MAX_BODY_BYTES) return { error: 413 };
  return { body };
};

/** Builds the handler. `env`, `fetchImpl` and `now` are injectable so the tests can run it with fakes. */
export function createHandler({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const hits = new Map();       // ip -> [timestamps]   (best effort: each serverless instance has its own)
  const seen = new Map();       // request_id -> { at, promise }  (best effort; n8n's phone de-duplication is the real guarantee)
  const log = (evt, extra = {}) => console.log(JSON.stringify({ evt, ...extra }));

  const forward = async (c, v, rid) => {
    const payload = {
      clinic_slug: c.slug,
      name: v.name,
      phone: `+91${v.mobile}`,
      enquiry: composeEnquiry(v),
      page_url: /^https?:\/\//i.test(v.page_url) ? v.page_url : '',
      utm_campaign: v.utm_campaign,
      consent_whatsapp: v.consent_whatsapp,
      consent_version: CONSENT_VERSION,
      request_id: rid,
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
    try {
      const r = await fetchImpl(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [c.header]: c.secret, 'X-Request-Id': rid },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      let data = null;
      try { data = await r.json(); } catch { /* n8n answered without JSON */ }
      if (r.status === 200 && data && (data.status === 'ok' || data.status === 'duplicate')) return { status: 200, body: { ok: true, status: 'received' } };
      if (r.status === 400 && data && data.status === 'invalid') {
        const consent = /consent/i.test(String(data.error || ''));
        return { status: 422, body: { ok: false, error: consent ? 'consent_required' : 'invalid' } };
      }
      log('upstream_failed', { rid, code: r.status });
      return { status: 502, body: { ok: false, error: 'unavailable' } };
    } catch (e) {
      const timeout = e && e.name === 'AbortError';
      log(timeout ? 'upstream_timeout' : 'upstream_error', { rid });
      return { status: timeout ? 504 : 502, body: { ok: false, error: timeout ? 'timeout' : 'unavailable' } };
    } finally {
      clearTimeout(timer);
    }
  };

  return async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method' }); }
    const c = readConfig(env);
    if (!originAllowed(req, c)) { log('origin_refused'); return send(res, 403, { ok: false, error: 'forbidden' }); }
    const parsed = bodyOf(req);
    if (parsed.error) return send(res, parsed.error, { ok: false, error: parsed.error === 413 ? 'too_large' : parsed.error === 415 ? 'content_type' : 'bad_json' });

    const t = now();
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const recent = (hits.get(ip) || []).filter((x) => t - x < RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.max) { log('rate_limited'); return send(res, 429, { ok: false, error: 'rate_limited' }); }
    recent.push(t); hits.set(ip, recent);

    const v = validateEnquiry(parsed.body);
    if (!v.ok) return send(res, 422, { ok: false, error: 'invalid', fields: v.errors });
    if (v.value.honeypot) { log('honeypot'); return send(res, 200, { ok: true, status: 'received' }); }   // a bot: say nothing useful, store nothing

    const problem = configProblem(c, env);
    if (problem) { log('not_configured', { var: problem }); return send(res, 503, { ok: false, error: 'unavailable' }); }

    const rid = v.value.request_id || `srv-${t.toString(36)}`;
    for (const [k, e] of seen) if (t - e.at > DEDUPE_TTL_MS) seen.delete(k);
    let entry = v.value.request_id ? seen.get(rid) : null;
    if (!entry) {
      entry = { at: t, promise: forward(c, v.value, rid) };
      if (v.value.request_id) seen.set(rid, entry);
      entry.promise.then((r) => { if (r.status !== 200) seen.delete(rid); });   // only a success is remembered; a failure may be retried
    }
    const result = await entry.promise;
    return send(res, result.status, result.body);
  };
}

export default createHandler();
