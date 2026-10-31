// Run: node n8n/snippets/ai-receptionist-central.test.js
// Slice 4C: W13 books, cancels and moves appointments only through the FLOW HQ booking API. Unit tests for the generated snippet
// n8n/snippets/ai-receptionist-central.js (made by n8n/final/tools/patch-4c-w13-booking.js from ai-receptionist.js): the free times come from the booking system,
// nothing changes until the patient says YES to a question naming the exact day and time, the patient is told "done" only after a 200/201, no Cal.com link exists.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ai = require('./ai-receptionist-central');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const CFG = { model: 'claude-haiku-4-5', leads_table: 'LEADS', min_confidence: 0.7, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, staff_alert_template: 'human_handoff_alert' };
const CLINIC = { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' };
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (rows) => ({ records: clone(rows) });
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const CAL = ai.aiCalendar(F.NOW, 7);
const TOMORROW = CAL[1].date;          // Wed 07 Oct 2026 (NOW = Tue 06 Oct 11:00 IST)
const DAY3 = CAL[2].date;
const slot = (date, start, end, doctor = 'DR-001', name = 'Dr. Mahesh Tiwari') => ({ slot_id: `${doctor}|${date}|${start}`, date, start_time: start, end_time: end, doctor_id: doctor, doctor_name: name, shift: 'morning', remaining_capacity: 1 });
const CENTRAL = (over = {}) => ({ configured: true, ok: true, available: true, ai_reason: '', reason: '', days: [
  { date: TOMORROW, slots: [slot(TOMORROW, '10:00', '10:30'), slot(TOMORROW, '10:30', '11:00'), slot(TOMORROW, '17:00', '17:30', 'DR-002', 'Dr. Sandeep Tiwari')] },
  { date: DAY3, slots: [slot(DAY3, '09:00', '09:30')] },
], ...over });
const NEW_MSG = (text, over = {}) => ({ id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: 'wamid.NEW.4', Status: 'Received', Created_At: F.sec(F.NOW) - 10, ...over } });
const ASK = (kind, text, ageSec = 120) => ({ id: 9, fields: { Conversation: 1, Direction: 'Out', Body: ai.aiConfirmAsk(kind, text), Sent_By: 'W13-ai-receptionist', Created_At: F.sec(F.NOW) - ageSec } });
function raw(text, o = {}) {
  const msg = NEW_MSG(text, o.msgFields);
  return {
    start: { message_row_id: 4, wa_message_id: 'wamid.NEW.4', msg_type: 'text' },
    clinic: CLINIC,
    settings: rec(F.settingsRows(o.settingsOver)),
    knowledge: rec(F.KNOWLEDGE),
    message: rec([msg]),
    conversation: rec(F.conversationRows()),
    lead: rec([F.leadRows()[0]].map((l) => ({ ...l, fields: { ...l.fields, ...(o.leadFields || {}) } }))),
    history: rec([...F.messageRows(), msg, ...(o.extraHistory || [])]),
    appointments: rec(F.appointmentRows()),
    central: 'central' in o ? o.central : CENTRAL(),
  };
}
const ctx = (text, o = {}) => ai.aiContext(raw(text, o), { ...CFG, ...(o.cfg || {}) }, F.NOW, h);
const decision = (action, over = {}) => ({ ...clone(F.BASE_DECISION), intent: 'book_appointment', action, confidence: 0.95, lead_stage: 'hot', reply: 'Sure, that works.', ...over });
const planFor = (text, d, o = {}) => {
  const { x, gate } = ctx(text, o);
  assert.strictEqual(gate.route, 'ai', `gate: ${gate.reason}`);
  assert.deepStrictEqual(ai.aiValidateDecision(d), []);
  return { x, plan: ai.aiPlan(d, x, { ...CFG, ...(o.cfg || {}) }) };
};
const BOOK_10 = (over = {}) => decision('book_slot', { booking: { date: TOMORROW, time: '10:00', time_window: null }, ...over });
const LABEL_10 = `${ai.aiDayLabel(TOMORROW)} at 10:00 AM with Dr. Mahesh Tiwari`;
const ok201 = { status: 201, body: { replayed: false, appointment: { booking_reference: 'wa-GKA-000042', status: 'Confirmed', doctor_name: 'Dr. Mahesh Tiwari' } } };
const toldBooked = (s) => /\bbooked\b|\bconfirmed\b|appointment is moved|is cancelled/i.test(s);

// ---------------------------------------------------------------- Cal.com and direct mode are gone
test('no Cal.com link is ever accepted: https links only, never a Cal.com host; booking_mode is always central and direct is ignored', () => {
  for (const bad of ['https://cal.com/clinic/30min', 'https://app.cal.com/x', 'https://CAL.com/x', 'https://clinic.cal.com/x', 'https://cal.eu/x', 'http://example.com/x', 'ftp://x', '', undefined]) assert.strictEqual(ai.aiSafeLink(bad), '', String(bad));
  assert.strictEqual(ai.aiSafeLink('https://www.demophysio.example/book'), 'https://www.demophysio.example/book');
  assert.strictEqual(ai.aiSafeLink('https://notcal.com.example/x'), 'https://notcal.com.example/x', 'only the real Cal.com hosts');
  const p = ai.aiProfile({ booking_mode: 'direct', booking_link: 'https://cal.com/x/y' }, 'Clinic');
  assert.deepStrictEqual([p.booking_mode, p.direct_requested, p.booking_link], ['central', true, '']);
  assert.strictEqual(ai.aiProfile({}, 'C').direct_requested, false);
  const x = ctx('hello', { settingsOver: { booking_mode: 'direct' } }).x;
  assert(x.notes.some((t) => /booking_mode = direct is ignored/.test(t)));
});

test('the prompt and the facts mention no Cal.com, no cancel or reschedule link, and say the system asks for YES', () => {
  const x = ctx('hello').x;
  const text = `${ai.AI_RULES}\n${ai.aiClinicFacts(x)}\n${ai.aiFacts(x)}`;
  assert(!/cal\.com|CANCEL_LINK|RESCHEDULE_LINK|booked online|books directly|book through the link/i.test(text.replace(/\{\{BOOKING_LINK\}\}/g, '')), 'no Cal.com or cancel / reschedule link text');
  assert(/confirms? with YES|answers YES|confirm one exact day and time/i.test(text));
  assert(/Never say a booking is made or confirmed/.test(ai.AI_RULES));
});

// ---------------------------------------------------------------- availability from the booking system
test('free times come from the booking system: unconfigured / unreachable / AI booking off = not known, with the reason', () => {
  const p = ai.aiProfile({}, 'C');
  for (const [c, why] of [[null, /not set up/], [{ configured: false }, /not set up/], [CENTRAL({ ok: false, reason: 'the booking system did not answer' }), /did not answer/], [CENTRAL({ available: false, ai_reason: 'disabled' }), /switched off in the CRM \(disabled\)/]]) {
    const s = ai.aiCentralSlots(c, p, F.NOW, 7);
    assert.deepStrictEqual([s.known, s.days.length], [false, 0]);
    assert.match(s.reason, why);
  }
  const x = ctx('Can I come tomorrow?', { central: CENTRAL({ ok: false, reason: 'the booking system did not answer' }) }).x;
  assert.strictEqual(x.slots.known, false);
  assert(x.notes.some((t) => /booking system: the booking system did not answer/.test(t)));
  assert(/not known right now\. Do not offer any time/.test(ai.aiFacts(x)));
});

test('known slots: unique times per day, the first doctor per time is the one booked, slot length and opening times from the slots', () => {
  const x = ctx('Can I come tomorrow?').x;
  assert.strictEqual(x.slots.known, true);
  assert.deepStrictEqual(x.slots.days.map((d) => [d.date, d.times.map(ai.aiHHMM)]), [[TOMORROW, ['10:00', '10:30', '17:00']], [DAY3, ['09:00']]]);
  assert.deepStrictEqual([x.slots.slot_minutes, x.slots.open, x.slots.close], [30, 9 * 60, 17 * 60 + 30]);
  assert.strictEqual(x.slots.by_key[`${TOMORROW}|10:00`].slot_id, `DR-001|${TOMORROW}|10:00`);
  const two = CENTRAL(); two.days[0].slots.push(slot(TOMORROW, '10:00', '10:30', 'DR-002', 'Dr. Sandeep Tiwari'));
  assert.strictEqual(ai.aiCentralSlots(two, ai.aiProfile({}, 'C'), F.NOW, 7).by_key[`${TOMORROW}|10:00`].doctor_id, 'DR-001');
  assert(/AVAILABILITY[\s\S]*10:00, 10:30, 17:00/.test(ai.aiFacts(x)));
  for (const bad of [{ slot_id: '', start_time: '10:00' }, { slot_id: 'x', start_time: '25' }]) {
    const c = CENTRAL(); c.days[0].slots = [bad]; assert.deepStrictEqual(ai.aiCentralSlots(c, ai.aiProfile({}, 'C'), F.NOW, 7).days.filter((d) => d.date === TOMORROW), []);
  }
});

test('no free times known and no safe link: a booking request is a hand-off (never an invented time, never a Cal.com link)', () => {
  const { plan } = planFor('Book tomorrow 10 am please', BOOK_10(), { central: null });
  assert.strictEqual(plan.route, 'handoff');
  assert(/cannot offer times right now/.test(plan.reason));
  assert.strictEqual(plan.central, null);
});

// ---------------------------------------------------------------- explicit confirmation
test('first request: the patient is ASKED to confirm the exact day, time and doctor; nothing is booked and no write is planned', () => {
  const { plan } = planFor('Book tomorrow 10 am please', BOOK_10({ reply: 'Booked! See you tomorrow at 10.' }));
  assert.strictEqual(plan.route, 'offer_slots');
  assert.strictEqual(plan.reply, ai.aiConfirmAsk('book', LABEL_10));
  assert(plan.reply.includes(ai.AI_CONFIRM_MARK) && !toldBooked(plan.reply), 'the AI wording ("Booked!") is not used');
  assert.deepStrictEqual([plan.central, plan.action_writes.length, plan.booked], [null, 0, null]);
  assert(plan.notes.some((t) => /asked the patient to confirm/.test(t)));
});

test('YES to that question: one create request with the slot id, the patient and a stable idempotency key; still no Grist write', () => {
  const { plan, x } = planFor('Yes', BOOK_10(), { extraHistory: [ASK('book', LABEL_10)] });
  assert.strictEqual(plan.route, 'book_slot');
  assert.deepStrictEqual(plan.action_writes, []);
  assert.strictEqual(plan.booked, null);
  const c = plan.central;
  assert.deepStrictEqual([c.op, c.slot_id, c.label, c.patient.phone, c.service], ['create', `DR-001|${TOMORROW}|10:00`, `${ai.aiDayLabel(TOMORROW)} at 10:00 AM`, F.ASHA, 'Physiotherapy']);
  assert.match(c.idem_key, /^[A-Za-z0-9._:-]{8,64}$/);
  assert.strictEqual(c.idem_key, ai.aiIdemKey(x.msg.wa_message_id, c.slot_id));
  assert.notStrictEqual(ai.aiIdemKey('wamid.A', 'DR-001|2026-10-07|10:00'), ai.aiIdemKey('wamid.B', 'DR-001|2026-10-07|10:00'));
  assert.notStrictEqual(ai.aiIdemKey('wamid.A', 'DR-001|2026-10-07|10:00'), ai.aiIdemKey('wamid.A', 'DR-001|2026-10-07|10:30'));
  assert(!toldBooked(plan.reply), `before the answer nothing is claimed: ${plan.reply}`);
});

test('a YES that does not match the question is not a confirmation: other time, other doctor, a stale question, a question from the patient, a yes that is not at the start', () => {
  const cases = [
    ['a different time was asked about', 'Yes', [ASK('book', `${ai.aiDayLabel(TOMORROW)} at 10:30 AM with Dr. Mahesh Tiwari`)]],
    ['a different doctor', 'Yes', [ASK('book', `${ai.aiDayLabel(TOMORROW)} at 10:00 AM with Dr. Sandeep Tiwari`)]],
    ['the question is four hours old', 'Yes', [ASK('book', LABEL_10, 4 * 3600)]],
    ['no question was asked', 'Yes', []],
    ['it was a cancel question', 'Yes', [ASK('cancel', LABEL_10)]],
    ['the patient did not say yes', 'Book tomorrow at 10', [ASK('book', LABEL_10)]],
    ['yes is not the first word', 'I think so, yes', [ASK('book', LABEL_10)]],
    ['no', 'No thanks', [ASK('book', LABEL_10)]],
  ];
  for (const [name, text, extra] of cases) {
    const { plan } = planFor(text, BOOK_10(), { extraHistory: extra });
    assert.strictEqual(plan.central, null, name);
    assert(plan.reply.includes(ai.AI_CONFIRM_MARK), `${name}: asked again`);
  }
  // a clinic question followed by another clinic message: only the NEWEST clinic message counts
  const newer = { id: 10, fields: { Conversation: 1, Direction: 'Out', Body: 'We are open 9 to 1.', Sent_By: 'W13-ai-receptionist', Created_At: F.sec(F.NOW) - 60 } };
  assert.strictEqual(planFor('Yes', BOOK_10(), { extraHistory: [ASK('book', LABEL_10), newer] }).plan.central, null);
  for (const yes of ['yes', 'Yes please', 'ok', 'Okay.', 'haan', 'Ji haan', 'theek hai', 'हाँ', 'ठीक है', 'confirm', '👍']) assert.strictEqual(planFor(yes, BOOK_10(), { extraHistory: [ASK('book', LABEL_10)] }).plan.central.op, 'create', yes);
});

test('a time that is not free is never booked (the real free times are offered); a patient with no valid phone is a hand-off', () => {
  const bad = planFor('Yes', BOOK_10({ booking: { date: TOMORROW, time: '12:00', time_window: null } }), { extraHistory: [ASK('book', LABEL_10)] }).plan;
  assert.strictEqual(bad.central, null);
  assert.strictEqual(bad.route, 'offer_slots');
  assert(/Free times:/.test(bad.reply));
  const noPhone = planFor('Yes', BOOK_10(), { extraHistory: [ASK('book', LABEL_10)], leadFields: { Phone: '12' } }).plan;
  assert.strictEqual(noPhone.route, 'handoff');
});

test('the model\'s own reply text is not needed for book / cancel / move (the system writes it), but every other action still needs it', () => {
  const ask = planFor('Book tomorrow 10 am please', BOOK_10({ reply: '' })).plan;
  assert.strictEqual(ask.reply, ai.aiConfirmAsk('book', LABEL_10));
  const yes = planFor('Yes', BOOK_10({ reply: '' }), { extraHistory: [ASK('book', LABEL_10)] }).plan;
  assert.strictEqual(yes.central.op, 'create');
  const cx = planFor('Yes', decision('cancel_appointment', { intent: 'cancel_appointment', appointment_ref: 'A1', reply: '' }), { extraHistory: [ASK('cancel', 'Wed 07 Oct 10:00 AM')] }).plan;
  assert.strictEqual(cx.central.op, 'cancel');
  const none = planFor('hello', decision('reply', { intent: 'greeting', reply: '' })).plan;
  assert.strictEqual(none.route, 'handoff'); assert(/no reply text/.test(none.reason));
});

test('an appointment change needs full confidence (confidence_write), like the old direct writes did', () => {
  const lowish = planFor('Yes', BOOK_10({ confidence: 0.8 }), { extraHistory: [ASK('book', LABEL_10)] }).plan;
  assert.strictEqual(lowish.route, 'handoff');
  assert.strictEqual(lowish.central, null);
});

// ---------------------------------------------------------------- cancel / reschedule
const A1 = 'Wed 07 Oct 10:00 AM';
test('cancel: asks first; after YES one cancel request keyed by the booking reference (an old Cal.com booking too) and the patient\'s phone; no link of any kind', () => {
  const d = decision('cancel_appointment', { intent: 'cancel_appointment', appointment_ref: 'A1', reply: 'Please use the link to cancel.' });
  const ask = planFor('Please cancel my appointment', d).plan;
  assert.deepStrictEqual([ask.central, ask.route, ask.reply], [null, 'reply', ai.aiConfirmAsk('cancel', A1)]);
  const go = planFor('Yes', d, { extraHistory: [ASK('cancel', A1)] });
  assert.deepStrictEqual(go.plan.central, { op: 'cancel', reference: 'cal-uid-asha-1', label: A1, patient_phone: F.ASHA });
  assert.deepStrictEqual([go.plan.links, go.plan.action_writes, go.plan.route], [{}, [], 'cancelled']);
  assert(!/cal\.com|https?:/i.test(JSON.stringify(go.plan)), 'no URL anywhere in the plan');
});

test('reschedule: asks first (from / to, with the doctor); after YES one move request with the new slot id', () => {
  const d = decision('reschedule_appointment', { intent: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: DAY3, time: '09:00', time_window: null }, reply: 'Use the link.' });
  const to = `from ${A1} to ${ai.aiDayLabel(DAY3)} at 9:00 AM with Dr. Mahesh Tiwari`;
  const ask = planFor('Move it to day after at 9', d).plan;
  assert.deepStrictEqual([ask.central, ask.reply], [null, ai.aiConfirmAsk('reschedule', to)]);
  const go = planFor('Yes', d, { extraHistory: [ASK('reschedule', to)] }).plan;
  assert.deepStrictEqual(go.central, { op: 'reschedule', reference: 'cal-uid-asha-1', slot_id: `DR-001|${DAY3}|09:00`, label: `${ai.aiDayLabel(DAY3)} at 9:00 AM`, from_label: A1, doctor_name: 'Dr. Mahesh Tiwari', patient_phone: F.ASHA });
  assert.deepStrictEqual([go.route, go.links, go.action_writes], ['rescheduled', {}, []]);
});

// ---------------------------------------------------------------- the booking system's answer
const withCentral = (extra, d = BOOK_10()) => { const r = planFor('Yes', d, { extraHistory: [ASK('book', LABEL_10)] }); return { ...r, apply: (res, dry = false) => { r.x.dry_run = dry; return ai.aiApplyCentral(r.plan, r.x, CFG, res); } }; };
const CANCEL_D = decision('cancel_appointment', { intent: 'cancel_appointment', appointment_ref: 'A1' });
const MOVE_D = decision('reschedule_appointment', { intent: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: DAY3, time: '09:00', time_window: null } });
const MOVE_TEXT = `from ${A1} to ${ai.aiDayLabel(DAY3)} at 9:00 AM with Dr. Mahesh Tiwari`;
const fresh = (kind, d, text) => { const r = planFor('Yes', d, { extraHistory: [ASK(kind, text)] }); return { ...r, apply: (res) => ai.aiApplyCentral(r.plan, r.x, CFG, res) }; };
const taken = { status: 409, body: { error: { code: 'slot_unavailable', reason: 'slot_full', availability: { date: TOMORROW, slots: [{ date: TOMORROW, start_time: '10:30' }, { date: TOMORROW, start_time: '17:00' }, { date: DAY3, start_time: '09:00' }, { date: DAY3, start_time: '09:30' }] } } } };

test('create: "booked" only after 200/201 with a booking reference; the lead becomes Booked; a replay (200) reads the same', () => {
  for (const res of [ok201, { status: 200, body: { replayed: true, appointment: ok201.body.appointment } }]) {
    const t = withCentral(); const plan = t.apply(res);
    assert.match(plan.reply, /^Your appointment is booked: .* at 10:00 AM with Dr\. Mahesh Tiwari\. Your reference is wa-GKA-000042\. See you then!$/);
    assert.deepStrictEqual([plan.route, plan.lead_patch.Status, plan.booking_ref], ['book_slot', 'Booked', 'wa-GKA-000042']);
  }
  const t = withCentral(); const plan = t.apply({ status: 201, body: {} });
  assert.strictEqual(plan.route, 'handoff', 'a 201 without an appointment is not a booking');
  assert(!toldBooked(plan.reply));
});

test('create: slot taken (409) = the new free times, never "booked"; with nothing else free = a hand-off', () => {
  const plan = withCentral().apply(taken);
  assert.strictEqual(plan.route, 'offer_slots');
  assert.match(plan.reply, /was just taken\. Free times: .* 10:30 AM, .* 5:00 PM, .* 9:00 AM\. Which one/);
  assert(!/9:30/.test(plan.reply), 'at most three');
  assert.strictEqual(plan.central, null);
  const none = withCentral().apply({ status: 409, body: { error: { code: 'slot_unavailable', availability: { slots: [] } } } });
  assert.strictEqual(none.route, 'handoff');
  const dup = withCentral().apply({ status: 409, body: { error: { code: 'duplicate_booking', booking_reference: 'wa-GKA-000007' } } });
  assert.match(dup.reply, /already have an appointment at that time \(reference wa-GKA-000007\)/);
});

test('create: AI booking off in the CRM, a server error, a network error, no answer, an unverified write = a hand-off that never says booked', () => {
  for (const [name, res] of [
    ['switched off', { status: 403, body: { error: { code: 'ai_booking_disabled', reason: 'disabled' } } }],
    ['write unverified', { status: 502, body: { error: { code: 'write_unverified' } } }],
    ['audit unavailable', { status: 503, body: { error: { code: 'audit_unavailable' } } }],
    ['unavailable', { status: 503, body: { error: { code: 'booking_unavailable' } } }],
    ['rate limited', { status: 429, body: {} }],
    ['token refused', { status: 401, body: { error: { code: 'unauthorized' } } }],
    ['network', { status: 0, error: 'connect ECONNREFUSED' }],
    ['no result at all', null],
  ]) {
    const plan = withCentral().apply(res);
    assert.strictEqual(plan.route, 'handoff', name);
    assert.strictEqual(plan.central, null, name);
    assert(!toldBooked(plan.reply), `${name}: ${plan.reply}`);
    assert(plan.conversation_patch.Needs_Human === true, name);
  }
  assert.match(withCentral().apply({ status: 403, body: { error: { code: 'ai_booking_disabled', reason: 'disabled' } } }).reason, /switched off in the CRM/);
  assert.match(withCentral().apply({ status: 502, body: { error: { code: 'write_unverified' } } }).reason, /check for .* before booking it again/);
});

test('dry run: the booking system is not called and the reply says so', () => {
  const t = withCentral(); const plan = t.apply(null, true);
  assert.match(plan.reply, /^\[dry run: nothing was sent to the booking system\]/);
});

test('cancel and reschedule results: done only on 200; a taken slot leaves the appointment where it was and offers times; anything else is a hand-off', () => {
  const c1 = fresh('cancel', CANCEL_D, A1).apply({ status: 200, body: { appointment: { status: 'Cancelled' }, already_cancelled: false } });
  assert.deepStrictEqual([c1.route, c1.reply], ['cancelled', `Your appointment on ${A1} is cancelled.`]);
  for (const res of [{ status: 409, body: { error: { code: 'cancel_too_late' } } }, { status: 404, body: { error: { code: 'not_found' } } }, { status: 0, error: 'timeout' }]) assert.strictEqual(fresh('cancel', CANCEL_D, A1).apply(res).route, 'handoff');
  const m1 = fresh('reschedule', MOVE_D, MOVE_TEXT).apply({ status: 200, body: { appointment: { status: 'Confirmed', doctor_name: 'Dr. Mahesh Tiwari' }, replayed: false } });
  assert.deepStrictEqual([m1.route, m1.reply], ['rescheduled', `Your appointment is moved to ${ai.aiDayLabel(DAY3)} at 9:00 AM with Dr. Mahesh Tiwari.`]);
  const m2 = fresh('reschedule', MOVE_D, MOVE_TEXT).apply(taken);
  assert.strictEqual(m2.route, 'offer_slots');
  assert.match(m2.reply, new RegExp(`was just taken\\. Your appointment on ${A1} is unchanged\\. Free times:`));
  assert.strictEqual(fresh('reschedule', MOVE_D, MOVE_TEXT).apply({ status: 409, body: { error: { code: 'change_too_late' } } }).route, 'handoff');
});

test('what is sent: the patient reply is free text through W12 with the right route; a hand-off adds the staff alert; the reply holds no URL', () => {
  const t = withCentral(); const plan = t.apply(ok201);
  const items = ai.aiSendItems(plan, t.x, h);
  assert.deepStrictEqual(items.map((i) => [i.w13_kind, i.message_type]), [['patient_reply', 'text']]);
  assert(!/https?:/.test(items[0].text_body));
  const off = withCentral(); const hp = off.apply({ status: 403, body: { error: { code: 'ai_booking_disabled' } } });
  assert.deepStrictEqual(ai.aiSendItems(hp, off.x, h).map((i) => i.w13_kind), ['patient_reply', 'staff_alert']);
});

// ---------------------------------------------------------------- structural guards on the generated file
test('the generated snippet has no Appointments write, no Cal.com URL builder, and is the repo snippet plus the 4C edits only', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ai-receptionist-central.js'), 'utf8');
  assert(!/table: 'Appointments'/.test(src), 'W13 writes no Appointments row');
  assert(!/\/reschedule\/|\?cancel=true|https:\/\/cal\.com/.test(src), 'no Cal.com link is built');
  assert(/GENERATED by n8n\/final\/tools\/patch-4c-w13-booking\.js/.test(src));
  const base = fs.readFileSync(path.join(__dirname, 'ai-receptionist.js'), 'utf8');
  assert(/table: 'Appointments'/.test(base), 'the original snippet is untouched (older lineages validate it)');
});

console.log(`ai-receptionist-central: ${n} tests passed`);
