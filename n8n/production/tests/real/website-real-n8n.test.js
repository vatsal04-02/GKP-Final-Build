// REAL n8n end-to-end test of the WEBSITE path: the website's own api/enquiry.mjs (from SITE_DIR) -> the real n8n webhook (header auth, W1) -> fake Grist.
// Stand-ins on 127.0.0.1 (Grist, Meta, AI provider, optionally the real Mailpit binary); fictional data; nothing leaves this computer.
// Settings are the "controlled live test" ones: FLOWHQ_WA_SEND_MODE=off, no alert e-mail address, external AI off, FLOWHQ_W1_REQUIRE_CONSENT=false.
//   N8N_RUNTIME_DIR=<dir with node_modules/.bin/n8n> N8N_NODE_DIR=<dir of a node >= 24> SITE_DIR=<website repo> [MAILPIT_BIN=<path>] node n8n/production/tests/real/website-real-n8n.test.js
// Exit codes: 0 = all passed, 1 = a check failed, 3 = NOT RUN (prerequisites missing: reported as "not tested", never as a pass).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const R = require('./n8n-real');
const S = require('./fake-services');
const H = require('../harness');
const { F } = S;

if (!R.available() || !process.env.SITE_DIR) { console.log('NOT RUN: set N8N_RUNTIME_DIR, N8N_NODE_DIR (node >= 24) and SITE_DIR (the website repo).'); process.exit(3); }
const WORKFLOW = process.env.PROD_FILE || path.join(__dirname, '..', '..', 'clinic-autopilot-production.json');
const MAILPIT = process.env.MAILPIT_BIN || '';
const P = H.P;
const KEYS = { grist: 'real-test-grist-key-0123456789', w1: 'real-test-w1-secret-0123456789abcdef', wa: 'real-test-wa-token-0123456789', ai: 'real-test-ai-key-0123456789', tg: '123456789:real-test-telegram-token-abcdefghij0123456', app: 'real-test-app-secret-0123456789abcdef', verify: 'real-test-verify-token-0123456789', cal: 'real-test-cal-secret-0123456789abcdef' };
const rows = (docs, t) => docs.DOCA[t].map((r) => ({ id: r.id, ...r.fields }));
const waitFor = async (fn, ms = 30000, what = 'condition') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await R.sleep(300); } throw new Error(`timeout waiting for ${what}`); };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const w = {};
let site;
// calls the website function like the browser does (JSON POST with a same-site Origin)
const submit = async (body, headers = {}) => {
  const req = { method: 'POST', headers: { origin: 'https://site.example.test', 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${1 + (submit.n = (submit.n || 0) + 1) % 250}`, ...headers }, body };
  const res = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s; } };
  await site(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const enquiry = (over = {}) => ({ name: 'Test Patient', phone: '+91 98000 00041', concern: 'Back Pain', visit: 'At the clinic', day: 'Mon 6', slot: 'Morning 9 AM–1 PM', consent_whatsapp: false, request_id: `req-${Math.random().toString(36).slice(2, 12)}`, ...over });

async function bringUp() {
  w.grist = await S.startGrist({ docs: { REGDOC: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true } }] },
    DOCA: { Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST }), LEADS: [], Conversations: [], Messages: [], Appointments: [], Run_Log: [], Send_Ledger: [], Knowledge: [] } }, apiKey: KEYS.grist });
  w.meta = await S.startMeta(); w.ai = await S.startAi(); w.mail = await S.startMailpit(MAILPIT);
  const env = {
    FLOWHQ_GRIST_URL: w.grist.url, FLOWHQ_REGISTRY_DOC_ID: 'REGDOC', FLOWHQ_DEFAULT_COUNTRY_CODE: '91', FLOWHQ_TEST_PHONE: P.TEST,
    FLOWHQ_WA_SEND_MODE: 'off', FLOWHQ_WA_ALLOWLIST: P.OWNER, FLOWHQ_WA_GRAPH_VERSION: 'v23.0', FLOWHQ_WA_GRAPH_BASE_URL: w.meta.url, FLOWHQ_WA_TEMPLATE_LANGUAGE: 'en',
    FLOWHQ_META_APP_SECRET: KEYS.app, FLOWHQ_META_VERIFY_TOKEN: KEYS.verify, FLOWHQ_CAL_WEBHOOK_SECRET: KEYS.cal, FLOWHQ_CAL_MAX_AGE_HOURS: '24',
    FLOWHQ_W1_REQUIRE_CONSENT: 'false', FLOWHQ_ALERT_EMAIL_TO: '', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example',
    FLOWHQ_AI_EXTERNAL_ENABLED: 'false', FLOWHQ_AI_BASE_URL: w.ai.url, FLOWHQ_AI_MODEL: 'openai/gpt-4o-mini', FLOWHQ_TELEGRAM_CHAT_ID: '',
  };
  w.n8n = await new R.RealN8n({ workflowFile: WORKFLOW, env }).init();
  const credEnv = { ...process.env, FLOWHQ_GRIST_API_KEY: KEYS.grist, FLOWHQ_W1_WEBHOOK_SECRET: KEYS.w1, FLOWHQ_WA_ACCESS_TOKEN: KEYS.wa, FLOWHQ_AI_API_KEY: KEYS.ai, FLOWHQ_TELEGRAM_BOT_TOKEN: KEYS.tg, FLOWHQ_SMTP_HOST: '127.0.0.1', FLOWHQ_SMTP_PORT: String(w.mail ? w.mail.smtpPort : 1), FLOWHQ_SMTP_USER: 'u', FLOWHQ_SMTP_PASSWORD: 'p-0123456789', FLOWHQ_SMTP_SECURE: 'false' };
  const out = path.join(w.n8n.dir, 'credentials.import.local.json');
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'create-credentials.js'), '--out', out, '--import', w.n8n.importCommand()], { env: credEnv, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`.slice(-400));
  w.n8n.importWorkflow(); w.n8n.publish(); await w.n8n.start();
  const { createHandler } = await import(path.join(process.env.SITE_DIR, 'api/enquiry.mjs'));
  w.site = (url) => createHandler({ env: { N8N_WEBHOOK_URL: url, N8N_WEBHOOK_SECRET: KEYS.w1, N8N_WEBHOOK_AUTH_HEADER: 'X-Lead-Secret', CLINIC_SLUG: 'demo-physio', ALLOWED_ORIGINS: 'https://site.example.test', N8N_TIMEOUT_MS: '15000' } });
  site = w.site(`${w.n8n.base}/webhook/website-lead`);
}

test('R1 website function -> real n8n (header auth) -> Grist: unticked WhatsApp box is stored with consent false; the visitor sees "received"; nothing is sent anywhere', async () => {
  const r = await submit(enquiry());
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true, status: 'received' }]);
  const lead = rows(w.grist.docs, 'LEADS').find((l) => l.Phone === '+919800000041');
  assert(lead, 'the lead is in Grist');
  assert.deepStrictEqual([lead.Name, lead.Source, lead.Status, lead.Consent_WhatsApp, lead.Consent_At, lead.Enquiry], ['Test Patient', 'Website', 'New', false, null, 'Concern: Back Pain · Visit: At the clinic · Preferred: Mon 6, Morning 9 AM–1 PM']);
  await waitFor(() => rows(w.grist.docs, 'Run_Log').some((l) => l.Workflow === 'W1-website-lead' && /\(created\)/.test(l.Record)), 30000, 'the W1 Run_Log row');
  await R.sleep(1500);
  assert.strictEqual(w.meta.calls.length, 0, 'no Meta call');
  assert.strictEqual(w.ai.calls ? w.ai.calls.length : 0, 0, 'no AI call');
  if (w.mail) assert.strictEqual((await w.mail.messages()).length, 0, 'no e-mail');
});

test('R2 ticked box: consent is recorded; a repeat of the same visitor is "received" but creates no second lead', async () => {
  const body = enquiry({ phone: '98000 00042', consent_whatsapp: true });
  assert.strictEqual((await submit(body)).status, 200);
  assert.strictEqual((await submit({ ...body, request_id: 'req-another-id-1' })).status, 200);
  const leads = rows(w.grist.docs, 'LEADS').filter((l) => l.Phone === '+919800000042');
  assert.strictEqual(leads.length, 1);
  assert.deepStrictEqual([leads[0].Consent_WhatsApp, leads[0].Consent_Source], [true, 'website-form']);
});

test('R3 SIMULTANEOUS submissions of the same phone with different request ids (two tabs, two devices): measured, N pairs', async () => {
  const N = Number(process.env.RACE_PAIRS || 8);
  const dup = [];
  for (let i = 0; i < N; i++) {
    const phone = `+9198000${String(50 + i).padStart(5, '0')}`;
    const rs = await Promise.all([submit(enquiry({ phone, request_id: `req-race-a-${i}-0000` })), submit(enquiry({ phone, request_id: `req-race-b-${i}-0000` }))]);
    assert(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    await R.sleep(600);
    const n = rows(w.grist.docs, 'LEADS').filter((l) => l.Phone === phone).length;
    if (n !== 1) dup.push([phone.slice(-2), n]);
  }
  const fired = rows(w.grist.docs, 'Run_Log').filter((l) => /parallel submission/.test(l.Error || '')).length;
  console.log(`      RACE RESULT: ${N} simultaneous pairs, ${dup.length} produced more than one lead ${JSON.stringify(dup)}; the race guard fired ${fired} times (Run_Log)`);
  w.raceDuplicates = dup.length;
  if (process.env.REQUIRE_NO_RACE === '1') assert.strictEqual(dup.length, 0, 'duplicate leads from simultaneous submissions');
});

test('R4 wrong secret / the n8n TEST url while the workflow is active: the website says "unavailable", nothing is stored', async () => {
  const before = rows(w.grist.docs, 'LEADS').length;
  const wrongSecret = (await import(path.join(process.env.SITE_DIR, 'api/enquiry.mjs'))).createHandler({ env: { N8N_WEBHOOK_URL: `${w.n8n.base}/webhook/website-lead`, N8N_WEBHOOK_SECRET: 'wrong-secret-0123456789abcdef', CLINIC_SLUG: 'demo-physio', ALLOWED_ORIGINS: 'https://site.example.test' } });
  const testUrl = w.site(`${w.n8n.base}/webhook-test/website-lead`);
  for (const h of [wrongSecret, testUrl]) {
    const req = { method: 'POST', headers: { origin: 'https://site.example.test', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.200' }, body: enquiry({ phone: '98000 00043' }) };
    const res = { statusCode: 0, body: '', setHeader() {}, end(s) { this.body = s; } };
    await h(req, res);
    assert.deepStrictEqual([res.statusCode, JSON.parse(res.body).error], [502, 'unavailable']);
  }
  assert.strictEqual(rows(w.grist.docs, 'LEADS').length, before);
});

test('R5 Grist unavailable: the visitor is told so (never "received") and no lead exists; after Grist is back the same request id succeeds', async () => {
  const phone = '98000 00044';
  const body = enquiry({ phone, request_id: 'req-grist-down-0001' });
  const real = w.grist.grist.handle.bind(w.grist.grist);
  w.grist.grist.handle = (m, u, q, b) => { throw new Error('Grist 503: down'); };
  const down = await submit(body);
  w.grist.grist.handle = real;
  assert.notStrictEqual(down.status, 200, JSON.stringify(down));
  assert.strictEqual(down.json.ok, false);
  assert.strictEqual(rows(w.grist.docs, 'LEADS').filter((l) => l.Phone === '+919800000044').length, 0);
  const up = await submit(body);
  assert.strictEqual(up.status, 200, JSON.stringify(up));
  assert.strictEqual(rows(w.grist.docs, 'LEADS').filter((l) => l.Phone === '+919800000044').length, 1);
});

(async () => {
  let failed = 0; const t0 = Date.now();
  try {
    await bringUp();
    for (const t of tests) {
      try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')}`); }
    }
  } catch (e) { failed++; console.log(`  FAIL could not start: ${String(e && e.stack || e).split('\n').slice(0, 5).join('\n    ')}`); }
  finally { try { await w.n8n.stop(); } catch (e) { /* */ } for (const k of ['grist', 'meta', 'ai', 'mail']) { try { w[k] && w[k].close(); } catch (e) { /* */ } } }
  console.log(`website real n8n: ${tests.length - failed}/${tests.length} passed (${Math.round((Date.now() - t0) / 1000)} s)${w.raceDuplicates !== undefined ? `; simultaneous-duplicate pairs: ${w.raceDuplicates}` : ''}`);
  process.exit(failed ? 1 : 0);
})();
