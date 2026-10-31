// Shared helpers for the production tests: loads the production export, a made-up environment, a fake Grist with a made-up clinic, fake Meta / AI.
// Everything here is fictional (numbers +9190000000xx, ids, secrets). Nothing touches the network.
const fs = require('fs');
const path = require('path');
const sim = require('./sim');
const { simulate, FakeGrist } = sim;
const F = require('../../tests/ai-fixtures');

const FILE = process.env.PROD_FILE || path.join(__dirname, '..', 'clinic-autopilot-production.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const loadWf = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

const PNID = '123456789012345';
const REG = 'REGDOC';
const DOC = 'DOCA';
const P = { ASHA: '+919000000011', BOB: '+919000000012', OWNER: '+919000000018', TEST: '+919000000019', INTL: '+447700900123' };
const ENV = {
  FLOWHQ_GRIST_URL: 'http://grist:8484',
  FLOWHQ_REGISTRY_DOC_ID: REG,
  FLOWHQ_TEST_PHONE: P.TEST,
  FLOWHQ_CAL_WEBHOOK_SECRET: 'test-cal-secret-0123456789abcdef',
  FLOWHQ_META_VERIFY_TOKEN: 'test-verify-token-0123456789',
  FLOWHQ_META_APP_SECRET: 'test-app-secret-0123456789abcdef',
  FLOWHQ_TELEGRAM_CHAT_ID: '1000001',
  FLOWHQ_WA_SEND_MODE: 'allowlist',
  FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.BOB},${P.OWNER},${P.TEST},${P.INTL}`,
  FLOWHQ_WA_GRAPH_VERSION: 'v23.0',
};

const registry = () => [{ id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: DOC, WA_Phone_Number_ID: PNID, Active: true } }];
const freshGrist = (docA = {}) => new FakeGrist({
  [REG]: { Clinics: registry() },
  [DOC]: {
    Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST }),
    LEADS: [], Conversations: [], Messages: [], Appointments: [], Run_Log: [], Send_Ledger: [], Knowledge: clone(F.KNOWLEDGE),
    // FOURC_CONSENT_YES=1 (n8n/final/run-tests.js "fourc"): every made-up phone has a recorded reminder-consent Yes, so the suites written before Slice 4C
    // (which only give leads Consent_WhatsApp) still exercise the reminder paths of the 4C workflow. Off by default: the older candidates never read this table.
    Reminder_Consent: process.env.FOURC_CONSENT_YES === '1' ? Object.values(P).map((phone, i) => ({ id: i + 1, fields: { Consent_ID: `RC-${i + 1}`, Phone: phone, Reminder_Consent: 'Yes', Reminder_Consent_Source: 'Told staff in person', Evidence_Ref: 'harness' } })) : [],
    ...docA,
  },
});

const ashaLead = (over = {}) => ({ id: 7, fields: { Lead_id: 'L-20261010-0001', Created_At: 1790000000, Name: 'Asha', Phone: P.ASHA, Source: 'Website', Status: 'New', Consent_WhatsApp: true, Consent_Source: 'website-form', ...over } });
const DAY = Date.parse('2026-10-14T11:00:00+05:30');     // a Wednesday, 11:00 IST
const NIGHT = Date.parse('2026-10-14T22:30:00+05:30');

// fake Meta: replies with a message id; calls[] records every request. reply: function(method,url,body) | {status,body} | undefined
const fakeMeta = (reply) => {
  const calls = [];
  let k = 0;
  const fn = (method, url, body) => {
    calls.push({ method, url, body: clone(body) });
    if (typeof reply === 'function') return reply(method, url, body, calls.length);
    if (reply) return reply;
    k++;
    return { status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.TEST${k}` }] } };
  };
  fn.calls = calls;
  return fn;
};
const metaError = (status, code, message) => ({ status, body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'x' } } });

const ledger = (g, doc = DOC) => (g.docs[doc].Send_Ledger || []).map((r) => ({ id: r.id, ...r.fields }));
const rows = (g, table, doc = DOC) => (g.docs[doc][table] || []).map((r) => ({ id: r.id, ...r.fields }));

// run a workflow from a trigger. Options: env overrides, now, meta, openrouter, grist, email
const run = (wf, start, items, o = {}) => {
  const env = { ...ENV, ...(o.env || {}) };
  for (const k of o.unset || []) delete env[k];
  const grist = o.grist || freshGrist();
  return { grist, r: simulate(wf, { start, items: items.map((j) => ({ json: j })), grist, now: o.now || DAY, workflowId: wf.id, env, meta: o.meta || fakeMeta(), openrouter: o.openrouter, booking: o.booking, email: o.email, staticData: o.staticData || {} }) };
};

// a message item as the callers (W3..W13) hand it to W12
const sendItem = (over = {}) => ({
  grist_base_url: ENV.FLOWHQ_GRIST_URL, doc_id: DOC, clinic_slug: 'demo-physio', clinic_name: 'Demo Physio',
  source_workflow: 'W5-reminders', audience: 'patient', template: 'reminder_24h', idem_key: 'W5:reminder_24h:uid-1',
  template_params: { name: 'Asha', clinic_name: 'Demo Physio', date: '15 Oct 2026', time: '9:00 AM', service: 'Assessment' },
  message_text: 'Hi Asha, a reminder: your Assessment is on 15 Oct at 9:00 AM.',
  wa_phone_number_id: PNID, lead_row_id: 7, lead_phone: P.ASHA,
  decision: { send: true, to: P.ASHA, reason: 'ok', test_mode: false }, send: true,
  ...over,
});

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const finish = async (title) => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); if (process.env.STOP_ON_FIRST !== '0') break; }
  }
  console.log(`${title}: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
};

module.exports = { ashaLead, FILE, clone, loadWf, PNID, REG, DOC, P, ENV, DAY, NIGHT, registry, freshGrist, fakeMeta, metaError, ledger, rows, run, sendItem, test, finish, sim, F };

// ---------------------------------------------------------------- W2 requests (signed like Meta signs them)
const crypto = require('crypto');
const metaRaw = (body) => JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sign = (raw, secret = ENV.FLOWHQ_META_APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const messageBody = (text, { id = 'wamid.IN.1', from = P.ASHA, name = 'Asha Patel', ts = Math.floor(DAY / 1000), pnid = PNID } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: pnid }, contacts: [{ profile: { name }, wa_id: from.slice(1) }], messages: [{ from: from.slice(1), id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }],
});
const statusBody = (statuses, { pnid = PNID } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: pnid }, statuses: statuses.map((s) => ({ recipient_id: P.ASHA.slice(1), timestamp: String(Math.floor(DAY / 1000)), ...s })) } }] }],
});
// the Webhook node's output with "Raw Body" on (json: headers / body, binary.data = the raw bytes)
const inboundRequest = (body, o = {}) => {
  const raw = o.raw !== undefined ? o.raw : metaRaw(body);
  const headers = o.headers !== undefined ? o.headers : { 'content-type': 'application/json', 'x-hub-signature-256': o.signature || sign(raw, o.secret) };
  const item = { json: { headers, params: {}, query: {}, body: o.parsed !== undefined ? o.parsed : JSON.parse(raw) } };
  if (o.binary !== false) item.binary = { data: { data: Buffer.from(o.binaryRaw !== undefined ? o.binaryRaw : raw).toString('base64'), mimeType: 'application/json' } };
  return item;
};
module.exports.metaRaw = metaRaw; module.exports.sign = sign; module.exports.messageBody = messageBody; module.exports.statusBody = statusBody; module.exports.inboundRequest = inboundRequest;
// like run(), but with a ready-made webhook item (binary included)
module.exports.runItem = (wf, start, item, o = {}) => {
  const env = { ...ENV, ...(o.env || {}) };
  for (const k of o.unset || []) delete env[k];
  const grist = o.grist || freshGrist();
  return { grist, r: sim.simulate(wf, { start, items: [item], grist, now: o.now || DAY, workflowId: wf.id, env, meta: o.meta || fakeMeta(), openrouter: o.openrouter, booking: o.booking, ollama: o.ollama, email: o.email, staticData: o.staticData || {} }) };
};
