// REAL n8n end-to-end test of the PRODUCTION export: the installed n8n imports the workflow through its own CLI, the credentials are created with
// scripts/create-credentials.js, the workflow is published and n8n is started; then real HTTP requests hit the real webhooks.
// Stand-ins on 127.0.0.1: Grist, Meta, an AI provider (all fake, with fictional data) and Mailpit (the real binary, if present). Nothing leaves this computer.
//   N8N_RUNTIME_DIR=<dir with node_modules/.bin/n8n> N8N_NODE_DIR=<dir of a node >= 24> [MAILPIT_BIN=<path>] [FAKETIME_LIB=<libfaketime.so.1>] node n8n/production/tests/real/real-n8n.test.js
// Exit codes: 0 = all passed, 1 = a check failed, 3 = NOT RUN (prerequisites missing: this is reported as "not tested", never as a pass).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const cp = require('child_process');
const R = require('./n8n-real');
const S = require('./fake-services');
const H = require('../harness');
const { F } = S;

if (!R.available()) { console.log('NOT RUN: set N8N_RUNTIME_DIR (a folder with node_modules/.bin/n8n) and N8N_NODE_DIR (a node >= 24 for n8n 2.x).'); process.exit(3); }
const WORKFLOW = process.env.PROD_FILE || path.join(__dirname, '..', '..', 'clinic-autopilot-production.json');
const MAILPIT = process.env.MAILPIT_BIN || '';
const sleep = R.sleep;
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- the clock n8n sees (shifted to 11:00 IST when libfaketime is available)
const shiftMs = () => (R.FAKETIME_LIB ? R.dayShiftSeconds() * 1000 : 0);
const clockNow = () => Date.now() + shiftMs();
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- fixtures
const KEYS = { grist: 'real-test-grist-key-0123456789', w1: 'real-test-w1-secret-0123456789abcdef', wa: 'real-test-wa-token-0123456789', ai: 'real-test-ai-key-0123456789', tg: '123456789:real-test-telegram-token-abcdefghij0123456', app: 'real-test-app-secret-0123456789abcdef', verify: 'real-test-verify-token-0123456789', cal: 'real-test-cal-secret-0123456789abcdef' };
const P = H.P;
const docsFor = (extraSettings = {}) => ({
  REGDOC: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true } }] },
  DOCA: { Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: undefined, owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...extraSettings }), LEADS: [], Conversations: [], Messages: [], Appointments: [], Run_Log: [], Send_Ledger: [], Knowledge: clone(F.KNOWLEDGE) },
});
const rows = (docs, t) => docs.DOCA[t].map((r) => ({ id: r.id, ...r.fields }));
const waitFor = async (fn, ms = 30000, what = 'condition') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await sleep(300); } throw new Error(`timed out waiting for: ${what}`); };
const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const metaRaw = (body) => JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const inboundMsg = (text, { id, from = P.BOB, name = 'Bob Singh' } = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '123456789012345' }, contacts: [{ profile: { name }, wa_id: from.slice(1) }], messages: [{ from: from.slice(1), id, timestamp: String(Math.floor(clockNow() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const statusBody = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '123456789012345' }, statuses: statuses.map((s) => ({ recipient_id: P.ASHA.slice(1), timestamp: String(Math.floor(clockNow() / 1000)), ...s })) } }] }] });
const calBody = (uid, over = {}) => { const start = clockNow() + 26 * 3600 * 1000; return { triggerEvent: 'BOOKING_CREATED', createdAt: iso(clockNow() - 30000), payload: { uid, title: 'Physio assessment', startTime: iso(start), endTime: iso(start + 2700000), status: 'ACCEPTED', organizer: { name: 'Dr Rao' }, attendees: [{ name: 'Meera Joshi', email: 'meera@example.test', phoneNumber: '+91 98000 00031' }], responses: {} }, ...over }; };
const formBody = (over = {}) => ({ clinic_slug: 'demo-physio', name: 'Priya Nair', phone: '98000 00021', enquiry: 'Knee pain since a month', consent_whatsapp: 'on', consent_version: 'v1', website: '', ...over });

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const state = {};

// ---------------------------------------------------------------- bring the world up
async function bringUp({ ai = false, blockEnv = false, tag = 'main' } = {}) {
  const w = {};
  w.grist = await S.startGrist({ docs: docsFor(ai ? { ai_mode: 'auto', booking_link: 'https://cal.com/demo-physio/assessment' } : {}), apiKey: KEYS.grist });
  w.meta = await S.startMeta();
  w.ai = await S.startAi();
  w.mail = await S.startMailpit(MAILPIT);
  const env = {
    FLOWHQ_GRIST_URL: w.grist.url, FLOWHQ_REGISTRY_DOC_ID: 'REGDOC', FLOWHQ_DEFAULT_COUNTRY_CODE: '91', FLOWHQ_TEST_PHONE: P.TEST,
    FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.BOB},${P.OWNER},${P.TEST},+919800000031,+919800000021,${P.INTL}`, FLOWHQ_WA_GRAPH_VERSION: 'v23.0', FLOWHQ_WA_GRAPH_BASE_URL: w.meta.url, FLOWHQ_WA_TEMPLATE_LANGUAGE: 'en',
    FLOWHQ_META_APP_SECRET: KEYS.app, FLOWHQ_META_VERIFY_TOKEN: KEYS.verify, FLOWHQ_CAL_WEBHOOK_SECRET: KEYS.cal, FLOWHQ_CAL_MAX_AGE_HOURS: '24',
    FLOWHQ_ALERT_EMAIL_TO: 'frontdesk@clinic.example', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example',
    FLOWHQ_AI_EXTERNAL_ENABLED: ai ? 'true' : 'false', FLOWHQ_AI_BASE_URL: w.ai.url, FLOWHQ_AI_MODEL: 'openai/gpt-4o-mini',
    FLOWHQ_TELEGRAM_CHAT_ID: '',
  };
  w.n8n = await new R.RealN8n({ workflowFile: WORKFLOW, env }).init();
  if (blockEnv) delete w.n8n.env.N8N_BLOCK_ENV_ACCESS_IN_NODE;   // n8n's default: $env is blocked in nodes
  // credentials through the shipped script (the same way an operator does it)
  const credEnv = { ...process.env, FLOWHQ_GRIST_API_KEY: KEYS.grist, FLOWHQ_W1_WEBHOOK_SECRET: KEYS.w1, FLOWHQ_WA_ACCESS_TOKEN: KEYS.wa, FLOWHQ_AI_API_KEY: KEYS.ai, FLOWHQ_TELEGRAM_BOT_TOKEN: KEYS.tg, FLOWHQ_SMTP_HOST: '127.0.0.1', FLOWHQ_SMTP_PORT: String(w.mail ? w.mail.smtpPort : 1), FLOWHQ_SMTP_USER: '', FLOWHQ_SMTP_PASSWORD: '', FLOWHQ_SMTP_SECURE: 'false', FLOWHQ_SMTP_DISABLE_STARTTLS: 'true' };
  const out = path.join(w.n8n.dir, 'credentials.import.local.json');
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'create-credentials.js'), '--out', out, '--import', w.n8n.importCommand()], { env: credEnv, encoding: 'utf8' });
  w.credOutput = `${r.stdout}${r.stderr}`;
  w.credStatus = r.status;
  w.credFileGone = !fs.existsSync(out);
  w.n8n.importWorkflow();
  w.n8n.publish();
  await w.n8n.start();
  return w;
}
const tearDown = async (w) => { try { await w.n8n.stop(); } catch (e) { /* */ } for (const k of ['grist', 'meta', 'ai', 'mail']) { try { w[k] && w[k].close(); } catch (e) { /* */ } } };
const W = () => state.main;

// ================================================================ the tests
test('credentials script: imports all six credentials through n8n\'s own CLI, prints no secret, deletes its file', () => {
  const w = W();
  assert.strictEqual(w.credStatus, 0, w.credOutput);
  assert(w.credFileGone, 'the import file must be gone');
  for (const v of Object.values(KEYS)) assert(!w.credOutput.includes(v), 'a secret was printed');
  assert.match(w.credOutput, /import finished/);
  const exp = path.join(w.n8n.dir, 'creds-export.json');
  w.n8n.cli(['export:credentials', '--all', `--output=${exp}`]);
  const list = JSON.parse(fs.readFileSync(exp, 'utf8'));
  assert.deepStrictEqual(list.map((c) => c.name).sort(), ['FlowHQ AI Provider', 'FlowHQ Grist API', 'FlowHQ SMTP', 'FlowHQ Telegram Alerts', 'FlowHQ W1 Webhook Auth', 'FlowHQ WhatsApp Cloud API']);
  const text = fs.readFileSync(exp, 'utf8');
  for (const v of Object.values(KEYS)) assert(!text.includes(v), 'credentials are stored encrypted (N8N_ENCRYPTION_KEY_FILE works)');
  fs.unlinkSync(exp);
});

test('the export imports inactive-by-itself, publishes, and n8n registers exactly the four webhooks', async () => {
  const w = W();
  const log = w.n8n.logTail(20000);
  assert(!/Error: Workflow could not be activated|could not be activated/i.test(log), log.slice(-600));
  for (const [m, p] of [['GET', '/webhook/whatsapp-inbound'], ['POST', '/webhook/whatsapp-inbound'], ['POST', '/webhook/website-lead'], ['POST', '/webhook/cal?clinic=x']]) {
    const r = await w.n8n.request(m, p, m === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {});
    assert.notStrictEqual(r.status, 404, `${m} ${p} is not registered`);
  }
  assert.strictEqual((await w.n8n.request('POST', '/webhook/cal-w4-test', { body: '{}', headers: { 'content-type': 'application/json' } })).status, 404, 'the obsolete test webhook must not exist');
  assert.strictEqual((await w.n8n.request('POST', '/webhook-test/website-lead', { body: '{}', headers: { 'content-type': 'application/json' } })).status, 404, 'test webhooks are not registered while the workflow is active');
});

test('Meta handshake in real n8n: the right token returns the challenge, a wrong one gets 403', async () => {
  const w = W();
  const ok = await w.n8n.request('GET', `/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=${KEYS.verify}&hub.challenge=4711`);
  assert.deepStrictEqual([ok.status, ok.text], [200, '4711']);
  const bad = await w.n8n.request('GET', '/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong-token-0123456789&hub.challenge=4711');
  assert.strictEqual(bad.status, 403);
});

test('W2 signature in real n8n (raw body, Buffer and HMAC inside the task runner): forged / unsigned / tampered = 401 and nothing stored; a signed unicode message is stored', async () => {
  const w = W();
  const body = inboundMsg('नमस्ते, फीस कितनी है? café ✓ 😀', { id: 'wamid.REAL.IN1' });
  const raw = metaRaw(body);
  const post = (headers, payload = raw) => w.n8n.request('POST', '/webhook/whatsapp-inbound', { body: payload, headers: { 'content-type': 'application/json', ...headers } });
  assert.strictEqual((await post({})).status, 401);
  assert.strictEqual((await post({ 'x-hub-signature-256': `sha256=${sign(raw, 'another-secret-0123456789abcdef')}` })).status, 401);
  assert.strictEqual((await post({ 'x-hub-signature-256': `sha256=${sign(raw, KEYS.app)}` }, raw.replace('REAL.IN1', 'REAL.IN9'))).status, 401, 'a tampered body');
  assert.strictEqual((await post({ 'x-hub-signature-256': `sha256=${sign(JSON.stringify(body), KEYS.app)}` })).status === 401 || JSON.stringify(body) === raw, true, 'a signature over a re-serialised copy is only valid if the bytes are identical');
  assert.strictEqual(rows(w.grist.docs, 'LEADS').length, 0, 'nothing was stored by a refused request');
  const ok = await post({ 'x-hub-signature-256': `sha256=${sign(raw, KEYS.app)}` });
  assert.strictEqual(ok.status, 200, ok.text);
  await waitFor(() => rows(w.grist.docs, 'Messages').some((m) => m.WA_Message_ID === 'wamid.REAL.IN1'), 30000, 'the inbound message in Grist');
  const m = rows(w.grist.docs, 'Messages').find((x) => x.WA_Message_ID === 'wamid.REAL.IN1');
  assert.strictEqual(m.Body, 'नमस्ते, फीस कितनी है? café ✓ 😀');
  const lead = rows(w.grist.docs, 'LEADS')[0];
  assert.deepStrictEqual([lead.Phone, lead.Consent_WhatsApp, lead.Consent_Source], [P.BOB, true, 'whatsapp-inbound']);
  // replay: same id again changes nothing
  const before = rows(w.grist.docs, 'Messages').length;
  assert.strictEqual((await post({ 'x-hub-signature-256': `sha256=${sign(raw, KEYS.app)}` })).status, 200);
  await sleep(4000);
  assert.strictEqual(rows(w.grist.docs, 'Messages').length, before, 'a replay creates no second message');
  assert.strictEqual(rows(w.grist.docs, 'LEADS').length, 1);
});

test('W1 in real n8n: header auth is enforced by n8n; validation answers come BEFORE any alert; a valid enquiry is stored, answered 200, alerted on WhatsApp (ledger) AND by e-mail', async () => {
  const w = W();
  const post = (body, headers = { 'x-lead-secret': KEYS.w1 }) => w.n8n.request('POST', '/webhook/website-lead', { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const noAuth = await post(formBody(), {});
  assert([401, 403].includes(noAuth.status), `no header: HTTP ${noAuth.status}`);
  assert([401, 403].includes((await post(formBody(), { 'x-lead-secret': 'wrong-secret-0123456789abcdef' })).status));
  assert.strictEqual(rows(w.grist.docs, 'LEADS').filter((l) => l.Name === 'Priya Nair').length, 0);
  const bad = await post(formBody({ consent_whatsapp: '' }));
  assert.deepStrictEqual([bad.status, bad.json], [400, { status: 'invalid', error: 'consent required' }]);
  const metaBefore = w.meta.calls.length;
  const ok = await post(formBody());
  assert.strictEqual(ok.status, 200, ok.text);
  assert.deepStrictEqual([ok.json.status, ok.json.action], ['ok', 'created']);
  const lead = rows(w.grist.docs, 'LEADS').find((l) => l.Name === 'Priya Nair');
  assert.deepStrictEqual([lead.Phone, lead.Status, lead.Consent_WhatsApp, lead.Consent_Source, lead.Consent_Version], ['+919800000021', 'New', true, 'website-form', 'v1'], 'stored before the answer');
  await waitFor(() => w.meta.calls.length > metaBefore, 30000, 'the staff alert at Meta');
  const call = w.meta.calls[w.meta.calls.length - 1];
  assert.deepStrictEqual([call.method, call.path, call.auth, call.body.template.name, call.body.to], ['POST', '/v23.0/123456789012345/messages', `Bearer ${KEYS.wa}`, 'new_lead_staff_alert', P.OWNER.slice(1)]);
  assert.match(call.body.biz_opaque_callback_data, /^fhq:W1:created:L-\d{8}-\d{4}:/);
  const led = await waitFor(() => rows(w.grist.docs, 'Send_Ledger').find((l) => /^W1:created:/.test(l.Idem_Key) && l.Status === 'accepted'), 20000, 'ledger row accepted');
  assert(/^wamid\.REAL\d+$/.test(led.WA_Message_ID));
  await waitFor(() => rows(w.grist.docs, 'Run_Log').some((l) => l.Workflow === 'W1-website-lead' && /\(created\)/.test(l.Record)), 30000, 'W1 Run_Log row of the created lead');
  if (w.mail) {
    const mail = await waitFor(async () => (await w.mail.messages()).find((m) => /New website lead: Priya Nair/.test(m.Subject)), 30000, 'the e-mail in Mailpit');
    const full = await w.mail.message(mail.ID);
    assert.deepStrictEqual([mail.From.Address, mail.To[0].Address], ['noreply@clinic.example', 'frontdesk@clinic.example']);
    assert.match(full.Text, /Phone: \+919800000021/);
    assert.match(rows(w.grist.docs, 'Run_Log').find((l) => l.Workflow === 'W1-website-lead' && /\(created\)/.test(l.Record)).Error, /staff e-mail sent/);
  }
  // the same submission again: duplicate, no second alert
  const callsNow = w.meta.calls.length;
  const dup = await post(formBody());
  assert.deepStrictEqual([dup.status, dup.json.status], [200, 'duplicate']);
  await sleep(3000);
  assert.strictEqual(w.meta.calls.length, callsNow);
});

test('W4 in real n8n: Cal.com signature over the RAW bytes, replay window, 401/422/200 answers, confirmation through W12', async () => {
  const w = W();
  const post = (raw, headers, q = 'demo-physio') => w.n8n.request('POST', `/webhook/cal?clinic=${q}`, { body: raw, headers: { 'content-type': 'application/json', ...headers } });
  const body = calBody('cal-real-1');
  const pretty = JSON.stringify(body, null, 2);   // other whitespace than JSON.stringify(parsed)
  assert.strictEqual((await post(pretty, {})).status, 401);
  assert.strictEqual((await post(pretty, { 'x-cal-signature-256': sign(pretty, 'another-secret-0123456789abcdef') })).status, 401);
  assert.strictEqual((await post(pretty, { 'x-cal-signature-256': sign(JSON.stringify(JSON.parse(pretty)), KEYS.cal) })).status, 401, 'a signature over the re-serialised copy is not the signature of the bytes sent');
  const old = JSON.stringify(calBody('cal-real-old', { createdAt: iso(clockNow() - 3 * 86400000) }));
  assert.strictEqual((await post(old, { 'x-cal-signature-256': sign(old, KEYS.cal) })).status, 401, 'replay window');
  assert.strictEqual(rows(w.grist.docs, 'Appointments').length, 0);
  const metaBefore = w.meta.calls.length;
  const ok = await post(pretty, { 'x-cal-signature-256': sign(pretty, KEYS.cal) });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.deepStrictEqual([ok.json.status, ok.json.action], ['ok', 'create']);
  const a = rows(w.grist.docs, 'Appointments');
  assert.deepStrictEqual([a.length, a[0].Booking_UID, a[0].Status], [1, 'cal-real-1', 'Booked']);
  await waitFor(() => w.meta.calls.length > metaBefore, 30000, 'the booking confirmation at Meta');
  const call = w.meta.calls[w.meta.calls.length - 1];
  assert.deepStrictEqual([call.body.template.name, call.body.to], ['booking_confirmation', '919800000031']);
  await waitFor(() => typeof rows(w.grist.docs, 'Appointments')[0].Confirm_Sent === 'number', 20000, 'Confirm_Sent');
  const nocreated = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'x' } });
  assert.strictEqual((await post(nocreated, { 'x-cal-signature-256': sign(nocreated, KEYS.cal) })).status, 422);
});

test('delivery receipts in real n8n move the ledger and Messages forward (signed like Meta)', async () => {
  const w = W();
  const led = rows(w.grist.docs, 'Send_Ledger').find((l) => /^W4:booking_confirmation:/.test(l.Idem_Key));
  assert(led && led.WA_Message_ID, 'a W4 confirmation is in the ledger');
  const send = async (statuses) => { const raw = metaRaw(statusBody(statuses)); const r = await w.n8n.request('POST', '/webhook/whatsapp-inbound', { body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sign(raw, KEYS.app)}` } }); assert.strictEqual(r.status, 200, r.text); };
  await send([{ id: led.WA_Message_ID, status: 'delivered', biz_opaque_callback_data: `fhq:${led.Idem_Key}` }]);
  await waitFor(() => rows(w.grist.docs, 'Send_Ledger').find((l) => l.id === led.id).Status === 'delivered', 30000, 'ledger delivered');
  await send([{ id: led.WA_Message_ID, status: 'read', biz_opaque_callback_data: `fhq:${led.Idem_Key}` }]);
  await waitFor(() => rows(w.grist.docs, 'Send_Ledger').find((l) => l.id === led.id).Status === 'read', 30000, 'ledger read');
  await send([{ id: led.WA_Message_ID, status: 'delivered', biz_opaque_callback_data: `fhq:${led.Idem_Key}` }]);
  await sleep(3000);
  assert.strictEqual(rows(w.grist.docs, 'Send_Ledger').find((l) => l.id === led.id).Status, 'read', 'a late "delivered" never moves a message backwards');
});

test('an unanswered Meta call (hangs) is UNCERTAIN in real n8n: the lead is stored and answered, the ledger says uncertain, nothing is re-sent', async () => {
  const w = W();
  w.meta.mode = 'hang';
  try {
    const before = w.meta.calls.length;
    const r = await w.n8n.request('POST', '/webhook/website-lead', { body: JSON.stringify(formBody({ name: 'Hana Uncertain', phone: '+44 7700 900123', enquiry: 'Shoulder' })), headers: { 'content-type': 'application/json', 'x-lead-secret': KEYS.w1 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.action, 'created');
    const led = await waitFor(() => rows(w.grist.docs, 'Send_Ledger').find((l) => /^W1:created:/.test(l.Idem_Key) && l.Status === 'uncertain'), 60000, 'ledger uncertain (Meta timeout is 15 s)');
    assert.strictEqual(led.WA_Message_ID, '');
    const log = await waitFor(() => rows(w.grist.docs, 'Run_Log').find((l) => l.Workflow === 'W1-website-lead' && /uncertain/.test(l.Error)), 30000, 'Run_Log says uncertain');
    assert.strictEqual(log.Outcome, 'failed');
    assert.strictEqual(w.meta.calls.length, before + 1, 'exactly one attempt');
    assert.strictEqual(rows(w.grist.docs, 'LEADS').find((l) => l.Name === 'Hana Uncertain').Phone, '+447700900123', 'an international number is stored');
  } finally { w.meta.mode = 'ok'; }
});

test('W10 and W14 scheduled sections ran or are registered without errors (log scan)', async () => {
  const w = W();
  const log = w.n8n.logTail(80000);
  assert(!/FlowHQ configuration incomplete/.test(log), 'a config guard fired');
  const noise = /A system task run failed|api\.n8n\.io|Strapi|ENOTFOUND|AxiosError|python task runner|deprecat|^ - |W4: the webhook body has no createdAt|unknown or inactive clinic slug/i;
  const errs = log.split('\n').filter((l) => /\b(error|failed)\b/i.test(l) && !/^\s+at /.test(l) && !noise.test(l));
  assert.deepStrictEqual(errs, [], `unexpected errors in the n8n log:\n${errs.slice(0, 5).join('\n')}`);
});

// ================================================================ second instance: external AI enabled
const AI_TESTS = [];
const aiTest = (name, fn) => AI_TESTS.push({ name, fn });
aiTest('external AI enabled in real n8n: ONE provider request with the identifiers masked; the patient gets the answer; no placeholder reaches the patient', async () => {
  const w = state.ai;
  const raw = metaRaw(inboundMsg('How much does it cost? mail me asha.patel@example.com or call 98000 00011', { id: 'wamid.REAL.AI1', from: P.ASHA, name: 'Asha Patel' }));
  w.grist.docs.DOCA.LEADS.push({ id: 1, fields: { Lead_id: 'L-1', Created_At: Math.floor(clockNow() / 1000) - 5 * 86400, Name: 'Asha Patel', Phone: P.ASHA, Source: 'WhatsApp', Status: 'Contacted', Consent_WhatsApp: true, Opted_Out: false } });
  w.grist.docs.DOCA.Conversations.push({ id: 1, fields: { Lead: 1, Phone: P.ASHA, Last_Inbound_At: Math.floor(clockNow() / 1000) - 5 * 86400, Unread: 0, Automation_Paused: false } });
  const r = await w.n8n.request('POST', '/webhook/whatsapp-inbound', { body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sign(raw, KEYS.app)}` } });
  assert.strictEqual(r.status, 200, r.text);
  await waitFor(() => w.ai.calls.length >= 1 && w.meta.calls.length >= 1, 60000, 'AI request and the reply');
  assert.strictEqual(w.ai.calls.length, 1);
  const sent = JSON.stringify(w.ai.calls[0].body);
  assert.strictEqual(w.ai.calls[0].auth, `Bearer ${KEYS.ai}`);
  assert(!/Asha|Patel|asha\.patel|example\.com|98000 00011|9800000011|9000000011/.test(sent), 'identifiers reached the AI provider');
  assert(/\[PATIENT\]/.test(sent) && /\[EMAIL\]/.test(sent) && /\[NUMBER\]/.test(sent));
  const reply = w.meta.calls.find((c) => c.body.type === 'text');
  assert(reply && /₹/.test(reply.body.text.body), 'the price answer was sent');
  assert(!/\[PATIENT\]|\[NUMBER\]|\[EMAIL\]/.test(JSON.stringify(w.meta.calls.map((c) => c.body))));
  await waitFor(() => rows(w.grist.docs, 'Send_Ledger').some((l) => /^W13:/.test(l.Idem_Key) && l.Status === 'accepted'), 30000, 'W13 ledger row');
});

// ================================================================ third instance: env access blocked (n8n's default)
const BLOCK_TESTS = [];
BLOCK_TESTS.push({ name: 'with n8n\'s DEFAULT (env access in nodes blocked) the workflow fails CLOSED: HTTP 500 and nothing is stored', fn: async () => {
  const w = state.block;
  const r = await w.n8n.request('POST', '/webhook/website-lead', { body: JSON.stringify(formBody()), headers: { 'content-type': 'application/json', 'x-lead-secret': KEYS.w1 } });
  assert([500, 502].includes(r.status), `HTTP ${r.status}`);
  assert.strictEqual(rows(w.grist.docs, 'LEADS').length, 0);
  assert.strictEqual(w.meta.calls.length, 0);
} });

// ================================================================ run
async function runGroup(title, list) {
  let failed = 0;
  console.log(title);
  for (const t of list) {
    try { await t.fn(); results.push({ name: t.name, ok: true }); console.log(`  ok  ${t.name}`); } catch (e) { failed++; results.push({ name: t.name, ok: false }); console.log(`  FAIL ${t.name}\n       ${String((e && e.stack) || e).split('\n').slice(0, 7).join('\n       ')}`); }
  }
  return failed;
}
(async () => {
  let failed = 0;
  const t0 = Date.now();
  console.log(`real n8n: ${cp.spawnSync(R.RUNTIME ? path.join(R.RUNTIME, 'node_modules/.bin/n8n') : 'n8n', ['--version'], { env: { ...process.env, PATH: `${R.NODE_DIR}:${process.env.PATH}` }, encoding: 'utf8' }).stdout.trim()}; clock ${R.FAKETIME_LIB ? 'shifted to 11:00 IST (libfaketime)' : 'REAL (no libfaketime): sends are blocked at night'}; Mailpit ${MAILPIT && fs.existsSync(MAILPIT) ? 'real binary' : 'NOT available (e-mail checks skipped)'}`);
  try {
    state.main = await bringUp({});
    failed += await runGroup('instance 1: production defaults, external AI off', tests);
  } finally { if (state.main) await tearDown(state.main); }
  try {
    state.ai = await bringUp({ ai: true });
    failed += await runGroup('instance 2: external AI enabled', AI_TESTS);
  } finally { if (state.ai) await tearDown(state.ai); }
  try {
    state.block = await bringUp({ blockEnv: true });
    failed += await runGroup('instance 3: n8n default (env access blocked)', BLOCK_TESTS);
  } catch (e) { failed++; console.log(`  FAIL instance 3 could not start: ${e.message.split('\n')[0]}`); } finally { if (state.block) await tearDown(state.block); }
  console.log(`real n8n: ${results.filter((r) => r.ok).length} passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(failed ? 1 : 0);
})();
