// Run: node n8n/snippets/ai-receptionist-aios.test.js
// Unit tests for the AI OS improvements in the shared decision module (ai-receptionist.js):
//   A1 the live no_reply rule · A2 the decision trace · A3 hand-off triage + the emergency gate · A4 confidence tiers.
// The W3 / W6 parts (A5, A6) and the patched live workflow are tested in n8n/integrated/ai-os.test.js.
const assert = require('assert');
const ai = require('./ai-receptionist');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
// The thresholds of W13 – Config after A4.
const CFG = { model: 'openai/gpt-4o-mini', leads_table: 'LEADS', min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, staff_alert_template: 'human_handoff_alert' };
const CLINIC = { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' };
const ok = (m) => console.log(`  ok  ${m}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (rows) => ({ records: clone(rows) });

const NEW_MSG = (text) => ({ id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: 'wamid.NEW.4', Status: 'Received', Created_At: F.sec(F.NOW) - 10 } });
function raw(text, o = {}) {
  const msg = NEW_MSG(text);
  return {
    start: { message_row_id: 4, wa_message_id: 'wamid.NEW.4', msg_type: 'text', ...(o.start || {}) },
    clinic: CLINIC,
    settings: rec(F.settingsRows(o.settingsOver)),
    knowledge: rec(F.KNOWLEDGE),
    message: rec([msg]),
    conversation: rec(F.conversationRows().map((c) => ({ ...c, fields: { ...c.fields, ...(o.convFields || {}) } }))),
    lead: rec([F.leadRows()[0]]),
    history: rec([...F.messageRows(), msg]),
    appointments: rec(F.appointmentRows()),
  };
}
const ctx = (text, o = {}) => ai.aiContext(raw(text, o), { ...CFG, ...(o.cfg || {}) }, o.now || F.NOW, h);
// The decision the fake model gives for this message, edited by the test; then the plan W13 – Plan makes from it.
const planFor = (text, edit, o = {}) => {
  const { x, gate } = ctx(text, o);
  assert.strictEqual(gate.route, 'ai', `gate: ${gate.reason}`);
  const d0 = F.fakeDecide(ai.aiBuildRequest(x, CFG));
  const d = edit ? edit(d0) : d0;
  assert.deepStrictEqual(ai.aiValidateDecision(d), []);
  return { x, d, plan: ai.aiPlan(d, x, { ...CFG, ...(o.cfg || {}) }) };
};
const sent = (over = {}) => ({ sent: true, send_status: 'accepted', wa_message_id: 'wamid.REPLY', send_error: '', ...over });
const table = (writes, t) => writes.filter((w) => w.table === t).map((w) => w.body.records[0]);

// ================================================================ A3: schema + validation
console.log('A3 triage: schema and validation');
const S = ai.AI_DECISION_SCHEMA;
for (const f of ['priority', 'staff_note', 'risk_flags']) assert(S.required.includes(f), `${f} required`);
assert.deepStrictEqual(S.properties.priority.enum, ['urgent', 'high', 'normal']);
assert.deepStrictEqual(S.properties.risk_flags.items.enum, ['emergency', 'complaint', 'payment', 'medical', 'legal', 'abusive', 'sensitive']);
assert.strictEqual(S.additionalProperties, false);
const good = { ...F.BASE_DECISION, intent: 'pricing', reply: 'The first assessment costs ₹800.' };
assert.deepStrictEqual(ai.aiValidateDecision(good), []);
assert.deepStrictEqual(ai.aiValidateDecision({ ...good, priority: 'critical' }), ['bad priority']);
assert.deepStrictEqual(ai.aiValidateDecision({ ...good, staff_note: null }), ['staff_note is not text']);
assert.deepStrictEqual(ai.aiValidateDecision({ ...good, risk_flags: ['vip'] }), ['bad risk_flags']);
assert.deepStrictEqual(ai.aiValidateDecision({ ...good, risk_flags: 'complaint' }), ['bad risk_flags']);
const missing = { ...good };
delete missing.priority;
assert(ai.aiValidateDecision(missing).includes('bad priority'));
const req = ai.aiBuildRequest(ctx('How much does this cost?').x, CFG);
assert(req.system[0].text.includes('Triage (for the clinic staff)') && req.system[0].text.includes('staff_note'));
ok('priority / staff_note / risk_flags are required, strictly typed (closed enums), explained in the rules; a decision without them is invalid (-> hand-off)');

assert.strictEqual(ai.aiStaffNote('Call him on +91 98765 43210 or see https://evil.example/x now'), 'Call him on [number] or see [link] now');
assert.strictEqual(ai.aiStaffNote('x'.repeat(400)).length, 200);
assert.strictEqual(ai.aiStaffNote(null), '');
assert.strictEqual(ai.aiStaffNote('line one\nline two'), 'line one line two');
assert.deepStrictEqual(ai.aiTriage({ priority: 'bogus', risk_flags: ['complaint', 'complaint', 'vip'], staff_note: 'n' }), { priority: 'normal', flags: ['complaint'], note: 'n' });
ok('staff_note: no links or phone numbers, one line, at most 200 characters; unknown priority / flags are dropped');

// ================================================================ A3: deterministic emergency gate
console.log('A3 triage: emergency gate (before any AI call)');
const EMERGENCIES = ['I have severe chest pain since morning', 'My father collapsed and is unconscious', 'Mujhe saans lene mein dikkat, seene mein dard hai',
  'मुझे सीने में दर्द हो रहा है', 'I want to kill myself', 'He fainted after the exercise', 'This is an emergency please call', 'She cannot breathe properly'];
for (const t of EMERGENCIES) {
  const { x, gate } = ctx(t);
  assert.strictEqual(gate.route, 'handoff', t);
  assert.deepStrictEqual([gate.triage.priority, gate.triage.flags], ['urgent', ['emergency']], t);
  const plan = ai.aiGatePlan(gate, x, CFG);
  assert(plan.reason.startsWith('URGENT · Possible emergency'), plan.reason);
  assert.strictEqual(plan.reply, x.profile.handoff_reply);           // the patient gets the standard hand-off reply (wording unchanged)
  const items = ai.aiSendItems(plan, x, h);
  assert.deepStrictEqual(items.map((i) => i.w13_kind), ['patient_reply', 'staff_alert']);
  assert.strictEqual(items[1].template, 'human_handoff_alert');
  assert(items[1].template_params.reason.startsWith('URGENT · '));
  assert(!/\+?\d{10}/.test(items[1].template_params.reason));
}
for (const t of ['Do you treat post stroke paralysis?', 'I had a fracture last year, can I start physio?', 'Knee pain after an accident, need sessions',
  'How much does this cost?', 'Is the doctor available for an emergency appointment on Sunday?', 'My chest muscles are sore after the gym']) {
  assert.strictEqual(ai.aiEmergencyIn(t), '', t);
}
let c = ctx('I have chest pain', { convFields: { Needs_Human: true } });
assert.strictEqual(c.gate.route, 'skip');                             // existing gates first: a person already owns it
c = ctx('I have chest pain', { now: F.NOW - 14 * 3600 * 1000 });     // 21:00 IST: not deferred, handed off
assert.strictEqual(c.gate.route, 'handoff');
c = ctx('I have chest pain', { convFields: { Automation_Paused: true } });
assert.strictEqual(c.gate.route, 'skip');
ok('chest pain / unconscious / Hinglish / Devanagari / suicide -> URGENT hand-off with no AI call; physio words (stroke, fracture, accident, "emergency appointment") are not emergencies; existing gates (paused, Needs_Human) still come first');

// ================================================================ A3: triage from the AI decision
console.log('A3 triage: AI decision');
let r = planFor('The therapist was rude yesterday, I am very unhappy', (d) => ({ ...d, intent: 'complaint', action: 'handoff', needs_human: true, sentiment: 'negative', confidence: 0.9, handoff_reason: 'complaint about therapist', priority: 'high', risk_flags: ['complaint'], staff_note: 'Unhappy with yesterday\'s session, wants a call. Suggest: call today.' }));
assert.strictEqual(r.plan.route, 'handoff');
assert.strictEqual(r.plan.reason, 'HIGH · Unhappy with yesterday\'s session, wants a call. Suggest: call today.');
assert(r.plan.notes.includes('hand-off: complaint about therapist'));
let items = ai.aiSendItems(r.plan, r.x, h);
assert.strictEqual(items[1].template_params.reason, r.plan.reason);
let w = ai.aiFinalWrites(r.plan, r.x, { patient: sent(), staff: sent() }, F.sec(F.NOW));
assert(table(w.writes, 'Messages')[0].fields.AI_Reason.startsWith('[high · complaint] HIGH · Unhappy'));
assert(table(w.writes, 'Messages')[0].fields.AI_Reason.includes('hand-off: complaint about therapist'));
assert.strictEqual(table(w.writes, 'Conversations')[0].fields.Handoff_Reason, r.plan.reason);   // what staff read in Grist = the alert text

// a risk flag forces a hand-off even when the model wanted to answer by itself
r = planFor('How much does this cost?', (d) => ({ ...d, risk_flags: ['payment'], staff_note: 'Asks about prices after a refund dispute.' }));
assert.deepStrictEqual([r.plan.route, r.plan.reply], ['handoff', r.x.profile.handoff_reply]);
r = planFor('How much does this cost?', (d) => ({ ...d, priority: 'urgent' }));
assert.strictEqual(r.plan.route, 'handoff');
assert(r.plan.reason.startsWith('URGENT · '));
r = planFor('How much does this cost?', (d) => ({ ...d, priority: 'high' }));                  // high without flags: informational answer allowed
assert.strictEqual(r.plan.route, 'reply');
// staff_note the AI wrote with a phone number / link never reaches the alert
r = planFor('The therapist was rude', (d) => ({ ...d, intent: 'complaint', action: 'handoff', needs_human: true, priority: 'high', risk_flags: ['complaint'], staff_note: 'Call +91 98765 43210, see https://x.example' }));
assert.strictEqual(ai.aiSendItems(r.plan, r.x, h)[1].template_params.reason, 'HIGH · Call [number], see [link]');
// no staff_note -> the reason as before (no duplicate note)
r = planFor('Do you accept XYZ insurance?');
assert.deepStrictEqual([r.plan.reason, r.plan.notes], ['question not covered by the knowledge base', []]);
ok('complaint -> HIGH hand-off with the staff note in the alert; any risk flag or URGENT forces a hand-off; notes are sanitised; no note = old reason');

// Escalated: only when the staff alert really went out (W3 then does not escalate again); failed alert -> W3 safety net
r = planFor('The therapist was rude', (d) => ({ ...d, intent: 'complaint', action: 'handoff', needs_human: true, priority: 'high', risk_flags: ['complaint'] }));
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent(), staff: sent() }, F.sec(F.NOW));
assert.strictEqual(table(w.writes, 'LEADS')[0].fields.Escalated, true);
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent(), staff: sent({ sent: false, send_status: 'rejected', send_error: 'template not approved' }) }, F.sec(F.NOW));
assert(!('Escalated' in table(w.writes, 'LEADS')[0].fields));
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent(), staff: null }, F.sec(F.NOW));
assert(!('Escalated' in table(w.writes, 'LEADS')[0].fields));
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent({ sent: false, send_error: 'quiet hours (21:00-08:00 IST)' }), staff: sent({ sent: false, send_error: 'quiet hours (21:00-08:00 IST)' }) }, F.sec(F.NOW));
assert.deepStrictEqual([w.status, table(w.writes, 'LEADS').length], ['deferred', 0]);
r = planFor('How much does this cost?');
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent() }, F.sec(F.NOW));
assert(!('Escalated' in table(w.writes, 'LEADS')[0].fields));
ok('LEADS.Escalated = true only when the hand-off alert was delivered; failed / missing alert or quiet hours -> not set (W3 still escalates); answers never set it');

// ================================================================ A4: confidence tiers
console.log('A4 confidence tiers');
const conf = (text, confidence, edit = (d) => d, o) => planFor(text, (d) => edit({ ...d, confidence }), o).plan;
let p = conf('How much does this cost?', 0.62);
assert.deepStrictEqual([p.route, p.reason], ['handoff', 'low confidence (0.62)']);
p = conf('How much does this cost?', 0.72);
assert.strictEqual(p.route, 'reply');                                                       // informational at 0.72: allowed
p = conf('How much does this cost?', 0.82);
assert.strictEqual(p.route, 'reply');
p = conf('Can I come tomorrow evening?', 0.72);
assert.strictEqual(p.route, 'offer_slots');                                                 // availability check = informational
p = conf('Book me for Saturday at 5.', 0.72);
assert.deepStrictEqual([p.route, p.reason], ['handoff', 'confidence 0.72 is below 0.8 for book_slot (book_appointment)']);
p = conf('I will think about it', 0.72);
assert.deepStrictEqual([p.route, p.reason], ['handoff', 'confidence 0.72 is below 0.8 for schedule_follow_up (follow_up_later)']);
p = conf('Book me for Saturday at 5.', 0.82);
assert.strictEqual(p.route, 'book_slot');                                                   // link mode: nothing written, 0.82 is enough
// direct booking writes Appointments: needs confidence_write (0.85)
p = conf('Book me for Saturday at 5.', 0.84, undefined, { settingsOver: { booking_mode: 'direct' } });
assert.deepStrictEqual([p.route, p.reason, p.action_writes.length], ['handoff', 'confidence 0.84 is below 0.85 for an appointment change', 0]);
p = conf('Book me for Saturday at 5.', 0.86, undefined, { settingsOver: { booking_mode: 'direct' } });
assert.deepStrictEqual([p.route, p.action_writes.length], ['book_slot', 1]);
// negative sentiment: informational answers only
p = conf('How much does this cost?', 0.9, (d) => ({ ...d, sentiment: 'negative' }));
assert.strictEqual(p.route, 'reply');
p = conf('Book me for Saturday at 5.', 0.9, (d) => ({ ...d, sentiment: 'negative' }));
assert.deepStrictEqual([p.route, p.reason], ['handoff', 'negative sentiment (book_appointment)']);
// thresholds come from W13 – Config; missing / broken values fall back to 0.65 / 0.8 / 0.85
p = conf('How much does this cost?', 0.68, undefined, { cfg: { min_confidence: 0.7 } });
assert.strictEqual(p.route, 'handoff');
p = planFor('Book me for Saturday at 5.', (d) => ({ ...d, confidence: 0.79 }), { cfg: { confidence_auto: 'abc', min_confidence: undefined } }).plan;
assert.strictEqual(p.route, 'handoff');
assert.deepStrictEqual([ai.aiNum('0.9', 0.8), ai.aiNum('', 0.8), ai.aiNum(NaN, 0.8), ai.aiNum(0, 0.8), ai.aiNum(3, 0.8)], [0.9, 0.8, 0.8, 0.8, 0.8]);
// the existing checks still run after the tiers: a made-up price at 0.95 is still not sent
p = conf('How much does this cost?', 0.95, (d) => ({ ...d, reply: 'It costs ₹199 only.' }));
assert.strictEqual(p.route, 'handoff');
ok('< 0.65 person; 0.65-0.80 informational only (book / follow-up -> person); >= 0.80 normal; Grist writes need 0.85 (0.84 -> person, 0.86 -> booked); negative mood -> informational only; fact check unchanged');

// ================================================================ A1: the live no_reply rule
console.log('A1 no_reply rule (synced from the live workflow)');
p = planFor('Thanks', (d) => d).plan;
assert.strictEqual(p.route, 'no_reply');
p = planFor('Thanks', (d) => ({ ...d, intent: 'not_interested' })).plan;
assert.strictEqual(p.route, 'no_reply');
p = planFor('How much does this cost?', (d) => ({ ...d, action: 'no_reply', reply: '' })).plan;
assert.deepStrictEqual([p.route, p.reason], ['handoff', 'AI selected no_reply for pricing; a response is required']);
ok('no_reply only for thanks / not interested; no_reply for anything else -> a person (the message is never silently dropped)');

// ================================================================ A2: decision trace
console.log('A2 decision trace');
assert.strictEqual(ai.aiTraceText({ gate: 'ai', model: 'openai/gpt-4o-mini', latency_ms: 1234.4, tokens_in: 3100, tokens_out: 210, fallback: false }), 'gate=ai openai/gpt-4o-mini 1234ms tok 3100/210');
assert.strictEqual(ai.aiTraceText({ gate: 'ai', model: 'openai/gpt-4o-mini', latency_ms: 30010, fallback: true }), 'gate=ai openai/gpt-4o-mini 30010ms fallback');
assert.strictEqual(ai.aiTraceText({ gate: 'defer' }), 'gate=defer');
assert.strictEqual(ai.aiTraceText(null), '');
r = planFor('How much does this cost?');
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent() }, F.sec(F.NOW), { gate: 'ai', model: 'openai/gpt-4o-mini', latency_ms: 900, tokens_in: 3000, tokens_out: 200, fallback: false });
assert.strictEqual(table(w.writes, 'Run_Log')[0].fields.Record, 'L-20261001-0001 wamid.NEW.4 pricing -> reply (replied) | gate=ai openai/gpt-4o-mini 900ms tok 3000/200');
assert.strictEqual(table(w.writes, 'Messages')[0].fields.AI_Reason, '');
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent() }, F.sec(F.NOW));
assert.strictEqual(table(w.writes, 'Run_Log')[0].fields.Record, 'L-20261001-0001 wamid.NEW.4 pricing -> reply (replied)');   // no trace = as before
// fallback: the AI answer was unusable -> hand-off, marked in AI_Reason and Run_Log
const { x } = ctx('How much does this cost?');
const fb = ai.aiPlan(null, x, CFG);
fb.reason = `${fb.reason}: request timed out`;
w = ai.aiFinalWrites(fb, x, { patient: sent(), staff: sent() }, F.sec(F.NOW), { gate: 'ai', model: 'openai/gpt-4o-mini', latency_ms: 30000, fallback: true });
assert(table(w.writes, 'Messages')[0].fields.AI_Reason.startsWith('fallback: '));
assert(table(w.writes, 'Run_Log')[0].fields.Record.endsWith('| gate=ai openai/gpt-4o-mini 30000ms fallback'));
assert(table(w.writes, 'Run_Log')[0].fields.Record.length <= 200);
assert(!Object.keys(Object.assign({}, ...w.writes.map((x2) => x2.body.records[0].fields))).some((k) => !['Intent', 'AI_Action', 'AI_Confidence', 'AI_Status', 'Needs_Human', 'AI_Reply', 'AI_Reason', 'Last_Intent', 'Handoff_Reason', 'Lead_Stage', 'AI_Summary', 'Escalated', 'Workflow', 'Record', 'Outcome', 'Error', 'At'].includes(k)));
ok('Run_Log Record carries gate, model, latency, tokens and "fallback"; AI_Reason starts with "fallback:" when the AI answer was unusable; only existing columns');

console.log('\nAll ai-receptionist AI OS cases pass');
