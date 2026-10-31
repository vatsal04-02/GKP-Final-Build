// STAGING: the WEBSITE enquiry path, end to end, with real parts only where we can have them:
//   the website's own server function (apps/clinic-website/api/enquiry.mjs, the file Vercel runs) -> a REAL n8n (the 4D candidate, W1 website-lead with the dedicated
//   "FlowHQ W1 Webhook Auth" credential) -> a REAL Grist (throwaway container) -> the REAL FLOW HQ server, which lists the lead.
// Stand-ins: Meta and the AI model are NOT involved (W1 sends nothing; external AI off; send mode off). Synthetic people only. Nothing leaves this computer.
// Needs Linux with n8n: flowhq/deploy/staging/run-staging-n8n.ps1 -Filter tests/real-grist/staging-website  (image gkp-staging-n8n:local). Skipped everywhere else.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PW, REAL_ENABLED, REAL_URL, createStaging, deleteStaging, prepareForN8n, startServer, type Server, type Staging } from './harness';

const req = createRequire(import.meta.url);
const N8N_TESTS = path.resolve('..', 'n8n', 'production', 'tests', 'real');
const SITE_API = path.resolve('..', 'apps', 'clinic-website', 'api', 'enquiry.mjs');
const ready = REAL_ENABLED && !!process.env.N8N_RUNTIME_DIR && fs.existsSync(path.join(process.env.N8N_RUNTIME_DIR || '/nope', 'node_modules', '.bin', 'n8n')) && fs.existsSync(path.join(N8N_TESTS, 'n8n-real.js')) && fs.existsSync(SITE_API);
const d = describe.skipIf(!ready);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => fs.readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();
const KEYS = { app: 'staging-app-secret-0123456789abcdef', verify: 'staging-verify-token-0123456789', w1: 'staging-w1-secret-0123456789abcdef', wa: 'staging-wa-token-0123456789', ai: 'staging-ai-key-0123456789', tg: '123456789:staging-telegram-token-abcdefghij0123456', cal: 'staging-cal-secret-0123456789abcdef' };
const ORIGIN = 'https://geetakrishnaphysiotherapy.co.in';
const PHONE = (n: number) => `+9190000${String(30000 + n)}`;   // synthetic +91 90000 3xxxx
const local10 = (p: string) => p.slice(3);

d('STAGING WEBSITE PATH: website function -> real n8n (W1, dedicated webhook credential) -> real Grist -> FLOW HQ', () => {
  const R = ready ? req(path.join(N8N_TESTS, 'n8n-real.js')) : null;
  const { remap } = ready ? req(path.resolve('..', 'n8n', 'final', 'tools', 'remap-credentials-for-scratch.js')) : { remap: null as never };
  let s: Staging; let flow: Server; let n8n: any; let handlerFor: (secret: string) => (rq: any, rs: any) => Promise<void>; let site: (rq: any, rs: any) => Promise<void>; let cookie = '';
  const rows = (t: string) => s.client.records(s.clinicDocId, t);
  const leadsOf = async (phone: string) => (await rows('LEADS')).filter((l) => l.fields.Phone === phone);
  const waitFor = async <T,>(fn: () => Promise<T> | T, ms = 60000, what = 'condition'): Promise<NonNullable<T>> => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v as NonNullable<T>; } catch { /* retry */ } await sleep(400); } throw new Error(`timed out waiting for ${what}\n${String(n8n.logTail(6000)).split('\n').filter((l: string) => /error|fail|credential|webhook/i.test(l)).slice(-12).join('\n')}`); };
  let n = 0;
  /** what the browser form sends (apps/clinic-website/src/scripts/booking.ts), posted to the website function like Vercel does */
  const form = (over: Record<string, unknown> = {}) => ({ name: 'ZZ Synthetic Patient', phone: PHONE(1), concern: 'Back Pain', visit: 'At the clinic', day: 'Mon 9', slot: 'Morning 9 AM–1 PM', consent_whatsapp: true, consent_version: 'DRAFT-2026-10-v1', website: '', request_id: `req-${Date.now().toString(36)}-${++n}`, page_url: `${ORIGIN}/`, utm_campaign: 'staging-test', ...over });
  const submit = async (body: unknown, o: { fn?: (rq: any, rs: any) => Promise<void>; headers?: Record<string, string> } = {}) => {
    const rq = { method: 'POST', headers: { origin: ORIGIN, host: 'geetakrishnaphysiotherapy.co.in', 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${1 + (n++ % 250)}`, ...o.headers }, body };
    const rs = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v; }, end(x: string) { this.body = x; } };
    await (o.fn || site)(rq, rs); return { status: rs.statusCode, json: JSON.parse(rs.body), raw: rs.body, headers: rs.headers };
  };
  const staffGet = async (p: string) => { if (!cookie) { const r = await fetch(`${flow.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'admin@test', password: PW }) }); cookie = r.headers.get('set-cookie')!.split(';')[0]!; } const r = await fetch(`${flow.base}/api/w/${s.slug}${p}`, { headers: { cookie } }); return { status: r.status, json: await r.json() as any }; };

  beforeAll(async () => {
    s = await createStaging('staging-physio', { bookingOn: false }); await prepareForN8n(s);
    flow = await startServer(s);
    const wf = remap(JSON.parse(fs.readFileSync(path.resolve('..', 'n8n', 'final', 'workflows', process.env.STAGING_WORKFLOW || 'FlowHQ_Clinic_Automation_production_candidate4d.json'), 'utf8'))).wf;
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'stg-web-')); const file = path.join(dir, 'workflow.staging.json'); fs.writeFileSync(file, JSON.stringify(wf));
    // production-like settings: consent REQUIRED (FLOWHQ_W1_REQUIRE_CONSENT is true in production), nothing sent to anyone, external AI off
    const env = {
      FLOWHQ_GRIST_URL: REAL_URL, FLOWHQ_REGISTRY_DOC_ID: s.registryDocId, FLOWHQ_DEFAULT_COUNTRY_CODE: '91', FLOWHQ_TEST_PHONE: '+919000000019',
      FLOWHQ_WA_SEND_MODE: 'off', FLOWHQ_WA_ALLOWLIST: '+919000000018', FLOWHQ_WA_GRAPH_VERSION: 'v23.0', FLOWHQ_WA_TEMPLATE_LANGUAGE: 'en',
      FLOWHQ_META_APP_SECRET: KEYS.app, FLOWHQ_META_VERIFY_TOKEN: KEYS.verify, FLOWHQ_CAL_WEBHOOK_SECRET: KEYS.cal, FLOWHQ_CAL_MAX_AGE_HOURS: '24', FLOWHQ_ALERT_EMAIL_TO: '', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example',
      FLOWHQ_AI_EXTERNAL_ENABLED: 'false', FLOWHQ_TELEGRAM_CHAT_ID: '', FLOWHQ_W1_REQUIRE_CONSENT: 'true', FLOWHQ_BOOKING_API_URL: flow.base,
    };
    n8n = await new R.RealN8n({ workflowFile: file, env }).init();
    const out = path.join(n8n.dir, 'credentials.import.local.json');
    const cred = spawnSync(process.execPath, [path.resolve('..', 'n8n', 'production', 'scripts', 'create-credentials.js'), '--out', out, '--import', n8n.importCommand()], { env: { ...process.env, NODE_ENV: 'production', FLOWHQ_GRIST_API_KEY: key(), FLOWHQ_W1_WEBHOOK_SECRET: KEYS.w1, FLOWHQ_WA_ACCESS_TOKEN: KEYS.wa, FLOWHQ_AI_API_KEY: KEYS.ai, FLOWHQ_TELEGRAM_BOT_TOKEN: KEYS.tg, FLOWHQ_BOOKING_API_TOKEN: flow.token, FLOWHQ_SMTP_HOST: '127.0.0.1', FLOWHQ_SMTP_PORT: '1' }, encoding: 'utf8' });
    if (cred.status !== 0) throw new Error(`create-credentials failed: ${(cred.stdout + cred.stderr).slice(-600)}`);
    n8n.importWorkflow(); n8n.publish(); await n8n.start(240000);
    await waitFor(async () => (await n8n.request('GET', `/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=${KEYS.verify}&hub.challenge=4711`)).text === '4711', 120000, 'the workflows to be live');
    const { createHandler } = await import(/* @vite-ignore */ SITE_API);
    handlerFor = (secret) => createHandler({ env: { N8N_WEBHOOK_URL: `${n8n.base}/webhook/website-lead`, N8N_WEBHOOK_SECRET: secret, N8N_WEBHOOK_AUTH_HEADER: 'X-Lead-Secret', CLINIC_SLUG: s.slug, ALLOWED_ORIGINS: ORIGIN, N8N_TIMEOUT_MS: '30000' }, fetchImpl: (...a: Parameters<typeof fetch>) => fetch(...a) });
    site = handlerFor(KEYS.w1);
  }, 600000);
  afterAll(async () => { try { await n8n?.stop(); } catch { /* */ } await flow?.stop('SIGKILL').catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); }, 120000);

  it('1. a valid enquiry: the website answers "received"; the lead is in the REAL Grist with EVERY form field (name, phone, concern / visit / day / slot, consent and its wording version, page, campaign, source)', async () => {
    const r = await submit(form());
    expect(r.status).toBe(200); expect(r.json).toEqual({ ok: true, status: 'received' });
    const lead = (await waitFor(async () => (await leadsOf(PHONE(1)))[0], 60000, 'the lead row')).fields as Record<string, any>;
    expect(lead.Name).toBe('ZZ Synthetic Patient'); expect(lead.Source).toBe('Website'); expect(lead.Status).toBe('New');
    expect(lead.Enquiry).toBe('Concern: Back Pain · Visit: At the clinic · Preferred: Mon 9, Morning 9 AM–1 PM');
    expect(lead.Page_URL).toBe(`${ORIGIN}/`); expect(lead.UTM_Campaign).toBe('staging-test');
    expect(lead.Consent_WhatsApp).toBe(true); expect(lead.Consent_Source).toBe('website-form'); expect(lead.Consent_Version).toBe('DRAFT-2026-10-v1'); expect(lead.Consent_At).toBeTruthy();
  });

  it('2. FLOW HQ (the real server) lists that lead for staff: name, phone, source and the enquiry text', async () => {
    const list = await staffGet('/contacts'); expect(list.status).toBe(200);
    const items: any[] = list.json.items || list.json.contacts || list.json; const c = items.find((x) => String(x.phone || '').replace(/\D/g, '') === PHONE(1).replace(/\D/g, ''));
    expect(c, `contacts: ${JSON.stringify(items).slice(0, 300)}`).toBeTruthy();
    expect(c.name).toBe('ZZ Synthetic Patient'); expect(String(c.source)).toMatch(/website/i); expect(String(c.enquiry)).toContain('Concern: Back Pain');
  });

  it('3. a different way of typing the same number is the same patient: "098 000 03 0001"-style input still creates ONE lead; resubmitting does not add one', async () => {
    const p = PHONE(2);
    const body = form({ phone: `+91 ${local10(p).slice(0, 5)} ${local10(p).slice(5)}`, name: 'ZZ Typed Patient' });
    expect((await submit(body)).status).toBe(200); await waitFor(async () => (await leadsOf(p)).length === 1, 60000, 'one lead');
    const again = await submit(body);                                        // identical request id: the website function answers from its own record of the request
    expect(again.status).toBe(200);
    const retry = await submit({ ...body, request_id: `req-retry-${n}` });   // a NEW request id, same details: n8n finds the phone and recognises it as a duplicate
    expect(retry.status).toBe(200); await sleep(2500);
    expect(await leadsOf(p)).toHaveLength(1);
  });

  it('4. an existing CRM lead is preserved: a later enquiry from the same number updates THAT row (enquiry appended, status and notes untouched), it does not create a second lead', async () => {
    const p = PHONE(3);
    await s.client.add(s.clinicDocId, 'LEADS', [{ Lead_id: 'L-EXIST-1', Name: 'Existing Patient', Phone: p, Source: 'Walk-in', Status: 'Contacted', Notes: 'Called on Monday: prefers evenings', Enquiry: 'Knee pain since June', Consent_WhatsApp: false }]);
    expect((await submit(form({ phone: p, name: 'Existing Patient', concern: 'Knee Pain / Arthritis', slot: 'Evening 4–8 PM' }))).status).toBe(200);
    const lead = (await waitFor(async () => { const l = await leadsOf(p); return l.length === 1 && String(l[0]!.fields.Enquiry).includes('Concern: Knee Pain') ? l[0] : null; }, 60000, 'the existing lead to be updated')).fields as Record<string, any>;
    expect(lead.Lead_id).toBe('L-EXIST-1'); expect(lead.Status).toBe('Contacted'); expect(lead.Notes).toBe('Called on Monday: prefers evenings'); expect(lead.Source).toBe('Walk-in'); expect(String(lead.Enquiry)).toContain('Knee pain since June');
    expect(lead.Consent_WhatsApp).toBe(true); expect(lead.Consent_Source).toBe('website-form');
  });

  it('5. invalid submissions are rejected and create nothing: bad phone, no name, a choice that is not offered, a ticked honeypot, and the WhatsApp box NOT ticked (consent is required in production)', async () => {
    const before = (await rows('LEADS')).length;
    const bad = [form({ phone: '12345', request_id: 'req-bad-phone-1' }), form({ name: '', request_id: 'req-bad-name-01' }), form({ concern: 'Dentistry', request_id: 'req-bad-choice-1' })];
    for (const b of bad) { const r = await submit(b); expect(r.status, JSON.stringify(r.json)).toBe(422); expect(r.json.ok).toBe(false); }
    const bot = await submit(form({ phone: PHONE(4), website: 'http://spam.example', request_id: 'req-bot-000001' })); expect(bot.status).toBe(200);   // a bot is told nothing useful
    const noConsent = await submit(form({ phone: PHONE(5), consent_whatsapp: false, request_id: 'req-noconsent-1' })); expect(noConsent.status).toBe(422); expect(noConsent.json.error).toBe('consent_required');
    await sleep(2500); expect((await rows('LEADS')).length).toBe(before);
    const skipped = await waitFor(async () => (await rows('Run_Log')).find((x) => /W1/.test(String(x.fields.Workflow)) && x.fields.Outcome === 'skipped'), 30000, 'W1 to log a skipped submission');
    expect(skipped).toBeTruthy();
    expect(await leadsOf(PHONE(4))).toHaveLength(0); expect(await leadsOf(PHONE(5))).toHaveLength(0);
  });

  it('6. authentication: a website holding the WRONG secret is refused by n8n (the visitor sees a failure, never "received"), nothing is stored; n8n itself answers 403 without the header', async () => {
    const wrong = handlerFor('wrong-secret-0123456789abcdef');
    const r = await submit(form({ phone: PHONE(6), request_id: 'req-wrongsecret1' }), { fn: wrong });
    expect(r.status).toBe(502); expect(r.json).toEqual({ ok: false, error: 'unavailable' });
    const direct = await n8n.request('POST', '/webhook/website-lead', { body: JSON.stringify({ name: 'x', phone: PHONE(6) }), headers: { 'content-type': 'application/json' } });
    expect(direct.status).toBe(403);
    await sleep(1500); expect(await leadsOf(PHONE(6))).toHaveLength(0);
  });

  it('7. no secret or internal address appears in anything the browser can see (response bodies and headers, success and failure)', async () => {
    const outs = [await submit(form({ phone: PHONE(7), request_id: 'req-leakcheck-1' })), await submit(form({ phone: '123', request_id: 'req-leakcheck-2' })), await submit(form({ phone: PHONE(8), request_id: 'req-leakcheck-3' }), { fn: handlerFor('wrong-secret-0123456789abcdef') })];
    for (const o of outs) { const all = `${o.raw} ${JSON.stringify(o.headers)}`; for (const secret of [KEYS.w1, 'wrong-secret-0123456789abcdef', n8n.base, '/webhook/website-lead', REAL_URL, flow.token]) expect(all).not.toContain(secret); }
  });
});
