// Run: node n8n/snippets/ai-handoff-gate.test.js
// The Needs_Human gate of W13 (aiContext + aiGates): a ticked Conversations.Needs_Human keeps the AI away from the message that was
// handed off (and anything older), but a patient message written AFTER that hand-off is answered again. Without a hand-off message
// (ticked by hand) the AI stays silent, as before. Every other gate keeps its place and order.
const assert = require('assert');
const ai = require('./ai-receptionist');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const CFG = { model: 'openai/gpt-4o-mini', leads_table: 'LEADS', min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, staff_alert_template: 'human_handoff_alert' };
const CLINIC = { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' };
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (rows) => ({ records: clone(rows) });
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const T = F.sec(F.NOW);

// Conversation 1 (Asha). Message 10 = the one W13 handed off at T-600 (Needs_Human on the row), 11 = the holding reply.
const HANDED = { id: 10, fields: { Conversation: 1, Direction: 'In', Body: 'I want a refund for yesterday', Sent_By: 'Patient', WA_Message_ID: 'wamid.H', Status: 'Received', Created_At: T - 600, AI_Status: 'handed_off', Needs_Human: true } };
const HOLD = { id: 11, fields: { Conversation: 1, Direction: 'Out', Body: 'Thank you for your message. A member of our team will reply to you shortly.', Sent_By: 'W13-ai-receptionist', Created_At: T - 590 } };
const msg = (id, text, at, over = {}) => ({ id, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: `wamid.${id}`, Status: 'Received', Created_At: at, ...over } });
function ctx(current, { history = [HANDED, HOLD], conv = { Needs_Human: true, Handoff_Reason: 'payment issue: refund' }, start = {}, now = F.NOW, leadFields = {} } = {}) {
  return ai.aiContext({
    start: { message_row_id: current ? current.id : 0, wa_message_id: current ? current.fields.WA_Message_ID : '', msg_type: 'text', ...start },
    clinic: CLINIC, settings: rec(F.settingsRows()), knowledge: rec(F.KNOWLEDGE),
    message: rec(current ? [current] : []),
    conversation: rec([{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 600, Unread: 1, Automation_Paused: false, ...conv } }]),
    lead: rec([F.leadRows()[0]].map((l) => ({ ...l, fields: { ...l.fields, ...leadFields } }))),
    history: rec([...F.messageRows(), ...history, ...(current ? [current] : [])]),
    appointments: rec(F.appointmentRows()),
  }, CFG, now, h);
}

console.log('Needs_Human gate');
let c = ctx(msg(12, 'How much does this cost?', T - 10));
assert.deepStrictEqual([c.gate.route, c.x.notes.some((t) => /after a hand-off/.test(t))], ['ai', true]);
ok('a patient message AFTER the hand-off is answered by the AI again (a note says Needs_Human stays ticked)');

c = ctx(HANDED, { history: [HOLD] });
assert.deepStrictEqual([c.gate.route, c.gate.quiet], ['skip', true]);   // already handled (AI_Status) comes first
const reopened = { ...HANDED, fields: { ...HANDED.fields, AI_Status: '' } };
c = ctx(reopened, { history: [HOLD] });
assert.deepStrictEqual([c.gate.route, /waiting for a person/.test(c.gate.reason)], ['skip', true]);
ok('the handed-off message itself (re-run, even with AI_Status cleared) stays with the person');

c = ctx(msg(9, 'older message', T - 900), { history: [HANDED, HOLD] });
assert.strictEqual(c.gate.route, 'skip');
c = ctx(msg(12, 'same second, lower id', T - 600), { history: [{ ...HANDED, id: 13 }, HOLD] });
assert.strictEqual(c.gate.route, 'skip');
c = ctx(msg(14, 'same second, higher id', T - 600), { history: [HANDED, HOLD] });
assert.strictEqual(c.gate.reason, 'the clinic already answered after this message');   // the holding reply came after it: existing gate
c = ctx(msg(14, 'same second, higher id', T - 600), { history: [HANDED] });
assert.strictEqual(c.gate.route, 'ai');
ok('a message older than the hand-off (or the same second, written earlier) is not answered; same second, written later, is');

c = ctx(msg(12, 'How much does this cost?', T - 10), { history: [] });
assert.deepStrictEqual([c.gate.route, /waiting for a person/.test(c.gate.reason)], ['skip', true]);
c = ctx(msg(12, 'How much does this cost?', T - 10), { history: [{ ...HANDED, fields: { ...HANDED.fields, Needs_Human: false } }, HOLD] });
assert.strictEqual(c.gate.route, 'skip');
ok('Needs_Human ticked by hand (no hand-off message from W13): the AI stays silent, exactly as before');

c = ctx(msg(12, 'How much does this cost?', T - 10), { conv: { Needs_Human: false, Handoff_Reason: 'payment issue: refund' } });
assert.deepStrictEqual([c.gate.route, c.x.notes.some((t) => /after a hand-off/.test(t))], ['ai', false]);
ok('Needs_Human unticked by staff: answered as before, no note');

// the newest hand-off counts: a second hand-off after the current message blocks it
c = ctx(msg(12, 'question', T - 300), { history: [HANDED, HOLD, msg(15, 'second issue', T - 100, { Needs_Human: true, AI_Status: 'handed_off' })] });
assert.strictEqual(c.gate.route, 'skip');
ok('two hand-offs: only messages after the NEWEST one are answered');

// every other gate keeps working, before and after the Needs_Human gate
const g = (text, o = {}) => ctx(msg(12, text, T - 10, o.msg), o).gate;
assert.strictEqual(g('STOP').route, 'opt_out');
assert.strictEqual(g('How much?', { conv: { Needs_Human: true, Automation_Paused: true } }).route, 'skip');
assert.strictEqual(ctx(msg(12, 'How much?', T - 10), { history: [HANDED, HOLD, { id: 16, fields: { Conversation: 1, Direction: 'In', Body: 'newer', Created_At: T - 5 } }] }).gate.route, 'skip');   // newer inbound
assert.strictEqual(ctx(msg(12, 'How much?', T - 10), { history: [HANDED, HOLD, { id: 17, fields: { Conversation: 1, Direction: 'Out', Body: 'staff reply', Sent_By: 'Dr Mehta', Created_At: T - 5 } }] }).gate.reason, 'the clinic already answered after this message');
assert.strictEqual(g('I have severe chest pain').route, 'handoff');
assert.strictEqual(g('my x-ray', { start: { msg_type: 'image' } }).route, 'handoff');
const night = Date.parse('2026-10-06T22:00:00+05:30');
assert.strictEqual(ctx(msg(12, 'How much?', F.sec(night) - 10), { now: night, history: [{ ...HANDED, fields: { ...HANDED.fields, Created_At: F.sec(night) - 600 } }] }).gate.route, 'defer');
const busy = Array.from({ length: 6 }, (_, i) => ({ id: 30 + i, fields: { Conversation: 1, Direction: 'Out', Body: 'r', Sent_By: 'W13-ai-receptionist', Created_At: T - 1000 + i } }));
assert.strictEqual(ctx(msg(12, 'How much?', T - 10), { history: [HANDED, HOLD, ...busy] }).gate.route, 'handoff');
assert.deepStrictEqual([g('How much?', { leadFields: { Opted_Out: true } }).route, g('How much?', { leadFields: { Opted_Out: true } }).reason], ['skip', 'the lead has opted out']);
for (const o of [{ leadFields: { Opted_Out: true } }, { conv: { Needs_Human: true, Automation_Paused: true } }]) assert(!ctx(msg(12, 'How much?', T - 10), o).x.notes.some((t) => /after a hand-off/.test(t)), 'note on a skipped message');
assert(!ctx(msg(12, 'How much?', F.sec(night) - 10), { now: night, history: [{ ...HANDED, fields: { ...HANDED.fields, Created_At: F.sec(night) - 600 } }] }).x.notes.some((t) => /after a hand-off/.test(t)), 'note on a deferred message');
ok('STOP, opted out, paused, newer message, staff already answered, emergency, media, night, rate limit: unchanged after a hand-off (and no "handled by the AI" note when one of them stops the message)');

// the deferred (night) message after a hand-off is answered by the 08:05 retry
c = ctx(msg(12, 'How much?', T - 10, { AI_Status: 'deferred' }), { start: { w13_retry: true } });
assert.strictEqual(c.gate.route, 'ai');
ok('a message deferred overnight after a hand-off is answered by the morning retry');

// the old Handoff_Reason never reaches the model nor the decision
c = ctx(msg(12, 'How much does this cost?', T - 10), { conv: { Needs_Human: true, Handoff_Reason: 'URGENT · Possible emergency, payment refund complaint' } });
const req = ai.aiBuildRequest(c.x, CFG);
assert(!JSON.stringify(req).includes('Possible emergency, payment refund complaint'));
const d = F.fakeDecide(req);
const plan = ai.aiPlan(d, c.x, CFG);
assert.deepStrictEqual([plan.route, plan.intent], ['reply', 'pricing']);
const w = ai.aiFinalWrites(plan, c.x, { patient: { sent: true, send_status: 'accepted', wa_message_id: 'wamid.R' } }, T);
const convWrite = w.writes.filter((x) => x.table === 'Conversations').map((x) => x.body.records[0].fields)[0];
assert.deepStrictEqual(convWrite, { Last_Intent: 'pricing' });   // Needs_Human and the old Handoff_Reason are left for staff
assert.strictEqual(w.writes.find((x) => x.table === 'Messages').body.records[0].fields.Needs_Human, false);
ok('the old Handoff_Reason is not in the prompt and does not decide anything; a normal answer leaves Needs_Human / Handoff_Reason for staff');

// a new message that itself needs a person is handed off again, with its own reason
c = ctx(msg(12, 'My knee is swollen, should I take ibuprofen?', T - 10));
const p2 = ai.aiPlan({ ...F.BASE_DECISION, intent: 'medical_question', action: 'handoff', needs_human: true, handoff_reason: 'medication question', confidence: 0.9 }, c.x, CFG);
const w2 = ai.aiFinalWrites(p2, c.x, { patient: { sent: true }, staff: { sent: true } }, T);
const cv = w2.writes.find((x) => x.table === 'Conversations').body.records[0].fields;
assert.deepStrictEqual([p2.route, cv.Needs_Human, cv.Handoff_Reason === 'medication question', w2.writes.find((x) => x.table === 'Messages').body.records[0].fields.Needs_Human], ['handoff', true, true, true]);
ok('a new medical question after a hand-off: handed off again, Needs_Human set again, Handoff_Reason = the NEW reason, the message becomes the new hand-off point');

console.log(`\nAll ${n} Needs_Human gate cases pass`);
