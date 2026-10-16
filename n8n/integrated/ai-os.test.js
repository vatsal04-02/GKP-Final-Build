// End-to-end tests of the AI OS improvements (A1-A6) on your patched workflow (ai-workflow-clinic.ai-os.json), next to the
// ORIGINAL export (source/ai-workflow-clinic.export.redacted.json) wherever the behaviour is meant to change, so each
// difference is proven to come from A1-A6 and nothing else. Fake Grist, fake Meta, fake OpenRouter; made-up numbers only.
// Run: node n8n/integrated/ai-os.test.js      (AI_OS_FILE / AI_OS_ORIG = other files, e.g. your private pair)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.AI_OS_FILE || path.join(__dirname, 'ai-workflow-clinic.ai-os.json');
const ORIG_FILE = process.env.AI_OS_ORIG || path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (m) => console.log(`  ok  ${m}`);
const suite = [];
const test = (name, fn) => suite.push({ name, fn });

// ---------------------------------------------------------------- the live CRM naming (LEADS / Lead_id), W2's "Received"
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

// ---------------------------------------------------------------- both workflows, filled in as after import (fake values)
const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const prepare = (file) => {
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  set('W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,${OWNER},${TESTP}`);
  set('W2 – Verify Config', 'meta_verify_token', 'test-verify-token-123');
  return w;
};
const NEW = prepare(FILE);
const OLD = prepare(ORIG_FILE);
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
const metaBody = (from, id, text, { ts = F.sec(F.NOW) - 5 } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
    contacts: [{ profile: { name: 'Asha Patel' }, wa_id: from }],
    messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }],
  } }] }],
});
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
let seq = 0;
function post(text, o = {}) {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const body = metaBody(P_ASHA, o.id || `wamid.IN.T${++seq}`, text, o);
  const r = simulate(o.w || NEW, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body } }], grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude) });
  const runs = allRuns(r);
  for (const run of runs) assert.strictEqual(run.error, null, `${run.visited[0]}: ${JSON.stringify(run.error)}`);
  const sends = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
  return { g, meta, claude, r, runs, sends };
}
const schedule = (start, g, o = {}) => {
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const r = simulate(o.w || NEW, { start, items: [{ json: {} }], grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(o.claude || F.fakeClaude()) });
  for (const run of allRuns(r)) assert.strictEqual(run.error, null, `${run.visited[0]}: ${JSON.stringify(run.error)}`);
  return { r, meta, g };
};
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const lastIn = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'In').pop();
const conv = (g) => rows(g, 'Conversations').find((c) => c.Phone === F.ASHA);
const lead = (g) => rows(g, 'LEADS').find((l) => l.Phone === F.ASHA);
const logs = (g, w) => rows(g, 'Run_Log').filter((l) => l.Workflow === w);
const alertOf = (meta) => meta.calls.map((c) => c.body).find((b) => b.type === 'template' && b.template.name === 'human_handoff_alert');
const alertReason = (meta) => { const a = alertOf(meta); return a ? a.template.components[0].parameters[3].text : null; };
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';
const decide = (over) => (req) => ({ ...F.fakeDecide(req), ...over });
const onlyW12Sends = (x) => assert.strictEqual(x.meta.calls.length, x.sends.length, 'every Meta call came from its own W12 run');

console.log(`AI OS (A1-A6): ${path.basename(FILE)}   (original: ${path.basename(ORIG_FILE)})`);

// ================================================================ A3 triage + emergency gate
test('A3 emergency "severe chest pain": no AI call; holding reply + URGENT human_handoff_alert, both via W12; Needs_Human; Escalated (the original asked the AI)', () => {
  const x = post('I have severe chest pain since morning, please help');
  onlyW12Sends(x);
  assert.strictEqual(x.claude.calls.length, 0, 'decided before any AI call');
  assert.deepStrictEqual(x.meta.calls.map((c) => c.body.to), [P_ASHA, OWNER.slice(1)]);
  assert.strictEqual(x.meta.calls[0].body.text.body, HOLD, 'the patient reply wording is unchanged');
  assert(alertReason(x.meta).startsWith('URGENT · Possible emergency ("chest pain")'), alertReason(x.meta));
  const m = lastIn(x.g);
  assert.deepStrictEqual([m.AI_Status, m.AI_Action, m.Needs_Human], ['handed_off', 'handoff', true]);
  assert(m.AI_Reason.startsWith('[urgent · emergency] URGENT · Possible emergency'), m.AI_Reason);
  assert.deepStrictEqual([conv(x.g).Needs_Human, conv(x.g).Handoff_Reason.slice(0, 8), lead(x.g).Escalated], [true, 'URGENT ·', true]);
  assert(/-> handoff \(handed_off\) \| gate=handoff$/.test(logs(x.g, 'W13-ai-receptionist')[0].Record));
  const y = post('I have severe chest pain since morning, please help', { w: OLD });
  assert.strictEqual(y.claude.calls.length, 1, 'original: the AI decided');
  for (const t of ['Papa behosh ho gaye, kya karein?', 'मुझे सीने में दर्द हो रहा है']) {
    const z = post(t);
    assert.deepStrictEqual([z.claude.calls.length, lastIn(z.g).AI_Status], [0, 'handed_off'], t);
    assert(alertReason(z.meta).startsWith('URGENT · '), t);
  }
  const p = post('Do you treat post stroke paralysis? My father had a fracture too.');
  assert.strictEqual(p.claude.calls.length, 1, 'stroke / fracture are physio topics, not emergencies: the AI decides');
});
test('A3 emergency at 22:00: nothing sent at night (W12 quiet hours unchanged), deferred; the 08:05 run sends the URGENT alert', () => {
  const night = Date.parse('2026-10-06T22:00:00+05:30');
  const x = post('He collapsed and is unconscious', { now: night, ts: F.sec(night) });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, lastIn(x.g).AI_Status], [0, 0, 'deferred']);
  assert.strictEqual(lead(x.g).Escalated, undefined, 'not escalated until the alert is delivered');
  const morning = schedule('W13 – Every Morning', x.g, { now: Date.parse('2026-10-07T08:05:00+05:30'), meta: x.meta, claude: x.claude });
  assert.deepStrictEqual([x.claude.calls.length, morning.meta.calls.length, lastIn(x.g).AI_Status, lead(x.g).Escalated], [0, 2, 'handed_off', true]);
  assert(alertReason(x.meta).startsWith('URGENT · Possible emergency'));
});
test('A3 complaint: HIGH alert with the AI\'s staff note; a risk flag forces a hand-off; links / numbers never reach the alert', () => {
  const complaint = { intent: 'complaint', action: 'handoff', needs_human: true, sentiment: 'negative', handoff_reason: 'complaint about therapist', reply: '', priority: 'high', risk_flags: ['complaint'], staff_note: 'Unhappy with yesterday\'s session, wants a call back. Suggest: call today.' };
  let x = post('The therapist was rude yesterday, very unhappy', { ai: decide(complaint) });
  onlyW12Sends(x);
  assert.strictEqual(alertReason(x.meta), 'HIGH · Unhappy with yesterday\'s session, wants a call back. Suggest: call today.');
  assert(lastIn(x.g).AI_Reason.startsWith('[high · complaint] HIGH · ') && lastIn(x.g).AI_Reason.includes('hand-off: complaint about therapist'));
  x = post('How much does this cost?', { ai: decide({ risk_flags: ['payment'], staff_note: 'Asked prices; earlier refund dispute.' }) });
  assert.deepStrictEqual([x.meta.calls[0].body.text.body, lastIn(x.g).AI_Status, alertReason(x.meta)], [HOLD, 'handed_off', 'Asked prices; earlier refund dispute.']);
  x = post('The therapist was rude', { ai: decide({ ...complaint, staff_note: 'Call him on +91 98765 43210 or https://evil.example/x' }) });
  assert.strictEqual(alertReason(x.meta), 'HIGH · Call him on [number] or [link]');
});
test('A3/A6 Escalated only when the hand-off alert was delivered: a failed alert leaves it off and W3 still escalates (safety net)', () => {
  const leadNew = [{ id: 9, fields: { Lead_id: 'L-9', Created_At: F.sec(F.NOW) - 40 * 60, Name: 'Asha Patel', Phone: F.ASHA, Source: 'WhatsApp', Status: 'New' } }];
  const convNew = [{ id: 1, fields: { Lead: 9, Phone: F.ASHA, Last_Inbound_At: F.sec(F.NOW) - 40 * 60, Unread: 0, Automation_Paused: false } }];
  const refuseTemplate = (body) => (body.type === 'template' ? { status: 400, body: { error: { code: 132001, message: 'Template name does not exist' } } } : null);
  let x = post('Do you accept the XYZ health insurance card?', { crm: { leads: leadNew, convs: convNew, appts: [] }, metaAnswer: refuseTemplate });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, conv(x.g).Needs_Human, lead(x.g).Escalated], ['handed_off', true, undefined]);
  let w3 = schedule('W3 – Every 10 minutes', x.g, { now: F.NOW + 60000 });
  assert.deepStrictEqual([w3.meta.calls.length, lead(x.g).Escalated], [1, true], 'W3 alerted staff instead');
  x = post('Do you accept the XYZ health insurance card?', { crm: { leads: leadNew, convs: convNew, appts: [] } });
  assert.strictEqual(lead(x.g).Escalated, true);
  w3 = schedule('W3 – Every 10 minutes', x.g, { now: F.NOW + 60000 });
  assert.strictEqual(w3.meta.calls.length, 0, 'staff were already alerted by the AI: no second alert');
});

// ================================================================ A4 confidence tiers
test('A4 tiers: 0.62 person; 0.68 price answer sent (original: person); 0.72 booking -> person (original: link sent); 0.82 booking -> link', () => {
  let x = post('How much does this cost?', { ai: decide({ confidence: 0.62 }) });
  assert.deepStrictEqual([x.meta.calls[0].body.text.body, lastIn(x.g).AI_Reason], [HOLD, 'low confidence (0.62)']);
  x = post('How much does this cost?', { ai: decide({ confidence: 0.68 }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, x.meta.calls.length], ['replied', 1]);
  x = post('How much does this cost?', { ai: decide({ confidence: 0.68 }), w: OLD });
  assert.strictEqual(lastIn(x.g).AI_Status, 'handed_off', 'original: 0.68 < 0.7');
  x = post('Book me for Saturday at 5.', { ai: decide({ confidence: 0.72 }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, x.meta.calls[0].body.text.body], ['handed_off', HOLD]);
  assert(lastIn(x.g).AI_Reason.startsWith('confidence 0.72 is below 0.8 for book_slot'));
  x = post('Book me for Saturday at 5.', { ai: decide({ confidence: 0.72 }), w: OLD });
  assert.strictEqual(lastIn(x.g).AI_Action, 'book_slot', 'original: booked with 0.72');
  x = post('Book me for Saturday at 5.', { ai: decide({ confidence: 0.82 }) });
  assert(/cal\.com\/demo-physio\/assessment\?date=2026-10-10/.test(x.meta.calls[0].body.text.body));
});
test('A4 writes need 0.85: direct booking at 0.84 -> person, no Appointments row; at 0.86 -> booked; negative mood -> informational only', () => {
  const direct = { settings: { booking_mode: 'direct' } };
  let x = post('Book me for Saturday at 5.', { crm: direct, ai: decide({ confidence: 0.84 }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, rows(x.g, 'Appointments').length, lead(x.g).Status], ['handed_off', 4, 'Contacted']);
  assert(lastIn(x.g).AI_Reason.startsWith('confidence 0.84 is below 0.85 for an appointment change'));
  x = post('Book me for Saturday at 5.', { crm: direct, ai: decide({ confidence: 0.86 }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, rows(x.g, 'Appointments').length, lead(x.g).Status], ['replied', 5, 'Booked']);
  x = post('Book me for Saturday at 5.', { ai: decide({ sentiment: 'negative' }) });
  assert.deepStrictEqual([lastIn(x.g).AI_Status, lastIn(x.g).AI_Reason], ['handed_off', 'negative sentiment (book_appointment)']);
  x = post('How much does this cost?', { ai: decide({ sentiment: 'negative' }) });
  assert.strictEqual(lastIn(x.g).AI_Status, 'replied');
});

// ================================================================ A1 no_reply rule (same behaviour as the live edit)
test('A1 no_reply: a question the AI wants to ignore goes to a person (as the live edit did); "thanks" stays silent', () => {
  for (const w of [NEW, OLD]) {
    let x = post('How much does this cost?', { w, ai: decide({ action: 'no_reply', reply: '' }) });
    assert.deepStrictEqual([lastIn(x.g).AI_Status, x.meta.calls[0].body.text.body], ['handed_off', HOLD]);
    assert(lastIn(x.g).AI_Reason.includes('AI selected no_reply for pricing; a response is required'));
    x = post('Thanks', { w });
    assert.deepStrictEqual([lastIn(x.g).AI_Status, x.meta.calls.length], ['no_reply', 0]);
  }
});

// ================================================================ A2 decision trace
test('A2 trace: Run_Log Record = gate, model, latency, tokens; an unusable AI answer is marked "fallback"; only existing columns', () => {
  let x = post('How much does this cost?');
  assert(/ -> reply \(replied\) \| gate=ai openai\/gpt-4o-mini \d+ms tok 1000\/200$/.test(logs(x.g, 'W13-ai-receptionist')[0].Record), logs(x.g, 'W13-ai-receptionist')[0].Record);
  assert.strictEqual(lastIn(x.g).AI_Reason, '');
  x = post('How much does this cost?', { ai: () => ({ throw: 'timeout of 45000ms exceeded' }) });
  assert(lastIn(x.g).AI_Reason.startsWith('fallback: '), lastIn(x.g).AI_Reason);
  assert(/\| gate=ai openai\/gpt-4o-mini \d+ms fallback$/.test(logs(x.g, 'W13-ai-receptionist')[0].Record));
  x = post('STOP');
  assert(logs(x.g, 'W13-ai-receptionist')[0].Record.endsWith('-> opt_out (opted_out) | gate=opt_out'));
  const y = post('How much does this cost?', { w: OLD });
  assert(!logs(y.g, 'W13-ai-receptionist')[0].Record.includes('gate='), 'original: no trace');
});

// ================================================================ A5 W6 follow-up gating
const DAYS3 = F.sec(F.NOW) - 3 * 86400;
const w6Leads = () => [
  [11, 'legacy (no AI fields)', {}], [12, 'Needs_Human', {}], [13, 'cold', { Lead_Stage: 'cold' }], [14, 'not interested', {}],
  [15, 'call-back planned', { Next_Action_At: F.sec(F.NOW) + 2 * 86400 }], [16, 'wrote 10 h ago', {}],
  [17, 'warm, wrote 3 days ago', { Lead_Stage: 'warm' }], [18, 'call-back date passed', { Next_Action_At: F.sec(F.NOW) - 86400 }],
].map(([id, name, f]) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: DAYS3, Name: name, Phone: `+9190000000${id + 20}`, Source: 'WhatsApp', Status: 'Contacted', ...f } }));
const w6Convs = () => [
  [12, { Needs_Human: true }], [14, { Last_Intent: 'not_interested' }], [16, { Last_Inbound_At: F.sec(F.NOW) - 10 * 3600 }],
  [17, { Last_Inbound_At: DAYS3, Last_Intent: 'pricing' }],
].map(([leadId, f], i) => ({ id: i + 1, fields: { Lead: leadId, Phone: `+9190000000${leadId + 20}`, Automation_Paused: false, ...f } }));
const noShowYesterday = () => [{ id: 1, fields: { Booking_UID: 'cal-ns-12', Lead: 12, Service: 'First assessment', Start: F.sec(F.NOW) - 86400, Status: 'No-show' } }];
const w6 = (w) => {
  const g = crm({ settings: { TEST_MODE: 'true' }, leads: w6Leads(), convs: w6Convs(), msgs: [], appts: noShowYesterday() });
  const x = schedule('W6 – Daily 10:00', g, { w });
  const followed = rows(g, 'LEADS').filter((l) => l.Followup_Sent).map((l) => l.id);
  const kinds = (x.r.runData['W6 – Plan follow-ups'] || []).map((i) => i.json.kind);   // the template names are W6's own (unchanged)
  return { g, x, followed, kinds };
};
test('A5 W6 day-2 follow-up: skips Needs_Human / cold / not interested / call-back planned / wrote in 48 h; legacy leads as before; rebook unchanged', () => {
  const after = w6(NEW);
  assert.deepStrictEqual(after.followed, [11, 17, 18]);
  assert.deepStrictEqual([after.kinds.sort(), after.x.meta.calls.length], [['followup', 'followup', 'followup', 'rebook'], 4]);
  assert.strictEqual(rows(after.g, 'Appointments')[0].Rebook_Sent !== undefined, true, 'no-show rebook for the Needs_Human lead: unchanged');
  const before = w6(OLD);
  assert.deepStrictEqual(before.followed, [11, 12, 13, 14, 15, 16, 17, 18], 'original: every open lead got it');
  assert.deepStrictEqual(before.kinds.filter((k) => k === 'rebook').length, 1);
  const names = (r) => [...new Set(r.x.meta.calls.map((c) => c.body.template.name))].sort();
  assert.deepStrictEqual(names(after), names(before), 'the same templates as before');
  assert(after.x.meta.calls.every((c) => c.body.to === TESTP.slice(1)), 'TEST_MODE still applies');
});
test('A5 W6 with no AI data at all (no conversations, no stages): exactly the original\'s sends', () => {
  const leads = () => w6Leads().map((l) => ({ id: l.id, fields: { ...l.fields, Lead_Stage: undefined, Next_Action_At: undefined } })).map((l) => { for (const k of Object.keys(l.fields)) if (l.fields[k] === undefined) delete l.fields[k]; return l; });
  const run = (w) => { const g = crm({ settings: { TEST_MODE: 'true' }, leads: leads(), convs: [], msgs: [], appts: [] }); const x = schedule('W6 – Daily 10:00', g, { w }); return [x.meta.calls.length, rows(g, 'LEADS').map((l) => !!l.Followup_Sent)]; };
  assert.deepStrictEqual(run(NEW), run(OLD));
});

// ================================================================ A6 W3 escalation
const ago = (min) => F.sec(F.NOW) - min * 60;
const w3Leads = () => [
  [21, 50, { Lead_Stage: 'cold' }], [22, 48, {}], [23, 41, { Lead_Stage: 'hot', AI_Summary: 'Wants a knee assessment\ntomorrow evening.' }],
  [24, 45, { Lead_Stage: 'warm', AI_Summary: 'Asked about back pain prices.' }], [25, 47, {}], [26, 46, {}], [27, 43, { Escalated: true }], [28, 44, {}],
].map(([id, min, f]) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: ago(min), Name: `Lead ${id}`, Phone: `+9190000000${id + 20}`, Source: 'WhatsApp', Status: 'New', Enquiry: 'back pain', ...f } }));
const w3Convs = () => [
  [25, { Automation_Paused: true }], [26, { Assigned_To: 'Dr. Mehta' }], [27, { Needs_Human: true }], [28, { Needs_Human: true }],
].map(([leadId, f], i) => ({ id: i + 1, fields: { Lead: leadId, Phone: `+9190000000${leadId + 20}`, Automation_Paused: false, ...f } }));
const w3 = (w, g = crm({ settings: { TEST_MODE: 'true' }, leads: w3Leads(), convs: w3Convs(), msgs: [], appts: [] })) => {
  const x = schedule('W3 – Every 10 minutes', g, { w });
  const back = x.r.runData["W3 – Call 'W12 - WhatsApp send'"] || [];
  return { g, x, order: back.map((b) => b.json.lead_row_id), built: x.r.runData['W3 – Build Message'] || [] };
};
test('A6 W3: hot -> warm / unknown -> cold; owned conversations (paused, assigned) skipped; AI hand-offs skipped via Escalated; failed alert still escalated', () => {
  const after = w3(NEW);
  assert.deepStrictEqual(after.order, [23, 22, 24, 28, 21]);
  assert.deepStrictEqual(rows(after.g, 'LEADS').filter((l) => l.Escalated).map((l) => l.id).sort(), [21, 22, 23, 24, 27, 28]);
  assert(after.x.meta.calls.every((c) => c.body.template.name === 'hello_world' && c.body.to === TESTP.slice(1)), 'template and TEST_MODE unchanged');
  const before = w3(OLD);
  assert.deepStrictEqual(before.order, [21, 22, 25, 26, 24, 28, 23], 'original: oldest first, nobody skipped');
});
test('A6 W3 message: AI_Summary (else Enquiry) and the stage in the existing staff message; one line; template params keep their keys', () => {
  const after = w3(NEW);
  const m = Object.fromEntries(after.built.map((b) => [b.json.lead_row_id, b.json]));
  assert.strictEqual(m[23].message_text, 'New lead [hot]: Lead 23 (+919000000043) has submitted an enquiry for Demo Physio. Wants a knee assessment tomorrow evening.');
  assert.deepStrictEqual(Object.keys(m[23].template_params), ['clinic_name', 'lead_name', 'lead_phone', 'enquiry']);
  assert.deepStrictEqual([m[23].template_params.enquiry, m[24].template_params.enquiry, m[22].template_params.enquiry], ['Wants a knee assessment tomorrow evening.', 'Asked about back pain prices.', 'back pain']);
  assert.strictEqual(m[22].message_text, 'New lead: Lead 22 (+919000000042) has submitted an enquiry for Demo Physio. back pain');
});
test('A6 W3 when Conversations cannot be read: nothing is skipped (escalation as before, by stage), no error', () => {
  const g = crm({ settings: { TEST_MODE: 'true' }, leads: w3Leads(), convs: w3Convs(), msgs: [], appts: [] }).failAt('GET', 'Conversations', 1);
  const after = w3(NEW, g);
  assert.deepStrictEqual(after.order, [23, 22, 25, 26, 24, 28, 21]);
});
test('A6 W3 with no AI data (no stages, no conversations): same leads, same order as the original', () => {
  const plain = () => crm({ settings: { TEST_MODE: 'true' }, leads: w3Leads().map((l) => ({ id: l.id, fields: { ...l.fields, Lead_Stage: '', AI_Summary: '' } })), convs: [], msgs: [], appts: [] });
  assert.deepStrictEqual(w3(NEW, plain()).order, w3(OLD, plain()).order);
});

// ================================================================ run, then switch each new rule off once (the suite must notice)
const runSuite = (quiet) => {
  const failed = [];
  for (const t of suite) {
    try { t.fn(); if (!quiet) ok(t.name); } catch (e) { failed.push(t.name); if (!quiet) console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').slice(0, 6).join('\n       ')}`); }
  }
  return failed;
};
const failures = runSuite(false);
if (failures.length) { console.log(`\n${failures.length} of ${suite.length} FAILED`); process.exit(1); }

if (!process.env.AI_OS_NO_MUTATIONS) {
  console.log('\nmutations (each new rule switched off once: the suite must fail)');
  const BASE = clone(NEW);
  const node = (w, n) => w.nodes.find((x) => x.name === n);
  const code = (w, names, from, to) => { for (const n of [].concat(names)) { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: ${from}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); } };
  const LIB_NODES = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
  const mutations = {
    'A3 emergency gate off': (w) => code(w, LIB_NODES, 'const emergency = aiEmergencyIn(c.text);', "const emergency = '';"),
    'A3 risk flags ignored': (w) => code(w, LIB_NODES, 'if (plan.triage.flags.length)', 'if (false)'),
    'A3 staff note not sanitised': (w) => code(w, LIB_NODES, ".replace(/\\+?\\d[\\d\\s-]{7,}\\d/g, '[number]')", ''),
    'A3 Escalated set even when the alert failed': (w) => code(w, LIB_NODES, "if (plan.route === 'handoff' && staff && staff.sent === true)", "if (plan.route === 'handoff')"),
    'A4 0.65-0.80 tier off': (w) => code(w, LIB_NODES, 'if (d.confidence < tAuto && !informational)', 'if (false)'),
    'A4 write threshold off': (w) => code(w, LIB_NODES, 'plan.action_writes.length && d.confidence < tWrite', 'false'),
    'A4 negative sentiment ignored': (w) => code(w, LIB_NODES, "if (d.sentiment === 'negative' && !informational)", 'if (false)'),
    'A2 trace not passed': (w) => code(w, 'W13 – Record Sends', 'Math.floor(Date.now() / 1000), trace)', 'Math.floor(Date.now() / 1000))'),
    'A5 hold off': (w) => code(w, 'W6 – Plan follow-ups', '&& !aiHold(r))', ')'),
    'A6 stage ordering off': (w) => code(w, 'W3 – Find due', 'stage(a.fields) - stage(b.fields) || ', ''),
    'A6 owned conversations not skipped': (w) => code(w, 'W3 – Find due', 'if (owned.has(String(r.id))) return false;', ''),
    'A6 W3 – Conversations error stops W3': (w) => { delete node(w, 'W3 – Conversations').onError; },
    'A6 summary not used': (w) => code(w, 'W3 – Build Message', 'enquiry: item.ai_summary || item.enquiry', 'enquiry: item.enquiry'),
  };
  let missed = 0;
  for (const [name, mutate] of Object.entries(mutations)) {
    const w = clone(BASE); mutate(w);
    Object.assign(NEW, w);
    const f = runSuite(true);
    if (f.length) console.log(`  caught  ${name}   <- ${f[0]}`); else { console.log(`  MISSED  ${name}`); missed++; }
  }
  Object.assign(NEW, BASE);
  if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
}
console.log(`\nAI OS: ${suite.length} end-to-end check groups pass`);
