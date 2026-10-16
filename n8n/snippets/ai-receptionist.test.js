// Run: node n8n/snippets/ai-receptionist.test.js
// Unit tests for the W13 decision layer: context and gates, the Claude request, checking Claude's answer, the fact check,
// every action route, what goes to W12 and what is written to Grist. The "AI" here is the fake in n8n/tests/ai-fixtures.js.
const assert = require('assert');
const ai = require('./ai-receptionist');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const CFG = { model: 'claude-haiku-4-5', leads_table: 'LEADS', min_confidence: 0.7, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, staff_alert_template: 'human_handoff_alert' };
const CLINIC = { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' };
const ok = (m) => console.log(`  ok  ${m}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (rows) => ({ records: clone(rows) });

// A new inbound message from Asha (message row 4), as W2 stored it; everything else from the demo clinic.
const NEW_MSG = (text, over = {}) => ({ id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: 'wamid.NEW.4', Status: 'Received', Created_At: F.sec(F.NOW) - 10, ...over } });
function raw(text, o = {}) {
  const msg = o.msg || NEW_MSG(text, o.msgFields);
  return {
    start: { message_row_id: 4, wa_message_id: 'wamid.NEW.4', msg_type: 'text', ...(o.start || {}) },
    clinic: CLINIC,
    settings: o.settings || rec(F.settingsRows(o.settingsOver)),
    knowledge: o.knowledge || rec(F.KNOWLEDGE),
    message: o.message || rec([msg]),
    conversation: o.conversation || rec(F.conversationRows().map((c) => ({ ...c, fields: { ...c.fields, ...(o.convFields || {}) } }))),
    lead: o.lead || rec([F.leadRows()[0]].map((l) => ({ ...l, fields: { ...l.fields, ...(o.leadFields || {}) } }))),
    history: o.history || rec([...F.messageRows(), msg, ...(o.extraHistory || [])]),
    appointments: o.appointments || rec(F.appointmentRows()),
  };
}
const ctx = (text, o = {}) => ai.aiContext(raw(text, o), { ...CFG, ...(o.cfg || {}) }, o.now || F.NOW, h);
const decide = (x) => {
  const req = ai.aiBuildRequest(x, CFG);
  return { req, d: F.fakeDecide(req) };
};
const planFor = (text, o = {}) => {
  const { x, gate } = ctx(text, o);
  assert.strictEqual(gate.route, 'ai', `gate: ${gate.reason}`);
  const { req, d } = decide(x);
  const dd = o.edit ? o.edit(d, x) : d;
  assert.deepStrictEqual(ai.aiValidateDecision(dd), []);
  return { x, req, d: dd, plan: ai.aiPlan(dd, x, CFG) };
};
const sent = (over = {}) => ({ sent: true, send_status: 'accepted', wa_message_id: 'wamid.REPLY', send_error: '', ...over });
const table = (writes, t) => writes.filter((w) => w.table === t).map((w) => w.body.records[0]);

// ================================================================ profile, knowledge, slots
console.log('profile, knowledge, slots');
let p = ai.aiProfile({}, 'Registry Name');
assert.deepStrictEqual([p.ai_mode, p.booking_mode, p.slot_minutes, p.capacity, p.notice_minutes, p.clinic_name, p.booking_link], ['off', 'link', 30, 1, 120, 'Registry Name', '']);
assert.strictEqual(ai.aiProfile({ ai_mode: ' AUTO ' }).ai_mode, 'auto');
assert.strictEqual(ai.aiProfile({ ai_mode: 'draft' }).ai_mode, 'draft');
assert.strictEqual(ai.aiProfile({ ai_mode: 'yes' }).ai_mode, 'off');
assert.strictEqual(ai.aiProfile({ booking_link: 'http://insecure.example/x' }).booking_link, '');
assert.strictEqual(ai.aiProfile({ slot_minutes: '5' }).slot_minutes, 30);
assert.strictEqual(ai.aiProfile({ booking_notice_minutes: '0' }).notice_minutes, 0);
ok('Settings: AI is OFF unless ai_mode is draft or auto; link booking by default; bad numbers fall back; only https booking links');

const kb = ai.aiKnowledge(F.KNOWLEDGE);
assert.deepStrictEqual(kb.map((k) => k.ref), ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
assert(!JSON.stringify(kb).includes('199'));
assert.strictEqual(ai.aiKnowledge([{ id: 1, fields: { Title: 'x', Content: 'y'.repeat(1400) } }, ...Array.from({ length: 40 }, (_, i) => ({ id: i + 2, fields: { Title: 't', Content: 'z'.repeat(1400) } }))]).length, 17);
ok('Knowledge: inactive rows are left out (the old ₹199 offer); refs K<row id>; total size capped');

const s = ai.aiFreeSlots(ai.aiProfile(Object.fromEntries(F.settingsRows().map((r) => [r.fields.Key, r.fields.Value]))), F.appointmentRows(), F.NOW, 7, h);
assert.strictEqual(s.known, true);
assert.deepStrictEqual(s.days.map((d) => d.date), ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12']);
assert.strictEqual(ai.aiHHMM(s.days[0].times[0]), '13:00');                                    // 11:00 now + 120 min notice
assert(!s.days[1].times.includes(17 * 60) && !s.days[1].times.includes(10 * 60) && s.days[1].times.includes(16 * 60 + 30));
assert(!s.days[2].times.includes(12 * 60));                                                    // Ravi's WhatsApp booking
assert.strictEqual(ai.aiHHMM(s.days[1].times[s.days[1].times.length - 1]), '18:30');          // last 30-min slot before 19:00
const s2 = ai.aiFreeSlots({ ...ai.aiProfile({ open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat' }), capacity: 2 }, F.appointmentRows(), F.NOW, 7, h);
assert(s2.days[1].times.includes(17 * 60));
assert.strictEqual(ai.aiFreeSlots(ai.aiProfile({}), [], F.NOW, 7, h).known, false);
ok('free slots: from clinic hours minus Booked appointments; notice period; Sunday closed; capacity; no hours = unknown (no times invented)');

const appts = ai.aiLeadAppointments(F.appointmentRows(), 1, F.NOW);
assert.deepStrictEqual(appts.map((a) => [a.ref, a.uid, a.origin, a.label]), [['A1', 'cal-uid-asha-1', 'calcom', 'Wed 07 Oct 10:00 AM']]);
assert.strictEqual(ai.aiLeadAppointments(F.appointmentRows(), 3, F.NOW)[0].origin, 'whatsapp');
assert.deepStrictEqual(ai.aiLeadAppointments(F.appointmentRows(), 0, F.NOW), []);
ok('the patient\'s own upcoming Booked appointments (past / completed ones left out), online vs WhatsApp origin');

// ================================================================ context + gates
console.log('context and gates');
let c = ctx('How much does this cost?');
assert.strictEqual(c.gate.route, 'ai');
assert.deepStrictEqual([c.x.lead.row_id, c.x.lead.lead_id, c.x.lead.phone, c.x.lead.created, c.x.conversation.row_id, c.x.msg.row_id, c.x.cfg.reply_mode], [1, 'L-20261001-0001', F.ASHA, false, 1, 4, 'auto']);
assert.deepStrictEqual(c.x.history.map((m) => m.id), [1, 2, 3]);
assert.strictEqual(c.x.text, 'How much does this cost?');
ok('context: lead, conversation, message, history (without the message itself), mode');

const gate = (text, o) => ctx(text, o).gate;
const cases = [
  ['Settings unreadable -> failed, no AI', { settings: { error: { message: 'Grist 500' } } }, 'failed', /Settings/],
  ['message row missing -> failed', { message: rec([]) }, 'failed', /not found/],
  ['lead unreadable -> failed', { lead: { error: 'timeout' } }, 'failed', /lead/],
  ['outbound row -> quiet skip', { msgFields: { Direction: 'Out' } }, 'skip', /not a patient message/],
  ['already handled -> quiet skip', { msgFields: { AI_Status: 'replied' } }, 'skip', /already handled/],
  ['STOP -> opt_out (even with AI off)', { text: 'STOP', settingsOver: { ai_mode: 'off' } }, 'opt_out', /stop/],
  ['AI off -> quiet skip', { settingsOver: { ai_mode: undefined } }, 'skip', /ai_mode/],
  ['lead opted out', { leadFields: { Opted_Out: true } }, 'skip', /opted out/],
  ['conversation paused by staff', { convFields: { Automation_Paused: true } }, 'skip', /paused/],
  ['waiting for a person', { convFields: { Needs_Human: true } }, 'skip', /waiting for a person/],
  ['staff answered after this message', { extraHistory: [{ id: 9, fields: { Conversation: 1, Direction: 'Out', Body: 'Staff reply', Created_At: F.sec(F.NOW) - 5 } }] }, 'skip', /already answered/],
  ['a newer patient message exists', { extraHistory: [{ id: 9, fields: { Conversation: 1, Direction: 'In', Body: 'hello?', Created_At: F.sec(F.NOW) - 2 } }] }, 'skip', /newer message/],
  ['quiet hours (22:00 IST) -> defer', { now: Date.parse('2026-10-06T22:00:00+05:30') }, 'defer', /quiet hours/],
  ['20:57 IST is inside the 5-minute margin -> defer', { now: Date.parse('2026-10-06T20:57:00+05:30') }, 'defer', /quiet hours/],
  ['image -> handoff', { start: { msg_type: 'image' }, text: '[WhatsApp image received]: knee x-ray' }, 'handoff', /image/],
  ['media detected from the Body on a retry', { start: { msg_type: undefined }, text: '[WhatsApp document received]' }, 'handoff', /media/],
];
for (const [name, o, route, re] of cases) {
  const g = gate(o.text || 'How much does this cost?', o);
  assert.strictEqual(g.route, route, `${name}: got ${g.route} (${g.reason})`);
  assert(re.test(g.reason), `${name}: reason "${g.reason}"`);
}
// six W13 replies in the last hour, all before this message
const recent = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, fields: { Conversation: 1, Direction: 'Out', Body: 'r', Sent_By: 'W13-ai-receptionist', Created_At: F.sec(F.NOW) - 3000 + i } }));
const g6 = gate('How much does this cost?', { extraHistory: recent });
assert.strictEqual(g6.route, 'handoff');
assert(/6 automatic replies/.test(g6.reason));
assert.strictEqual(gate('x', { msgFields: { AI_Status: 'deferred' }, start: { w13_retry: true } }).route, 'ai');
assert.strictEqual(gate('x', { msgFields: { AI_Status: 'deferred' } }).route, 'skip');
assert.strictEqual(gate('x', { msgFields: { AI_Status: 'replied' }, start: { w13_retry: true } }).route, 'skip');
ok(`gates (${cases.length + 4} cases): read failures, not-ours, already handled, STOP, AI off, opted out, paused, waiting for a person, answered, newer message, night, media, rate limit, morning retry`);

c = ctx('x', { knowledge: { error: { message: 'Grist 404: no such table Knowledge' } }, appointments: { error: 'Grist 500' }, history: { error: 'timeout' } });
assert.strictEqual(c.gate.route, 'ai');
assert.deepStrictEqual([c.x.kb.length, c.x.slots.known, c.x.appointments_unknown], [0, false, true]);
assert.strictEqual(c.x.notes.length, 3);
ok('Knowledge / Appointments / history unreadable: the AI still runs, knows nothing about them (no slots offered), and the reason is logged');

// dry run: no message row, ai_mode off, at night -> still asks the AI, never claims or writes
c = ai.aiContext({ ...raw('Kitne charges hain?', { settingsOver: { ai_mode: 'off' } }), start: { dry_run: true, patient_phone: '9000000012', text: 'Kitne charges hain?', sender_name: 'Test' }, message: undefined, lead: rec([]), conversation: rec([]), history: rec([]) }, CFG, Date.parse('2026-10-06T23:00:00+05:30'), h);
assert.strictEqual(c.gate.route, 'ai');
assert.deepStrictEqual([c.x.dry_run, c.x.lead.row_id, c.x.lead.phone, c.x.lead.created, c.x.text, c.x.cfg.reply_mode], [true, 0, '+919000000012', true, 'Kitne charges hain?', 'auto']);
ok('dry run (manual test): no message row needed, works with AI off and at night, unknown patient = new contact');

// ================================================================ the Claude request
console.log('Claude request');
c = ctx('Can I come tomorrow evening?');
let req = ai.aiBuildRequest(c.x, CFG);
assert.deepStrictEqual(Object.keys(req).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
assert.strictEqual(req.model, 'claude-haiku-4-5');
assert.deepStrictEqual(req.output_config.format.type, 'json_schema');
assert.strictEqual(req.system.length, 3);
assert.deepStrictEqual(req.system[1].cache_control, { type: 'ephemeral' });
assert.strictEqual(req.messages[0].content, '<patient_message>\nCan I come tomorrow evening?\n</patient_message>');
const facts = req.system.map((b) => b.text).join('\n');
for (const line of ['NOW: Tue 06 Oct 2026-10-06, 11:00 IST', '- 2026-10-07 = wednesday Wed 07 Oct (tomorrow)', '- 2026-10-11 = sunday Sun 11 Oct',
  '[K1] (services) Knee pain physiotherapy: One-to-one knee rehab', '- earlier summary: Asked about knee pain treatment',
  '- [A1] Wed 07 Oct 10:00 AM, Knee pain physiotherapy with Dr. Mehta (booked online', '- patient (Thu 01 Oct 11:00): Do you treat knee pain?',
  '- booking: patients book through the link']) assert(facts.includes(line), `prompt is missing: ${line}`);
assert(/^- 2026-10-07 \(Wed 07 Oct\): .*16:00, 16:30, 17:30/m.test(facts), 'tomorrow\'s free times (17:00 taken)');
assert(!/2026-10-11 \(/.test(facts), 'Sunday has no free times');
assert(!facts.includes('9000000011') && !facts.includes('199'), 'no patient phone number and no inactive knowledge in the prompt');
const schema = ai.AI_DECISION_SCHEMA;
const walk = (o) => { if (o && o.type === 'object') { assert.strictEqual(o.additionalProperties, false); assert.deepStrictEqual([...o.required].sort(), Object.keys(o.properties).sort()); Object.values(o.properties).forEach(walk); } if (o && o.anyOf) o.anyOf.forEach(walk); };
walk(schema);
assert(!/minimum|maximum|minLength|maxLength/.test(JSON.stringify(schema)));
ok('request: Haiku, structured output (every object closed, every field required, no numeric limits), rules + cached clinic facts + per-message facts, message wrapped as data; real calendar, free times, KB, appointments, history; no phone number');

// ================================================================ Claude's answer
console.log('reading and checking the answer');
const good = F.fakeDecide(req);
assert.deepStrictEqual(ai.aiParseResponse(F.claudeResponse(good)), { ok: true, decision: good });
assert.strictEqual(ai.aiParseResponse({ error: { message: 'timeout of 45000ms exceeded' } }).ok, false);
assert.strictEqual(ai.aiParseResponse({ ...F.claudeResponse(good), stop_reason: 'refusal' }).error, 'Claude declined to answer');
assert(/cut off/.test(ai.aiParseResponse({ ...F.claudeResponse(good), stop_reason: 'max_tokens' }).error));
assert(/not JSON/.test(ai.aiParseResponse(F.claudeResponse('Sure! Here is my answer')).error));
assert.strictEqual(ai.aiParseResponse({ type: 'error', error: { type: 'overloaded_error' } }).ok, false);
assert.strictEqual(ai.aiParseResponse(null).ok, false);
ok('API error / timeout, refusal, max_tokens, non-JSON, empty: all "not ok" (W13 then hands off)');

assert.deepStrictEqual(ai.aiValidateDecision(good), []);
const bad = { ...good, intent: 'buy_now', action: 'send_money', confidence: 1.4, booking: { date: '7 Oct', time: '5pm', time_window: 'night' }, kb_refs: 'K1', follow_up_days: 2.5 };
assert.strictEqual(ai.aiValidateDecision(bad).length, 8);
assert.deepStrictEqual(ai.aiValidateDecision([]), ['the decision is not an object']);
ok('decision validation: unknown intent / action, confidence outside 0-1, bad date / time / window, wrong types');

const allowed = ai.aiAllowedFacts(c.x);
assert.deepStrictEqual(ai.aiCheckReply('The assessment is ₹500 and sessions are Rs. 800.', allowed), []);
assert.deepStrictEqual(ai.aiCheckReply('Special price only ₹199!', allowed), ['price 199 is not in the knowledge base']);
assert.deepStrictEqual(ai.aiCheckReply('Come at 4 PM or 4:30 pm.', allowed), []);
assert.deepStrictEqual(ai.aiCheckReply('We open at 7 AM.', allowed), ['time 07:00 is not a free slot, appointment or opening time']);
assert.deepStrictEqual(ai.aiCheckReply('Book at https://evil.example/pay', allowed), ['link https://evil.example/pay is not in the knowledge base']);
assert.deepStrictEqual(ai.aiCheckReply('Call us on +91 98765 43210', allowed), ['a phone number that is not in the knowledge base']);
assert.deepStrictEqual(ai.aiCheckReply('Pay here {{PAYMENT_LINK}}', allowed), ['unknown placeholder {{PAYMENT_LINK}}']);
assert.deepStrictEqual(ai.aiCheckReply('5 baje aa jaiye', allowed), []);
assert.deepStrictEqual(ai.aiTimesIn('at 5:30 PM, 17:00 or 9 baje'), [[17 * 60 + 30], [9 * 60, 21 * 60], [17 * 60]]);
ok('fact check: prices only from the KB, times only free / booked / opening, no foreign links, phone numbers or placeholders; Hinglish "baje"');

// ================================================================ routes
console.log('decision -> plan');
let r = planFor('How much does this cost?');
assert.deepStrictEqual([r.plan.route, r.plan.intent, r.plan.reply], ['reply', 'pricing', 'The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.']);
assert.deepStrictEqual(r.plan.lead_patch, { Lead_Stage: 'warm', AI_Summary: 'Asked about prices.' });
assert.deepStrictEqual(r.plan.conversation_patch, { Last_Intent: 'pricing' });
ok('pricing -> reply with the knowledge-base prices');

r = planFor('How much does this cost?', { edit: (d) => ({ ...d, reply: 'Only ₹199 this week!' }) });
assert.strictEqual(r.plan.route, 'handoff');
assert.strictEqual(r.plan.reason, 'the AI reply failed the fact check (details in Messages > AI_Reason)');
assert(/fact check: price 199/.test(r.plan.notes[0]));
assert.strictEqual(r.plan.reply, F.SETTINGS.handoff_reply || 'Thank you for your message. A member of our team will reply to you shortly.');
assert.deepStrictEqual(r.plan.conversation_patch, { Last_Intent: 'pricing', Needs_Human: true, Handoff_Reason: r.plan.reason });
ok('hallucinated price -> NOT sent; hand-off with the reason, the patient gets the hand-off message');

for (const intent of ai.AI_HUMAN_INTENTS) {
  r = planFor('How much does this cost?', { edit: (d) => ({ ...d, intent, needs_human: false, action: 'reply', reply: 'Sure.' }) });
  assert.strictEqual(r.plan.route, 'handoff', intent);
}
r = planFor('How much does this cost?', { edit: (d) => ({ ...d, confidence: 0.55 }) });
assert.deepStrictEqual([r.plan.route, r.plan.reason], ['handoff', 'low confidence (0.55)']);
assert.strictEqual(ai.aiPlan(null, ctx('x').x, CFG).route, 'handoff');
ok('complaint / human request / payment / medical always go to a person; confidence < 0.7 too; no valid AI answer too');

r = planFor('Can I come tomorrow evening?');
assert.deepStrictEqual([r.plan.route, r.plan.reply], ['offer_slots', 'Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free. Which one suits you?']);
r = planFor('Can I come tomorrow evening?', { edit: (d) => ({ ...d, reply: 'Yes, 5 PM tomorrow is free!' }) });
assert.strictEqual(r.plan.route, 'offer_slots');
assert.strictEqual(r.plan.reply, 'Here are the free times. Free times: Wed 07 Oct 4:00 PM, Wed 07 Oct 4:30 PM, Wed 07 Oct 5:30 PM. Which one would you like?');
assert(/not free/.test(r.plan.notes[0]));
ok('availability: real free evening times; an invented one (5 PM is taken) is replaced by the real ones');

r = planFor('Book me for Saturday at 5.');
assert.deepStrictEqual([r.plan.route, r.plan.reply], ['book_slot', 'Saturday at 5:00 PM is free. Please confirm your booking here: {{BOOKING_LINK}}']);
assert.strictEqual(r.plan.links['{{BOOKING_LINK}}'], 'https://cal.com/demo-physio/assessment?date=2026-10-10&month=2026-10');
assert.deepStrictEqual([r.plan.action_writes, r.plan.lead_patch.Status], [[], undefined]);
r = planFor('Book me for Saturday at 5.', { edit: (d) => ({ ...d, reply: 'Done, you are booked for Saturday 5 PM!' }) });
assert.strictEqual(r.plan.reply, 'Sat 10 Oct at 5:00 PM is free. Please confirm it here: {{BOOKING_LINK}}');
r = planFor('Book me for Saturday at 5.', { edit: (d) => ({ ...d, booking: { ...d.booking, date: '2026-10-07', time: '17:00' }, reply: 'Wednesday 5 PM is free.' }) });
assert.strictEqual(r.plan.route, 'offer_slots');
assert(/not available/.test(r.plan.reply) && !/5:00 PM/.test(r.plan.reply.split('Free times:')[1].split(',')[0]));
r = planFor('Book me for Saturday at 5.', { edit: (d) => ({ ...d, booking: { ...d.booking, date: '2026-12-25' } }) });
assert(/outside the next 7 days/.test(r.plan.reason));
ok('booking (link mode): a free slot gets the Cal.com link for that day; "booked" claims are replaced (nothing is booked until they confirm); a taken slot -> real alternatives; dates outside the calendar -> person');

r = planFor('Book me for Saturday at 5.', { settingsOver: { booking_mode: 'direct' } });
assert.strictEqual(r.plan.route, 'book_slot');
assert.deepStrictEqual(r.plan.action_writes, [{ method: 'POST', table: 'Appointments', body: { records: [{ fields: { Booking_UID: 'wa-wamid.NEW.4', Lead: 1, Service: 'Appointment', Start: F.at('2026-10-10', '17:00'), End: F.at('2026-10-10', '17:30'), Status: 'Booked' } }] } }]);
assert.strictEqual(r.plan.lead_patch.Status, 'Booked');
assert(!r.plan.reply.includes('{{BOOKING_LINK}}'));
ok('booking (direct mode): one Appointments row (Booking_UID wa-<message id> = idempotent), lead Booked');

r = planFor('Cancel my appointment tomorrow.');
assert.deepStrictEqual([r.plan.route, r.plan.links], ['cancel_link', { '{{CANCEL_LINK}}': 'https://cal.com/booking/cal-uid-asha-1?cancel=true' }]);
assert.deepStrictEqual(r.plan.action_writes, []);
r = planFor('Cancel my appointment tomorrow.', { edit: (d) => ({ ...d, reply: 'Your appointment is cancelled.' }) });
assert.strictEqual(r.plan.reply, 'To cancel your appointment on Wed 07 Oct 10:00 AM, please use this link: {{CANCEL_LINK}}');
ok('cancel (online booking): the Cal.com cancel link for THAT booking (Cal.com cancels, W4 updates Grist); a false "cancelled" is replaced');

const ravi = { lead: rec([F.leadRows()[2]]), conversation: rec([{ id: 2, fields: { Lead: 3, Phone: '+919000000015' } }]), history: rec([NEW_MSG('Cancel my appointment', { Conversation: 2 })]), msg: NEW_MSG('Cancel my appointment', { Conversation: 2 }) };
r = planFor('Cancel my appointment', ravi);
assert.deepStrictEqual([r.plan.route, r.plan.action_writes], ['cancelled', [{ method: 'PATCH', table: 'Appointments', body: { records: [{ id: 3, fields: { Status: 'Cancelled' } }] } }]]);
r = planFor('Move my appointment to Friday 11', { ...ravi, edit: (d) => ({ ...d, intent: 'reschedule_appointment', action: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-09', time: '11:00', time_window: null }, reply: 'Done, moved to Friday 11:00 AM.' }) });
assert.strictEqual(r.plan.route, 'rescheduled');
assert.deepStrictEqual(r.plan.action_writes.map((w) => `${w.method} ${JSON.stringify(w.body.records[0].fields.Status)}`), ['PATCH "Rescheduled"', 'POST "Booked"']);
ok('WhatsApp bookings: cancel = Status Cancelled; reschedule to a free time = old row Rescheduled + new Booked row');

r = planFor('Cancel my appointment', { appointments: rec([]), edit: (d) => ({ ...d, intent: 'cancel_appointment', action: 'cancel_appointment', needs_human: false, confidence: 0.9, appointment_ref: 'A1', reply: 'ok {{CANCEL_LINK}}' }) });
assert(/no upcoming appointment/.test(r.plan.reason));
const two = rec([...F.appointmentRows(), { id: 9, fields: { Booking_UID: 'cal-uid-asha-2', Lead: 1, Start: F.at('2026-10-09', '10:00'), Status: 'Booked' } }]);
r = planFor('Cancel my appointment tomorrow.', { appointments: two, edit: (d) => ({ ...d, appointment_ref: null }) });
assert.deepStrictEqual([r.plan.route, r.plan.reply], ['reply', 'Which appointment do you mean? 1) Wed 07 Oct 10:00 AM, 2) Fri 09 Oct 10:00 AM']);
ok('cancel with no appointment -> person; two appointments and no ref -> asks which one');

r = planFor('I will think about it');
assert.deepStrictEqual([r.plan.route, r.plan.lead_patch.Next_Action_At], ['follow_up', F.sec(F.NOW) + 3 * F.DAY]);
r = planFor('thanks');
assert.strictEqual(r.plan.route, 'no_reply');
r = planFor('Do you accept XYZ insurance?');
assert.deepStrictEqual([r.plan.route, r.plan.reason], ['handoff', 'question not covered by the knowledge base']);
ok('"I\'ll think about it" -> Next_Action_At in 3 days; "thanks" -> no reply; unknown question -> person');

r = planFor('Can I come tomorrow evening?', { settingsOver: { open_time: undefined } });
assert.deepStrictEqual([r.plan.route, r.plan.reply, r.plan.links['{{BOOKING_LINK}}']], ['offer_slots', 'Please pick a time that suits you here: {{BOOKING_LINK}}', F.SETTINGS.booking_link]);
r = planFor('Can I come tomorrow evening?', { settingsOver: { open_time: undefined }, edit: (d) => ({ ...d, reply: 'Tomorrow 5 PM works!' }) });
assert.deepStrictEqual([r.plan.route, r.plan.reply], ['offer_slots', 'Please choose a free time here: {{BOOKING_LINK}}']);
r = planFor('Can I come tomorrow evening?', { settingsOver: { open_time: undefined, booking_link: undefined } });
assert.strictEqual(r.plan.route, 'handoff');
r = planFor('How much does this cost?', { edit: (d) => ({ ...d, reply: 'Book here: {{BOOKING_LINK}}' }) });
assert.deepStrictEqual([r.plan.route, r.plan.links['{{BOOKING_LINK}}']], ['reply', F.SETTINGS.booking_link]);
r = planFor('How much does this cost?', { edit: (d) => ({ ...d, reply: 'Cancel: {{CANCEL_LINK}}' }) });
assert.strictEqual(r.plan.route, 'handoff');
ok('no clinic hours: booking link instead of times (no link -> person); every placeholder gets a real link or the message goes to a person');

// ================================================================ sends + writes
console.log('sends and CRM writes');
r = planFor('How much does this cost?');
let items = ai.aiSendItems(r.plan, r.x, h);
assert.strictEqual(items.length, 1);
assert.deepStrictEqual({ ...items[0], decision: undefined }, {
  source_workflow: 'W13-ai-receptionist', wa_phone_number_id: '123456789012345', grist_base_url: 'http://grist:8484', doc_id: 'DOCA', decision: undefined,
  w13_kind: 'patient_reply', audience: 'patient', message_type: 'text', text_body: r.plan.reply, message_text: r.plan.reply, template: '', lead_row_id: 1, lead_phone: F.ASHA, last_inbound_at: F.sec(F.NOW) - 10,
});
assert.deepStrictEqual(items[0].decision, { send: true, to: '+919000000019', reason: 'test mode: sent to TEST_PHONE', test_mode: true });
ok('reply -> ONE free-text item for W12; TEST_MODE sends it to TEST_PHONE; the 24-hour window uses the patient\'s message time');

let w = ai.aiFinalWrites(r.plan, r.x, { patient: sent() }, F.sec(F.NOW));
assert.strictEqual(w.status, 'replied');
assert.deepStrictEqual(table(w.writes, 'Messages'), [{ id: 4, fields: { Intent: 'pricing', AI_Action: 'reply', AI_Confidence: 0.92, AI_Status: 'replied', Needs_Human: false, AI_Reply: r.plan.reply, AI_Reason: '' } }]);
assert.deepStrictEqual(table(w.writes, 'Conversations'), [{ id: 1, fields: { Last_Intent: 'pricing' } }]);
assert.deepStrictEqual(table(w.writes, 'LEADS'), [{ id: 1, fields: { Lead_Stage: 'warm', AI_Summary: 'Asked about prices.', First_Response_At: F.sec(F.NOW) } }]);
assert.deepStrictEqual(table(w.writes, 'Run_Log')[0].fields, { Workflow: 'W13-ai-receptionist', Record: 'L-20261001-0001 wamid.NEW.4 pricing -> reply (replied)', Outcome: 'ok', Error: '', At: F.sec(F.NOW) });
w = ai.aiFinalWrites(r.plan, { ...r.x, lead: { ...r.x.lead, status: 'New' } }, { patient: sent() }, F.sec(F.NOW));
assert.strictEqual(table(w.writes, 'LEADS')[0].fields.Status, 'Contacted');
ok('replied: message row (intent, action, confidence, status, reply), conversation Last_Intent, lead stage / summary / first response, New -> Contacted, Run_Log ok');

w = ai.aiFinalWrites(r.plan, r.x, { patient: sent({ sent: false, send_status: 'blocked', send_error: 'quiet hours (21:00-08:00 IST)' }) }, F.sec(F.NOW));
assert.strictEqual(w.status, 'deferred');
assert.deepStrictEqual(w.writes.map((x) => x.table), ['Messages', 'Run_Log']);
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent({ sent: false, send_status: 'rejected', send_error: '131047: outside the 24h window' }) }, F.sec(F.NOW));
assert.deepStrictEqual([w.status, w.needs_human, table(w.writes, 'Run_Log')[0].fields.Outcome], ['failed', true, 'failed']);
assert.strictEqual(table(w.writes, 'Conversations')[0].fields.Needs_Human, true);
assert(/131047/.test(table(w.writes, 'Messages')[0].fields.AI_Reason));
w = ai.aiFinalWrites(r.plan, r.x, { patient: null }, F.sec(F.NOW));
assert.strictEqual(w.status, 'failed');
ok('not sent: quiet hours -> deferred (only the message + Run_Log; the 08:05 run tries again); Meta refused / W12 gave nothing -> failed + Needs_Human');

r = planFor('Do you accept XYZ insurance?');
items = ai.aiSendItems(r.plan, r.x, h);
assert.deepStrictEqual(items.map((i) => i.w13_kind), ['patient_reply', 'staff_alert']);
assert.deepStrictEqual(items[1].template_params, { clinic_name: 'Demo Physio', lead_name: 'Asha Patel', lead_phone: F.ASHA, reason: 'question not covered by the knowledge base' });
assert.deepStrictEqual([items[1].template, items[1].audience, items[1].decision.to], ['human_handoff_alert', 'staff', '+919000000019']);
w = ai.aiFinalWrites(r.plan, r.x, { patient: sent(), staff: sent() }, F.sec(F.NOW));
assert.deepStrictEqual([w.status, w.needs_human], ['handed_off', true]);
assert.deepStrictEqual(table(w.writes, 'Conversations')[0].fields, { Last_Intent: 'other', Needs_Human: true, Handoff_Reason: 'question not covered by the knowledge base' });
assert(!('Status' in table(w.writes, 'LEADS')[0].fields) && !('First_Response_At' in table(w.writes, 'LEADS')[0].fields));
ok('hand-off: polite holding reply + staff alert (human_handoff_alert); conversation Needs_Human; lead NOT marked Contacted (W3 keeps chasing staff)');

const draftX = { ...r.x, cfg: { ...r.x.cfg, reply_mode: 'draft' } };
r = planFor('How much does this cost?', { settingsOver: { ai_mode: 'draft' } });
assert.deepStrictEqual(ai.aiSendItems(r.plan, r.x, h), []);
w = ai.aiFinalWrites(r.plan, r.x, {}, F.sec(F.NOW));
assert.deepStrictEqual([w.status, table(w.writes, 'Messages')[0].fields.AI_Reply], ['drafted', r.plan.reply]);
assert.strictEqual(ai.aiSendItems(ai.aiPlan(F.fakeDecide(ai.aiBuildRequest(draftX, CFG)), draftX, CFG), draftX, h).map((i) => i.w13_kind).join(), 'staff_alert');
ok('draft mode: nothing is sent to the patient; the reply waits in Messages > AI_Reply for staff (hand-off alerts still reach staff)');

c = ctx('STOP');
let gp = ai.aiGatePlan(c.gate, c.x, CFG);
w = ai.aiFinalWrites(gp, c.x, {}, F.sec(F.NOW));
assert.deepStrictEqual([w.status, table(w.writes, 'LEADS')[0].fields, ai.aiSendItems(gp, c.x, h)], ['opted_out', { Opted_Out: true }, []]);
c = ctx('x', { msgFields: { AI_Status: 'replied' } });
w = ai.aiFinalWrites(ai.aiGatePlan(c.gate, c.x, CFG), c.x, {}, F.sec(F.NOW));
assert.deepStrictEqual(w.writes, []);
c = ctx('x', { now: Date.parse('2026-10-06T22:00:00+05:30') });
w = ai.aiFinalWrites(ai.aiGatePlan(c.gate, c.x, CFG), c.x, {}, F.sec(F.NOW));
assert.deepStrictEqual([w.status, w.writes.map((x) => x.table)], ['deferred', ['Messages', 'Run_Log']]);
c = ctx('x', { settings: { error: 'Grist 500' } });
w = ai.aiFinalWrites(ai.aiGatePlan(c.gate, c.x, CFG), c.x, {}, F.sec(F.NOW));
assert.deepStrictEqual([w.status, table(w.writes, 'Run_Log')[0].fields.Outcome], ['failed', 'failed']);
ok('STOP -> lead Opted_Out, no message; already handled -> no writes at all; night -> deferred; Settings unreadable -> failed in Run_Log');

c = ai.aiContext({ ...raw('x'), start: { dry_run: true, patient_phone: '9000000012', text: 'How much does this cost?' }, lead: rec([]), conversation: rec([]), history: rec([]) }, CFG, F.NOW, h);
r = { plan: ai.aiPlan(F.fakeDecide(ai.aiBuildRequest(c.x, CFG)), c.x, CFG) };
w = ai.aiFinalWrites(r.plan, c.x, {}, F.sec(F.NOW));
assert.deepStrictEqual([w.status, w.writes, w.reply.startsWith('The first assessment costs ₹500')], ['dry_run', [], true]);
ok('dry run: the decision and the reply are reported; nothing is written');

console.log('\nAll ai-receptionist cases pass');
