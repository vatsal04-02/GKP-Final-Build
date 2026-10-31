// Slice 4C: W13 (the WhatsApp AI receptionist) in the SIMULATOR, behind W2, with a fake FLOW HQ booking API: fake Grist, Meta, OpenRouter, booking API. Nothing leaves this computer.
//   node n8n/final/tests/4c-w13-booking.test.js
// What is proved: the free times come from the booking API; nothing is booked, cancelled or moved until the patient says YES to a question naming the exact day and time;
// exactly one create / cancel / move request is made, with the booking credential and a stable Idempotency-Key; the patient is told "booked" only after the API says 201;
// W13 itself never writes an Appointments row; no Cal.com link reaches a patient; AI booking off / API down / token refused / slot just taken = a safe message or a hand-off.
// What is NOT proved: that the real FLOW HQ API behaves like this fake (the vitest API tests prove that) or that a real n8n runs these nodes (docs/n8n-staging.md).
'use strict';
const path = require('path');
const assert = require('assert');
process.env.PROD_FILE = process.env.FOURC_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4c.json');
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const H = require('../../production/tests/harness');
const { run, runItem, inboundRequest, messageBody, fakeMeta, rows, freshGrist, test, finish, clone, P, F, ENV, PNID } = H;

const wf = H.loadWf();
const T = F.sec(F.NOW);
const TODAY = '2026-10-06';
const DAY1 = '2026-10-07';                                   // tomorrow (Wed): the day the tests book
const CHAN = 'FlowHQ Booking API';
const BASE = 'http://flowhq:8787';

// ---------------------------------------------------------------- a fake FLOW HQ booking API (the contract of docs/booking-api.md, in miniature)
function fakeBooking(o = {}) {
  const st = { available: o.available !== false, down: !!o.down, status: o.status || null, taken: new Set(o.taken || []), race: new Set(), appts: new Map(), idem: new Map(), seq: 0 };
  const calls = [];
  const slotsOf = (date) => (date <= TODAY ? [] : ['10:00', '10:30', '17:00'].map((t, i) => ({ slot_id: `DR-00${i < 2 ? 1 : 2}|${date}|${t}`, date, start_time: t, end_time: t === '10:00' ? '10:30' : t === '10:30' ? '11:00' : '17:30', doctor_id: i < 2 ? 'DR-001' : 'DR-002', doctor_name: i < 2 ? 'Dr. Mahesh Tiwari' : 'Dr. Sandeep Tiwari', shift: i < 2 ? 'morning' : 'evening', remaining_capacity: 1 }))
    .filter((s) => !st.taken.has(s.slot_id)));
  const fn = (method, url, headers, body) => {
    calls.push({ method, url, headers: { ...headers }, body: body === undefined ? undefined : clone(body) });
    if (st.down) throw new Error('connect ECONNREFUSED 172.18.0.5:8787');
    if (st.status) return { status: st.status, body: { error: { code: st.status === 401 ? 'unauthorized' : 'backend_error' } } };
    const u = new URL(url);
    const m = u.pathname.match(/^\/api\/booking\/(availability|appointments)(?:\/([^/]+?))?(\/cancel)?$/);
    if (!m) return { status: 404, body: { error: { code: 'not_found' } } };
    if (m[1] === 'availability' && method === 'GET') {
      const date = u.searchParams.get('date');
      return { status: 200, body: { date, timezone: 'Asia/Kolkata', ai_booking: { available: st.available, reason: st.available ? null : 'disabled' }, closed: null, slots: st.available ? slotsOf(date) : [] } };
    }
    const open = (date) => slotsOf(date).filter((s) => !st.race.has(s.slot_id));   // race: still listed by /availability, but gone by the time of the booking call
    const offerAgain = (date) => ({ date, closed: null, slots: open(date) });
    if (m[1] === 'appointments' && method === 'POST' && !m[2]) {
      if (!st.available) return { status: 403, body: { error: { code: 'ai_booking_disabled', reason: 'disabled' } } };
      const key = headers['Idempotency-Key'];
      if (!/^[A-Za-z0-9._:-]{8,64}$/.test(String(key || ''))) return { status: 400, body: { error: { code: 'invalid_idempotency_key' } } };
      const date = body.slot_id.split('|')[1];
      if (st.idem.has(key)) return { status: 200, body: { replayed: true, appointment: st.idem.get(key) } };
      if (!open(date).some((s) => s.slot_id === body.slot_id)) return { status: 409, body: { error: { code: 'slot_unavailable', reason: 'slot_full', availability: offerAgain(date) } } };
      const appt = { booking_reference: `wa-GKA-${String(++st.seq).padStart(6, '0')}`, status: 'Confirmed', slot_id: body.slot_id, doctor_name: body.slot_id.startsWith('DR-001') ? 'Dr. Mahesh Tiwari' : 'Dr. Sandeep Tiwari', patient: { phone: body.patient.phone }, service: body.service };
      st.taken.add(body.slot_id); st.appts.set(appt.booking_reference, appt); st.idem.set(key, appt);
      return { status: 201, body: { replayed: false, appointment: appt } };
    }
    if (m[1] === 'appointments' && m[2] && method === 'POST' && m[3]) {
      if (m[2] !== 'cal-uid-asha-1' && !st.appts.has(m[2])) return { status: 404, body: { error: { code: 'not_found' } } };
      return { status: 200, body: { appointment: { booking_reference: m[2], status: 'Cancelled' }, already_cancelled: false } };
    }
    if (m[1] === 'appointments' && m[2] && method === 'PATCH') {
      if (!st.available) return { status: 403, body: { error: { code: 'ai_booking_disabled', reason: 'disabled' } } };
      const date = body.slot_id.split('|')[1];
      if (!slotsOf(date).some((s) => s.slot_id === body.slot_id)) return { status: 409, body: { error: { code: 'slot_unavailable', availability: offerAgain(date) } } };
      st.taken.add(body.slot_id);
      return { status: 200, body: { replayed: false, appointment: { booking_reference: m[2], status: 'Confirmed', doctor_name: 'Dr. Mahesh Tiwari' } } };
    }
    return { status: 404, body: { error: { code: 'not_found' } } };
  };
  fn.calls = calls; fn.st = st;
  const pathOf = (url) => String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  fn.of = (re) => calls.filter((c) => re.test(`${c.method} ${pathOf(c.url)}`));
  return fn;
}

// ---------------------------------------------------------------- the clinic and the patient
const leads = () => F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } }));
const crm = ({ settings = {}, appts = [] } = {}) => freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER, ...settings }), LEADS: leads(), Conversations: [], Messages: [], Appointments: clone(appts) });
const decision = (action, over = {}) => ({ ...clone(F.BASE_DECISION), intent: 'book_appointment', action, confidence: 0.95, lead_stage: 'hot', reply: 'Sure.', ...over });
const BOOK = (time = '10:00') => decision('book_slot', { booking: { date: DAY1, time, time_window: null } });
// a patient message arriving through W2; W13 runs behind it. `claude(body)` returns the AI's decision for this message.
function say(text, { g, booking, decide, env = {}, id = 'wamid.IN.1', at = 0, meta = fakeMeta() }) {
  const claude = F.fakeClaude(decide || (() => decision('reply', { intent: 'other', reply: 'Hello!' })));
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody(text, { id, from: P.ASHA, name: 'Asha Patel', ts: T + at })), {
    grist: g, now: F.NOW + at * 1000, openrouter: F.fakeOpenRouter(claude), meta, booking,
    env: { ...ENV, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}`, FLOWHQ_AI_EXTERNAL_ENABLED: 'true', FLOWHQ_BOOKING_API_URL: BASE, ...env },
  });
  const all = (r) => [r, ...(r.subRuns || []).flatMap(all)];
  for (const x of all(res.r)) assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`);
  return { res, claude, meta, g };
}
const sentTexts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? c.body.text.body : `[template ${c.body.template && c.body.template.name}]`));
const patientTexts = (meta) => meta.calls.filter((c) => c.body.to === P.ASHA.slice(1)).map((c) => (c.body.type === 'text' ? c.body.text.body : `[template ${c.body.template.name}]`));
const apptWrites = (g) => g.calls.filter((c) => c.table === 'Appointments' && c.method !== 'GET');
const lead = (g) => rows(g, 'LEADS').find((l) => l.id === 1);
const noCal = (texts) => texts.forEach((t) => assert(!/cal\.com|\/reschedule\/|cancel=true/i.test(t), `no Cal.com link: ${t}`));
const ASK_BOOK = `Shall I book Wed 07 Oct at 10:00 AM with Dr. Mahesh Tiwari? Reply YES to confirm.`;

// ---------------------------------------------------------------- the build
test('the booking nodes are wired: Appointments -> days -> availability -> collect -> Build Context, and Plan -> central calls? -> (split -> API ->) collect -> Action Writes?', () => {
  const edges = []; for (const [from, v] of Object.entries(wf.connections)) (v.main || []).forEach((o, i) => (o || []).forEach((c) => edges.push([from, c.node, i])));
  const out = (n) => edges.filter((e) => e[0] === n).map((e) => `${e[1]}#${e[2]}`);
  assert.deepStrictEqual(out('W13 – Appointments'), ['W13 – Availability days#0']);
  assert.deepStrictEqual(out('W13 – Availability days'), ['W13 – Booking availability#0']);
  assert.deepStrictEqual(out('W13 – Booking availability'), ['W13 – Availability collect#0']);
  assert.deepStrictEqual(out('W13 – Availability collect'), ['W13 – Build Context#0']);
  assert.deepStrictEqual(out('W13 – Plan'), ['W13 – Central calls?#0']);
  assert.deepStrictEqual(out('W13 – Central calls?'), ['W13 – Split central calls#0', 'W13 – Central collect#1']);
  assert.deepStrictEqual(out('W13 – Split central calls'), ['W13 – Booking API#0']);
  assert.deepStrictEqual(out('W13 – Booking API'), ['W13 – Central collect#0']);
  assert.deepStrictEqual(out('W13 – Central collect'), ['W13 – Action Writes?#0']);
  const cfg = wf.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((a) => a.name === 'booking_api_url');
  assert(/FLOWHQ_BOOKING_API_URL/.test(cfg.value) && !/localhost|flowhq:|http/.test(cfg.value.replace('FLOWHQ_BOOKING_API_URL', '')), 'the address comes from the environment, never from the workflow');
  const api = wf.nodes.find((n) => n.name === 'W13 – Booking API');
  assert.strictEqual(api.credentials.httpHeaderAuth.name, CHAN);
  assert(!/Bearer\s+\S|[A-Za-z0-9]{6,}\.[A-Za-z0-9_-]{24,}/.test(JSON.stringify(wf.nodes.filter((n) => /Booking|Central|Availability/.test(n.name)).map((n) => ({ ...n, credentials: undefined })))), 'no token in any node');
});

// ---------------------------------------------------------------- availability
test('the free times are the booking API\'s: one GET per day with the booking credential, and the AI is told those times (not the Settings hours)', () => {
  const booking = fakeBooking();
  const x = say('Do you have a slot tomorrow?', { g: crm(), booking, decide: () => decision('reply', { intent: 'availability_check', reply: 'Let me check.' }) });
  const gets = booking.of(/^GET \/api\/booking\/availability$/);
  assert.strictEqual(gets.length, 7, 'slot_days = 7');
  assert.deepStrictEqual(gets.map((c) => new URL(c.url).searchParams.get('date'))[0], TODAY);
  const facts = x.claude.calls[0].body.system.map((b) => b.text).join('\n');
  assert(new RegExp(`- ${DAY1} \\([^)]*\\): 10:00, 10:30, 17:00`).test(facts), facts.slice(facts.indexOf('AVAILABILITY'), facts.indexOf('AVAILABILITY') + 400));
  assert(/booking link: none/.test(facts), 'the Cal.com booking_link in Settings is not offered to the AI');
  assert(!/cal\.com/i.test(facts), 'no Cal.com text reaches the AI');
  assert.strictEqual(booking.of(/^(POST|PATCH)/).length, 0);
});

test('not configured / API down / token refused / AI booking off in the CRM: no time is offered, a booking request goes to a person, nothing is written', () => {
  const cases = [
    ['no address', { env: { FLOWHQ_BOOKING_API_URL: '' }, booking: fakeBooking() }],
    ['down', { booking: fakeBooking({ down: true }) }],
    ['token refused', { booking: fakeBooking({ status: 401 }) }],
    ['AI booking off', { booking: fakeBooking({ available: false }) }],
  ];
  for (const [name, o] of cases) {
    const g = crm();
    const meta = fakeMeta();
    const x = say('Book me for tomorrow at 10', { g, meta, decide: () => BOOK(), ...o });
    const facts = x.claude.calls[0].body.system.map((b) => b.text).join('\n');
    assert(/AVAILABILITY[^\n]*\n- not known right now/.test(facts), `${name}: the AI is told no time is known`);
    assert.deepStrictEqual(apptWrites(g), [], `${name}: no Appointments write`);
    assert.strictEqual(o.booking.of(/^(POST|PATCH)/).length, 0, `${name}: no booking call`);
    const texts = patientTexts(meta);
    texts.forEach((t) => assert(!/booked|confirmed/i.test(t), `${name}: ${t}`));
    noCal(sentTexts(meta));
    assert(rows(g, 'Messages').some((m) => m.Direction === 'In' && /handed_off/.test(m.AI_Status)), `${name}: a person is asked to take over`);
  }
});

// ---------------------------------------------------------------- the booking journey
test('journey: ask -> (no booking yet) -> YES -> exactly one create request -> "booked" with the reference; W13 writes no Appointments row; no Cal.com link anywhere', () => {
  const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
  const a = say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
  assert.deepStrictEqual(patientTexts(meta), [ASK_BOOK], 'the first answer is the question');
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 0, 'nothing is booked before the YES');
  assert.strictEqual(rows(g, 'Messages').filter((m) => m.Direction === 'Out').length, 1);

  const b = say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
  const creates = booking.of(/^POST \/api\/booking\/appointments$/);
  assert.strictEqual(creates.length, 1, 'exactly one create request');
  assert.match(creates[0].headers['Idempotency-Key'], /^w13-[0-9a-f]{16}$/);
  assert.deepStrictEqual(creates[0].body, { slot_id: `DR-001|${DAY1}|10:00`, patient: { name: 'Asha Patel', phone: P.ASHA }, service: 'Physiotherapy', reason: 'Do you treat knee pain?' });
  assert.deepStrictEqual(patientTexts(meta), [ASK_BOOK, 'Your appointment is booked: Wed 07 Oct at 10:00 AM with Dr. Mahesh Tiwari. Your reference is wa-GKA-000001. See you then!']);
  assert.strictEqual(lead(g).Status, 'Booked');
  assert.deepStrictEqual(apptWrites(g), [], 'W13 never writes the Appointments table');
  noCal(sentTexts(meta));
  const msg = rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.IN.2');
  assert.strictEqual(msg.AI_Status, 'replied');
});

test('the same inbound message delivered twice (a webhook retry) is answered once and books once', () => {
  const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
  say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 125, decide: () => BOOK() });
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 1);
  assert.strictEqual(booking.st.appts.size, 1);
  assert.strictEqual(patientTexts(meta).filter((t) => /Your appointment is booked/.test(t)).length, 1);
});

test('a YES that does not follow the question (or follows a different time) books nothing and asks again', () => {
  const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
  say('yes', { g, booking, meta, decide: () => BOOK() });
  assert.deepStrictEqual(patientTexts(meta), [ASK_BOOK]);
  say('Actually 10:30 please. Yes', { g, booking, meta, id: 'wamid.IN.2', at: 60, decide: () => BOOK('10:30') });
  say('Yes', { g, booking, meta, id: 'wamid.IN.3', at: 120, decide: () => BOOK('10:30') });
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 1);
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/)[0].body.slot_id, `DR-001|${DAY1}|10:30`);
});

test('the slot is taken between the question and the YES: the fresh availability stops it, the patient gets the real free times, never "booked"', () => {
  const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
  say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
  booking.st.taken.add(`DR-001|${DAY1}|10:00`);                              // someone else (staff, Cal.com, another chat) takes it
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
  const last = patientTexts(meta).pop();
  assert.match(last, /^Sorry, that time is not available\. Free times: Wed 07 Oct 10:30 AM, Wed 07 Oct 5:00 PM, Thu 08 Oct 10:00 AM\. Which one would you like\?$/);
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 0, 'no create request for a time that is no longer listed');
  assert.strictEqual(booking.st.appts.size, 0);
});

test('the slot is taken DURING the booking call (a race the CRM catches): 409 -> the new free times, "just taken", never "booked"; the lead is not marked Booked', () => {
  const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
  say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
  booking.st.race.add(`DR-001|${DAY1}|10:00`);
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
  const last = patientTexts(meta).pop();
  assert.match(last, /^Sorry, Wed 07 Oct at 10:00 AM was just taken\. Free times: Wed 07 Oct 10:30 AM, Wed 07 Oct 5:00 PM\. Which one would you like\?$/, 'the API answers with the same day\'s remaining times');
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 1);
  assert.strictEqual(booking.st.appts.size, 0);
  assert.notStrictEqual(lead(g).Status, 'Booked');
});
test('the booking API fails at the create call (down, 503, unverified write): a person is asked to check, the patient is not told it is booked', () => {
  for (const [name, mutate] of [['down', (b) => { b.st.down = true; }], ['503', (b) => { b.st.status = 503; }], ['unverified', (b) => { b.st.status = 502; }]]) {
    const g = crm(); const booking = fakeBooking(); const meta = fakeMeta();
    say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
    const real = booking; const wrapped = (m, u, h, b) => { if (m === 'POST') mutate(real); return real(m, u, h, b); };
    wrapped.calls = real.calls; wrapped.of = real.of; wrapped.st = real.st;
    say('Yes', { g, booking: wrapped, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
    patientTexts(meta).slice(1).forEach((t) => assert(!/booked|confirmed/i.test(t), `${name}: ${t}`));
    assert(rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.IN.2').AI_Status === 'handed_off', name);
    assert(meta.calls.some((c) => c.body.to === P.OWNER.slice(1)), `${name}: the owner is alerted`);
    assert.deepStrictEqual(apptWrites(g), [], name);
  }
});

test('cancel an old Cal.com booking: asks first, then ONE cancel request keyed by its reference; no Cal.com link, no Grist write by W13', () => {
  const g = crm({ appts: F.appointmentRows() }); const booking = fakeBooking(); const meta = fakeMeta();
  const CANCEL = decision('cancel_appointment', { intent: 'cancel_appointment', appointment_ref: 'A1', reply: 'Please use the link to cancel.' });
  say('Please cancel my appointment', { g, booking, meta, decide: () => CANCEL });
  assert.deepStrictEqual(patientTexts(meta), ['Shall I cancel your appointment on Wed 07 Oct 10:00 AM? Reply YES to confirm.']);
  assert.strictEqual(booking.of(/cancel$/).length, 0);
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => CANCEL });
  const calls = booking.of(/^POST \/api\/booking\/appointments\/[^/]+\/cancel$/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(new URL(calls[0].url).pathname, '/api/booking/appointments/cal-uid-asha-1/cancel');
  assert.strictEqual(calls[0].body.patient_phone, P.ASHA);
  assert.strictEqual(patientTexts(meta).pop(), 'Your appointment on Wed 07 Oct 10:00 AM is cancelled.');
  assert.deepStrictEqual(apptWrites(g), []);
  noCal(sentTexts(meta));
});

test('reschedule: asks (from / to), then ONE move request with the new slot id; a slot taken meanwhile leaves the appointment where it was', () => {
  const g = crm({ appts: F.appointmentRows() }); const booking = fakeBooking(); const meta = fakeMeta();
  const MOVE = decision('reschedule_appointment', { intent: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-08', time: '10:30', time_window: null } });
  say('Move it to Thursday 10:30', { g, booking, meta, decide: () => MOVE });
  assert.match(patientTexts(meta)[0], /^Shall I move your appointment from Wed 07 Oct 10:00 AM to Thu 08 Oct at 10:30 AM with Dr\. Mahesh Tiwari\? Reply YES to confirm\.$/);
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => MOVE });
  const moves = booking.of(/^PATCH /);
  assert.strictEqual(moves.length, 1);
  assert.deepStrictEqual(moves[0].body, { patient_phone: P.ASHA, slot_id: 'DR-001|2026-10-08|10:30' });
  assert.strictEqual(patientTexts(meta).pop(), 'Your appointment is moved to Thu 08 Oct at 10:30 AM with Dr. Mahesh Tiwari.');
  assert.deepStrictEqual(apptWrites(g), []);
});

test('direct mode and a Cal.com link in Settings change nothing: W13 still books only through the API and shows the AI no link', () => {
  const g = crm({ settings: { booking_mode: 'direct', booking_link: 'https://cal.com/demo-physio/assessment' } }); const booking = fakeBooking(); const meta = fakeMeta();
  say('Book me for tomorrow at 10', { g, booking, meta, decide: () => BOOK() });
  say('Yes', { g, booking, meta, id: 'wamid.IN.2', at: 120, decide: () => BOOK() });
  assert.strictEqual(booking.of(/^POST \/api\/booking\/appointments$/).length, 1);
  assert.deepStrictEqual(apptWrites(g), [], 'direct mode would have written Appointments from W13');
  noCal(sentTexts(meta));
  assert(rows(g, 'Messages').some((m) => /booking_mode = direct is ignored/.test(m.AI_Reason || '')), 'staff can see that direct mode was ignored');
});

test('a clinic\'s OWN (non-Cal.com) booking link is still usable when times are unknown, but Cal.com never is', () => {
  const own = crm({ settings: { booking_link: 'https://www.demophysio.example/book' } });
  const meta = fakeMeta();
  say('Book me for tomorrow at 10', { g: own, booking: fakeBooking({ down: true }), meta, decide: () => decision('book_slot', { booking: { date: DAY1, time: '10:00', time_window: null }, reply: 'Please choose a time: {{BOOKING_LINK}}' }) });
  assert(patientTexts(meta).some((t) => t.includes('https://www.demophysio.example/book')));
  noCal(sentTexts(meta));
});

finish('4c-w13-booking');
