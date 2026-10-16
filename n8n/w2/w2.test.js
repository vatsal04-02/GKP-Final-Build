// Checks for the STANDALONE W2 - WhatsApp Inbound workflow (n8n/w2/W2-WhatsApp-Inbound.json). Runs the shipped JSON in the simulator
// with a fake Grist: structure, Meta verification, every inbound path, failures at every Grist call, parallel-message races, the manual test
// branch, and mutation tests (each safety rule is switched off once; the suite must then fail).   Run: node n8n/w2/w2.test.js
// No Meta, no Telegram, no other workflow is involved: W2 has none of them.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');

const FILE = process.env.W2_FILE || path.join(__dirname, 'W2-WhatsApp-Inbound.json');
const raw = fs.readFileSync(FILE, 'utf8');
const base = JSON.parse(raw);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));

// ---------------------------------------------------------------- the CRM as the live Grist has it (grist/schema.md + the live LEADS / Lead_id naming)
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];   // the one value W2 adds (README: add it to the Choice column in Grist)

class W2Grist extends FakeGrist {
  constructor(docs) { super(docs); this.count = {}; this.fail = []; this.before = {}; }
  failAt(method, table, nth = 1, message = 'Grist 500: injected failure') { this.fail.push({ key: `${method} ${table}`, nth, message }); return this; }
  validate(t, fields) {
    super.validate(t, fields);
    if (t === 'Conversations' && 'Unread' in fields && !Number.isInteger(fields.Unread)) throw new Error('Grist 400: Conversations.Unread must be an integer (schema.md)');
    if (t === 'Conversations' && 'Lead' in fields && !Number.isInteger(fields.Lead)) throw new Error('Grist 400: Conversations.Lead must be a row id');
    if (t === 'Messages' && 'Conversation' in fields && !Number.isInteger(fields.Conversation)) throw new Error('Grist 400: Messages.Conversation must be a row id');
  }
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    const f = this.fail.find((x) => x.key === key && x.nth === this.count[key]);
    if (f) throw new Error(f.message);
    if (this.before[key]) this.before[key](this, body);
    return super.handle(method, url, query, body);
  }
}

const NOW = Date.parse('2026-10-06T11:00:00+05:30');
const sec = (ms) => Math.floor(ms / 1000);
const TS = sec(NOW) - 30;
const PNID = '123456789012345';
const P1 = '919000000011', P2 = '919000000012', P3 = '919000000013';   // made-up numbers only
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const clinic = (id, slug, doc, pnid, active) => ({ id, fields: { Clinic_Slug: slug, Clinic_Name: slug === 'demo-clinic' ? 'Demo Clinic' : 'Old Clinic', Grist_Doc_ID: doc, WA_Phone_Number_ID: pnid, Active: active } });
const lead = (id, phone, over = {}) => ({ id, fields: { Lead_id: `L-20261001-000${id}`, Created_At: sec(NOW) - 86400, Name: 'Existing Patient', Phone: phone, Source: 'Website', Status: 'New', Enquiry: 'earlier enquiry', ...over } });
const grist = ({ leads = [], convs = [], msgs = [], clinics } = {}) => new W2Grist({
  [REG]: { Clinics: clinics || [clinic(1, 'demo-clinic', 'DOCA', PNID, 'TRUE'), clinic(2, 'old-clinic', 'DOCB', '555000111222333', 'FALSE')] },
  DOCA: { LEADS: clone(leads), Conversations: clone(convs), Messages: clone(msgs), Run_Log: [] },
  DOCB: { LEADS: [], Conversations: [], Messages: [], Run_Log: [] },
});

// ---------------------------------------------------------------- Meta payload builders (fake data)
const metaMsg = (msg, { pnid = PNID, name = 'W2 Test Patient', contacts } = {}) => {
  const p = fixture('meta-inbound-text.sample.json');
  const v = p.entry[0].changes[0].value;
  v.metadata.phone_number_id = pnid;
  v.contacts = contacts || (name === null ? [] : [{ profile: { name }, wa_id: msg.from }]);
  v.messages = [msg];
  return p;
};
const textMsg = (from, id, body, ts = TS) => ({ from, id, timestamp: String(ts), type: 'text', text: { body } });
const multi = (messages, contacts, pnid = PNID) => { const p = metaMsg(messages[0], { pnid }); p.entry[0].changes[0].value.messages = messages; p.entry[0].changes[0].value.contacts = contacts; return p; };

const hook = (body, over = {}) => [{ json: { headers: {}, params: {}, query: {}, body, ...over } }];
const post = (w, body, { g = grist(), now = NOW } = {}) => ({ g, r: simulate(w, { start: 'W2 – Webhook Inbound', items: hook(body), grist: g, now, workflowId: 'W2_TEST' }) });
const rows = (g, t, doc = 'DOCA') => g.docs[doc][t].map((x) => ({ id: x.id, ...x.fields }));
const fields = (g, t, doc = 'DOCA') => g.docs[doc][t].map((x) => x.fields);
const writes = (g, from = 0) => g.calls.slice(from).filter((c) => c.method !== 'GET');
const logs = (g) => fields(g, 'Run_Log');
const clean = (r) => { assert.strictEqual(r.error, null, JSON.stringify(r.error)); };

// ---------------------------------------------------------------- the suite (a list, so mutation tests can run it again on a broken copy)
const suite = [];
const test = (name, fn) => suite.push({ name, fn });
const node = (w, name) => w.nodes.find((x) => x.name === name);

// ================================================================ structure
test('structure: names, ids, connections, no dangling nodes, W2 only', (w) => {
  const names = w.nodes.map((x) => x.name);
  assert.strictEqual(new Set(names).size, names.length, 'duplicate node names');
  assert.strictEqual(new Set(w.nodes.map((x) => x.id)).size, names.length, 'duplicate node ids');
  const functional = w.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote');
  for (const x of functional) assert(x.name.startsWith('W2 – '), `${x.name} does not start with "W2 – "`);
  const incoming = new Set();
  for (const [from, o] of Object.entries(w.connections)) {
    assert(names.includes(from), `unknown source ${from}`);
    o.main.forEach((outs, oi) => outs.forEach((c) => {
      assert(names.includes(c.node), `unknown target ${c.node}`);
      assert.strictEqual(c.type, 'main'); assert.strictEqual(c.index, 0);
      const n = node(w, from);
      const max = n.type === 'n8n-nodes-base.if' ? 2 : n.type === 'n8n-nodes-base.splitInBatches' ? 2 : n.parameters && n.onError === 'continueErrorOutput' ? 2 : 1;
      assert(oi < max, `${from} has no output ${oi}`);
      incoming.add(c.node);
    }));
  }
  const triggers = functional.filter((x) => /webhook$|manualTrigger$/.test(x.type)).map((x) => x.name).sort();
  assert.deepStrictEqual(triggers, ['W2 – Manual Test', 'W2 – Webhook Inbound', 'W2 – Webhook Verify']);
  const dangling = functional.filter((x) => !triggers.includes(x.name) && !incoming.has(x.name));
  assert.deepStrictEqual(dangling.map((x) => x.name), [], 'nodes nobody connects to');
  // every functional node can be reached from a trigger
  const seen = new Set(triggers); const q = [...triggers];
  while (q.length) for (const o of (w.connections[q.shift()] || { main: [] }).main) for (const c of o) if (!seen.has(c.node)) { seen.add(c.node); q.push(c.node); }
  assert.deepStrictEqual(functional.filter((x) => !seen.has(x.name)).map((x) => x.name), [], 'unreachable nodes');
  assert(functional.length === 53, `expected 53 functional nodes, found ${functional.length}`);
  // independence: the only other workflow is W13 (fire and forget, id from Config), no Meta call
  const calls = w.nodes.filter((x) => /executeWorkflow/i.test(x.type));
  assert.deepStrictEqual(calls.map((x) => x.name), ['W2 – Hand To AI'], 'W2 calls only W13');
  assert.deepStrictEqual([calls[0].parameters.workflowId.value, calls[0].parameters.mode, calls[0].parameters.options, calls[0].onError], ['={{ $json.ai_workflow_id }}', 'each', { waitForSubWorkflow: false }, 'continueRegularOutput']);
  const all = JSON.stringify(functional);
  assert(!/graph\.facebook\.com/.test(all), 'W2 must not call Meta');
  assert(!/\$\('(?!W2 – )/.test(all), 'a node refers to a node outside W2');
  assert(!/workflowId|errorWorkflow/.test(JSON.stringify(w.settings)) && !('errorWorkflow' in w.settings), 'W2 must not point at another workflow');
});
test('structure: webhooks (GET + POST on whatsapp-inbound), credentials, error outputs', (w) => {
  const hooks = w.nodes.filter((x) => x.type === 'n8n-nodes-base.webhook');
  assert.deepStrictEqual(hooks.map((x) => `${x.parameters.httpMethod} ${x.parameters.path}`).sort(), ['GET whatsapp-inbound', 'POST whatsapp-inbound']);
  for (const h of hooks) assert.strictEqual(h.parameters.responseMode, 'responseNode');
  assert.strictEqual(new Set(hooks.map((x) => x.webhookId)).size, 2);
  const http = w.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest');
  assert.strictEqual(http.length, 12);
  for (const h of http) {
    assert.deepStrictEqual(h.credentials, { httpHeaderAuth: { id: '9J6XxrIQoFDcQZ0Y', name: 'Header Auth account 2' } }, `${h.name} credential`);
    assert(/\/api\/docs\//.test(h.parameters.url), `${h.name} is not a Grist call`);
    assert(['continueErrorOutput', 'continueRegularOutput'].includes(h.onError), `${h.name} has no error handling`);
    assert(!h.retryOnFail, `${h.name} must not retry (no retry loops)`);
    if (h.onError === 'continueErrorOutput') assert((w.connections[h.name].main[1] || []).some((c) => c.node === 'W2 – Build Run Log'), `${h.name} error output must reach Build Run Log`);
  }
  const creds = new Set(w.nodes.flatMap((x) => Object.values(x.credentials || {}).map((c) => `${c.id}|${c.name}`)));
  assert.deepStrictEqual([...creds], ['9J6XxrIQoFDcQZ0Y|Header Auth account 2']);
});
test('structure: Meta-facing safety (placeholder token, no secrets, fake test data only)', (w) => {
  const cfg = node(w, 'W2 – Verify Config').parameters.assignments.assignments;
  assert.deepStrictEqual(cfg.map((a) => [a.name, a.value]), [['meta_verify_token', 'PASTE_META_WEBHOOK_VERIFY_TOKEN']]);
  const text = JSON.stringify(w);
  for (const [re, what] of [[/EAA[A-Za-z0-9]{20,}/, 'Meta access token'], [/Bearer\s+[A-Za-z0-9._-]{16,}/, 'bearer token'], [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, 'Telegram token'], [/sk-ant-/, 'API key'], [/api[_-]?key["']?\s*[:=]\s*["'][^"']{8,}/i, 'api key value']]) assert(!re.test(text), `${what} found`);
  // the token must not be written in any Code node
  for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) assert(!/meta_verify_token\s*=\s*['"]/.test(n.parameters.jsCode), `${n.name} hard-codes the token`);
  // phone numbers anywhere in the workflow or the fixtures: only the made-up 91900000001x / 15550000000 family
  const files = [raw, ...fs.readdirSync(path.join(__dirname, 'fixtures')).map((f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'))];
  for (const t of files) for (const m of t.matchAll(/(?<![\dA-Za-z.])(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g)) assert(/^(\+?91[\s-]?)?9000000\d{3}$/.test(m[0]), `non-fake looking number: ${m[0]}`);
  for (const t of files) for (const m of t.matchAll(/\b1555\d{7}\b/g)) assert.strictEqual(m[0], '15550000000');
});
test('structure: phone normalisation is W12\'s function, verbatim', (w) => {
  const snippet = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'normalize-phone.js'), 'utf8');
  const fn = snippet.slice(snippet.indexOf('function normalizeIndianPhone'), snippet.indexOf('\n}\n', snippet.indexOf('function normalizeIndianPhone')) + 3);
  assert(node(w, 'W2 – Normalize Phone').parameters.jsCode.includes(fn), 'Normalize Phone drifted from n8n/snippets/normalize-phone.js');
  const w12 = path.join(__dirname, '..', 'workflows', 'W12-whatsapp-send.json');
  if (fs.existsSync(w12)) assert(JSON.parse(fs.readFileSync(w12, 'utf8')).nodes.find((x) => x.name === 'Prepare request').parameters.jsCode.includes(fn), 'the snippet no longer matches W12');
});
test('structure: Config follows the live schema (LEADS, In, count) and Grist ids', (w) => {
  const cfg = Object.fromEntries(node(w, 'W2 – Config').parameters.assignments.assignments.map((a) => [a.name, a.value]));
  assert.deepStrictEqual(cfg, { grist_base_url: 'http://grist:8484', registry_doc_id: 'REGISTRY_DOC_ID_PLACEHOLDER', leads_table: 'LEADS', message_direction_in: 'In', message_status_in: 'Received', unread_mode: 'count', message_sent_by: 'Patient', default_lead_name: 'WhatsApp Lead', ai_workflow_id: 'PASTE_W13_WORKFLOW_ID' });
});

// ================================================================ Meta verification (GET)
const verify = (w, token, query) => {
  const ww = clone(w); node(ww, 'W2 – Verify Config').parameters.assignments.assignments[0].value = token;
  const r = simulate(ww, { start: 'W2 – Webhook Verify', items: [{ json: { headers: {}, params: {}, query, body: {} } }], grist: grist(), now: NOW, workflowId: 'W2_TEST' });
  clean(r);
  return r;
};
test('verify: correct token echoes the challenge as plain text (200)', (w) => {
  const r = verify(w, 'my-test-token', { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-test-token', 'hub.challenge': '1158201444' });
  assert.deepStrictEqual(r.responses.map((x) => [x.node, x.code, x.type, x.body, x.headers['Content-Type']]), [['W2 – Respond Challenge', 200, 'text', '1158201444', 'text/plain']]);
  const nested = verify(w, 'my-test-token', { hub: { mode: 'subscribe', verify_token: 'my-test-token', challenge: '42' } });
  assert.strictEqual(nested.responses[0].body, '42');
});
test('verify: wrong token, wrong mode, missing challenge, unconfigured token are refused', (w) => {
  const q = (o) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': 'my-test-token', 'hub.challenge': '1158201444', ...o });
  const code = (r) => [r.responses.length, r.responses[0].node, r.responses[0].code, r.responses[0].body];
  assert.deepStrictEqual(code(verify(w, 'my-test-token', q({ 'hub.verify_token': 'wrong' }))), [1, 'W2 – Respond Forbidden', 403, 'Verification failed']);
  assert.deepStrictEqual(code(verify(w, 'my-test-token', q({ 'hub.verify_token': 'my-test-toke' }))), [1, 'W2 – Respond Forbidden', 403, 'Verification failed']);
  assert.deepStrictEqual(code(verify(w, 'my-test-token', q({ 'hub.mode': 'unsubscribe' }))), [1, 'W2 – Respond Forbidden', 403, 'Verification failed']);
  assert.deepStrictEqual(code(verify(w, 'my-test-token', q({ 'hub.challenge': undefined }))), [1, 'W2 – Respond Forbidden', 400, 'Verification failed']);
  assert.deepStrictEqual(code(verify(w, 'my-test-token', q({ 'hub.challenge': '<script>' }))), [1, 'W2 – Respond Forbidden', 400, 'Verification failed']);
  assert.strictEqual(verify(w, 'my-test-token', {}).responses[0].code, 403);
  // the file as shipped (placeholder): even a request that sends the placeholder text is refused
  const ph = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
  assert.strictEqual(verify(w, ph, q({ 'hub.verify_token': ph })).responses[0].code, 403);
  assert.strictEqual(verify(w, '', q({ 'hub.verify_token': '' })).responses[0].code, 403);
});
test('verify: the token is not copied into the check output or any response', (w) => {
  const r = verify(w, 'my-test-token', { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-test-token', 'hub.challenge': '7' });
  assert(!JSON.stringify(r.runData['W2 – Check Verify Token']).includes('my-test-token'));
  assert(!JSON.stringify(r.responses).includes('my-test-token'));
});

// ================================================================ inbound: existing patient
test('inbound: existing patient -> no new lead, 1 message, conversation created with Unread 1, Run_Log ok, answered 200 first', (w) => {
  const { g, r } = post(w, metaMsg(textMsg(P1, 'wamid.T1', 'Hello, a question about my knee')), { g: grist({ leads: [lead(1, '+919000000011')] }) });
  clean(r);
  assert.deepStrictEqual(r.responses.map((x) => [x.node, x.code, x.body, x.headers['Content-Type']]), [['W2 – Respond', 200, '{"status":"received"}', 'application/json']]);
  assert.strictEqual(r.visited.indexOf('W2 – Respond') < r.visited.indexOf('W2 – Clinics'), true, 'Meta must be answered before any Grist call');
  assert.strictEqual(g.docs.DOCA.LEADS.length, 1);
  assert.deepStrictEqual(fields(g, 'Conversations'), [{ Phone: '+919000000011', Lead: 1, Last_Inbound_At: TS, Unread: 1 }]);
  assert.deepStrictEqual(fields(g, 'Messages'), [{ Conversation: 1, Direction: 'In', Body: 'Hello, a question about my knee', Sent_By: 'Patient', WA_Message_ID: 'wamid.T1', Status: 'Received', Created_At: TS }]);
  assert.deepStrictEqual(logs(g), [{ Workflow: 'W2-WhatsApp-Inbound', Record: 'L-20261001-0001 wamid.T1 (existing lead, text)', Outcome: 'ok', Error: '', At: sec(NOW) }]);
  assert.strictEqual(r.runData['W2 – Prepare Staff Alert'][0].json.staff_alert, null);
});
test('inbound: existing conversation -> updated, Unread +1, Automation_Paused / Assigned_To untouched, Last_Inbound_At never moves back', (w) => {
  const conv = { id: 5, fields: { Lead: 1, Phone: '+919000000011', Last_Inbound_At: TS - 1000, Unread: 2, Automation_Paused: true, Assigned_To: 'Dr Rao' } };
  const { g, r } = post(w, metaMsg(textMsg(P1, 'wamid.T2', 'Hi again')), { g: grist({ leads: [lead(1, '+919000000011')], convs: [conv] }) });
  clean(r);
  assert.deepStrictEqual(fields(g, 'Conversations'), [{ Lead: 1, Phone: '+919000000011', Last_Inbound_At: TS, Unread: 3, Automation_Paused: true, Assigned_To: 'Dr Rao' }]);
  assert.strictEqual(fields(g, 'Messages')[0].Conversation, 5);
  const older = post(w, metaMsg(textMsg(P1, 'wamid.T3', 'late delivery', TS - 5000)), { g: grist({ leads: [lead(1, '+919000000011')], convs: [{ id: 5, fields: { ...conv.fields, Last_Inbound_At: TS } }] }) });
  clean(older.r);
  assert.strictEqual(fields(older.g, 'Conversations')[0].Last_Inbound_At, TS, 'an older message must not move Last_Inbound_At back');
  assert.strictEqual(fields(older.g, 'Messages')[0].Created_At, TS - 5000, 'the message keeps its own timestamp');
});

// ================================================================ inbound: new patient
test('inbound: new patient -> ONE lead in the existing format, conversation, message, Run_Log, staff-alert payload (not sent)', (w) => {
  const { g, r } = post(w, metaMsg(textMsg(P2, 'wamid.N1', 'Hi, do you treat back pain?'), { name: 'W2 Test Patient' }), { g: grist({ leads: [lead(3, '+919000000099', { Lead_id: 'L-20261006-0003' })] }) });
  clean(r);
  assert.strictEqual(g.docs.DOCA.LEADS.length, 2);
  assert.deepStrictEqual(g.docs.DOCA.LEADS[1].fields, { Lead_id: 'L-20261006-0004', Created_At: sec(NOW), Name: 'W2 Test Patient', Phone: '+919000000012', Source: 'WhatsApp', Status: 'New', Enquiry: 'Hi, do you treat back pain?' });
  assert.deepStrictEqual(fields(g, 'Conversations'), [{ Phone: '+919000000012', Lead: 4, Last_Inbound_At: TS, Unread: 1 }]);
  assert.strictEqual(fields(g, 'Messages')[0].Conversation, 1);
  assert.deepStrictEqual(logs(g).map((x) => [x.Outcome, x.Record, x.Error]), [['ok', 'L-20261006-0004 wamid.N1 (new lead, text)', '']]);
  assert(!/9000000012/.test(JSON.stringify(logs(g))), 'Run_Log must not hold the phone number');
  const a = r.runData['W2 – Prepare Staff Alert'][0].json.staff_alert;
  assert.deepStrictEqual([a.prepared, a.audience, a.source_workflow, a.template, a.decision.send, a.decision.to, a.lead_row_id], [true, 'staff', 'W2-WhatsApp-Inbound', 'new_lead_staff_alert', false, null, 4]);
  assert.deepStrictEqual(a.template_params, { clinic_name: 'Demo Clinic', lead_name: 'W2 Test Patient', lead_phone: '+919000000012', enquiry: 'Hi, do you treat back pain?' });
  assert.match(a.message_text, /^New WhatsApp lead \(Demo Clinic\): W2 Test Patient, \+919000000012 - "Hi, do you treat back pain\?"\. L-20261006-0004\.$/);
  assert(!r.visited.some((n) => /graph|WhatsApp Cloud|Call|Execute/i.test(n)), 'W2 must not send anything');
});
test('inbound: no profile name -> "WhatsApp Lead"; number formats collapse to +91XXXXXXXXXX', (w) => {
  for (const from of ['919000000012', '9000000012', '+91 90000 00012', '09000000012']) {
    const { g, r } = post(w, metaMsg(textMsg(from, 'wamid.F1', 'x'), { name: null }));
    clean(r);
    assert.deepStrictEqual([g.docs.DOCA.LEADS[0].fields.Phone, g.docs.DOCA.LEADS[0].fields.Name], ['+919000000012', 'WhatsApp Lead'], from);
  }
  // same patient, two formats, two deliveries -> still one lead and one conversation
  const g = grist();
  clean(post(w, metaMsg(textMsg('919000000012', 'wamid.F2', 'a')), { g }).r);
  clean(post(w, metaMsg(textMsg('+91 90000 00012', 'wamid.F3', 'b')), { g }).r);
  assert.deepStrictEqual([g.docs.DOCA.LEADS.length, g.docs.DOCA.Conversations.length, g.docs.DOCA.Messages.length, fields(g, 'Conversations')[0].Unread], [1, 1, 2, 2]);
});
test('inbound: two messages from one NEW patient in one payload -> one lead, one conversation, Unread 2', (w) => {
  const m = [textMsg(P2, 'wamid.B1', 'first', TS), textMsg(P2, 'wamid.B2', 'second', TS + 1)];
  const { g, r } = post(w, multi(m, [{ profile: { name: 'W2 Test Patient' }, wa_id: P2 }]));
  clean(r);
  assert.deepStrictEqual([g.docs.DOCA.LEADS.length, g.docs.DOCA.Conversations.length, g.docs.DOCA.Messages.length], [1, 1, 2]);
  assert.deepStrictEqual(fields(g, 'Conversations')[0], { Phone: '+919000000012', Lead: 1, Last_Inbound_At: TS + 1, Unread: 2 });
  assert.strictEqual(r.responses.length, 1, 'Meta is answered once per delivery');
  assert.deepStrictEqual(logs(g).map((x) => x.Outcome), ['ok', 'ok']);
});
test('inbound: two DIFFERENT new patients in one payload -> unique Lead_ids (messages are processed one at a time)', (w) => {
  const m = [textMsg(P2, 'wamid.C1', 'one'), textMsg(P3, 'wamid.C2', 'two')];
  const { g, r } = post(w, multi(m, [{ profile: { name: 'Patient Two' }, wa_id: P2 }, { profile: { name: 'Patient Three' }, wa_id: P3 }]));
  clean(r);
  assert.deepStrictEqual(g.docs.DOCA.LEADS.map((x) => [x.fields.Lead_id, x.fields.Name, x.fields.Phone]), [['L-20261006-0001', 'Patient Two', '+919000000012'], ['L-20261006-0002', 'Patient Three', '+919000000013']]);
  assert.deepStrictEqual(fields(g, 'Conversations').map((c) => c.Lead), [1, 2]);
});

// ================================================================ idempotency
test('duplicate WA_Message_ID -> nothing created, Unread not counted again, Run_Log skipped, still answered 200', (w) => {
  const g = grist({ leads: [lead(1, '+919000000011')] });
  const body = metaMsg(textMsg(P1, 'wamid.D1', 'hello'));
  clean(post(w, body, { g }).r);
  const before = g.calls.length;
  const second = post(w, body, { g });
  clean(second.r);
  assert.deepStrictEqual(writes(g, before).map((c) => c.table), ['Run_Log'], 'only the Run_Log row may be written for a duplicate');
  assert.deepStrictEqual([g.docs.DOCA.LEADS.length, g.docs.DOCA.Conversations.length, g.docs.DOCA.Messages.length, fields(g, 'Conversations')[0].Unread], [1, 1, 1, 1]);
  assert.deepStrictEqual(logs(g).map((x) => x.Outcome), ['ok', 'skipped']);
  assert.match(logs(g)[1].Error, /duplicate WA_Message_ID \(Messages row 1\)/);
  assert.deepStrictEqual(second.r.responses.map((x) => x.code), [200]);
  assert.strictEqual(second.r.runData['W2 – Prepare Staff Alert'], undefined);
  // a NEW patient's duplicate must not create a second lead either
  const g2 = grist(); const b2 = metaMsg(textMsg(P2, 'wamid.D2', 'hello'));
  clean(post(w, b2, { g: g2 }).r); clean(post(w, b2, { g: g2 }).r); clean(post(w, b2, { g: g2 }).r);
  assert.deepStrictEqual([g2.docs.DOCA.LEADS.length, g2.docs.DOCA.Conversations.length, g2.docs.DOCA.Messages.length], [1, 1, 1]);
});
test('duplicate inside one payload (same id twice) -> second one is skipped', (w) => {
  const m = [textMsg(P1, 'wamid.D3', 'hello'), textMsg(P1, 'wamid.D3', 'hello')];
  const { g, r } = post(w, multi(m, [{ profile: { name: 'x' }, wa_id: P1 }]), { g: grist({ leads: [lead(1, '+919000000011')] }) });
  clean(r);
  assert.deepStrictEqual([g.docs.DOCA.Messages.length, fields(g, 'Conversations')[0].Unread, logs(g).map((x) => x.Outcome)], [1, 1, ['ok', 'skipped']]);
});

// ================================================================ clinic resolution
test('unknown phone_number_id and inactive clinic -> stop safely, nothing written, still answered 200', (w) => {
  const unknown = post(w, metaMsg(textMsg(P1, 'wamid.U1', 'hi'), { pnid: '000000000000000' }));
  clean(unknown.r);
  assert.strictEqual(unknown.g.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.deepStrictEqual(unknown.g.calls.map((c) => c.table), ['Clinics']);
  assert.strictEqual(unknown.r.runData['W2 – Clinic Rejected'][0].json.reason, 'unknown phone_number_id');
  assert.deepStrictEqual(unknown.r.responses.map((x) => x.code), [200]);
  const inactive = post(w, metaMsg(textMsg(P1, 'wamid.U2', 'hi'), { pnid: '555000111222333' }));
  clean(inactive.r);
  assert.strictEqual(inactive.g.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.strictEqual(inactive.r.runData['W2 – Clinic Rejected'][0].json.reason, 'clinic is not active');
  assert.strictEqual(inactive.g.docs.DOCB.Messages.length, 0);
});
test('Active may be "TRUE", true, "True" (active) - "FALSE", false, empty (not); the phone_number_id may be text or a number', (w) => {
  for (const [active, pnid, ok] of [['TRUE', PNID, true], [true, PNID, true], ['True', PNID, true], ['FALSE', PNID, false], [false, PNID, false], ['', PNID, false], ['TRUE', Number(PNID), true], [null, PNID, false]]) {
    const { g, r } = post(w, metaMsg(textMsg(P1, `wamid.A${String(active)}${typeof pnid}`, 'hi')), { g: grist({ clinics: [clinic(1, 'demo-clinic', 'DOCA', pnid, active)] }) });
    clean(r);
    assert.strictEqual(g.docs.DOCA.Messages.length, ok ? 1 : 0, `Active=${JSON.stringify(active)} pnid type ${typeof pnid}`);
  }
  const noDoc = post(w, metaMsg(textMsg(P1, 'wamid.A9', 'hi')), { g: grist({ clinics: [clinic(1, 'demo-clinic', '', PNID, 'TRUE')] }) });
  clean(noDoc.r);
  assert.strictEqual(noDoc.r.runData['W2 – Clinic Rejected'][0].json.reason, 'clinic has no Grist_Doc_ID');
});

// ================================================================ malformed / other events
test('malformed or unrelated payloads -> 400 for garbage, 200 for Meta-shaped, never a crash, never a Grist call', (w) => {
  const g400 = (body) => { const x = post(w, body); clean(x.r); assert.strictEqual(x.g.calls.length, 0, 'no Grist call for garbage'); return x.r.responses.map((y) => [y.code, JSON.parse(y.body).status]); };
  for (const body of [{ hello: 'world' }, null, [], 'text', 42, { entry: 'x' }, { object: 'whatsapp_business_account' }]) assert.deepStrictEqual(g400(body), [[400, 'invalid']], JSON.stringify(body));
  const ignored = (body) => { const x = post(w, body); clean(x.r); assert.strictEqual(x.g.calls.length, 0); return x.r.responses.map((y) => [y.code, JSON.parse(y.body).status]); };
  assert.deepStrictEqual(ignored({ entry: [] }), [[200, 'ignored']]);
  assert.deepStrictEqual(ignored({ entry: [{ changes: [] }, 'junk', { changes: [null, { value: 'x' }, { value: {} }] }] }), [[200, 'ignored']]);
  assert.deepStrictEqual(ignored(fixture('meta-status.sample.json')), [[200, 'status']]);
  const bad = (mut) => { const p = metaMsg(textMsg(P1, 'wamid.M1', 'hi')); mut(p.entry[0].changes[0].value); return ignored(p); };
  assert.deepStrictEqual(bad((v) => { delete v.metadata.phone_number_id; }), [[200, 'ignored']]);
  assert.deepStrictEqual(bad((v) => { delete v.messages[0].id; }), [[200, 'ignored']]);
  assert.deepStrictEqual(bad((v) => { delete v.messages[0].from; }), [[200, 'ignored']]);
  assert.deepStrictEqual(bad((v) => { v.messages = ['not an object']; }), [[200, 'ignored']]);
  const r = post(w, metaMsg({ from: P1, id: 'wamid.M2', type: 'text', text: { body: 'no timestamp' } }), { g: grist({ leads: [lead(1, '+919000000011')] }) });
  clean(r.r);
  assert.strictEqual(fields(r.g, 'Messages')[0].Created_At, sec(NOW), 'a missing timestamp falls back to "now"');
});
test('a good message next to a bad one: the good one is stored, the bad one is dropped', (w) => {
  const p = multi([textMsg(P1, 'wamid.G1', 'good'), { from: P1, type: 'text', text: { body: 'no id' } }], [{ profile: { name: 'x' }, wa_id: P1 }]);
  const { g, r } = post(w, p, { g: grist({ leads: [lead(1, '+919000000011')] }) });
  clean(r);
  assert.deepStrictEqual(fields(g, 'Messages').map((m) => m.Body), ['good']);
  assert.deepStrictEqual(r.responses.map((x) => x.code), [200]);
});
test('non-text messages never crash: sensible Body, lead Enquiry only for real text', (w) => {
  const body = (msg, name) => { const { g, r } = post(w, metaMsg(msg, { name }), { g: grist({ leads: [lead(1, '+919000000011')] }) }); clean(r); return fields(g, 'Messages')[0].Body; };
  assert.strictEqual(body({ from: P1, id: 'wamid.X1', timestamp: String(TS), type: 'image', image: { id: 'm', caption: 'photo of my knee' } }), '[WhatsApp image received]: photo of my knee');
  assert.strictEqual(body({ from: P1, id: 'wamid.X2', timestamp: String(TS), type: 'sticker', sticker: { id: 'm' } }), '[WhatsApp sticker received]');
  assert.strictEqual(body({ from: P1, id: 'wamid.X3', timestamp: String(TS), type: 'location', location: { latitude: 1, longitude: 2 } }), '[WhatsApp location received]');
  assert.strictEqual(body({ from: P1, id: 'wamid.X4', timestamp: String(TS), type: 'audio' }), '[WhatsApp audio received]');
  assert.strictEqual(body({ from: P1, id: 'wamid.X5', timestamp: String(TS), type: 'reaction', reaction: { emoji: '+1' } }), '[WhatsApp reaction received]');
  assert.strictEqual(body({ from: P1, id: 'wamid.X6', timestamp: String(TS), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b', title: 'Yes, book me' } } }), 'Yes, book me');
  assert.strictEqual(body({ from: P1, id: 'wamid.X7', timestamp: String(TS), type: 'button', button: { text: 'Call me', payload: 'p' } }), 'Call me');
  assert.strictEqual(body({ from: P1, id: 'wamid.X8', timestamp: String(TS), type: 'text', text: {} }), '[WhatsApp text received]');
  assert.strictEqual(body({ from: P1, id: 'wamid.X9', timestamp: String(TS), type: 'text', text: { body: 'a\u0000b\u0007c' + 'x'.repeat(5000) } }).length, 2000, 'long text is cut at 2000');
  assert.strictEqual(body({ from: P1, id: 'wamid.XA', timestamp: String(TS), type: 'unsupported', errors: [{ code: 131051 }] }), '[WhatsApp unsupported received]');
  // a NEW patient whose first message is an image: lead has no Enquiry
  const { g, r } = post(w, metaMsg({ from: P2, id: 'wamid.X0', timestamp: String(TS), type: 'image', image: { id: 'm', caption: 'cap' } }));
  clean(r);
  assert.strictEqual('Enquiry' in g.docs.DOCA.LEADS[0].fields, false);
  assert.strictEqual(fields(g, 'Messages')[0].Body, '[WhatsApp image received]: cap');
});
test('a sender that is not an Indian mobile -> skipped in Run_Log, nothing stored, number masked', (w) => {
  const { g, r } = post(w, metaMsg(textMsg('14155550100', 'wamid.I1', 'hello from abroad')));
  clean(r);
  assert.deepStrictEqual([g.docs.DOCA.LEADS.length, g.docs.DOCA.Conversations.length, g.docs.DOCA.Messages.length], [0, 0, 0]);
  assert.deepStrictEqual(logs(g).map((x) => [x.Outcome, x.Record]), [['skipped', 'wamid.I1 *******0100']]);
  assert.match(logs(g)[0].Error, /not a valid Indian mobile/);
  assert(!/14155550100/.test(JSON.stringify(logs(g))));
});

// ================================================================ failures at every Grist call
const FAILS = [
  ['GET', 'Clinics', 1, null, 'registry lookup (no clinic CRM to log into)'],
  ['GET', 'Messages', 1, 'Normalize Phone', 'duplicate check'],
  ['GET', 'LEADS', 1, 'Read Duplicate', 'find lead'],
  ['GET', 'LEADS', 2, 'Read Lead', 'recent leads'],
  ['POST', 'LEADS', 1, 'Read Lead', 'create lead'],
  ['GET', 'LEADS', 3, 'Read Lead', 'recheck lead'],
  ['GET', 'Conversations', 1, 'Lead Ready', 'find conversation'],
  ['POST', 'Conversations', 1, 'Read Conversation', 'create conversation'],
  ['GET', 'Conversations', 2, 'Read Conversation', 'recheck conversation'],
  ['POST', 'Messages', 1, 'Conversation Ready', 'add message'],
  ['PATCH', 'Conversations', 1, 'Message Saved', 'update conversation'],
];
test('Grist failure at each of the 11 calls -> one failed Run_Log row naming the stage, no crash, no staff alert, nothing repeated', (w) => {
  for (const [method, table, nth, stage, label] of FAILS) {
    const g = grist().failAt(method, table, nth, `Grist 500: boom in ${label}`);
    const { r } = post(w, metaMsg(textMsg(P2, 'wamid.E1', 'hello'), { name: 'W2 Test Patient' }), { g });
    clean(r);
    assert.deepStrictEqual(r.responses.map((x) => x.code), [200], `${label}: Meta is answered before the failure`);
    assert.strictEqual(g.count[`${method} ${table}`], nth, `${label}: no retry (the failing call was made exactly once)`);
    if (stage === null) { assert.strictEqual(logs(g).length, 0, `${label}: nowhere to log`); assert.strictEqual(g.calls.filter((c) => c.method !== 'GET').length, 0); continue; }
    assert.strictEqual(logs(g).length, 1, `${label}: exactly one Run_Log row`);
    const l = logs(g)[0];
    assert.deepStrictEqual([l.Workflow, l.Outcome], ['W2-WhatsApp-Inbound', 'failed'], label);
    assert.strictEqual(l.Error, `Grist request failed after "${stage}": Grist 500: boom in ${label}`, label);
    assert(l.Record.startsWith('wamid.E1 '), `${label}: Record names the message (${l.Record})`);
    assert(!/9000000012/.test(JSON.stringify(l)), `${label}: number masked`);
    assert.strictEqual(r.runData['W2 – Prepare Staff Alert'], undefined, `${label}: no staff alert after a failure`);
    if (table === 'Messages' && method === 'POST') assert.strictEqual(g.docs.DOCA.Messages.length, 0);
    if (table === 'Conversations' && method === 'PATCH') assert.strictEqual(g.docs.DOCA.Messages.length, 1);   // the message is safe, only the counter failed
  }
});
test('a failing Run_Log write ends quietly (no loop), and a failure on one message does not stop the next one', (w) => {
  const g = grist({ leads: [lead(1, '+919000000011')] }).failAt('POST', 'Run_Log', 1);
  const { r } = post(w, metaMsg(textMsg(P1, 'wamid.R1', 'hi')), { g });
  clean(r);
  assert.strictEqual(g.count['POST Run_Log'], 1);
  assert.strictEqual(g.docs.DOCA.Messages.length, 1);
  // two messages: the first fails at the duplicate check, the second goes through
  const g2 = grist({ leads: [lead(1, '+919000000011')] }).failAt('GET', 'Messages', 1);
  const p = multi([textMsg(P1, 'wamid.R2', 'one'), textMsg(P1, 'wamid.R3', 'two')], [{ profile: { name: 'x' }, wa_id: P1 }]);
  clean(post(w, p, { g: g2 }).r);
  assert.deepStrictEqual(logs(g2).map((x) => x.Outcome), ['failed', 'ok']);
  assert.deepStrictEqual(fields(g2, 'Messages').map((m) => m.WA_Message_ID), ['wamid.R3']);
  // the SECOND message fails after the first was stored: its Run_Log row must describe the second message, not leftovers of the first
  const g3 = grist({ leads: [lead(1, '+919000000011')] }).failAt('GET', 'Conversations', 3);   // calls 1-2 are the first message (find + recheck), 3 is the second one's find
  clean(post(w, p, { g: g3 }).r);
  assert.deepStrictEqual(logs(g3).map((x) => x.Outcome), ['ok', 'failed']);
  assert(logs(g3)[1].Record.startsWith('wamid.R3 '), logs(g3)[1].Record);
  assert.match(logs(g3)[1].Error, /after "Lead Ready"/);
  // a bearer token inside an error text never reaches Run_Log
  const g4 = grist().failAt('GET', 'Messages', 1, 'request failed: Authorization: Bearer abc.def-ghi_123 rejected');
  clean(post(w, metaMsg(textMsg(P2, 'wamid.R4', 'x')), { g: g4 }).r);
  assert(!/abc\.def/.test(JSON.stringify(logs(g4))));
});

// ================================================================ parallel messages (race guards)
test('race: two executions create the same new lead -> both use the LOWEST row, the extra row is reported, no second staff alert', (w) => {
  const g = grist();
  g.before['POST LEADS'] = (gr) => { gr.docs.DOCA.LEADS.push({ id: 1, fields: { Lead_id: 'L-20261006-0001', Created_At: sec(NOW), Name: 'Other run', Phone: '+919000000012', Source: 'WhatsApp', Status: 'New' } }); };
  const { r } = post(w, metaMsg(textMsg(P2, 'wamid.L1', 'hello'), { name: 'W2 Test Patient' }), { g });
  clean(r);
  assert.strictEqual(g.docs.DOCA.LEADS.length, 2);
  assert.strictEqual(fields(g, 'Conversations')[0].Lead, 1, 'the conversation hangs on the lowest lead row');
  assert.strictEqual(logs(g)[0].Outcome, 'ok');
  assert.match(logs(g)[0].Error, /parallel messages created lead row 2 as a duplicate of row 1; row 1 is used \(row 2 can be deleted\)/);
  assert.strictEqual(r.runData['W2 – Prepare Staff Alert'][0].json.staff_alert, null, 'only the run that created the lowest row alerts staff');
  assert.strictEqual(r.runData['W2 – Prepare Staff Alert'][0].json.lead_row_id, 1);
});
test('race: two executions create the same conversation -> both use the lowest row; Unread is counted on that one', (w) => {
  const g = grist({ leads: [lead(1, '+919000000011')] });
  g.before['POST Conversations'] = (gr) => { gr.docs.DOCA.Conversations.push({ id: 1, fields: { Phone: '+919000000011', Lead: 1, Last_Inbound_At: TS - 5, Unread: 4 } }); };
  const { r } = post(w, metaMsg(textMsg(P1, 'wamid.V1', 'hello')), { g });
  clean(r);
  assert.strictEqual(fields(g, 'Messages')[0].Conversation, 1);
  assert.deepStrictEqual([fields(g, 'Conversations')[0].Unread, fields(g, 'Conversations')[0].Last_Inbound_At], [5, TS]);
  assert.strictEqual('Unread' in fields(g, 'Conversations')[1], false, 'the extra row is left alone');
  assert.match(logs(g)[0].Error, /parallel messages created conversation row 2 as a duplicate of row 1/);
});

// ================================================================ manual test branch
test('manual test: all fake cases run end to end without answering any webhook; a second run with fresh ids works too', (w) => {
  const g = grist({ leads: [lead(1, '+919000000011', { Name: 'W2 Test Existing' })], clinics: [clinic(1, 'demo-clinic', 'DOCA', '123456789012345', 'TRUE')] });
  const first = simulate(w, { start: 'W2 – Manual Test', items: [{ json: {} }], grist: g, now: NOW, workflowId: 'W2_TEST' });
  clean(first);
  assert.strictEqual(first.responses.length, 0, 'the manual test must not try to answer a webhook');
  assert.deepStrictEqual(first.visited.filter((n) => n === 'W2 – Respond'), []);
  assert.deepStrictEqual(logs(g).map((x) => [x.Outcome, x.Record.replace(/wamid\.W2TEST\.\d+\./, 'wamid.')]), [
    ['ok', 'L-20261001-0001 wamid.existing (existing lead, text)'],
    ['ok', 'L-20261006-0001 wamid.new (new lead, text)'],
    ['ok', 'L-20261001-0001 wamid.dup (existing lead, text)'],
    ['skipped', 'wamid.dup +********0011'],
    ['ok', 'L-20261001-0001 wamid.image (existing lead, image)'],
  ]);
  assert.deepStrictEqual(fields(g, 'Messages').map((m) => m.Body), ['Hello, I would like to ask about my knee.', 'Hi, do you treat back pain?', 'Duplicate delivery test', '[WhatsApp image received]: photo of my knee']);
  assert.deepStrictEqual(g.docs.DOCA.LEADS.map((x) => x.fields.Phone), ['+919000000011', '+919000000012']);
  assert.deepStrictEqual(fields(g, 'Conversations').map((c) => [c.Phone, c.Unread]), [['+919000000011', 3], ['+919000000012', 1]]);
  assert(!JSON.stringify(g.docs).match(/\b9[1-9]\d{9}\b/g)?.some((n) => !/^91900000001[12]$/.test(n)), 'only the made-up numbers appear');
  const second = simulate(w, { start: 'W2 – Manual Test', items: [{ json: {} }], grist: g, now: NOW + 1000, workflowId: 'W2_TEST' });
  clean(second);
  assert.strictEqual(g.docs.DOCA.LEADS.length, 2, 'the new patient exists now: no second lead');
  assert.strictEqual(g.docs.DOCA.Messages.length, 8);
});
test('manual test: a pasted Meta payload runs alone (PASTED_PAYLOAD)', (w) => {
  const ww = clone(w);
  const n = node(ww, 'W2 – Test Cases');
  n.parameters.jsCode = n.parameters.jsCode.replace('const PASTED_PAYLOAD = null;', `const PASTED_PAYLOAD = ${JSON.stringify(metaMsg(textMsg(P3, 'wamid.PASTE1', 'pasted')))};`);
  const g = grist();
  const r = simulate(ww, { start: 'W2 – Manual Test', items: [{ json: {} }], grist: g, now: NOW, workflowId: 'W2_TEST' });
  clean(r);
  assert.deepStrictEqual(fields(g, 'Messages').map((m) => m.WA_Message_ID), ['wamid.PASTE1']);
  const only = clone(w); const o = node(only, 'W2 – Test Cases'); o.parameters.jsCode = o.parameters.jsCode.replace("const ONLY = '';", "const ONLY = 'status-event';");
  const g2 = grist(); clean(simulate(only, { start: 'W2 – Manual Test', items: [{ json: {} }], grist: g2, now: NOW, workflowId: 'W2_TEST' }));
  assert.strictEqual(g2.calls.length, 0);
});

// ================================================================ hand-off to W13 (AI receptionist)
const W13_ID = 'W13TESTID0000001';
const withAi = (w, id = W13_ID) => { const ww = clone(w); node(ww, 'W2 – Config').parameters.assignments.assignments.find((a) => a.name === 'ai_workflow_id').value = id; return ww; };
const fakeW13 = (fail) => ({ name: 'W13 (fake)', nodes: [
  { name: 'In', type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: { inputSource: 'passthrough' } },
  { name: 'Work', type: 'n8n-nodes-base.code', parameters: { jsCode: fail ? "throw new Error('W13 broke');" : 'return $input.all();' } },
], connections: { In: { main: [[{ node: 'Work', type: 'main', index: 0 }]] } } });
test('AI hand-off: every NEW stored message starts W13 once (no waiting) with the clinic, message and lead ids', (w) => {
  const g = grist({ leads: [lead(1, '+919000000011')] });
  const body = multi([textMsg(P1, 'wamid.AI1', 'How much?'), textMsg(P2, 'wamid.AI2', 'Hi'), textMsg(P1, 'wamid.AI1', 'How much?')], [{ profile: { name: 'A' }, wa_id: P1 }, { profile: { name: 'B' }, wa_id: P2 }]);
  const r = simulate(withAi(w), { start: 'W2 – Webhook Inbound', items: hook(body), grist: g, now: NOW, workflowId: 'W2_TEST', workflows: { [W13_ID]: fakeW13() } });
  clean(r);
  assert.strictEqual(r.responses[0].code, 200);
  const subs = r.subRuns.filter((x) => x.workflowId === W13_ID);
  assert.deepStrictEqual(subs.map((x) => x.waited), [false, false]);
  const got = subs.map((x) => x.runData.In[0].json);
  assert.deepStrictEqual(got.map((j) => [j.wa_message_id, j.message_row_id, j.lead_row_id, j.conversation_id, j.wa_phone_number_id, j.msg_type, j.patient_phone, j.doc_id]), [
    ['wamid.AI1', 1, 1, 1, PNID, 'text', '+919000000011', 'DOCA'],
    ['wamid.AI2', 2, 2, 2, PNID, 'text', '+919000000012', 'DOCA'],
  ]);
  assert.deepStrictEqual(logs(g).map((x) => [x.Outcome, x.Error]), [['ok', ''], ['ok', ''], ['skipped', 'duplicate WA_Message_ID (Messages row 1); nothing was created']]);
});
test('AI hand-off: off with the placeholder id, never for the manual test, and a broken / missing W13 never stops W2', (w) => {
  let g = grist();
  let r = simulate(w, { start: 'W2 – Webhook Inbound', items: hook(metaMsg(textMsg(P1, 'wamid.OFF', 'hi'))), grist: g, now: NOW, workflowId: 'W2_TEST' });
  clean(r);
  assert.deepStrictEqual([r.subRuns.length, r.visited.includes('W2 – Hand To AI'), fields(g, 'Messages').length], [0, false, 1]);
  g = grist({ leads: [lead(1, '+919000000011', { Name: 'W2 Test Existing' })], clinics: [clinic(1, 'demo-clinic', 'DOCA', '123456789012345', 'TRUE')] });
  r = simulate(withAi(w), { start: 'W2 – Manual Test', items: [{ json: {} }], grist: g, now: NOW, workflowId: 'W2_TEST', workflows: { [W13_ID]: fakeW13() } });
  clean(r);
  assert.strictEqual(r.subRuns.length, 0, 'fake test patients must never reach the AI');
  for (const [ww, workflows, why] of [[withAi(w, 'NOSUCHWORKFLOW1'), {}, /AI hand-off failed: Workflow does not exist/], [withAi(w), { [W13_ID]: fakeW13(true) }, /^$/]]) {
    g = grist();
    r = simulate(ww, { start: 'W2 – Webhook Inbound', items: hook(multi([textMsg(P1, 'wamid.X1', 'a'), textMsg(P2, 'wamid.X2', 'b')], [])), grist: g, now: NOW, workflowId: 'W2_TEST', workflows });
    clean(r);
    assert.deepStrictEqual(fields(g, 'Messages').map((m) => m.WA_Message_ID), ['wamid.X1', 'wamid.X2']);
    assert.deepStrictEqual(logs(g).map((x) => x.Outcome), ['ok', 'ok']);
    for (const l of logs(g)) assert(why.test(l.Error), l.Error);
  }
});

// ================================================================ the fixtures work as curl bodies
test('fixtures: the sample payloads are accepted as they are', (w) => {
  for (const [f, status] of [['meta-inbound-text.sample.json', 200], ['meta-inbound-image.sample.json', 200], ['meta-status.sample.json', 200]]) {
    const { g, r } = post(w, fixture(f));
    clean(r);
    assert.strictEqual(r.responses[0].code, status, f);
    if (f === 'meta-inbound-text.sample.json') assert.strictEqual(g.docs.DOCA.Messages.length, 1);
  }
});

// ================================================================ run the suite, then mutate
const runSuite = (w, quiet) => {
  const failed = [];
  for (const t of suite) {
    try { t.fn(w); if (!quiet) console.log(`  ok  ${t.name}`); } catch (e) { failed.push([t.name, e.message.split('\n')[0]]); if (!quiet) console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').slice(0, 4).join('\n       ')}`); }
  }
  return failed;
};
const failures = runSuite(base, false);
if (failures.length) { console.error(`\n${failures.length} of ${suite.length} checks FAILED`); process.exit(1); }

if (!process.env.W2_NO_MUTATIONS) {
  console.log('\nmutations (each safety rule switched off once: the suite must fail)');
  const code = (w, name, from, to) => { const n = node(w, name); assert(n.parameters.jsCode.includes(from), `mutation target missing in ${name}: ${from}`); n.parameters.jsCode = n.parameters.jsCode.replace(from, to); };
  const rewire = (w, from, out, to) => { w.connections[from].main[out] = [{ node: to, type: 'main', index: 0 }]; };
  const mutations = {
    'duplicates are not stopped': (w) => rewire(w, 'W2 – Duplicate?', 0, 'W2 – Find Lead'),
    'inactive clinics are accepted': (w) => code(w, 'W2 – Resolve Clinic', "String(f.Active).toUpperCase() === 'TRUE'", 'true'),
    'the lowest row is NOT preferred (race guard off)': (w) => code(w, 'W2 – Read Created Lead', 'a.id - b.id', 'b.id - a.id'),
    'the conversation race guard is off': (w) => code(w, 'W2 – Read Created Conversation', 'a.id - b.id', 'b.id - a.id'),
    'Unread is counted twice': (w) => code(w, 'W2 – Message Saved', '(Number(ctx.conv_unread) || 0) + 1', '(Number(ctx.conv_unread) || 0) + 2'),
    'phone numbers are not normalised': (w) => code(w, 'W2 – Normalize Phone', 'normalizeIndianPhone($json.from)', "({ phone: $json.from, valid: true })"),
    'Last_Inbound_At may move backwards': (w) => code(w, 'W2 – Message Saved', 'Math.max(Number(ctx.conv_last_inbound) || 0, ctx.msg_timestamp)', 'ctx.msg_timestamp'),
    'Meta is answered after processing': (w) => { rewire(w, 'W2 – Webhook Source?', 0, 'W2 – Valid Event?'); w.connections['W2 – Loop Over Messages'].main[0] = [{ node: 'W2 – Respond', type: 'main', index: 0 }]; },
    'the verify token is not checked': (w) => code(w, 'W2 – Check Verify Token', "else if (!same(sent, want)) reason = 'verify token does not match';", ''),
    'the placeholder token is accepted': (w) => code(w, 'W2 – Check Verify Token', "if (!want || want === PLACEHOLDER)", 'if (!want)'),
    'conversation flags are overwritten': (w) => code(w, 'W2 – Message Saved', 'Unread: unread }', 'Unread: unread, Automation_Paused: false }'),
    'failures are not logged': (w) => rewire(w, 'W2 – Add Message', 1, 'W2 – Loop Over Messages'),
    'the manual test reaches the AI': (w) => { const n = node(w, 'W2 – AI Wanted?'); n.parameters.conditions.conditions[0].leftValue = n.parameters.conditions.conditions[0].leftValue.replace(' && !$json.test_case', ''); },
    'duplicates reach the AI': (w) => rewire(w, 'W2 – Duplicate?', 0, 'W2 – Hand To AI'),
    'status events create messages': (w) => code(w, 'W2 – Parse Meta Event', "if (!Array.isArray(v.messages) || !v.messages.length) continue;", "if (!Array.isArray(v.messages)) v.messages = (v.statuses || []).map((s) => ({ from: s.recipient_id, id: s.id, type: 'text', text: { body: s.status } }));"),
  };
  let missed = 0;
  for (const [name, mutate] of Object.entries(mutations)) {
    const w = clone(base); mutate(w);
    const f = runSuite(w, true);
    if (f.length) console.log(`  caught  ${name}   <- ${f[0][0]}`); else { console.log(`  MISSED  ${name}`); missed++; }
  }
  if (missed) { console.error(`\n${missed} mutation(s) were not caught`); process.exit(1); }
}
console.log(`\nW2: ${suite.length} check groups pass (standalone workflow, ${base.nodes.length} nodes)`);
