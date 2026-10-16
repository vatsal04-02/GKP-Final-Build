// Run: node n8n/snippets/ai-outcome-staff.test.js
// Two W13 additions for W7 and W10, in the shared decision module (ai-receptionist.js):
//   1. outcome intents: the patient's answer to W7's "how are you feeling?" (better / same / worse) - worse and same always go to a
//      person (worse = HIGH, flagged medical), better gets a short thank-you; no medical advice is ever sent.
//   2. staff gate: a staff member wrote to the patient (W10 reply) in the last 24 h -> the AI stays out of that conversation.
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
const NUDGE = { id: 20, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, thank you for visiting Demo Physio for your Knee pain physiotherapy. How are you feeling now? Just reply here: better, the same or worse.', Sent_By: 'W7-outcome-nudge', Template: 'outcome_check', Created_At: T - 3 * 3600 } };
const msg = (id, text, at) => ({ id, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: `wamid.${id}`, Status: 'Received', Created_At: at } });
function ctx(current, extra = []) {
  return ai.aiContext({
    start: { message_row_id: current.id, wa_message_id: current.fields.WA_Message_ID, msg_type: 'text' },
    clinic: CLINIC, settings: rec(F.settingsRows()), knowledge: rec(F.KNOWLEDGE), message: rec([current]),
    conversation: rec(F.conversationRows()), lead: rec([F.leadRows()[0]]),
    history: rec([...F.messageRows(), ...extra, current]), appointments: rec(F.appointmentRows()),
  }, CFG, F.NOW, h);
}
const decide = (text, extra = [NUDGE]) => {
  const { x, gate } = ctx(msg(30, text, T - 10), extra);
  assert.strictEqual(gate.route, 'ai', gate.reason);
  const req = ai.aiBuildRequest(x, CFG);
  const d = F.fakeDecide(req);
  assert.deepStrictEqual(ai.aiValidateDecision(d), []);
  return { x, req, d, plan: ai.aiPlan(d, x, CFG) };
};

console.log('outcome intents (answers to W7)');
for (const i of ['outcome_better', 'outcome_same', 'outcome_worse']) {
  assert(ai.AI_INTENTS.includes(i) && ai.AI_DECISION_SCHEMA.properties.intent.enum.includes(i));
}
assert(String(ai.AI_RULES).includes('Outcome check:'));
assert(ai.AI_HUMAN_INTENTS.includes('outcome_worse') && ai.AI_HUMAN_INTENTS.includes('outcome_same') && !ai.AI_HUMAN_INTENTS.includes('outcome_better'));
ok('outcome_better / outcome_same / outcome_worse are in the strict schema and explained in the rules; same and worse are person-only');

let r = decide('Much better now, thank you!');
assert.deepStrictEqual([r.d.intent, r.plan.route, r.plan.reply, r.plan.conversation_patch.Last_Intent], ['outcome_better', 'reply', 'So glad to hear you are feeling better! Thank you for letting us know.', 'outcome_better']);
r = decide('Much better now, thank you!');
const nr = ai.aiPlan({ ...r.d, action: 'no_reply', reply: '' }, r.x, CFG);
assert.strictEqual(nr.route, 'no_reply');
ok('better: a short thank-you (or no reply); the outcome is recorded as Messages.Intent / Conversations.Last_Intent');

r = decide('It is worse, more pain since yesterday');
assert.deepStrictEqual([r.d.intent, r.plan.route, r.plan.reply, r.plan.triage.priority, r.plan.triage.flags], ['outcome_worse', 'handoff', r.x.profile.handoff_reply, 'high', ['medical']]);
assert(r.plan.reason.startsWith('HIGH · Patient says they feel worse after the visit'));
// even if the model tried to answer with advice, code hands off and never sends it
const advice = ai.aiPlan({ ...r.d, action: 'reply', needs_human: false, confidence: 0.97, reply: 'Apply ice and take paracetamol.' }, r.x, CFG);
assert.deepStrictEqual([advice.route, advice.reply], ['handoff', r.x.profile.handoff_reply]);
ok('worse: HIGH hand-off flagged medical with a staff note; any advice the model writes is never sent');

r = decide('Still the same, no change');
assert.deepStrictEqual([r.d.intent, r.plan.route, r.plan.reason], ['outcome_same', 'handoff', 'no improvement after the visit: no change yet']);
ok('same: a person follows up ("no improvement after the visit")');

const urgent = ctx(msg(30, 'Much worse, I have severe chest pain', T - 10), [NUDGE]);
assert.deepStrictEqual([urgent.gate.route, urgent.gate.triage.priority], ['handoff', 'urgent']);
ok('urgent words in an outcome answer: the emergency gate hands off as URGENT before any AI call');

r = decide('Better, but please book me for Saturday at 5', [NUDGE]);
assert.deepStrictEqual([r.d.intent, r.plan.route], ['book_appointment', 'book_slot']);
assert(/cal\.com/.test(Object.values(r.plan.links).join(' ')) || /\{\{BOOKING_LINK\}\}/.test(r.plan.reply));
ok('wants another appointment: the normal booking path (real free slots / Cal.com link only), lead stage hot');

const plain = ctx(msg(30, 'Is the price still the same?', T - 10), []);
assert.strictEqual(F.fakeDecide(ai.aiBuildRequest(plain.x, CFG)).intent !== 'outcome_same', true);
ok('without a check-in in the conversation, "still the same" is not read as an outcome');

console.log('staff gate (W10 replies)');
const staff = (ago, by = 'Ravi (front desk)') => ({ id: 21, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, Dr Mehta will call you at 5.', Sent_By: by, Status: 'sent', WA_Message_ID: 'wamid.STAFF', Created_At: T - ago } });
let c = ctx(msg(30, 'Ok thanks, what time exactly?', T - 10), [staff(3600)]);
assert.deepStrictEqual([c.gate.route, /staff member is talking/.test(c.gate.reason)], ['skip', true]);
c = ctx(msg(30, 'Ok thanks, what time exactly?', T - 10), [staff(25 * 3600)]);
assert.strictEqual(c.gate.route, 'ai');
c = ctx(msg(30, 'Ok thanks', T - 10), [staff(3600, 'W5-reminders (TEST_MODE: sent to +919000000019)')]);
assert.strictEqual(c.gate.route, 'ai');
for (const by of ['W12', 'W12 (TEST_MODE: sent to +919000000019)', 'W13-ai-receptionist', 'W7-outcome-nudge']) assert.strictEqual(ctx(msg(30, 'Ok thanks', T - 10), [staff(3600, by)]).gate.route, 'ai', by);
for (const by of ['Wendy', 'W3D clinic desk']) assert.strictEqual(ctx(msg(30, 'Ok thanks', T - 10), [staff(3600, by)]).gate.route, 'skip', by);
c = ctx(msg(30, 'Ok thanks', T - 10), [staff(3600, '')]);
assert.strictEqual(c.gate.route, 'skip');
c = ctx(msg(30, 'Ok thanks', T - 10), [{ ...staff(3600), fields: { ...staff(3600).fields, Created_At: 0 } }]);
assert.strictEqual(c.gate.route, 'ai');
ok('a staff message in the last 24 h keeps the AI out; after 24 h, or messages written by automations (W5, W13...), it answers');
c = ctx(msg(30, 'STOP', T - 10), [staff(3600)]);
assert.strictEqual(c.gate.route, 'opt_out');
c = ctx(msg(30, 'I have severe chest pain', T - 10), [staff(3600)]);
assert.strictEqual(c.gate.route, 'handoff');
ok('STOP and emergencies still work inside a staff conversation (STOP opts out, chest pain = URGENT alert)');

console.log(`\nAll ${n} outcome / staff gate cases pass`);
