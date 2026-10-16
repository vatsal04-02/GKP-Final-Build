// End-to-end tests of the INTEGRATED master, stage 1 (clinic-autopilot-master-ai.stage1.json): ONE workflow, ONE execution path.
//   Meta webhook -> W2 (store) -> this workflow again with w13_job (no wait) -> "W12 – AI Job?" -> SECTION W13 (OpenRouter AI,
//   gates, checks, CRM) -> this workflow again (wait) -> "W12 – AI Job?" -> W12 (the only WhatsApp sender) -> fake Meta.
// Fake Grist, fake Meta, fake OpenRouter (n8n/tests/ai-fixtures.js: it reads the real prompt). Made-up numbers only.
// Run: node n8n/integrated/integrated.test.js        (INTEGRATED_FILE=<file> tests another build, e.g. your private import file)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.INTEGRATED_FILE || path.join(__dirname, 'clinic-autopilot-master-ai.stage1.json');
const BASE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (m) => console.log(`  ok  ${m}`);
const suite = [];
const test = (name, fn) => suite.push({ name, fn });

// ---------------------------------------------------------------- the live CRM naming (LEADS / Lead_id) and W2's "Received" status
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
class TestGrist extends FakeGrist {
  constructor(docs) { super(docs); this.count = {}; this.fail = []; }
  failAt(method, table, nth = 1) { this.fail.push({ key: `${method} ${table}`, nth }); return this; }
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    if (this.fail.some((x) => x.key === key && x.nth === this.count[key])) throw new Error('Grist 500: injected failure');
    return super.handle(method, url, query, body);
  }
}

// ---------------------------------------------------------------- the workflow as you would fill it after import (fake values)
const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011', P_NEW = '919000000013';
const OWNER = '+919000000018', TESTP = '+919000000019';
const VERIFY = 'test-verify-token-123';
const prepare = (base) => {
  const w = clone(base);
  const set = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  set('W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+${P_NEW},+919000000014,${OWNER},${TESTP}`);
  set('W2 – Verify Config', 'meta_verify_token', VERIFY);
  return w;
};
let prepared = prepare(BASE);   // the workflow under test (the mutation tests swap in broken copies)
const crm = ({ settings = {}, msgs, convs, leads, appts } = {}) => new TestGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', ...settings }), Knowledge: clone(F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const metaBody = (from, id, text, { ts = F.sec(F.NOW) - 5, type = 'text', pnid = PNID } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
    contacts: [{ profile: { name: from === P_NEW ? 'Neha' : 'Asha Patel' }, wa_id: from }],
    messages: [type === 'text' ? { from, id, timestamp: String(ts), type: 'text', text: { body: text } } : { from, id, timestamp: String(ts), type, [type]: { id: 'MEDIA', caption: text } }],
  } }] }],
});
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
function post(text, o = {}) {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const body = o.body || metaBody(o.from || P_ASHA, o.id || `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, text, o);
  const r = simulate(o.w || prepared, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body } }], grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude) });
  const runs = allRuns(r);
  const aiJobs = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W13 – Config'));
  const sends = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
  const done = aiJobs.length ? (aiJobs[aiJobs.length - 1].runData['W13 – Done'] || [])[0] : null;
  return { g, meta, claude, r, runs, aiJobs, sends, out: done ? done.json : null };
}
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const lastIn = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'In').pop();
const leadOf = (g, phone) => rows(g, 'LEADS').find((l) => l.Phone === phone);
const conv = (g, phone) => rows(g, 'Conversations').find((c) => c.Phone === phone);
const logs = (g, w) => rows(g, 'Run_Log').filter((l) => l.Workflow === w);
const texts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${(c.body.template.components || [{ parameters: [] }])[0].parameters.map((p) => p.text).join(' | ')}`));
const clean = (x) => { for (const run of x.runs) assert.strictEqual(run.error, null, `${run.visited[0]}: ${JSON.stringify(run.error)}`); };
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';

console.log(`integrated master: ${path.basename(FILE)}`);

// ================================================================ the build is reproducible
test('the committed file is exactly what build-integrated.js makes from the (redacted) master export', () => {
  if (process.env.INTEGRATED_FILE) return;
  const tmp = path.join(os.tmpdir(), `integrated-${process.pid}.json`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build-integrated.js'), '--in', path.join(__dirname, 'source', 'master-export.redacted.json'), '--out', tmp], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(tmp, 'utf8'), fs.readFileSync(FILE, 'utf8'));
  fs.unlinkSync(tmp);
});

// ================================================================ W2 stays W2
test('Meta GET verification unchanged: right token -> challenge (200), wrong token -> 403, and the AI never runs', () => {
  const run = (token) => simulate(prepared, { start: 'W2 – Webhook Verify', items: [{ json: { headers: {}, params: {}, body: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' } } }], grist: crm(), now: F.NOW, workflowId: 'MASTER' });
  let r = run(VERIFY);
  assert.deepStrictEqual([r.error, r.responses.map((x) => [x.code, x.body])], [null, [[200, '12345']]]);
  r = run('wrong');
  assert.deepStrictEqual(r.responses.map((x) => x.code), [403]);
  assert(!r.visited.some((n) => n.startsWith('W13 – ')) && !r.subRuns.length);
});

// ================================================================ the requested scenarios
test('1. NORMAL patient message (existing lead, price): Meta 200 first, ONE AI job, reply through W12, CRM + both Run_Logs ok', () => {
  const x = post('How much does this cost?');
  clean(x);
  assert.deepStrictEqual([x.r.responses.map((r) => r.code), x.aiJobs.length, x.sends.length], [[200], 1, 1]);
  assert.deepStrictEqual([x.aiJobs[0].waited, x.sends[0].waited], [false, true], 'W2 does not wait for the AI; the AI waits for W12\'s result');
  assert(x.r.visited.indexOf('W2 – Respond') < x.r.visited.indexOf('W2 – Start AI Receptionist'), 'Meta is answered before the AI starts');
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.`]);
  assert.strictEqual(x.meta.calls[0].body.type, 'text');
  const m = lastIn(x.g);
  assert.deepStrictEqual([m.Direction, m.Status, m.AI_Status, m.Intent, m.AI_Action, m.Needs_Human], ['In', 'Received', 'replied', 'pricing', 'reply', false]);
  const out = rows(x.g, 'Messages').filter((r) => r.Direction === 'Out' && r.id > 3);
  assert.deepStrictEqual(out.map((o) => [o.Conversation, o.Sent_By, o.WA_Message_ID]), [[1, 'W13-ai-receptionist', 'wamid.SENT.1']]);
  assert.deepStrictEqual([conv(x.g, F.ASHA).Unread, conv(x.g, F.ASHA).Last_Intent], [1, 'pricing']);
  assert.deepStrictEqual(logs(x.g, 'W2-WhatsApp-Inbound').map((l) => [l.Outcome, l.Error, l.Record]), [['ok', '', `L-20261001-0001 ${m.WA_Message_ID} (existing lead, text)`]]);
  assert.deepStrictEqual(logs(x.g, 'W13-ai-receptionist').map((l) => l.Outcome), ['ok']);
  const job = x.aiJobs[0].runData['W12 – When called by another workflow'][0].json;
  assert.deepStrictEqual(job, { w13_job: true, dry_run: false, w13_retry: false, wa_phone_number_id: PNID, clinic_slug: 'demo-clinic', message_row_id: m.id, wa_message_id: m.WA_Message_ID, msg_type: 'text', patient_phone: F.ASHA, sender_name: 'Asha Patel', text: 'How much does this cost?' });
});
test('2. SERVICE question from a NEW patient: lead created by W2, services only from Knowledge, lead Contacted', () => {
  const x = post('Hi, I want to know about your services.', { from: P_NEW });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_NEW}: Hi! We offer Knee pain physiotherapy and Back pain physiotherapy. Would you like to book a first assessment?`]);
  const l = leadOf(x.g, `+${P_NEW}`);
  assert.deepStrictEqual([l.Source, l.Status, l.Lead_Stage, l.First_Response_At, l.AI_Summary], ['WhatsApp', 'Contacted', 'warm', F.sec(F.NOW), 'New enquiry about services.']);
  assert.strictEqual(rows(x.g, 'LEADS').filter((r) => r.Phone === `+${P_NEW}`).length, 1);
});
test('3. AVAILABILITY "Can I come tomorrow evening?": only REAL free evening slots (17:00 is taken), never invented', () => {
  const x = post('Can I come tomorrow evening?');
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free. Which one suits you?`]);
  const y = post('Can I come tomorrow evening?', { ai: (req) => ({ ...F.fakeDecide(req), reply: 'Sure, come at 5 PM or 8 PM!' }) });
  assert.deepStrictEqual(texts(y.meta), [`${P_ASHA}: Here are the free times. Free times: Wed 07 Oct 4:00 PM, Wed 07 Oct 4:30 PM, Wed 07 Oct 5:30 PM. Which one would you like?`]);
});
test('4. BOOKING "Book me for Saturday at 5.": link mode -> Cal.com link for Saturday; direct mode -> Appointments row, lead Booked; taken slot -> real alternatives', () => {
  let x = post('Book me for Saturday at 5.');
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Saturday at 5:00 PM is free. Please confirm your booking here: https://cal.com/demo-physio/assessment?date=2026-10-10&month=2026-10`]);
  assert.strictEqual(rows(x.g, 'Appointments').length, 4);
  x = post('Book me for Saturday at 5.', { crm: { settings: { booking_mode: 'direct' } }, id: 'wamid.BOOK.1' });
  clean(x);
  assert.deepStrictEqual(rows(x.g, 'Appointments').pop(), { id: 5, Booking_UID: 'wa-wamid.BOOK.1', Lead: 1, Service: 'Appointment', Start: F.at('2026-10-10', '17:00'), End: F.at('2026-10-10', '17:30'), Status: 'Booked' });
  assert.strictEqual(leadOf(x.g, F.ASHA).Status, 'Booked');
  x = post('Book me for Wednesday at 5.');
  assert(/^919000000011: Sorry, that time is not available\. Free times: /.test(texts(x.meta)[0]));
});
test('5. CANCELLATION "Cancel my appointment tomorrow.": the Cal.com cancel link of THAT booking (W4 then updates Grist)', () => {
  const x = post('Cancel my appointment tomorrow.');
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: No problem. You can cancel your appointment on Wed 07 Oct 10:00 AM with this link: https://cal.com/booking/cal-uid-asha-1?cancel=true`]);
  assert.strictEqual(lastIn(x.g).AI_Action, 'cancel_link');
});
test('6. UNKNOWN question -> HUMAN HANDOFF: holding reply + human_handoff_alert to the owner, BOTH through W12; Needs_Human; a new patient message is answered again', () => {
  const x = post('Do you accept the XYZ health insurance card?');
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: ${HOLD}`, `${OWNER.slice(1)}: [human_handoff_alert] Demo Physio | Asha Patel | ${F.ASHA} | question not covered by the knowledge base`]);
  assert.strictEqual(x.sends.length, 2, 'two W12 runs (patient + staff)');
  assert.deepStrictEqual([lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human, conv(x.g, F.ASHA).Handoff_Reason], ['handed_off', true, 'question not covered by the knowledge base']);
  const y = post('How much does this cost?', { g: x.g, meta: x.meta, claude: x.claude, ts: F.sec(F.NOW) + 60, now: F.NOW + 120000 });
  clean(y);
  // INTEGRATED_LEGACY_NEEDS_HUMAN: set by the regression runners ONLY for workflow files from before the Needs_Human gate fix
  if (process.env.INTEGRATED_LEGACY_NEEDS_HUMAN) assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, lastIn(x.g).AI_Status], [2, 1, 'skipped']);
  else assert.deepStrictEqual([x.meta.calls.length, x.claude.calls.length, lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human], [3, 2, 'replied', true]);
});
test('7. DUPLICATE inbound (same WA_Message_ID twice): stored once, ONE AI job, ONE reply', () => {
  const x = post('How much does this cost?', { id: 'wamid.DUP.1' });
  const y = post('How much does this cost?', { id: 'wamid.DUP.1', g: x.g, meta: x.meta, claude: x.claude });
  clean(y);
  assert.deepStrictEqual([x.aiJobs.length, y.aiJobs.length, x.meta.calls.length, x.claude.calls.length], [1, 0, 1, 1]);
  assert.strictEqual(rows(x.g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.DUP.1').length, 1);
  assert.deepStrictEqual(logs(x.g, 'W2-WhatsApp-Inbound').map((l) => l.Outcome), ['ok', 'skipped']);
  const twoInOne = { ...metaBody(P_ASHA, 'wamid.M1', 'How much does this cost?') };
  twoInOne.entry[0].changes[0].value.messages.push({ from: P_NEW, id: 'wamid.M2', timestamp: String(F.sec(F.NOW) - 4), type: 'text', text: { body: 'Hi, I want to know about your services.' } });
  twoInOne.entry[0].changes[0].value.contacts.push({ profile: { name: 'Neha' }, wa_id: P_NEW });
  const z = post('', { body: twoInOne });
  clean(z);
  assert.deepStrictEqual([z.aiJobs.length, z.meta.calls.length], [2, 2], 'two messages in one webhook = exactly one AI job each');
});
test('8. INVALID webhook payload / delivery receipt / unknown clinic / bad number: no AI job, nothing sent', () => {
  let x = post('', { body: { hello: 'not a Meta body' } });
  assert.deepStrictEqual([x.r.responses.map((r) => r.code), x.aiJobs.length, x.meta.calls.length, x.g.calls.filter((c) => c.method !== 'GET').length], [[400], 0, 0, 0]);
  x = post('', { body: { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, statuses: [{ id: 'wamid.S', status: 'delivered', timestamp: '1', recipient_id: P_ASHA }] } }] }] } });
  assert.deepStrictEqual([x.r.responses.map((r) => r.code), x.aiJobs.length, x.meta.calls.length], [[200], 0, 0]);
  x = post('How much does this cost?', { pnid: '999999999999999' });
  assert.deepStrictEqual([x.aiJobs.length, x.meta.calls.length, rows(x.g, 'Messages').length], [0, 0, 3]);
  x = post('How much does this cost?', { from: '12025550123' });
  assert.deepStrictEqual([x.aiJobs.length, x.meta.calls.length], [0, 0]);
});
test('9. AI FAILURE (timeout, 429, malformed JSON, schema-breaking answer) -> safe hand-off through W12, never a made-up answer', () => {
  const cases = [['timeout', () => ({ throw: 'timeout of 45000ms exceeded' })], ['429', () => ({ http: { status: 429, body: { type: 'error', error: { message: 'rate limited' } } } })],
    ['malformed', () => 'Sure! {intent: pricing'], ['schema', () => ({ ...F.BASE_DECISION, intent: 'buy_now', reply: 'Price is ₹1' })]];
  for (const [name, ai] of cases) {
    const x = post('How much does this cost?', { ai });
    clean(x);
    assert.deepStrictEqual(texts(x.meta).map((t) => t.split(': ')[0]), [P_ASHA, OWNER.slice(1)], name);
    assert(texts(x.meta)[0].endsWith(HOLD) && !JSON.stringify(x.meta.calls).includes('₹1'), name);
    assert.deepStrictEqual([lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human], ['handed_off', true], name);
  }
});
test('10. W12 FAILURE (Meta refuses 131047 / Meta unreachable): status failed + Needs_Human + Run_Log failed; no retry storm, W2 unaffected', () => {
  let x = post('How much does this cost?', { metaAnswer: () => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }) });
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human, logs(x.g, 'W13-ai-receptionist')[0].Outcome, logs(x.g, 'W2-WhatsApp-Inbound')[0].Outcome], [1, 'failed', true, 'failed', 'ok']);
  assert(/131047/.test(lastIn(x.g).AI_Reason));
  x = post('How much does this cost?', { meta: Object.assign(() => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); }, { calls: [] }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, conv(x.g, F.ASHA).Needs_Human], ['failed', true]);
  assert(/could not reach Meta/.test(lastIn(x.g).AI_Reason));
});
test('11. GRIST FAILURE: message save fails -> no AI job; AI claim fails -> no AI, no send; a final CRM write fails -> AI execution errors (W11 alerts), W2 unaffected', () => {
  let x = post('How much does this cost?', { g: crm().failAt('POST', 'Messages', 1) });
  assert.deepStrictEqual([x.aiJobs.length, x.meta.calls.length, logs(x.g, 'W2-WhatsApp-Inbound')[0].Outcome], [0, 0, 'failed']);
  const noRow = crm();
  const handle = noRow.handle.bind(noRow);
  noRow.handle = (method, url, query, body) => (method === 'POST' && /Messages\/records$/.test(url) ? { records: [] } : handle(method, url, query, body));
  x = post('How much does this cost?', { g: noRow });
  assert.deepStrictEqual([x.aiJobs.length, x.meta.calls.length, logs(x.g, 'W2-WhatsApp-Inbound')[0].Outcome], [0, 0, 'failed'], 'Add Message gave no row id: no AI job');
  x = post('How much does this cost?', { g: crm().failAt('PATCH', 'Messages', 1) });
  assert.deepStrictEqual([x.aiJobs.length, x.claude.calls.length, x.meta.calls.length], [1, 0, 0]);
  x = post('How much does this cost?', { g: crm().failAt('GET', 'Settings', 1) });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, logs(x.g, 'W13-ai-receptionist')[0].Outcome], [0, 0, 'failed']);
  x = post('How much does this cost?', { g: crm().failAt('PATCH', 'Messages', 2) });
  assert(x.aiJobs[0].error && /Grist write\(s\) failed/.test(x.aiJobs[0].error.message), 'the AI execution stops with an error (error workflow)');
  assert.deepStrictEqual([x.r.error, x.r.responses.map((r) => r.code), logs(x.g, 'W2-WhatsApp-Inbound').map((l) => [l.Outcome, l.Error])], [null, [200], [['ok', '']]], 'the AI error never reaches W2');
});
test('12. STOP / opt-out: lead Opted_Out, nothing sent; the next message is not answered', () => {
  const x = post('STOP');
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, leadOf(x.g, F.ASHA).Opted_Out, lastIn(x.g).AI_Status], [0, true, 'opted_out']);
  const y = post('How much does this cost?', { g: x.g, meta: x.meta, claude: x.claude, ts: F.sec(F.NOW) + 30, now: F.NOW + 60000 });
  clean(y);
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Reason], [0, 'the lead has opted out']);
});
test('13. LOW CONFIDENCE (0.55) / medical / payment -> hand-off: the AI text is never sent', () => {
  for (const [name, over, re] of [['low confidence', { confidence: 0.55 }, /low confidence \(0\.55\)/], ['medical', { intent: 'medical_question', needs_human: false, reply: 'Take ibuprofen.' }, /medical question/], ['payment', { intent: 'payment_issue', needs_human: false, reply: 'Refund done.' }, /payment issue/]]) {
    const x = post('How much does this cost?', { ai: (req) => ({ ...F.fakeDecide(req), ...over }) });
    clean(x);
    assert(texts(x.meta)[0].endsWith(HOLD) && !/ibuprofen|Refund done|₹500/.test(JSON.stringify(x.meta.calls)), name);
    assert(re.test(lastIn(x.g).AI_Reason), `${name}: ${lastIn(x.g).AI_Reason}`);
  }
});

// ================================================================ the other safety gates through the integrated path
test('gates: AI off (no ai_mode) does nothing; draft mode sends nothing; TEST_MODE -> TEST_PHONE; paused; media; rate limit; made-up price / link', () => {
  let x = post('How much does this cost?', { crm: { settings: { ai_mode: undefined } } });
  assert.deepStrictEqual([x.aiJobs.length, x.claude.calls.length, x.meta.calls.length, lastIn(x.g).AI_Status], [1, 0, 0, undefined]);
  x = post('How much does this cost?', { crm: { settings: { ai_mode: 'draft' } } });
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status], [0, 'drafted']);
  x = post('How much does this cost?', { crm: { settings: { TEST_MODE: 'true' } } });
  assert.deepStrictEqual(texts(x.meta).map((t) => t.split(': ')[0]), [TESTP.slice(1)]);
  x = post('How much does this cost?', { crm: { convs: [{ id: 1, fields: { ...F.conversationRows()[0].fields, Automation_Paused: true } }] } });
  assert.deepStrictEqual([x.meta.calls.length, lastIn(x.g).AI_Status], [0, 'skipped']);
  x = post('my knee x-ray', { type: 'image' });
  assert.deepStrictEqual([x.claude.calls.length, lastIn(x.g).AI_Status], [0, 'handed_off']);
  const recent = Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, fields: { Conversation: 1, Direction: 'Out', Body: 'r', Sent_By: 'W13-ai-receptionist', Created_At: F.sec(F.NOW) - 3000 + i } }));
  x = post('How much does this cost?', { crm: { msgs: [...F.messageRows(), ...recent] } });
  assert.deepStrictEqual([x.claude.calls.length, lastIn(x.g).AI_Status], [0, 'handed_off']);
  x = post('How much does this cost?', { ai: (req) => ({ ...F.fakeDecide(req), reply: 'Only ₹199 today, pay at https://pay.example/x' }) });
  assert(texts(x.meta)[0].endsWith(HOLD) && !/199|pay\.example/.test(JSON.stringify(x.meta.calls)));
});
test('night: deferred at 22:00 without asking the AI; W13 – Every Morning (08:05) answers it through W12 the next day', () => {
  const night = Date.parse('2026-10-06T22:00:00+05:30');
  const x = post('Can I come tomorrow evening?', { now: night, ts: F.sec(night) });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, lastIn(x.g).AI_Status], [0, 0, 'deferred']);
  const morning = Date.parse('2026-10-07T08:05:00+05:30');
  const r = simulate(prepared, { start: 'W13 – Every Morning', items: [{ json: {} }], grist: x.g, now: morning, workflowId: 'MASTER', workflows: {}, meta: x.meta, openrouter: F.fakeOpenRouter(x.claude) });
  for (const run of allRuns(r)) assert.strictEqual(run.error, null, JSON.stringify(run.error));
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, lastIn(x.g).AI_Status], [1, 1, 'replied']);
});
test('W12 callers W3 / W5 / W6 are untouched: their items have no w13_job and go straight to W12 (W12 manual test too)', () => {
  const item = { decision: { send: true, to: TESTP, reason: 'test', test_mode: true }, template: 'hello_world', template_params: {}, wa_phone_number_id: PNID, audience: 'staff', source_workflow: 'W3-speed-to-lead' };
  const meta = fakeMeta();
  const r = simulate(prepared, { start: 'W12 – When called by another workflow', items: [{ json: item }], grist: crm(), now: F.NOW, workflowId: 'MASTER', meta });
  assert.strictEqual(r.error, null);
  assert(!r.visited.some((n) => n.startsWith('W13 – ')));
  assert.deepStrictEqual([meta.calls.length, meta.calls[0].body.template.name, r.runData['W12 – Return result'][0].json.sent], [1, 'hello_world', true]);
});

// ================================================================ run, then break each integration point once (the suite must notice)
const runSuite = (quiet) => {
  const failed = [];
  for (const t of suite) {
    try { t.fn(); if (!quiet) ok(t.name); } catch (e) { failed.push(t.name); if (!quiet) console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').slice(0, 6).join('\n       ')}`); }
  }
  return failed;
};
const failures = runSuite(false);
if (failures.length) { console.log(`\n${failures.length} of ${suite.length} FAILED: ${failures.join(' | ')}`); process.exit(1); }

if (!process.env.INTEGRATED_NO_MUTATIONS) {
  console.log('\nmutations (each integration point broken once: the suite must fail)');
  const node = (w, n) => w.nodes.find((x) => x.name === n);
  const cond = (w, n, from, to) => { const c = node(w, n).parameters.conditions.conditions[0]; assert(c.leftValue.includes(from), `${n}: ${from}`); c.leftValue = c.leftValue.replace(from, to); };
  const code = (w, n, from, to) => { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: ${from}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
  const mutations = {
    'the router never sends AI jobs to SECTION W13': (w) => cond(w, 'W12 – AI Job?', '$json.w13_job === true || $json.w13_retry === true', 'false'),
    'the router sends everything to SECTION W13 (W12 callers broken)': (w) => cond(w, 'W12 – AI Job?', '$json.w13_job === true || $json.w13_retry === true', 'true'),
    'W2 starts the AI for a message that was not stored': (w) => cond(w, 'W2 – AI Wanted?', "$json.run_outcome === 'ok' && Number($json.message_row_id) > 0 && ", ''),
    'W2 waits for the AI (an AI error breaks W2)': (w) => { node(w, 'W2 – Start AI Receptionist').parameters.options = {}; },
    'W2 – AI Handed does not restore W2\'s own item (Run_Log broken)': (w) => code(w, 'W2 – AI Handed', 'if (!e) return { json: ctx };', 'if (!e) return { json: $json };'),
    'the AI job loses the message row id': (w) => code(w, 'W2 – AI Job', '    message_row_id: $json.message_row_id,', '    message_row_id: 0,'),
    'the AI job is not marked w13_job (never routed)': (w) => code(w, 'W2 – AI Job', '    w13_job: true,', '    w13_job: false,'),
    'the morning retry is not routed': (w) => cond(w, 'W12 – AI Job?', ' || $json.w13_retry === true', ''),
    'W12 lost A-01 (no free text)': (w) => { for (const n of ['W12 – Prepare request']) code(w, n, "const isText = input.message_type === 'text';", 'const isText = false;'); },
    'AI sends bypass W12 (W13 – Call W12 points elsewhere)': (w) => { node(w, 'W13 – Config').parameters.assignments.assignments.find((a) => a.name === 'w12_workflow_id').value = 'SOMEOTHERID00001'; },
  };
  let missed = 0;
  for (const [name, mutate] of Object.entries(mutations)) {
    const w = clone(BASE); mutate(w);
    prepared = prepare(w);
    const f = runSuite(true).filter((n) => !n.startsWith('the committed file'));
    if (f.length) console.log(`  caught  ${name}   <- ${f[0]}`); else { console.log(`  MISSED  ${name}`); missed++; }
  }
  prepared = prepare(BASE);
  if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
}
console.log(`\nINTEGRATED MASTER: ${suite.length} end-to-end check groups pass`);
