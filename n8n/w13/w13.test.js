// End-to-end tests for the AI lead system: Meta webhook -> W2 (store) -> W13 (AI receptionist) -> W12 inside the MASTER workflow
// (send) -> Grist. Runs the SHIPPED JSON files in the simulator with a fake Grist, a fake Meta and a fake Claude (n8n/tests/ai-fixtures.js:
// it reads the facts W13 puts in the prompt and answers like a careful receptionist). No real API is called.
// Covers the 7 lead scenarios, the reliability cases (duplicates, retries, AI timeout / bad output / hallucination, Meta and Grist
// failures, night, STOP, rate limit, TEST_MODE, draft mode), the manual dry run, the morning retry, structure, and mutation tests.
// Run: node n8n/w13/w13.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const REPO = path.join(__dirname, '..', '..');
const W13_FILE = process.env.W13_FILE || path.join(__dirname, 'W13-AI-Receptionist.json');
const raw13 = fs.readFileSync(W13_FILE, 'utf8');
// The same suite runs on W13 (Anthropic) and on the OpenRouter DEMO workflow (w13-openrouter.test.js); only the provider checks differ.
const PROVIDER = /openrouter\.ai/.test(raw13) ? 'openrouter' : 'anthropic';
const ASK = PROVIDER === 'openrouter' ? 'W13 – Provider Request' : 'W13 – Ask Claude';   // where the provider layer starts
const base13 = JSON.parse(raw13);
const W2 = JSON.parse(fs.readFileSync(path.join(REPO, 'n8n/w2/W2-WhatsApp-Inbound.json'), 'utf8'));
const MASTER = JSON.parse(fs.readFileSync(path.join(REPO, 'n8n/merged/clinic-autopilot-single-workflow.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- the live CRM naming (LEADS / Lead_id) and W2's "Received" status
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

class TestGrist extends FakeGrist {
  constructor(docs) { super(docs); this.count = {}; this.fail = []; }
  failAt(method, table, nth = 1, message = 'Grist 500: injected failure') { this.fail.push({ key: `${method} ${table}`, nth, message }); return this; }
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    const f = this.fail.find((x) => x.key === key && x.nth === this.count[key]);
    if (f) throw new Error(f.message);
    return super.handle(method, url, query, body);
  }
}

// ---------------------------------------------------------------- the three workflows, wired like the live n8n
const IDS = { W2: 'W2LIVEID0000001', W13: 'W13LIVEID000001', MASTER: 'MASTERLIVEID001' };
const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011', P_NEW = '919000000013';
const OWNER = '+919000000018', TESTP = '+919000000019';
const setCfg = (w, nodeName, values) => { for (const a of w.nodes.find((n) => n.name === nodeName).parameters.assignments.assignments) if (a.name in values) a.value = values[a.name]; };
const wire = (w13 = base13) => {
  const w2 = clone(W2); setCfg(w2, 'W2 – Config', { ai_workflow_id: IDS.W13 });
  const t = clone(w13); setCfg(t, 'W13 – Config', { w12_workflow_id: IDS.MASTER });
  const m = clone(MASTER); setCfg(m, 'W12 – Config', { w12_allowlist: `+${P_ASHA},+919000000012,+${P_NEW},+919000000014,${OWNER},${TESTP}`, w12_graph_api_version: 'v23.0' });
  return { w2, w13: t, master: m, workflows: { [IDS.W2]: w2, [IDS.W13]: t, [IDS.MASTER]: m } };
};

const crm = ({ settings = {}, convs, msgs, leads, appts, knowledge } = {}) => new TestGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', ...settings }), Knowledge: clone(knowledge || F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => {
    calls.push({ method, url, body });
    const a = answer ? answer(body, calls.length) : null;
    if (a) return a;
    return { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.SENT.${calls.length}` }] } };
  };
  fn.calls = calls;
  return fn;
};
const metaBody = (from, id, text, ts = F.sec(F.NOW) - 5, type = 'text') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
    contacts: [{ profile: { name: from === P_NEW ? 'Neha' : 'Asha Patel' }, wa_id: from }],
    messages: [type === 'text' ? { from, id, timestamp: String(ts), type: 'text', text: { body: text } } : { from, id, timestamp: String(ts), type, [type]: { id: 'MEDIA', caption: text } }],
  } }] }],
});
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
// One inbound WhatsApp message through the whole system.
function inbound(text, o = {}) {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const wf = o.wf || wire(o.w13);
  const r = simulate(wf.w2, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body: o.body || metaBody(o.from || P_ASHA, o.id || `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, text, o.ts, o.type) } }], grist: g, now: o.now || F.NOW, workflowId: IDS.W2, workflows: wf.workflows, meta, anthropic: claude, openrouter: F.fakeOpenRouter(claude) });
  const runs = allRuns(r);
  const w13 = runs.filter((x) => x.workflowId === IDS.W13);
  const w12 = runs.filter((x) => x.workflowId === IDS.MASTER);
  const done = w13.length ? (w13[w13.length - 1].runData['W13 – Done'] || [])[0] : null;
  return { g, meta, claude, r, w13, w12, out: done ? done.json : null, wf };
}
const runW13 = (item, o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta();
  const claude = o.claude || F.fakeClaude(o.ai);
  const wf = o.wf || wire(o.w13);
  const r = simulate(wf.w13, { start: o.start || 'W13 – When Called', items: [{ json: item }], grist: g, now: o.now || F.NOW, workflowId: IDS.W13, workflows: wf.workflows, meta, anthropic: claude, openrouter: F.fakeOpenRouter(claude) });
  return { g, meta, claude, r, runs: allRuns(r) };
};
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const lastIn = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'In').pop();
const outRows = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'Out' && m.id > 3);
const leadOf = (g, phone) => rows(g, 'LEADS').find((l) => l.Phone === phone);
const conv = (g, phone) => rows(g, 'Conversations').find((c) => c.Phone === phone);
const logsOf = (g, wfName) => rows(g, 'Run_Log').filter((l) => l.Workflow === wfName);
const texts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${c.body.template.components ? c.body.template.components[0].parameters.map((p) => p.text).join(' | ') : ''}`));
const clean = (x) => { for (const run of allRuns(x.r)) assert.strictEqual(run.error, null, `${run.workflowId || 'W2'}: ${JSON.stringify(run.error)}`); };

// ---------------------------------------------------------------- the suite (a list, so mutation tests can run it on a broken W13)
const suite = [];
const test = (name, fn) => suite.push({ name, fn });
const node = (w, name) => w.nodes.find((x) => x.name === name);

// ================================================================ structure
test('structure: names, connections, nothing dangling or unreachable, 4 entry points', (w) => {
  const names = w.nodes.map((x) => x.name);
  assert.strictEqual(new Set(names).size, names.length);
  assert.strictEqual(new Set(w.nodes.map((x) => x.id)).size, names.length);
  const functional = w.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote');
  for (const x of functional) assert(x.name.startsWith('W13 – '), x.name);
  const incoming = new Set();
  for (const [from, o] of Object.entries(w.connections)) {
    assert(names.includes(from), from);
    const n = node(w, from);
    o.main.forEach((outs, oi) => outs.forEach((c) => {
      assert(names.includes(c.node), c.node);
      const max = n.type === 'n8n-nodes-base.if' || n.onError === 'continueErrorOutput' ? 2 : 1;
      assert(oi < max, `${from} has no output ${oi}`);
      incoming.add(c.node);
    }));
  }
  const triggers = functional.filter((x) => /Trigger$|manualTrigger$/.test(x.type)).map((x) => x.name).sort();
  assert.deepStrictEqual(triggers, ['W13 – Every Morning', 'W13 – Manual Test', 'W13 – When Called']);
  assert.deepStrictEqual(functional.filter((x) => !triggers.includes(x.name) && !incoming.has(x.name)).map((x) => x.name), []);
  const seen = new Set(triggers); const q = [...triggers];
  while (q.length) for (const o of (w.connections[q.shift()] || { main: [] }).main) for (const c of o) if (!seen.has(c.node)) { seen.add(c.node); q.push(c.node); }
  assert.deepStrictEqual(functional.filter((x) => !seen.has(x.name)).map((x) => x.name), []);
  assert(!/\$\('(?!W13 – )/.test(JSON.stringify(functional)), 'a node refers to a node outside W13');
  for (const x of w.nodes.filter((n) => n.type === 'n8n-nodes-base.if')) assert.strictEqual(x.parameters.conditions.options.typeValidation, 'strict');
  assert.deepStrictEqual(node(w, 'W13 – Every Morning').parameters.rule.interval, [{ field: 'cronExpression', expression: '5 8 * * *' }]);
  assert.strictEqual(w.settings.timezone, 'Asia/Kolkata');
});
test('structure: credentials, placeholders, no secrets; only W12 talks to Meta', (w) => {
  const http = w.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest');
  const claude = http.filter((x) => /anthropic|openrouter/.test(x.parameters.url));
  if (PROVIDER === 'anthropic') {
    assert.deepStrictEqual(claude.map((x) => x.name), ['W13 – Ask Claude']);
    assert.deepStrictEqual(claude[0].credentials, { httpHeaderAuth: { id: 'PASTE_ANTHROPIC_CREDENTIAL_ID', name: 'Anthropic API' } });
    assert.deepStrictEqual(claude[0].parameters.headerParameters.parameters, [{ name: 'anthropic-version', value: '2023-06-01' }]);
  } else {
    assert.deepStrictEqual(claude.map((x) => [x.name, x.parameters.method, x.parameters.url]), [['W13 – Ask Model', 'POST', 'https://openrouter.ai/api/v1/chat/completions']]);
    assert.deepStrictEqual(claude[0].credentials, { httpHeaderAuth: { id: 'PASTE_OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter API' } });
    assert.deepStrictEqual(claude[0].parameters.headerParameters.parameters, [{ name: 'X-Title', value: 'Clinic Autopilot (demo)' }], 'the key comes from the credential, never a header value');
    assert.strictEqual(claude[0].parameters.jsonBody, '={{ JSON.stringify($json.body) }}');
    assert(!/api\.anthropic\.com/.test(raw13) && !/sk-or-/.test(raw13), 'no Anthropic call and no OpenRouter key in the demo');
  }
  assert.deepStrictEqual([claude[0].onError, claude[0].retryOnFail, claude[0].maxTries, claude[0].parameters.options.timeout], ['continueRegularOutput', true, 2, 45000]);
  for (const x of http.filter((n) => n !== claude[0])) assert.deepStrictEqual(x.credentials, { httpHeaderAuth: { id: '9J6XxrIQoFDcQZ0Y', name: 'Header Auth account 2' } }, x.name);
  assert(!/graph\.facebook\.com/.test(raw13), 'W13 must not call Meta (W12 does)');
  assert(!/sk-ant|x-api-key"\s*:\s*"[^"]|Bearer\s+[A-Za-z0-9]|EAA[A-Za-z0-9]{20,}|ts\.net/.test(raw13));
  assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw13));
  const phones = (raw13.match(/\b9[1-9]\d{9}\b|\+91\d{10}/g) || []).filter((p) => !/^(\+?91)?90000000\d\d$/.test(p));
  assert.deepStrictEqual(phones, [], 'only made-up 9000000xxx numbers');
  const cfg = Object.fromEntries(node(w, 'W13 – Config').parameters.assignments.assignments.map((a) => [a.name, a.value]));
  const model = PROVIDER === 'anthropic' ? { anthropic_model: 'claude-haiku-4-5' } : { model_provider: 'openrouter', openrouter_model: 'openai/gpt-4o-mini' };
  assert.deepStrictEqual(cfg, { grist_base_url: 'http://grist:8484', registry_doc_id: 'REGISTRY_DOC_ID_PLACEHOLDER', leads_table: 'LEADS', ...model, w12_workflow_id: 'PASTE_W12_WORKFLOW_ID', min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, pause_on_handoff: false, staff_alert_template: 'human_handoff_alert' });
  const calls = w.nodes.filter((x) => x.type === 'n8n-nodes-base.executeWorkflow');
  assert.deepStrictEqual(calls.map((x) => [x.name, x.parameters.workflowId.value, x.parameters.mode, x.parameters.options.waitForSubWorkflow !== false, x.onError]), [
    ['W13 – Run Each Test', '={{ $workflow.id }}', 'each', true, 'continueRegularOutput'],
    ['W13 – Retry Each', '={{ $workflow.id }}', 'each', true, 'continueRegularOutput'],
    ['W13 – Call W12', "={{ $('W13 – Start').first().json.w12_workflow_id }}", 'each', true, 'continueRegularOutput'],
  ]);
});
test('structure: the shared helpers are pasted verbatim from n8n/snippets/', (w) => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
  const snip = (f) => fs.readFileSync(path.join(REPO, 'n8n/snippets', f), 'utf8');
  const ai = snip('ai-receptionist.js');
  const blocks = [ai.slice(ai.indexOf('const AI_INTENTS'), ai.indexOf('if (typeof module')), snip('normalize-phone.js').match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0],
    snip('send-guard.js').match(/function decideSend[\s\S]*?\n\}\n/)[0], snip('send-guard.js').match(/function inQuietHours[\s\S]*?\n\}\n/)[0], snip('clinic-hours.js').match(/function parseDays[\s\S]*?\n\}\n/)[0]];
  for (const nm of ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends']) {
    const c = strip(node(w, nm).parameters.jsCode);
    for (const b of blocks) assert(c.includes(strip(b)), `${nm} does not embed the current snippet: ${b.slice(0, 40)}`);
  }
  if (PROVIDER === 'openrouter') {
    const prov = snip('ai-provider.js');
    const pb = strip(prov.slice(prov.indexOf('const AI_OPENROUTER_FINISH'), prov.indexOf('if (typeof module')));
    for (const nm of ['W13 – Provider Request', 'W13 – Provider Answer']) assert(strip(node(w, nm).parameters.jsCode).includes(pb), `${nm} does not embed n8n/snippets/ai-provider.js`);
  }
  assert(strip(node(w, 'W13 – Start').parameters.jsCode).includes(strip(blocks[1])));
  let n = 0;
  const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', '$workflow', `return (${m[1]});`); n++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
  w.nodes.forEach((x) => chk(x.parameters));
  for (const x of w.nodes.filter((y) => y.type === 'n8n-nodes-base.code')) new Function('$', '$input', '$json', x.parameters.jsCode);   // every Code node compiles
  assert(n > 20);
});

// ================================================================ the 7 lead scenarios, end to end
test('1. NEW lead "Hi, I want to know about your services." -> lead created, services from the KB, reply sent, CRM updated', (w) => {
  const x = inbound('Hi, I want to know about your services.', { from: P_NEW, w13: w });
  clean(x);
  assert.strictEqual(x.r.responses[0].code, 200, 'Meta is answered first');
  assert.deepStrictEqual(texts(x.meta), [`${P_NEW}: Hi! We offer Knee pain physiotherapy and Back pain physiotherapy. Would you like to book a first assessment?`]);
  assert.strictEqual(x.meta.calls[0].body.type, 'text');
  const l = leadOf(x.g, `+${P_NEW}`);
  assert.deepStrictEqual([l.Name, l.Source, l.Status, l.Lead_Stage, l.AI_Summary, l.First_Response_At], ['Neha', 'WhatsApp', 'Contacted', 'warm', 'New enquiry about services.', F.sec(F.NOW)]);
  assert.strictEqual(rows(x.g, 'LEADS').filter((r) => r.Phone === `+${P_NEW}`).length, 1);
  const m = lastIn(x.g);
  assert.deepStrictEqual([m.AI_Status, m.Intent, m.AI_Action, m.Needs_Human, m.AI_Confidence], ['replied', 'services_info', 'reply', false, 0.92]);
  const out = outRows(x.g);
  assert.deepStrictEqual(out.map((o) => [o.Conversation, o.Sent_By, o.WA_Message_ID, o.Template]), [[conv(x.g, `+${P_NEW}`).id, 'W13-ai-receptionist', 'wamid.SENT.1', '']]);
  assert.deepStrictEqual(conv(x.g, `+${P_NEW}`).Last_Intent, 'services_info');
  assert.deepStrictEqual(logsOf(x.g, 'W13-ai-receptionist').map((r) => [r.Outcome, r.Record.replace(/wamid\.IN\.\w+/, 'wamid').replace(/ \d+ms /, ' Nms ')]), [['ok', `${l.Lead_id} wamid services_info -> reply (replied) | gate=ai ${PROVIDER === 'openrouter' ? 'openai/gpt-4o-mini' : 'claude-haiku-4-5'} Nms tok 1000/200`]]);
  assert.deepStrictEqual(logsOf(x.g, 'W2-WhatsApp-Inbound').map((r) => r.Outcome), ['ok']);
  const req = x.claude.calls[0].body;
  assert(/new contact: yes/.test(req.system[2].text) && /\[K1\] \(services\) Knee pain physiotherapy/.test(req.system[1].text));
});
test('2. EXISTING lead "Can I come tomorrow evening?" -> only REAL free evening slots (17:00 is taken), same lead, history used', (w) => {
  const x = inbound('Can I come tomorrow evening?', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free. Which one suits you?`]);
  assert.strictEqual(rows(x.g, 'LEADS').length, 3, 'no new lead');
  assert.deepStrictEqual([lastIn(x.g).AI_Action, leadOf(x.g, F.ASHA).Lead_Stage, leadOf(x.g, F.ASHA).Status], ['offer_slots', 'hot', 'Contacted']);
  const facts = x.claude.calls[0].body.system[2].text;
  assert(facts.includes('- patient (Thu 01 Oct 11:00): Do you treat knee pain?'), 'history in the prompt');
  const tomorrow = facts.match(/^- 2026-10-07 \(Wed 07 Oct\): .*$/m)[0];
  assert(tomorrow.includes('16:30, 17:30') && !tomorrow.includes('17:00') && !tomorrow.includes('10:00'), 'tomorrow: 10:00 (Asha) and 17:00 (another patient) are taken');
});
test('3. PRICE "How much does this cost?" -> prices exactly from the knowledge base', (w) => {
  const x = inbound('How much does this cost?', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.`]);
  assert.deepStrictEqual([lastIn(x.g).Intent, lastIn(x.g).AI_Status], ['pricing', 'replied']);
});
test('4. BOOKING "Book me for Saturday at 5." -> link mode: Saturday\'s Cal.com link, nothing booked yet; direct mode: Appointments row, lead Booked', (w) => {
  let x = inbound('Book me for Saturday at 5.', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Saturday at 5:00 PM is free. Please confirm your booking here: https://cal.com/demo-physio/assessment?date=2026-10-10&month=2026-10`]);
  assert.strictEqual(x.meta.calls[0].body.text.preview_url, true);
  assert.strictEqual(rows(x.g, 'Appointments').length, 4, 'link mode books nothing itself (Cal.com -> W4 does)');
  x = inbound('Book me for Saturday at 5.', { w13: w, crm: { settings: { booking_mode: 'direct' } }, id: 'wamid.BOOK.1' });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Saturday at 5:00 PM is free. Please confirm your booking here:`]);
  const a = rows(x.g, 'Appointments').pop();
  assert.deepStrictEqual(a, { id: 5, Booking_UID: 'wa-wamid.BOOK.1', Lead: 1, Service: 'Appointment', Start: F.at('2026-10-10', '17:00'), End: F.at('2026-10-10', '17:30'), Status: 'Booked' });
  assert.deepStrictEqual([leadOf(x.g, F.ASHA).Status, lastIn(x.g).AI_Action], ['Booked', 'book_slot']);
  x = inbound('Book me for Wednesday at 5.', { w13: w });
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Sorry, that time is not available. Free times: Wed 07 Oct 9:00 AM, Wed 07 Oct 9:30 AM, Wed 07 Oct 10:30 AM. Which one would you like?`]);
});
test('5. CANCEL "Cancel my appointment tomorrow." -> the cancel link of THAT booking (online) / Status Cancelled (WhatsApp booking)', (w) => {
  let x = inbound('Cancel my appointment tomorrow.', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: No problem. You can cancel your appointment on Wed 07 Oct 10:00 AM with this link: https://cal.com/booking/cal-uid-asha-1?cancel=true`]);
  assert.strictEqual(rows(x.g, 'Appointments')[0].Status, 'Booked', 'Cal.com cancels; W4 then updates Grist');
  assert.deepStrictEqual([lastIn(x.g).AI_Action, leadOf(x.g, F.ASHA).Lead_Stage], ['cancel_link', 'cold']);
  x = inbound('Cancel my appointment', { w13: w, from: '919000000015', crm: { convs: [...F.conversationRows(), { id: 2, fields: { Lead: 3, Phone: '+919000000015' } }] } });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [], 'Ravi is not in the allowlist: W12 blocks (allowlist mode) and nothing is sent');
  assert.strictEqual(rows(x.g, 'Appointments')[2].Status, 'Cancelled');
  assert.deepStrictEqual([lastIn(x.g).AI_Status, lastIn(x.g).Needs_Human], ['failed', true]);
  assert(/not in the W12 allowlist/.test(lastIn(x.g).AI_Reason));
});
test('6. UNKNOWN question -> hand-off: holding reply + staff alert, Needs_Human; a NEW patient message is answered again; a hand tick keeps the AI silent', (w) => {
  const x = inbound('Do you accept the XYZ health insurance card?', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [
    `${P_ASHA}: Thank you for your message. A member of our team will reply to you shortly.`,
    `${OWNER.slice(1)}: [human_handoff_alert] Demo Physio | Asha Patel | ${F.ASHA} | question not covered by the knowledge base`,
  ]);
  assert.deepStrictEqual([lastIn(x.g).AI_Status, lastIn(x.g).Needs_Human, conv(x.g, F.ASHA).Needs_Human, conv(x.g, F.ASHA).Handoff_Reason], ['handed_off', true, true, 'question not covered by the knowledge base']);
  assert.strictEqual(conv(x.g, F.ASHA).Automation_Paused, false, 'pause_on_handoff is off by default (reminders still go)');
  const n = inbound('Do you accept the XYZ health insurance card?', { w13: w, from: P_NEW });
  clean(n);
  assert.deepStrictEqual([leadOf(n.g, `+${P_NEW}`).Status, leadOf(n.g, `+${P_NEW}`).First_Response_At], ['New', undefined], 'a hand-off is not a real answer: the lead stays New so W3 keeps chasing staff');
  // a NEW patient message after the hand-off is answered again; Needs_Human and the hand-off reason stay for staff
  const y = inbound('How much does this cost?', { w13: w, g: x.g, meta: x.meta, claude: x.claude, ts: F.sec(F.NOW) + 60, now: F.NOW + 120000 });
  clean(y);
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, lastIn(x.g).AI_Status, lastIn(x.g).Needs_Human], [2, 3, 'replied', false]);
  assert.deepStrictEqual([conv(x.g, F.ASHA).Needs_Human, conv(x.g, F.ASHA).Handoff_Reason], [true, 'question not covered by the knowledge base']);
  // Needs_Human ticked BY HAND (no hand-off message from W13): the AI stays silent, as before
  const manual = inbound('How much does this cost?', { w13: w, crm: { convs: [{ id: 1, fields: { ...F.conversationRows()[0].fields, Needs_Human: true } }] } });
  clean(manual);
  assert.deepStrictEqual([manual.claude.calls.length, manual.meta.calls.length, lastIn(manual.g).AI_Status], [0, 0, 'skipped']);
  assert(/waiting for a person/.test(lastIn(manual.g).AI_Reason));
});
test('7. RETURNING lead after 5 days -> earlier conversation + summary in the prompt, KB price, booking link', (w) => {
  const x = inbound('Hi again, is the knee treatment price still the same?', { w13: w });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Welcome back Asha! Yes, knee physiotherapy is still ₹800 per session, and you can book here: https://cal.com/demo-physio/assessment`]);
  const facts = x.claude.calls[0].body.system[2].text;
  for (const s of ['- new contact: no', '- earlier summary: Asked about knee pain treatment; wanted to think about it.', '- patient (Thu 01 Oct 11:01): Ok, I will think about it', '- clinic (Thu 01 Oct 11:00): Yes, we treat knee pain.']) assert(facts.includes(s), s);
  assert.deepStrictEqual([leadOf(x.g, F.ASHA).Likely_Service, leadOf(x.g, F.ASHA).Lead_Stage, leadOf(x.g, F.ASHA).AI_Summary], ['Knee pain physiotherapy', 'hot', 'Returning patient with knee pain, ready to start treatment.']);
});

// ================================================================ reliability
test('duplicates: the same webhook twice and a re-run of W13 on a handled message -> ONE reply; the row is claimed before Claude', (w) => {
  const g0 = crm();
  const x = inbound('How much does this cost?', { w13: w, id: 'wamid.DUP.1', g: g0, ai: () => { g0.calls.push({ method: 'CLAUDE' }); return undefined; } });
  const claimAt = g0.calls.findIndex((c) => c.method === 'PATCH' && c.table === 'Messages' && c.body.records[0].fields.AI_Status === 'processing');
  assert(claimAt >= 0 && claimAt < g0.calls.findIndex((c) => c.method === 'CLAUDE'), 'Messages.AI_Status = processing is written BEFORE Claude is asked');
  const y = inbound('How much does this cost?', { w13: w, id: 'wamid.DUP.1', g: x.g, meta: x.meta, claude: x.claude });
  clean(y);
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, y.w13.length], [1, 1, 0]);
  const m = lastIn(x.g);
  const z = runW13({ wa_phone_number_id: PNID, message_row_id: m.id, wa_message_id: m.WA_Message_ID, msg_type: 'text' }, { w13: w, g: x.g, meta: x.meta, claude: x.claude });
  assert.strictEqual(z.r.error, null);
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, z.r.runData['W13 – Done'][0].json.status], [1, 1, 'skipped']);
  assert.strictEqual(logsOf(x.g, 'W13-ai-receptionist').length, 1, 'a quiet skip writes nothing');
});
test('AI failures -> safe hand-off, never a made-up answer: timeout, overload (529), not JSON, invalid decision, refusal', (w) => {
  const cases = [
    ['timeout', () => ({ throw: 'timeout of 45000ms exceeded' }), /Claude request failed: (OpenRouter: )?timeout/],
    ['overloaded', () => ({ http: { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } } }), /status code 529/],
    ['not JSON', () => 'Sure! The price is ₹999.', /not JSON/],
    ['invalid decision', () => ({ ...F.BASE_DECISION, intent: 'buy', reply: 'ok' }), /invalid decision: unknown intent/],
    ['refusal', () => ({ http: { status: 200, body: { ...F.claudeResponse(F.BASE_DECISION), stop_reason: 'refusal' } } }), /declined/],
  ];
  for (const [name, ai, re] of cases) {
    const x = inbound('How much does this cost?', { w13: w, ai });
    clean(x);
    assert.deepStrictEqual(texts(x.meta).map((t) => t.split(':')[0]), [P_ASHA, OWNER.slice(1)], name);
    assert(texts(x.meta)[0].endsWith('A member of our team will reply to you shortly.'), name);
    assert(!JSON.stringify(x.meta.calls).includes('999'), name);
    assert.deepStrictEqual([lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human], ['handed_off', true], name);
    assert(re.test(lastIn(x.g).AI_Reason), `${name}: ${lastIn(x.g).AI_Reason}`);
  }
});
test('hallucination guard: an invented price, link or slot never reaches the patient', (w) => {
  let x = inbound('How much does this cost?', { w13: w, ai: (req) => ({ ...F.fakeDecide(req), reply: 'Special offer: only ₹199 today! Pay at https://pay.example/x' }) });
  clean(x);
  assert(!JSON.stringify(x.meta.calls).match(/199|pay\.example/));
  assert(/fact check: price 199 is not in the knowledge base; link https:\/\/pay\.example\/x/.test(lastIn(x.g).AI_Reason), 'the details are in Grist for staff');
  x = inbound('Can I come tomorrow evening?', { w13: w, ai: (req) => ({ ...F.fakeDecide(req), reply: 'Sure, come at 5 PM or 8 PM tomorrow!' }) });
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Here are the free times. Free times: Wed 07 Oct 4:00 PM, Wed 07 Oct 4:30 PM, Wed 07 Oct 5:30 PM. Which one would you like?`]);
  x = inbound('How much does this cost?', { w13: w, ai: (req) => ({ ...F.fakeDecide(req), intent: 'payment_issue', needs_human: false, reply: 'Refund done.' }) });
  assert(texts(x.meta)[0].endsWith('reply to you shortly.') && /payment issue/.test(lastIn(x.g).AI_Reason));
  x = inbound('How much does this cost?', { w13: w, ai: (req) => ({ ...F.fakeDecide(req), confidence: 0.55 }) });
  assert(texts(x.meta)[0].endsWith('reply to you shortly.') && /low confidence \(0\.55\)/.test(lastIn(x.g).AI_Reason), 'an unsure AI answer is not sent');
});
test('Meta / W12 / Grist failures: reported, Needs_Human, never a crash or a double send', (w) => {
  let x = inbound('How much does this cost?', { w13: w, metaAnswer: () => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }) });
  clean(x);
  assert.deepStrictEqual([lastIn(x.g).AI_Status, lastIn(x.g).Needs_Human, conv(x.g, F.ASHA).Needs_Human, logsOf(x.g, 'W13-ai-receptionist')[0].Outcome], ['failed', true, true, 'failed']);
  assert(/131047/.test(lastIn(x.g).AI_Reason));
  const wf = wire(w); setCfg(wf.w13, 'W13 – Config', { w12_workflow_id: 'WRONGID00000001' });
  x = inbound('How much does this cost?', { wf });
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status], [0, 'failed']);
  assert(/W12 gave no result: Workflow does not exist/.test(lastIn(x.g).AI_Reason));
  x = inbound('How much does this cost?', { w13: w, g: crm().failAt('PATCH', 'Messages', 1) });
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length], [0, 0], 'claim failed: no AI, no send');
  x = inbound('How much does this cost?', { w13: w, g: crm().failAt('GET', 'Settings', 1) });
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, logsOf(x.g, 'W13-ai-receptionist')[0].Outcome], [0, 0, 'failed']);
  x = inbound('Book me for Saturday at 5.', { w13: w, crm: { settings: { booking_mode: 'direct' } }, g: crm({ settings: { booking_mode: 'direct' } }).failAt('POST', 'Appointments', 1) });
  assert(texts(x.meta)[0].endsWith('reply to you shortly.'), 'a booking that could not be saved is never confirmed');
  assert(/could not save the appointment change/.test(lastIn(x.g).AI_Reason));
  x = inbound('How much does this cost?', { w13: w, g: crm().failAt('PATCH', 'Messages', 2) });
  const run = x.w13[0];
  assert(run.error && /Grist write\(s\) failed/.test(run.error.message), 'a failed CRM write alerts (error workflow)');
  assert.deepStrictEqual([x.meta.calls.length, x.r.error], [1, null], 'W2 is not affected');
});
test('rules: STOP opts out, AI off by default, TEST_MODE, quiet hours, rate limit, paused, media, draft mode', (w) => {
  let x = inbound('STOP', { w13: w });
  assert.deepStrictEqual([x.meta.calls.length, leadOf(x.g, F.ASHA).Opted_Out, lastIn(x.g).AI_Status], [0, true, 'opted_out']);
  const y = inbound('How much does this cost?', { w13: w, g: x.g, meta: x.meta, claude: x.claude, ts: F.sec(F.NOW) + 30, now: F.NOW + 60000 });
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Reason], [0, 'the lead has opted out']);
  x = inbound('How much does this cost?', { w13: w, crm: { settings: { ai_mode: undefined } } });
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, lastIn(x.g).AI_Status, logsOf(x.g, 'W13-ai-receptionist').length], [0, 0, undefined, 0]);
  x = inbound('How much does this cost?', { w13: w, crm: { settings: { TEST_MODE: 'true' } } });
  assert.deepStrictEqual(texts(x.meta).map((t) => t.split(':')[0]), [TESTP.slice(1)]);
  assert.deepStrictEqual([outRows(x.g)[0].Conversation, outRows(x.g)[0].Sent_By], [1, `W13-ai-receptionist (TEST_MODE: sent to ${TESTP})`]);
  x = inbound('How much does this cost?', { w13: w, now: Date.parse('2026-10-06T22:00:00+05:30'), ts: F.sec(Date.parse('2026-10-06T22:00:00+05:30')) });
  assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, lastIn(x.g).AI_Status], [0, 0, 'deferred']);
  const recent = Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, fields: { Conversation: 1, Direction: 'Out', Body: 'r', Sent_By: 'W13-ai-receptionist', Created_At: F.sec(F.NOW) - 3000 + i } }));
  x = inbound('How much does this cost?', { w13: w, crm: { msgs: [...F.messageRows(), ...recent] } });
  assert.deepStrictEqual([x.claude.calls.length, lastIn(x.g).AI_Status], [0, 'handed_off']);
  x = inbound('How much does this cost?', { w13: w, crm: { convs: [{ id: 1, fields: { ...F.conversationRows()[0].fields, Automation_Paused: true } }] } });
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status], [0, 'skipped']);
  x = inbound('my knee x-ray', { w13: w, type: 'image' });
  assert.deepStrictEqual([x.claude.calls.length, lastIn(x.g).AI_Status, texts(x.meta).length], [0, 'handed_off', 2]);
  x = inbound('How much does this cost?', { w13: w, crm: { settings: { ai_mode: 'draft' } } });
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status, lastIn(x.g).AI_Reply], [0, 'drafted', 'The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.']);
});
test('night: deferred at 22:00, answered by the 08:05 run (newest message per conversation, within 20 h)', (w) => {
  const night = Date.parse('2026-10-06T22:00:00+05:30');
  const x = inbound('Can I come tomorrow evening?', { w13: w, now: night, ts: F.sec(night) });
  inbound('How much does this cost?', { w13: w, g: x.g, meta: x.meta, claude: x.claude, from: P_NEW, now: night + 60000, ts: F.sec(night) + 60 });
  assert.deepStrictEqual([x.meta.calls.length, rows(x.g, 'Messages').filter((m) => m.AI_Status === 'deferred').length], [0, 2]);
  const morning = Date.parse('2026-10-07T08:05:00+05:30');
  const z = runW13({}, { w13: w, g: x.g, meta: x.meta, claude: x.claude, start: 'W13 – Every Morning', now: morning });
  for (const run of z.runs) assert.strictEqual(run.error, null, JSON.stringify(run.error));
  assert.strictEqual(x.claude.calls.length, 2);
  assert.deepStrictEqual(texts(x.meta).map((t) => t.split(':')[0]).sort(), [P_ASHA, P_NEW].sort());
  assert(/2026-10-08 \(Thu 08 Oct\)/.test(x.claude.calls[0].body.system[2].text), 'the morning run sees the morning\'s calendar ("tomorrow" = Thursday)');
  assert.deepStrictEqual(rows(x.g, 'Messages').filter((m) => m.AI_Status === 'deferred').length, 0);
  const again = runW13({}, { w13: w, g: x.g, meta: x.meta, claude: x.claude, start: 'W13 – Every Morning', now: morning + 3600000 });
  assert.deepStrictEqual([again.r.error, x.meta.calls.length], [null, 2], 'nothing is answered twice');
});
test('manual test (dry run): 7 scenarios with real facts, Claude asked 7 times, nothing written, nothing sent', (w) => {
  const g = crm();
  g.docs[REG].Clinics[0].fields.WA_Phone_Number_ID = '123456789012345';
  const z = runW13({}, { w13: w, g, start: 'W13 – Manual Test', crm: {} });
  for (const run of z.runs) assert.strictEqual(run.error, null, JSON.stringify(run.error));
  assert.deepStrictEqual([z.meta.calls.length, g.calls.filter((c) => c.method !== 'GET').length, z.claude.calls.length], [0, 0, 7]);
  const rep = z.r.runData['W13 – Test Report'].map((i) => i.json);
  assert.deepStrictEqual(rep.map((r) => [r.test_case, r.status, r.route]), [
    ['new-lead', 'dry_run', 'reply'], ['existing-lead-availability', 'dry_run', 'offer_slots'], ['price', 'dry_run', 'reply'], ['booking', 'dry_run', 'book_slot'],
    ['cancellation', 'dry_run', 'cancel_link'], ['unknown-question', 'dry_run', 'handoff'], ['returning-lead', 'dry_run', 'reply'],
  ]);
  assert.deepStrictEqual(rep[5].would_send.map((s) => s.kind), ['patient_reply', 'staff_alert']);
  assert.strictEqual(rep[0].would_send[0].to, '+919000000013');
});

// ================================================================ run the suite, then mutate W13
const runSuite = (w, quiet, behaviourOnly) => {
  const failed = [];
  for (const t of suite.filter((x) => !behaviourOnly || !x.name.startsWith('structure:'))) {
    try { t.fn(w); if (!quiet) console.log(`  ok  ${t.name}`); } catch (e) { failed.push([t.name, e.message.split('\n')[0]]); if (!quiet) console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').slice(0, 6).join('\n       ')}`); }
  }
  return failed;
};
const failures = runSuite(base13, false);
if (failures.length) { console.error(`\n${failures.length} of ${suite.length} checks FAILED`); process.exit(1); }

if (!process.env.W13_NO_MUTATIONS) {
  console.log('\nmutations (each safety rule switched off once: the suite must fail)');
  const code = (w, name, from, to) => { const n = node(w, name); assert(n.parameters.jsCode.includes(from), `mutation target missing in ${name}: ${from}`); n.parameters.jsCode = n.parameters.jsCode.split(from).join(to); };
  const rewire = (w, from, out, to) => { w.connections[from].main[out] = [{ node: to, type: 'main', index: 0 }]; };
  const mutations = {
    'the fact check is off': (w) => code(w, 'W13 – Plan', 'const problems = aiCheckReply(d.reply, aiAllowedFacts(x), { skipTimes: slotAction });', 'const problems = [];'),
    'complaints / payments / medical are not forced to a person': (w) => code(w, 'W13 – Plan', 'if (AI_HUMAN_INTENTS.includes(d.intent))', 'if (false)'),
    'low confidence is accepted': (w) => code(w, 'W13 – Plan', 'if (d.confidence < tLow)', 'if (false)'),
    'invented slots are not replaced': (w) => code(w, 'W13 – Plan', 'if (aiTimesIn(plan.reply).some((readings) => !readings.some((m) => okTimes.has(m) || m === x.slots.open || m === x.slots.close))) {', 'if (false) {'),
    'the message is not claimed (re-runs reply again)': (w) => code(w, 'W13 – Build Context', "if (!c.dry_run && c.ai_status && !(c.retry && c.ai_status === 'deferred'))", 'if (false)'),
    'Needs_Human is ignored': (w) => code(w, 'W13 – Build Context', 'if (c.needs_human && !c.after_handoff)', 'if (false)'),
    'Needs_Human never lets a new message through': (w) => code(w, 'W13 – Build Context', 'if (c.needs_human && !c.after_handoff)', 'if (c.needs_human)'),
    'quiet hours are ignored': (w) => code(w, 'W13 – Build Context', "if (!c.dry_run && c.night) return { route: 'defer'", "if (false) return { route: 'defer'"),
    'STOP is not honoured': (w) => code(w, 'W13 – Build Context', 'if (AI_STOP_WORDS.test(c.text || \'\'))', 'if (false)'),
    'AI is on by default': (w) => code(w, 'W13 – Build Context', "ai_mode: ['draft', 'auto'].includes(mode) ? mode : 'off'", "ai_mode: 'auto'"),
    'the dry run sends': (w) => code(w, 'W13 – Split Sends', 'if (dry || !items.length)', 'if (!items.length)'),
    'a failed booking write is still confirmed': (w) => code(w, 'W13 – Plan Ready', 'if (errs.length)', 'if (false)'),
    'a missing W12 answer counts as sent': (w) => code(w, 'W13 – Record Sends', "sent: false, send_status: 'no_result'", "sent: true, send_status: 'accepted'"),
    'the rate limit is off': (w) => code(w, 'W13 – Build Context', 'if (c.ai_replies_last_hour >= c.max_per_hour)', 'if (false)'),
    'Claude is asked before the claim': (w) => { rewire(w, 'W13 – Claim?', 0, ASK); },
    'handed-off leads count as Contacted': (w) => code(w, 'W13 – Record Sends', "const answered = !!reply && reply.sent && plan.route !== 'handoff';", 'const answered = !!reply && reply.sent;'),
  };
  let missed = 0;
  for (const [name, mutate] of Object.entries(mutations)) {
    const w = clone(base13); mutate(w);
    const f = runSuite(w, true, true);   // must be caught by BEHAVIOUR (structure / verbatim-code checks are left out)
    if (f.length) console.log(`  caught  ${name}   <- ${f[0][0]}`); else { console.log(`  MISSED  ${name}`); missed++; }
  }
  if (missed) { console.error(`\n${missed} mutation(s) were not caught`); process.exit(1); }
}
console.log(`\nW13${PROVIDER === 'openrouter' ? ' DEMO (OpenRouter)' : ''}: ${suite.length} end-to-end check groups pass (W2 -> W13 -> master W12, ${base13.nodes.length} W13 nodes)`);
