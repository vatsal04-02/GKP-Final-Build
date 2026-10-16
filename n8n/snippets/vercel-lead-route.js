// Vercel proxy: website contact form -> n8n workflow W1 (website lead intake).
// The browser posts to YOUR site (/api/lead); this route forwards to n8n with a secret header, so the n8n
// URL and secret never reach the browser and no CORS setup is needed.
//
// Where to put this file:
//   Next.js (App Router):          app/api/lead/route.js
//   Plain / static site on Vercel: api/lead.js
//
// Vercel > Project > Settings > Environment Variables (never put these in code or git):
//   N8N_LEAD_WEBHOOK_URL   https://<TS_HOSTNAME>/webhook/website-lead   (the n8n *Production* URL, workflow active)
//   N8N_LEAD_SECRET        same value as the n8n "Lead webhook secret" credential (header X-Lead-Secret)
//   CLINIC_SLUG            this website's clinic, e.g. demo-physio (must exist in the Agency Registry > Clinics)
//
// Form: POST /api/lead with JSON or form fields: name, phone, enquiry, page_url, utm_campaign,
// plus a hidden input named "website" that humans never fill (bots do; those are dropped silently).
//
// Replies: 200 {ok:true} | 400 {ok:false,error:"invalid"} | 502 {ok:false,error:"upstream"} when n8n is
// unreachable (e.g. the laptop is asleep) - show the visitor "please call us" in that case.

const MAX_BODY = 10000;

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function readFields(request) {
  const type = request.headers.get('content-type') || '';
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  try {
    if (type.includes('application/json')) return JSON.parse(raw);
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  } catch (e) {
    return null;
  }
  return null;
}

export async function POST(request) {
  const url = process.env.N8N_LEAD_WEBHOOK_URL;
  const secret = process.env.N8N_LEAD_SECRET;
  const clinic = process.env.CLINIC_SLUG;
  if (!url || !secret || !clinic) {
    console.error('lead route: N8N_LEAD_WEBHOOK_URL, N8N_LEAD_SECRET or CLINIC_SLUG is not set');
    return reply({ ok: false, error: 'not_configured' }, 500);
  }

  const f = await readFields(request);
  if (!f || typeof f !== 'object') return reply({ ok: false, error: 'invalid' }, 400);

  const str = (v, max) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
  const payload = {
    clinic,                                   // set here, not by the browser, so visitors cannot pick another clinic
    name: str(f.name, 100),
    phone: str(f.phone, 30),
    enquiry: str(f.enquiry, 1000),
    page_url: str(f.page_url || request.headers.get('referer'), 500),
    utm_campaign: str(f.utm_campaign, 100),
    website: str(f.website, 200),             // honeypot
  };

  if (payload.website) return reply({ ok: true });   // bot: pretend it worked, forward nothing
  if (!payload.name || payload.phone.replace(/\D/g, '').length < 10) return reply({ ok: false, error: 'invalid' }, 400);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lead-secret': secret },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!res.ok) {
      console.error(`lead route: n8n answered ${res.status}`);
      return reply({ ok: false, error: 'upstream' }, 502);
    }
    return reply({ ok: true });
  } catch (e) {
    console.error('lead route: could not reach n8n:', e && e.name);
    return reply({ ok: false, error: 'upstream' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
