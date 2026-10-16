// W7 (outcome check-in), W8 (review request), W9 (weekly report) and W10 (staff reply) END TO END on your workflow after
// apply-w7-w10.js: each section runs from its own trigger in the simulator (fake Grist, fake Meta, fake OpenRouter), through
// W12 for every WhatsApp message, and W2 -> W13 for the patient's answers. One line per check: PASS / FAIL and why.
// Made-up numbers only. Run: node n8n/integrated/w7-w10.test.js        (W7W10_FILE = another file, e.g. your private one)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.W7W10_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- live CRM naming (LEADS / Lead_id), W2's "Received"
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
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

// ---------------------------------------------------------------- the workflow, filled in as after import (test values, in memory)
const PNID = '123456789012345';
const PNID2 = '223456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const LINK = 'https://g.page/r/demo-physio-test/review';
const w = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const setv = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
setv('W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,${OWNER},${TESTP}`);
setv('W2 – Verify Config', 'meta_verify_token', 'test-verify-token-123');
setv('W4 – Config', 'cal_webhook_secret', 'test-cal-secret-456');

const T = F.sec(F.NOW);   // Tue 06 Oct 2026, 11:00 IST
const MIN = 60, HOUR = 3600, DAY = 86400;
const ON = { TEST_MODE: 'false', outcome_checkin: 'on', review_requests: 'on', review_link: LINK };
const crm = ({ settings = {}, msgs, convs, leads, appts, docB } = {}) => new TestGrist({
  [REG]: { Clinics: [
    { id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } },
    ...(docB ? [{ id: 2, fields: { Clinic_Slug: 'second-clinic', Clinic_Name: 'Second Physio', Grist_Doc_ID: 'DOCB', WA_Phone_Number_ID: PNID2, Active: true } }] : []),
    { id: 3, fields: { Clinic_Slug: 'old-clinic', Clinic_Name: 'Closed Clinic', Grist_Doc_ID: 'DOCX', WA_Phone_Number_ID: '323456789012345', Active: false } },
  ] },
  DOCA: {
    Settings: F.settingsRows({ ...ON, ...settings }), Knowledge: clone(F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || []), Run_Log: [],
  },
  ...(docB ? { DOCB: docB } : {}),
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const fakeReportAi = (content, status = 200) => {
  const calls = [];
  const fn = (method, url, headers, body) => {
    calls.push({ url, headers, body });
    if (status !== 200) return { status, body: { error: { message: 'provider down' } } };
    return { status: 200, body: { id: 'gen-test', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] } };
  };
  fn.calls = calls;
  return fn;
};
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const run = (start, items, o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const openrouter = o.openrouter || F.fakeOpenRouter(claude);
  const r = simulate(o.w || w, { start, items, grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter });
  const runs = allRuns(r);
  const w12 = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
  return { r, g, meta, claude, openrouter, runs, w12, errors: runs.filter((x) => x.error).map((x) => x.error) };
};
const tick = (start, o = {}) => run(start, [{ json: {} }], o);
const rows = (g, t, doc = 'DOCA') => g.docs[doc][t].map((x) => ({ id: x.id, ...x.fields }));
const logs = (g, wf, doc = 'DOCA') => rows(g, 'Run_Log', doc).filter((l) => l.Workflow === wf);
const onlyW12 = (x) => {
  assert.strictEqual(x.meta.calls.length, x.w12.filter((s) => s.visited.includes('W12 – Meta send')).length, 'a Meta call that did not come from W12');
  for (const s of x.runs) if (s.visited.includes('W12 – Meta send')) assert.strictEqual(s.visited[0], 'W12 – When called by another workflow');
};
const tpl = (c) => (c.body.type === 'text' ? `text:${c.body.text.body}` : `${c.body.template.name}(${(((c.body.template.components || [])[0] || {}).parameters || []).map((p) => p.text).join(' | ')})`);
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';

const results = [];
const check = (id, title, fn) => {
  try { const why = fn(); results.push({ id, title, ok: true, why: why || '' }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n').slice(0, process.env.W7W10_VERBOSE ? 40 : 4).join(' ') }); }
};

// ================================================================ W7 outcome check-in
const W7_APPTS = () => [
  { id: 11, fields: { Booking_UID: 'cal-w7-asha', Lead: 1, Service: 'Knee pain physiotherapy', Physio: 'Dr. Mehta', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'Completed' } },
  { id: 12, fields: { Booking_UID: 'cal-w7-early', Lead: 2, Service: 'First assessment', Start: T - 11 * HOUR, End: T - 10 * HOUR, Status: 'Completed' } },   // 10 h ago: too early
  { id: 13, fields: { Booking_UID: 'cal-w7-noshow', Lead: 3, Service: 'Back pain physiotherapy', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'No-show' } },
];
const w7 = (o = {}) => tick('W7 – Every hour', { ...o, crm: { appts: W7_APPTS(), ...o.crm } });
const appt = (g, id) => rows(g, 'Appointments').find((a) => a.id === id);
const inboxOut = (g, wf) => rows(g, 'Messages').filter((m) => m.Direction === 'Out' && String(m.Sent_By || '').startsWith(wf));

check('W7.1', 'completed appointment -> outcome check-in', () => {
  const x = w7();
  assert.deepStrictEqual(x.errors, []);
  onlyW12(x);
  assert.deepStrictEqual(x.meta.calls.map(tpl), ['outcome_check(Asha | Demo Physio | Knee pain physiotherapy)']);
  assert.strictEqual(x.meta.calls[0].body.to, P_ASHA);
  assert.deepStrictEqual([appt(x.g, 11).Outcome_Sent, appt(x.g, 12).Outcome_Sent, appt(x.g, 13).Outcome_Sent], [T, undefined, undefined]);
  assert.deepStrictEqual(logs(x.g, 'W7-outcome-nudge').map((l) => [l.Record, l.Outcome]), [['cal-w7-asha L-20261001-0001', 'ok']]);
  const m = inboxOut(x.g, 'W7-outcome-nudge');
  assert(m.length === 1 && m[0].Template === 'outcome_check' && /How are you feeling now\?/.test(m[0].Body) && m[0].WA_Message_ID === 'wamid.SENT.1');
  const t = tick('W7 – Every hour', { crm: { appts: W7_APPTS(), convs: [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 2 * HOUR, Unread: 0 } }] } });
  assert(t.meta.calls.length === 1 && t.meta.calls[0].body.type === 'text' && /How are you feeling now\?/.test(t.meta.calls[0].body.text.body));
  return 'visit ended 22 h ago: template outcome_check via W12, Outcome_Sent set, inbox row + Run_Log ok; ended 10 h ago and No-show: nothing; patient wrote in the last 24 h: same text as a free message';
});
check('W7.2', 'duplicate run -> no duplicate', () => {
  const g = crm({ settings: {}, appts: W7_APPTS() });
  const a = tick('W7 – Every hour', { g });
  const b = tick('W7 – Every hour', { g, meta: a.meta });
  const c = tick('W7 – Every hour', { g, meta: a.meta, now: F.NOW + 3 * HOUR * 1000 });
  assert.deepStrictEqual([a.meta.calls.length, b.errors, c.errors, logs(g, 'W7-outcome-nudge').length], [1, [], [], 1]);
  const again = W7_APPTS().concat([{ id: 14, fields: { Booking_UID: 'cal-w7-asha-2', Lead: 1, Service: 'Knee pain physiotherapy', Start: T - 21 * HOUR, End: T - 20.5 * HOUR, Status: 'Completed', } }]);
  const d = tick('W7 – Every hour', { crm: { appts: again.map((r) => (r.id === 11 ? { ...r, fields: { ...r.fields, Outcome_Sent: T - 2 * DAY } } : r)) } });
  assert.strictEqual(d.meta.calls.length, 0);
  return 'same hour, next hour, 3 h later: still one message (Outcome_Sent); another visit 2 days after a check-in: none (7-day gap)';
});
check('W7.3', 'opt-out -> blocked', () => {
  const leads = F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l));
  const x = w7({ crm: { leads } });
  const paused = w7({ crm: { convs: [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 5 * DAY, Automation_Paused: true } }] } });
  const badPhone = w7({ crm: { leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Phone: '12345' } } : l)), settings: { TEST_MODE: 'true' } } });
  const off = w7({ crm: { settings: { outcome_checkin: undefined } } });
  assert.deepStrictEqual([x.meta.calls.length, appt(x.g, 11).Outcome_Sent, logs(x.g, 'W7-outcome-nudge').length], [0, undefined, 0]);
  assert.deepStrictEqual([paused.meta.calls.length, badPhone.meta.calls.length, off.meta.calls.length], [0, 0, 0]);
  return 'Opted_Out: nothing sent, flag not set; also nothing for Automation_Paused, an invalid phone (even in TEST_MODE) or a clinic without outcome_checkin = on';
});
check('W7.4', 'quiet hours -> blocked', () => {
  const g = crm({ appts: W7_APPTS() });
  const night = Date.parse('2026-10-06T22:20:00+05:30');
  const x = tick('W7 – Every hour', { g, now: night });
  const y = tick('W7 – Every hour', { g, now: Date.parse('2026-10-07T08:20:00+05:30') });
  const asha = (r) => r.meta.calls.filter((c) => c.body.to === P_ASHA).length;
  assert.deepStrictEqual([x.meta.calls.length, asha(y), appt(g, 11).Outcome_Sent], [0, 1, Date.parse('2026-10-07T08:20:00+05:30') / 1000]);
  return '22:20 IST: nothing sent, flag untouched; 08:20 next morning: sent once';
});
check('W7.5', 'TEST_MODE -> safe recipient', () => {
  const x = w7({ crm: { settings: { TEST_MODE: 'true' } } });
  const m = inboxOut(x.g, 'W7-outcome-nudge')[0];
  assert.deepStrictEqual([x.meta.calls.map((c) => c.body.to), m.Sent_By, logs(x.g, 'W7-outcome-nudge')[0].Record], [[TESTP.slice(1)], `W7-outcome-nudge (TEST_MODE: sent to ${TESTP})`, 'cal-w7-asha L-20261001-0001 (TEST_MODE)']);
  const missing = w7({ crm: { settings: { TEST_MODE: undefined, TEST_PHONE: undefined } } });
  assert.strictEqual(missing.meta.calls.length, 0);
  return 'sent to TEST_PHONE, logged in the patient\'s conversation; TEST_MODE missing = ON and no TEST_PHONE = nothing sent';
});

// the patient answers the check-in: W2 -> W13 (the AI receptionist) -> W12, two hours after the check-in went out
const metaBody = (from, id, text, ts) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
    contacts: [{ profile: { name: 'Asha Patel' }, wa_id: from }], messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }],
  } }] }],
});
let seq = 0;
const answer = (text, o = {}) => {
  const base = o.base || w7();
  const now = o.now || F.NOW + 2 * HOUR * 1000;
  const x = run('W2 – Webhook Inbound', [{ json: { headers: {}, params: {}, query: {}, body: metaBody(P_ASHA, `wamid.ANS.${++seq}`, text, F.sec(now) - 5) } }], { g: base.g, now, claude: o.claude });
  x.last = rows(x.g, 'Messages').filter((m) => m.Direction === 'In').pop();
  x.texts = x.meta.calls.map(tpl);
  x.conv = rows(x.g, 'Conversations')[0];
  x.lead = rows(x.g, 'LEADS').find((l) => l.id === 1);
  return x;
};
check('W7.6', 'patient wants another appointment -> rebooking intent, real slot / Cal.com link only', () => {
  const x = answer('Better, but please book me for Saturday at 5');
  assert.deepStrictEqual(x.errors, []);
  onlyW12(x);
  assert.deepStrictEqual([x.claude.calls.length, x.last.Intent, x.conv.Last_Intent, x.lead.Lead_Stage], [1, 'book_appointment', 'book_appointment', 'hot']);
  assert(x.texts.length === 1 && x.texts[0].includes('https://cal.com/demo-physio/assessment'), x.texts[0]);
  assert.strictEqual(rows(x.g, 'Appointments').length, 3);   // nothing booked by the AI: Cal.com -> W4 writes the appointment
  const better = answer('Much better now, thank you!');
  assert.deepStrictEqual([better.last.Intent, better.conv.Last_Intent, better.texts], ['outcome_better', 'outcome_better', ['text:So glad to hear you are feeling better! Thank you for letting us know.']]);
  const same = answer('Still the same, no change');
  assert.deepStrictEqual([same.last.Intent, same.conv.Needs_Human, same.texts], ['outcome_same', true, [`text:${HOLD}`, same.texts[1]]]);
  return 'W13 reads the check-in in the history: "book me" = book_appointment (lead hot, the booking link from Settings, no appointment invented); "better" = outcome_better recorded (Messages.Intent, Conversations.Last_Intent) + thank-you; "same" = a person follows up';
});
check('W7.7', 'urgent / high-risk answer -> human hand-off', () => {
  const x = answer('Much worse, I have severe chest pain');
  onlyW12(x);
  assert.deepStrictEqual([x.claude.calls.length, x.last.AI_Status, x.conv.Needs_Human, /^URGENT/.test(x.conv.Handoff_Reason), x.texts[0], /^human_handoff_alert/.test(x.texts[1])], [0, 'handed_off', true, true, `text:${HOLD}`, true]);
  const y = answer('It is worse, more pain since yesterday');
  assert.deepStrictEqual([y.claude.calls.length, y.last.Intent, y.last.AI_Status, y.conv.Needs_Human, y.texts[0]], [1, 'outcome_worse', 'handed_off', true, `text:${HOLD}`]);
  assert(/^HIGH · Patient says they feel worse after the visit/.test(y.conv.Handoff_Reason), y.conv.Handoff_Reason);
  // the model tries to answer "worse" itself, with advice and high confidence: code still hands off, the advice is never sent
  const advice = F.fakeClaude(() => ({ ...F.BASE_DECISION, intent: 'outcome_worse', action: 'reply', needs_human: false, confidence: 0.97, reply: 'Apply ice and take paracetamol twice a day.' }));
  const z = answer('It is worse, more pain since yesterday', { claude: advice });
  const toPatient = z.meta.calls.filter((c) => c.body.to === P_ASHA).map(tpl);
  assert.deepStrictEqual([z.last.AI_Status, z.conv.Needs_Human, toPatient, z.texts.some((t) => /paracetamol|apply ice/i.test(t))], ['handed_off', true, [`text:${HOLD}`], false]);
  return 'chest pain: URGENT hand-off before any AI call; "worse": HIGH hand-off flagged medical, even when the model tries to answer with advice; only the holding reply goes to the patient + staff alert, both through W12';
});

// ================================================================ W8 review request
const W8_APPTS = () => [
  { id: 21, fields: { Booking_UID: 'cal-w8-asha', Lead: 1, Service: 'Knee pain physiotherapy', Start: T - 5 * HOUR, End: T - 4 * HOUR, Status: 'Completed' } },
  { id: 22, fields: { Booking_UID: 'cal-w8-recent', Lead: 2, Service: 'First assessment', Start: T - 2 * HOUR, End: T - HOUR, Status: 'Completed' } },   // 1 h ago: too early
];
const w8 = (o = {}) => tick('W8 – Every hour', { ...o, crm: { appts: W8_APPTS(), ...o.crm } });
check('W8.1', 'completed appointment -> review request', () => {
  const x = w8();
  assert.deepStrictEqual(x.errors, []);
  onlyW12(x);
  assert.deepStrictEqual(x.meta.calls.map(tpl), [`review_request(Asha | Demo Physio | ${LINK})`]);
  assert.deepStrictEqual([appt(x.g, 21).Review_Sent, appt(x.g, 22).Review_Sent, logs(x.g, 'W8-review-request').map((l) => l.Outcome)], [T, undefined, ['ok']]);
  const m = inboxOut(x.g, 'W8-review-request')[0];
  assert(/honest review/.test(m.Body) && !/5 star|stars|positive|discount|free/i.test(m.Body));
  const unhappy = w8({ crm: { convs: [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 5 * DAY, Needs_Human: true, Last_Intent: 'complaint' } }] } });
  assert.strictEqual(unhappy.meta.calls.length, 1);
  return 'visit ended 4 h ago: review_request with Settings > review_link via W12, Review_Sent set, Run_Log ok; the same polite text for everyone (an unhappy patient is not filtered out: no review gating)';
});
check('W8.2', 'duplicate -> blocked', () => {
  const g = crm({ appts: W8_APPTS() });
  const a = tick('W8 – Every hour', { g });
  const b = tick('W8 – Every hour', { g, now: F.NOW + 2 * HOUR * 1000 });
  const recent = w8({ crm: { appts: W8_APPTS().concat([{ id: 23, fields: { Booking_UID: 'cal-w8-old', Lead: 1, Start: T - 31 * DAY, End: T - 31 * DAY + HOUR, Status: 'Completed', Review_Sent: T - 30 * DAY } }]) } });
  assert.deepStrictEqual([a.meta.calls.map((c) => c.body.to), b.meta.calls.map((c) => c.body.to), recent.meta.calls.length], [[P_ASHA], ['919000000014'], 0]);
  return 'two hours later: only the other patient, whose visit is now 3 h old (Review_Sent stops a second one to Asha); asked 30 days ago for another visit: nothing (one request per 90 days)';
});
check('W8.3', 'missing review URL -> safe config warning', () => {
  const at1035 = Date.parse('2026-10-06T10:35:00+05:30');
  const g = crm({ settings: { review_link: undefined }, appts: W8_APPTS() });
  const x = tick('W8 – Every hour', { g, now: at1035 });
  const y = tick('W8 – Every hour', { g, now: at1035 + HOUR * 1000 });
  const warn = logs(g, 'W8-review-request');
  assert.deepStrictEqual([x.errors, x.meta.calls.length, y.meta.calls.length, appt(g, 21).Review_Sent, warn.length, warn[0].Outcome], [[], 0, 0, undefined, 1, 'skipped']);
  assert(/review_link is missing or not an https:\/\/ link: 1 review request\(s\) are waiting/.test(warn[0].Error), warn[0].Error);
  const notHttps = tick('W8 – Every hour', { crm: { settings: { review_link: 'g.page/r/demo' }, appts: W8_APPTS() }, now: at1035 });
  assert.deepStrictEqual([notHttps.meta.calls.length, logs(notHttps.g, 'W8-review-request').length], [0, 1]);
  return 'no link: nothing sent, nothing flagged (they go once the link is set), one Run_Log warning a day (10:xx IST); a link that is not https:// counts as missing; no link is ever made up';
});
check('W8.4', 'opt-out -> blocked', () => {
  const x = w8({ crm: { leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l)) } });
  const off = w8({ crm: { settings: { review_requests: 'off' } } });
  assert.deepStrictEqual([x.meta.calls.length, appt(x.g, 21).Review_Sent, off.meta.calls.length], [0, undefined, 0]);
  return 'Opted_Out: nothing sent, flag untouched; review_requests = off: nothing';
});
check('W8.5', 'quiet hours -> blocked', () => {
  const g = crm({ appts: W8_APPTS() });
  const x = tick('W8 – Every hour', { g, now: Date.parse('2026-10-06T21:35:00+05:30') });
  const y = tick('W8 – Every hour', { g, now: Date.parse('2026-10-07T08:35:00+05:30') });
  assert.deepStrictEqual([x.meta.calls.length, y.meta.calls.filter((c) => c.body.to === P_ASHA).length, appt(g, 21).Review_Sent], [0, 1, Date.parse('2026-10-07T08:35:00+05:30') / 1000]);
  return '21:35 IST: nothing, flag untouched; 08:35 next morning: sent once';
});
check('W8.6', 'TEST_MODE -> safe recipient', () => {
  const x = w8({ crm: { settings: { TEST_MODE: 'true' } } });
  assert.deepStrictEqual([x.meta.calls.map((c) => c.body.to), inboxOut(x.g, 'W8-review-request')[0].Sent_By], [[TESTP.slice(1)], `W8-review-request (TEST_MODE: sent to ${TESTP})`]);
  return 'sent to TEST_PHONE only';
});

// ================================================================ W9 weekly report (Mon 12 Oct 2026 09:00 IST: the week 05-11 Oct)
const MON = Date.parse('2026-10-12T09:00:00+05:30');
const W = F.sec(Date.parse('2026-10-05T00:00:00+05:30'));
const d = (day, hour, min = 0) => W + day * DAY + hour * HOUR + min * MIN;
const W9_CRM = () => ({
  settings: { owner_phone: OWNER },
  leads: [
    [101, d(0, 10), 'WhatsApp', 'Booked', 5, 'hot'], [102, d(1, 11), 'WhatsApp', 'Contacted', 12, 'warm'], [103, d(2, 12), 'WhatsApp', 'New', null, ''],
    [104, d(3, 9), 'Website', 'Converted', 30, 'hot'], [105, d(4, 15), 'Website', 'Lost', 8, 'cold'], [106, W - 2 * DAY, 'Website', 'Booked', 4, 'warm'], [107, W - 3 * DAY, 'WhatsApp', 'Lost', 3, 'cold', true],
  ].map(([id, at, src, st, fr, stage, out]) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: at, Name: `Lead ${id}`, Phone: `+9190000${id}00`.slice(0, 13), Source: src, Status: st, ...(fr ? { First_Response_At: at + fr * MIN } : {}), ...(stage ? { Lead_Stage: stage } : {}), Opted_Out: !!out } })),
  appts: [
    [201, d(0, 10), 'Completed'], [202, d(1, 10), 'Completed'], [203, d(2, 10), 'Completed'], [204, d(3, 10), 'No-show'], [205, d(4, 10), 'Cancelled'], [206, d(5, 10), 'Cancelled'],
    [207, d(4, 16), 'Rescheduled'], [210, d(6, 10), 'Booked'], [208, W - 2 * DAY, 'Completed'], [209, F.sec(MON) + 2 * DAY, 'Booked'],
  ].map(([id, start, st]) => ({ id, fields: { Booking_UID: `u${id}`, Lead: 101, Service: 'Physio', Start: start, End: start + 45 * MIN, Status: st } })),
  convs: [[1, true, false], [2, true, true], [3, false, false]].map(([id, nh, p]) => ({ id, fields: { Lead: 100 + id, Phone: `+91900000010${id}`, Needs_Human: nh, Automation_Paused: p } })),
  msgs: [
    ...[['replied', 'pricing'], ['replied', 'pricing'], ['replied', 'services_info'], ['replied', 'location_hours'], ['handed_off', 'outcome_worse'], ['handed_off', 'complaint'], ['no_reply', 'outcome_better'], ['skipped', '']]
      .map(([s, i], k) => ({ id: 300 + k, fields: { Conversation: 1, Direction: 'In', Body: 'x', Status: 'Received', Created_At: d(k % 7, 12), AI_Status: s, Intent: i } })),
    { id: 320, fields: { Conversation: 1, Direction: 'In', Body: 'old', Status: 'Received', Created_At: W - DAY, AI_Status: 'replied' } },
    { id: 321, fields: { Conversation: 1, Direction: 'Out', Body: 'staff', Sent_By: 'Ravi (front desk)', Status: 'sent', Created_At: d(2, 13) } },
    { id: 322, fields: { Conversation: 1, Direction: 'Out', Body: 'ai', Sent_By: 'W13-ai-receptionist', Status: 'queued', Created_At: d(2, 13) } },
  ],
  runlog: [
    ...[['W5-reminders', 'x', 'ok'], ['W5-reminders', 'x', 'ok'], ['W5-reminders', 'x', 'ok'], ['W5-reminders', 'x', 'failed'], ['W6-followups', 'L-1 (followup)', 'ok'], ['W6-followups', 'u2 (rebook) L-2', 'ok'],
      ['W7-outcome-nudge', 'u1', 'ok'], ['W7-outcome-nudge', 'u2', 'ok'], ['W8-review-request', 'u1', 'ok'], ['W8-review-request', 'u2', 'ok'], ['W3-speed-to-lead', 'L-1 (escalated)', 'ok'],
      ...Array.from({ length: 7 }, () => ['W13-ai-receptionist', 'r', 'ok'])].map(([wf, rec, out], k) => ({ id: 400 + k, fields: { Workflow: wf, Record: rec, Outcome: out, Error: out === 'failed' ? 'boom' : '', At: d(k % 7, 14) } })),
    { id: 450, fields: { Workflow: 'W5-reminders', Record: 'old', Outcome: 'ok', Error: '', At: W - DAY } },
  ],
});
const GOOD_AI = {
  summary: '5 new leads came in this week and 2 booked. 3 visits were completed, 1 patient did not show up and 2 cancelled.',
  observations: ['2 conversations are waiting for a person.'],
  recommendations: ['Call the 1 lead that is still New today.', 'Mark the 1 past appointment that is still Booked as Completed or No-show.'],
};
const w9 = (o = {}) => {
  const c = W9_CRM();
  const g = o.g || crm({ settings: { ...c.settings, ...(o.settings || {}) }, leads: c.leads, appts: c.appts, convs: c.convs, msgs: c.msgs });
  if (!o.g) g.docs.DOCA.Run_Log = clone(c.runlog);
  const openrouter = o.openrouter || fakeReportAi(o.ai || GOOD_AI);
  const x = tick('W9 – Monday 09:00', { g, now: MON, openrouter, meta: o.meta });
  x.report = logs(g, 'W9-weekly-report').filter((l) => /^WEEKLY REPORT/.test(l.Record)).pop();
  x.text = x.report ? x.report.Record : '';
  x.section = (n) => { const s = x.text.indexOf(`\n${n}. `); const e = x.text.indexOf(`\n${n + 1}. `); return x.text.slice(s, e < 0 ? undefined : e); };
  return x;
};
const W9X = w9();
check('W9.1', 'correct lead counts', () => {
  assert.deepStrictEqual(W9X.errors, []);
  const s = W9X.section(2);
  for (const line of ['- New leads: 5 (WhatsApp 3, Website 2)', '- Contacted: 4 | booked: 2 | still New: 1', '- Median first response: 8 min', '- Stage of new leads: hot 2 | warm 1 | cold 1 | not rated 1', '- Opted out (all time): 1']) assert(s.includes(line), `missing "${line}" in ${s}`);
  return 'only leads created Mon-Sun: 5 (WhatsApp 3, Website 2), contacted 4, booked 2, still New 1, median first reply 8 min, stages, opted out 1';
});
check('W9.2', 'correct appointment counts', () => {
  const s = W9X.section(3);
  for (const line of ['- Total 8 | completed 3 | no-show 1', '- Past appointments still marked Booked: 1 | booked for the next 7 days: 1']) assert(s.includes(line), `missing "${line}" in ${s}`);
  return 'appointments that started in the week: 8, completed 3 (the one from the week before not counted), 1 still Booked in the past, 1 booked ahead';
});
check('W9.3', 'correct cancellations', () => {
  assert(W9X.section(3).includes('| cancelled 2 | rescheduled 1'));
  return 'cancelled 2, rescheduled 1';
});
check('W9.4', 'correct no-shows', () => {
  const rep = W9X.r.runData['W9 – Report'][0].json;
  assert(W9X.section(3).includes('| no-show 1 |') && rep.headline.includes('1 no-show') && rep.metrics.appointments.no_show === 1);
  return 'no-show 1 (section 3, the headline used for the owner copy, the data given to the AI)';
});
check('W9.5', 'correct hand-off counts', () => {
  const s = W9X.section(4);
  for (const line of ['- Patient messages 8 | AI replied 4 | handed to staff 2 | drafts 0 | no reply needed 1 | deferred overnight 0 | skipped 1 | failed 0 | opted out 0', '- Check-in answers: better 1 | same 0 | worse 1', '- Conversations waiting for a person now: 2 | paused: 1 | staff replies sent: 1']) assert(s.includes(line), `missing "${line}" in ${s}`);
  assert(W9X.section(5).includes('- Speed-to-lead alerts 1 | reminders 3 | day-2 follow-ups 1 | no-show rebooks 1 | check-ins 2 | review requests 2'));
  const issues = W9X.section(6);
  for (const t of ['1 past appointment(s) are still marked Booked', '2 conversation(s) are waiting for a person', "1 of this week's new leads were never contacted", '1 patient(s) said they feel worse', '1 automation step(s) failed']) assert(issues.includes(t), `issue missing: ${t}`);
  return 'patient messages 8 (the one from the week before not counted), AI replied 4, handed off 2, waiting 2, staff replies 1; follow-ups from Run_Log; issues from the numbers';
});
check('W9.6', 'AI summary matches the computed numbers', () => {
  assert.strictEqual(W9X.openrouter.calls.length, 1);
  const req = W9X.openrouter.calls[0];
  const data = JSON.parse(req.body.messages[1].content.replace(/^DATA\n/, ''));
  assert.deepStrictEqual([req.body.model, data.leads.new, data.appointments.completed, data.appointments.cancelled, data.appointments.no_show, data.ai.handed_off], ['openai/gpt-4o-mini', 5, 3, 2, 1, 2]);
  assert(!/Lead 10|\+9190000/.test(JSON.stringify(req.body)), 'patient names / phones sent to the AI');
  assert(W9X.section(1).includes(GOOD_AI.summary) && W9X.section(1).includes('- 2 conversations are waiting for a person.'));
  assert(W9X.section(7).includes('7. Recommended actions (AI suggestions, not facts)') && W9X.section(7).includes(`- ${GOOD_AI.recommendations[0]}`));
  assert(/^Numbers: computed by n8n from Grist/m.test(W9X.text) && W9X.report.Error === '');
  for (const sec of [2, 3, 4, 5, 6]) assert.strictEqual(W9X.section(sec), w9({ openrouter: fakeReportAi('', 500) }).section(sec), `section ${sec} depends on the AI`);
  return 'ONE OpenRouter call (W13\'s model and credential), numbers only (no names / phones); its summary uses exactly the computed numbers; sections 2-6 are identical with or without AI; recommendations labelled "not facts"';
});
check('W9.7', 'AI cannot invent metrics', () => {
  const bad = w9({ ai: { summary: '12 new leads came in this week. Bookings rose 40%. Twenty patients were treated. 3 visits were completed.', observations: ['Revenue was ₹ 40000.'], recommendations: ['Hire 2 more staff for the 30 extra patients.'] } });
  const s1 = bad.section(1);
  assert(s1.includes('3 visits were completed.') && !/\b12\b|40|Twenty|30|₹/.test(bad.text.replace(/^Numbers:.*$/m, '')), bad.text);
  assert(bad.text.includes('(5 AI line(s) dropped: they quoted a number that is not in the data)') && bad.section(7).includes('(suggested by the rules, not facts)'));
  const down = w9({ openrouter: fakeReportAi('', 500) });
  assert(down.errors.length === 0 && down.report && /^AI text not used/.test(down.report.Error) && down.section(1).includes('This week: 5 new leads (2 booked)'));
  const junk = w9({ ai: 'not json at all' });
  assert(/AI answer was not JSON/.test(junk.report.Error));
  return '"12 new leads", "40%", "Twenty", "₹ 40000", "30 extra": every such line dropped (5), the rest kept; AI down or not JSON: the report is saved from the numbers alone, the reason in Run_Log';
});
check('W9.8', 'owner copy through W12 (optional, once a week)', () => {
  const off = w9();
  const g = W9X.g;
  assert.strictEqual(off.meta.calls.length, 0);
  const x = w9({ settings: { weekly_report_whatsapp: 'on' } });
  onlyW12(x);
  assert.deepStrictEqual(x.meta.calls.map((c) => [c.body.to, c.body.template.name, c.body.template.components[0].parameters[1].text]), [[OWNER.slice(1), 'weekly_owner_report', '05 Oct 2026 to 11 Oct 2026']]);
  const again = tick('W9 – Monday 09:00', { g: x.g, now: MON + 3600000, openrouter: fakeReportAi(GOOD_AI) });
  assert.deepStrictEqual([again.meta.calls.length, logs(x.g, 'W9-weekly-report').filter((l) => /^owner WhatsApp/.test(l.Record)).map((l) => l.Outcome)], [0, ['ok']]);
  const writes = x.g.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.table}`);
  assert(writes.every((t) => t === 'POST Run_Log' || t === 'POST Messages' || t === 'POST Conversations') && !g.calls.some((c) => c.method === 'PATCH'));
  return 'weekly_report_whatsapp = on: headline + first action as template weekly_owner_report to owner_phone via W12; a re-run does not send it again; W9 writes only Run_Log (no CRM row is changed)';
});

// ================================================================ W10 staff reply from the Grist inbox
const STAFF = (over = {}) => ({ id: 50, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, Dr Mehta can see you today at 5 pm.', Sent_By: 'Ravi (front desk)', Send: true, Created_At: T - 60, ...over } });
const CONV = (over = {}) => ({ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 2 * HOUR, Unread: 1, Automation_Paused: false, ...over } });
const w10 = (o = {}) => tick('W10 – Every minute', { crm: { convs: [CONV(o.conv)], msgs: [...F.messageRows(), STAFF(o.row)], leads: o.leads, settings: o.settings }, ...o });
const row50 = (g) => rows(g, 'Messages').find((m) => m.id === 50);
const W10X = w10();
check('W10.1', 'staff creates a reply -> it is sent', () => {
  assert.deepStrictEqual(W10X.errors, []);
  assert.deepStrictEqual(W10X.meta.calls.map((c) => [c.body.to, c.body.type, c.body.text.body]), [[P_ASHA, 'text', 'Hi Asha, Dr Mehta can see you today at 5 pm.']]);
  return 'the ticked row goes out word for word as a WhatsApp message (inside the 24 h window)';
});
check('W10.2', 'successful send marked correctly', () => {
  const r = row50(W10X.g);
  assert.deepStrictEqual([r.Status, r.WA_Message_ID, r.Send, r.AI_Reason, r.Sent_By, r.Created_At], ['sent', 'wamid.SENT.1', false, '', 'Ravi (front desk)', T - 60]);
  assert.deepStrictEqual([rows(W10X.g, 'Conversations')[0].Unread, rows(W10X.g, 'Messages').length, logs(W10X.g, 'W10-staff-reply').map((l) => [l.Record, l.Outcome])], [0, 4, [['message 50 (staff reply) wamid.SENT.1', 'ok']]]);
  return 'row: Status sent, WA_Message_ID, Send unticked; conversation Unread 0; Run_Log ok; no second inbox row';
});
check('W10.3', 'duplicate send blocked', () => {
  const again = tick('W10 – Every minute', { g: W10X.g });
  const retick = w10({ row: { Send: true, Status: 'sent', WA_Message_ID: 'wamid.EARLIER' } });
  assert.deepStrictEqual([again.meta.calls.length, retick.meta.calls.length, row50(retick.g).Send, row50(retick.g).WA_Message_ID], [0, 0, false, 'wamid.EARLIER']);
  const claimFails = w10({ g: crm({ convs: [CONV()], msgs: [...F.messageRows(), STAFF()] }).failAt('PATCH', 'Messages', 1) });
  assert.deepStrictEqual([claimFails.meta.calls.length, claimFails.r.error.node], [0, 'W10 – Claim row']);
  return 'next minute: nothing (Send unticked by the claim); Send ticked again on a sent row: not resent, unticked; claim write fails: nothing sent (W11 alerts)';
});
check('W10.4', 'invalid recipient blocked', () => {
  const x = w10({ conv: { Phone: '12345' }, leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Phone: '12345' } } : l)) });
  const r = row50(x.g);
  assert.deepStrictEqual([x.meta.calls.length, r.Status, r.Send, r.AI_Reason, logs(x.g, 'W10-staff-reply')[0].Outcome], [0, 'failed', false, 'the conversation has no valid patient phone number', 'failed']);
  const old = w10({ conv: { Last_Inbound_At: T - 30 * HOUR } });
  const noConv = w10({ row: { Conversation: 0 } });
  const empty = w10({ row: { Body: '  ' } });
  assert.deepStrictEqual([old.meta.calls.length, row50(old.g).Status, noConv.meta.calls.length, row50(noConv.g).Status, empty.meta.calls.length], [0, 'needs_template', 0, 'failed', 0]);
  return 'bad phone: not sent, Status failed + reason, Send unticked, Run_Log failed; last patient message 30 h ago: needs_template (WhatsApp rule); no conversation / empty body: failed';
});
check('W10.5', 'opt-out blocked', () => {
  const x = w10({ leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l)) });
  assert.deepStrictEqual([x.meta.calls.length, row50(x.g).Status, /opted out/.test(row50(x.g).AI_Reason)], [0, 'failed', true]);
  return 'Opted_Out: not sent, the reason on the row';
});
check('W10.6', 'human ownership preserved', () => {
  const x = w10({ conv: { Needs_Human: true, Assigned_To: 'Ravi', Automation_Paused: true, Handoff_Reason: 'HIGH · wants a call' } });
  const c = rows(x.g, 'Conversations')[0];
  assert.deepStrictEqual([x.meta.calls.length, c.Needs_Human, c.Assigned_To, c.Automation_Paused, c.Handoff_Reason], [1, true, 'Ravi', true, 'HIGH · wants a call']);
  // the patient answers 10 minutes later: W13 does not answer over the staff member
  const now = F.NOW + 10 * MIN * 1000;
  const y = run('W2 – Webhook Inbound', [{ json: { headers: {}, params: {}, query: {}, body: metaBody(P_ASHA, 'wamid.AFTER.STAFF', 'Ok thanks, what time exactly?', F.sec(now) - 5) } }], { g: W10X.g, now });
  const last = rows(W10X.g, 'Messages').filter((m) => m.Direction === 'In').pop();
  assert.deepStrictEqual([y.claude.calls.length, y.meta.calls.length, last.AI_Status, /staff member is talking/.test(last.AI_Reason)], [0, 0, 'skipped', true]);
  return 'staff reply sent while Needs_Human / Assigned_To / Automation_Paused are set; none of them changed; the patient\'s next message is left to staff (W13: no AI call, no reply for 24 h after a staff message)';
});
check('W10.7', 'WhatsApp sent through W12 only', () => {
  onlyW12(W10X);
  const meta = w.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  assert.deepStrictEqual(meta, ['W12 – Prepare request', 'W12 – Read reply']);
  assert(W10X.w12.length === 1 && W10X.r.visited.includes("W10 – Call 'W12 - WhatsApp send'"));
  return 'the one Meta call came from a W12 run started by W10 – Call \'W12 - WhatsApp send\'; only W12 nodes know the Meta URL';
});
check('W10.8', 'send failure logged', () => {
  const x = w10({ metaAnswer: () => ({ status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } }) });
  const r = row50(x.g);
  assert.deepStrictEqual([x.errors, r.Status, r.WA_Message_ID, r.Send, /131026/.test(r.AI_Reason)], [[], 'failed', '', false, true]);
  assert(/131026/.test(logs(x.g, 'W10-staff-reply')[0].Error) && logs(x.g, 'W10-staff-reply')[0].Outcome === 'failed');
  assert.strictEqual(tick('W10 – Every minute', { g: x.g, meta: x.meta }).meta.calls.length, 1);   // not retried by itself
  const window = w10({ metaAnswer: () => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }) });
  assert.strictEqual(row50(window.g).Status, 'needs_template');
  return 'Meta refused: row Status failed + Meta\'s reason, no WA id, Send unticked (no retry loop), Run_Log failed; WhatsApp 24 h refusal: needs_template';
});
check('W10.9', 'quiet hours and TEST_MODE', () => {
  const g = crm({ convs: [CONV({ Last_Inbound_At: F.sec(Date.parse('2026-10-06T21:00:00+05:30')) })], msgs: [...F.messageRows(), STAFF()] });
  const x = tick('W10 – Every minute', { g, now: Date.parse('2026-10-06T22:00:00+05:30') });
  const held = row50(g);
  const y = tick('W10 – Every minute', { g, now: Date.parse('2026-10-07T08:01:00+05:30') });
  assert.deepStrictEqual([x.meta.calls.length, held.Send, /quiet hours/.test(held.AI_Reason), y.meta.calls.length, row50(g).Status], [0, true, true, 1, 'sent']);
  const t = w10({ settings: { TEST_MODE: 'true' } });
  assert.deepStrictEqual([t.meta.calls.map((c) => c.body.to), row50(t.g).AI_Reason], [[TESTP.slice(1)], `TEST_MODE: sent to ${TESTP}`]);
  return '22:00: waits (Send stays ticked, note on the row), 08:01: sent; TEST_MODE: to TEST_PHONE, noted on the row';
});

// ================================================================ cross-cutting
check('X.1', 'a failure is visible and never sends twice', () => {
  const saved = COLUMNS.Appointments;
  COLUMNS.Appointments = saved.filter((c) => c !== 'Outcome_Sent');
  let x;
  try { x = w7(); } finally { COLUMNS.Appointments = saved; }
  assert.deepStrictEqual([x.meta.calls.length, x.r.error.node], [0, 'W7 – Claim Outcome_Sent']);
  const alert = run('W11 – Error Trigger', [{ json: { execution: { id: '77', url: 'https://n8n.example/x/executions/77', error: { message: x.r.error.message }, lastNodeExecuted: x.r.error.node, mode: 'trigger' }, workflow: { id: 'MASTER', name: w.name } } }]);
  assert(alert.r.telegram.length === 1 && alert.r.telegram[0].text.includes('Step: W7 – Claim Outcome_Sent'));
  const w8fail = w8({ g: crm({ appts: W8_APPTS() }).failAt('PATCH', 'Appointments', 1) });
  assert.deepStrictEqual([w8fail.meta.calls.length, w8fail.r.error.node], [0, 'W8 – Claim Review_Sent']);
  return 'Outcome_Sent column missing: the claim fails, nothing is sent, the run stops and W11 alerts with the step name; same for W8 (Review_Sent)';
});
check('X.2', 'every clinic from the Agency Registry, separately', () => {
  const docB = { Settings: F.settingsRows({ ...ON, clinic_name: 'Second Physio' }), LEADS: [{ id: 1, fields: { Lead_id: 'L-B-1', Name: 'Bina Shah', Phone: '+919000000012', Status: 'Booked' } }], Conversations: [], Messages: [], Run_Log: [],
    Appointments: [{ id: 1, fields: { Booking_UID: 'cal-b-1', Lead: 1, Service: 'Back pain physiotherapy', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'Completed' } }] };
  const x = w7({ crm: { appts: W7_APPTS(), docB } });
  assert.deepStrictEqual(x.meta.calls.map((c) => [c.url.split('/')[4], c.body.to, c.body.template.components[0].parameters[1].text]).sort(), [[PNID, P_ASHA, 'Demo Physio'], [PNID2, '919000000012', 'Second Physio']]);
  assert.deepStrictEqual([rows(x.g, 'Appointments', 'DOCB')[0].Outcome_Sent, logs(x.g, 'W7-outcome-nudge', 'DOCB').length], [T, 1]);
  return 'two active clinics: each patient gets the message from their own clinic\'s WhatsApp number, flags and logs in their own doc; the inactive clinic is skipped';
});
check('X.3', 'AI use: W7 / W8 / W10 none, W9 one call per clinic', () => {
  const xs = [w7(), w8(), W10X];
  assert(xs.every((x) => x.claude.calls.length === 0));
  const ai = w.nodes.filter((n) => /openrouter\.ai/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  assert.deepStrictEqual(ai, ['W13 – Ask Model', 'W9 – Ask Model']);
  const ask = w.nodes.find((n) => n.name === 'W9 – Ask Model');
  const w13 = w.nodes.find((n) => n.name === 'W13 – Ask Model');
  assert.deepStrictEqual([ask.credentials, ask.parameters.options.allowUnauthorizedCerts], [w13.credentials, undefined]);
  return 'W7 / W8 / W10 runs: 0 model calls (W7 answers are read by the existing W13 call); W9: one call with the same OpenRouter credential, TLS checked';
});
check('X.4', 'real connections', () => {
  throw new Error('NOT RUN: this sandbox cannot reach your n8n, Grist or Meta, and the export holds only credential references; run the README checklist in your n8n');
});

// ---------------------------------------------------------------- report
const width = Math.max(...results.map((r) => `${r.id} ${r.title}`.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${`${r.id} ${r.title}`.padEnd(width)}  ${r.why}`);
const expected = new Set(['X.4']);
const bad = results.filter((r) => !r.ok && !expected.has(r.id));
const known = results.filter((r) => !r.ok && expected.has(r.id));
console.log(`\n${results.length - bad.length - known.length} PASS, ${known.length} known FAIL (reported: needs your n8n), ${bad.length} unexpected FAIL`);
if (process.env.W7W10_REPORT) fs.writeFileSync(process.env.W7W10_REPORT, JSON.stringify(results, null, 2));
if (bad.length) process.exit(1);
console.log(`W7-W10 TEST: ${results.length} checks run on ${path.basename(FILE)}`);
