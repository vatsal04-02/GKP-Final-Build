// Run: node n8n/snippets/ai-split-hours.test.js
// Two opening windows a day (Geeta Krishna: Mon-Sat 09:00-13:00 and 16:00-20:00, Sunday closed): nothing may be offered or booked
// in the lunch break, before opening, after closing, on Sunday, or in a slot that would run into a closed period.
// Also proves old clinics (no open_hours) behave exactly as before. Fake data only.
const assert = require('assert');
const ai = require('./ai-receptionist');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const ok = (m) => console.log(`  ok  ${m}`);
const HH = (m) => ai.aiHHMM(m);
const GK = { open_hours: '09:00-13:00, 16:00-20:00', working_days: 'Mon-Sat', slot_minutes: '30', booking_notice_minutes: '0' };
const MON = Date.parse('2026-10-05T07:00:00+05:30');          // Monday 05 Oct 2026, 07:00 IST, before opening
const profile = (over = {}) => ai.aiProfile({ ...GK, ...over });
const slots = (over = {}, appts = [], now = MON, days = 7) => ai.aiFreeSlots(profile(over), appts, now, days, h);
const dayOf = (s, date) => (s.days.find((d) => d.date === date) || { times: [] }).times.map(HH);
const booked = (date, from, to, uid = 'x') => ({ id: 1, fields: { Booking_UID: uid, Status: 'Booked', Start: F.at(date, from), End: F.at(date, to) } });

// ---------------------------------------------------------------- parsing
const P = (t) => ai.aiParseWindows(t, parseClock);
assert.strictEqual(P(undefined), undefined); assert.strictEqual(P(''), undefined); assert.strictEqual(P('   '), undefined);
assert.deepStrictEqual(P('09:00-13:00, 16:00-20:00'), [[540, 780], [960, 1200]]);
assert.deepStrictEqual(P('4 PM - 8 PM; 9 AM - 1 PM'), [[540, 780], [960, 1200]]);                    // any order, 12-hour times, semicolon
assert.deepStrictEqual(P('9:00 to 13:00 and 16:00 to 20:00'), [[540, 780], [960, 1200]]);
assert.deepStrictEqual(P('09:00–13:00,16:00—20:00'), [[540, 780], [960, 1200]]);                     // en and em dash
assert.deepStrictEqual(P('08:00-20:00'), [[480, 1200]]);                                              // one window is fine
for (const bad of ['09:00-13:00, 12:00-20:00', '13:00-09:00', '09:00-09:00', '09:00', '09:00-13:00-16:00', 'lunch', '09:00-13:00, 16:00-25:00', '9-1', '08:00-09:00,10:00-11:00,12:00-13:00,14:00-15:00,16:00-17:00']) assert.strictEqual(P(bad), null, `should be unreadable: ${bad}`);
ok('open_hours parsing: two windows, 12-hour and "to" forms, any order; empty = not set; overlapping, backwards, empty, extra or more than 4 windows = unreadable');

// ---------------------------------------------------------------- both windows, the lunch closure, the boundaries
let s = slots();
assert.strictEqual(s.known, true); assert.deepStrictEqual(s.windows, [[540, 780], [960, 1200]]); assert.deepStrictEqual([s.open, s.close], [540, 1200]);
const mon = dayOf(s, '2026-10-05');
assert.deepStrictEqual(mon.slice(0, 3), ['09:00', '09:30', '10:00']);
assert.strictEqual(mon.length, 16);                                                                    // 8 in the morning + 8 in the evening
assert.strictEqual(mon[7], '12:30');                                                                   // last morning start: 12:30-13:00
assert.strictEqual(mon[8], '16:00');                                                                   // first evening start
assert.strictEqual(mon[15], '19:30');                                                                  // last evening start: 19:30-20:00
for (const t of ['08:30', '13:00', '13:30', '14:00', '15:00', '15:30', '20:00', '20:30', '21:00']) assert(!mon.includes(t), `${t} must not be offered`);
ok('both windows: 09:00-12:30 and 16:00-19:30 starts; nothing at 13:00-15:30 (lunch), before 09:00, or at/after 20:00; the first and last slot of each window are offered');

// slot length that does not divide the window, and slots that would run into a closed period
let s45 = slots({ slot_minutes: '45' });
assert.deepStrictEqual(dayOf(s45, '2026-10-05').filter((t) => t < '13:00'), ['09:00', '09:45', '10:30', '11:15', '12:00']);   // 12:00-12:45 fits; the next start, 12:45, would end 13:30
assert(!dayOf(s45, '2026-10-05').includes('12:45'), '12:45 + 45 min would end 13:30, inside lunch');
assert.deepStrictEqual(dayOf(s45, '2026-10-05').filter((t) => t >= '16:00').slice(-2), ['18:15', '19:00']);   // 19:00-19:45 fits; the next start, 19:45, would end 20:30
assert(!dayOf(s45, '2026-10-05').includes('20:00') && !dayOf(s45, '2026-10-05').includes('19:45'));
let s60 = slots({ slot_minutes: '60' });
assert.deepStrictEqual(dayOf(s60, '2026-10-05'), ['09:00', '10:00', '11:00', '12:00', '16:00', '17:00', '18:00', '19:00']);
let s90 = slots({ slot_minutes: '90' });
assert.deepStrictEqual(dayOf(s90, '2026-10-05'), ['09:00', '10:30', '16:00', '17:30']);                // 12:00-13:30 and 19:00-20:30 would overlap a closed period
let s240 = slots({ slot_minutes: '240' });
assert.deepStrictEqual(dayOf(s240, '2026-10-05'), ['09:00', '16:00']);
ok('appointment duration: a slot must start AND end inside one window (45/60/90/240 minutes): nothing overlaps the lunch break or the closing time; each window restarts its own grid');

// ---------------------------------------------------------------- Sunday and working days
assert.deepStrictEqual(s.days.map((d) => d.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);   // 7 days from Monday: Sunday 11 Oct is skipped
assert(!s.days.some((d) => d.date === '2026-10-11'), 'Sunday 11 Oct has no slots');
const sunNow = Date.parse('2026-10-11T08:00:00+05:30');                                                // it is Sunday morning
assert.deepStrictEqual(slots({}, [], sunNow, 1).days, []);
const sat = dayOf(slots({}, [], Date.parse('2026-10-10T07:00:00+05:30'), 1), '2026-10-10');
assert.strictEqual(sat.length, 16);                                                                    // Saturday works both windows
ok('Sunday: no slots; Saturday: both windows');

// ---------------------------------------------------------------- time zone: the day and the hours are India time, whatever the server clock says
const justBeforeClose = Date.parse('2026-10-10T19:45:00+05:30');                                       // Sat 19:45 IST = 14:15 UTC
assert.deepStrictEqual(dayOf(slots({}, [], justBeforeClose, 1), '2026-10-10'), []);                    // 19:30 has started: nothing left today, and 20:00 is closed
const lateSatUtc = Date.parse('2026-10-10T19:30:00Z');                                                 // = Sunday 11 Oct 01:00 IST
assert.deepStrictEqual(slots({}, [], lateSatUtc, 1).days, []);                                         // IST says Sunday: closed
const earlyMonUtc = Date.parse('2026-10-04T20:00:00Z');                                                // = Monday 05 Oct 01:30 IST
assert.strictEqual(dayOf(slots({}, [], earlyMonUtc, 1), '2026-10-05')[0], '09:00');
ok('time zone: dates and hours are India time (UTC evening that is already Sunday/Monday in India is handled correctly)');

// ---------------------------------------------------------------- notice period and existing bookings (any length) keep working
assert.strictEqual(dayOf(slots({ booking_notice_minutes: '120' }, [], Date.parse('2026-10-05T08:00:00+05:30'), 1), '2026-10-05')[0], '10:00');
assert.strictEqual(dayOf(slots({ booking_notice_minutes: '120' }, [], Date.parse('2026-10-05T12:00:00+05:30'), 1), '2026-10-05')[0], '16:00');   // 14:00 is lunch: next is 16:00
let b = slots({}, [booked('2026-10-05', '11:30', '12:30')]);                                           // a 60-minute Cal.com booking
assert.deepStrictEqual(dayOf(b, '2026-10-05').filter((t) => t >= '11:00' && t < '13:00'), ['11:00', '12:30']);
b = slots({}, [booked('2026-10-05', '12:30', '16:30')]);                                               // a booking that spans the lunch break
assert(!dayOf(b, '2026-10-05').includes('12:30') && !dayOf(b, '2026-10-05').includes('16:00') && dayOf(b, '2026-10-05').includes('16:30') && dayOf(b, '2026-10-05').includes('12:00'));
b = slots({ booking_capacity: '2' }, [booked('2026-10-05', '09:00', '09:30')]);
assert(dayOf(b, '2026-10-05').includes('09:00'));                                                       // capacity 2: one booking leaves it free
b = slots({}, [{ id: 2, fields: { Status: 'Cancelled', Start: F.at('2026-10-05', '09:00'), End: F.at('2026-10-05', '09:30') } }]);
assert(dayOf(b, '2026-10-05').includes('09:00'));                                                       // cancelled bookings do not block
ok('notice period (skips the lunch break), booking durations, a booking across lunch, capacity and cancelled bookings all still apply');

// ---------------------------------------------------------------- compatibility: no open_hours = the old single window, byte for byte
const legacy = ai.aiFreeSlots(ai.aiProfile({ open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat', slot_minutes: '30', booking_notice_minutes: '0' }), [], MON, 7, h);
assert.deepStrictEqual(legacy.windows, [[540, 1140]]); assert.deepStrictEqual([legacy.open, legacy.close], [540, 1140]);
assert.strictEqual(dayOf(legacy, '2026-10-05').length, 20); assert(dayOf(legacy, '2026-10-05').includes('14:00'));   // legacy clinics keep their continuous day
assert.deepStrictEqual(legacy.days.map((d) => d.date), s.days.map((d) => d.date));
const withBoth = ai.aiFreeSlots(ai.aiProfile({ open_time: '09:00', close_time: '19:00', ...GK }), [], MON, 7, h);
assert.deepStrictEqual(withBoth.windows, [[540, 780], [960, 1200]]);                                    // open_hours wins over open_time / close_time
assert.strictEqual(ai.aiFreeSlots(ai.aiProfile({ open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat', open_hours: 'lunch' }), [], MON, 7, h).known, false);   // unreadable open_hours: never guess, never fall back to a wider window
assert.strictEqual(ai.aiFreeSlots(ai.aiProfile({ open_hours: '09:00-13:00,16:00-20:00' }), [], MON, 7, h).known, false);                                                        // no working_days: unknown
assert.strictEqual(ai.aiFreeSlots(ai.aiProfile({ working_days: 'Mon-Sat' }), [], MON, 7, h).known, false);                                                                      // no hours at all: unknown
ok('compatibility: without open_hours the old single window is unchanged; open_hours wins; unreadable open_hours or missing hours/days = no slots (nothing invented)');

// ---------------------------------------------------------------- the real decision path: a booking in a closed period is refused (direct mode) and replaced by real times
const CFG = { model: 'claude-haiku-4-5', leads_table: 'LEADS', min_confidence: 0.7, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, staff_alert_template: 'human_handoff_alert' };
const CLINIC = { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' };
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (rows) => ({ records: clone(rows) });
const NOW = F.NOW;                                                                                      // Tuesday 06 Oct 2026, 11:00 IST
function plan(text, over, edit) {
  const msg = { id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: 'wamid.NEW.4', Status: 'Received', Created_At: F.sec(NOW) - 60 } };
  const raw = { start: { message_row_id: 4, wa_message_id: 'wamid.NEW.4', msg_type: 'text' }, clinic: CLINIC, settings: rec(F.settingsRows({ open_time: undefined, close_time: undefined, ...GK, booking_notice_minutes: '120', ...over })),
    knowledge: rec(F.KNOWLEDGE), message: rec([msg]), conversation: rec(F.conversationRows()), lead: rec([F.leadRows()[0]]), history: rec([...F.messageRows(), msg]), appointments: rec(over && over._appts || []) };
  const { x, gate } = ai.aiContext(raw, CFG, NOW, h);
  assert.strictEqual(gate.route, 'ai', gate.reason);
  const base = F.fakeDecide(ai.aiBuildRequest(x, CFG));
  assert.strictEqual(base.action, 'book_slot', 'the fake AI must start from a real booking decision, or these tests prove nothing');
  const d = edit(base);
  assert.deepStrictEqual(ai.aiValidateDecision(d), []);
  return { x, plan: ai.aiPlan(d, x, CFG) };
}
const TEXT = 'Book me for Saturday at 5.';                       // the fake AI turns this into a real book_slot decision; each case then changes the date and time
const book = (date, time) => (d) => ({ ...d, booking: { date, time, time_window: null }, reply: `${time} is free. Please confirm.` });
const writesTo = (r, table) => r.plan.action_writes.filter((w) => w.table === table);
const afterFree = (r) => (r.plan.reply.split('Free times:')[1] || '');
const CLOSED = [['2026-10-07', '13:00', 'lunch starts'], ['2026-10-07', '14:00', 'mid lunch'], ['2026-10-07', '15:30', 'last lunch half hour'], ['2026-10-07', '12:45', 'would run 12:45-13:15 into lunch'], ['2026-10-07', '08:30', 'before opening'],
  ['2026-10-07', '20:00', 'at closing'], ['2026-10-07', '19:45', 'would run past 20:00'], ['2026-10-11', '10:00', 'Sunday morning'], ['2026-10-11', '17:00', 'Sunday evening']];
for (const mode of ['direct', 'link']) {
  for (const [date, time, why] of CLOSED) {
    const r = plan(TEXT, { booking_mode: mode }, book(date, time));
    assert.strictEqual(r.plan.route, 'offer_slots', `${mode}: ${date} ${time} (${why}) must be refused and answered with real times, not booked or handed off`);
    assert(!r.plan.booked && !writesTo(r, 'Appointments').length && !r.plan.lead_patch.Status, `${mode}: ${date} ${time} (${why}): nothing written`);
    assert(/not available/.test(r.plan.reply), r.plan.reply);
    assert(!/\{\{BOOKING_LINK\}\}/.test(r.plan.reply), `${mode}: no booking link is given for a closed time`);
    for (const t of afterFree(r).match(/\d{1,2}:\d\d [AP]M/g) || []) { const m = parseClock(t); assert((m >= 540 && m < 780) || (m >= 960 && m < 1200), `${mode}: alternative ${t} must be inside a window`); }
  }
}
for (const [date, time] of [['2026-10-07', '09:00'], ['2026-10-07', '12:30'], ['2026-10-07', '16:00'], ['2026-10-07', '19:30']]) {
  const d = plan(TEXT, { booking_mode: 'direct' }, book(date, time));
  assert.strictEqual(d.plan.route, 'book_slot', `${date} ${time} is inside a window`);
  assert.deepStrictEqual([d.plan.booked.Start, d.plan.booked.End, d.plan.booked.Status], [F.at(date, time), F.at(date, time) + 1800, 'Booked']);
  const l = plan(TEXT, { booking_mode: 'link' }, book(date, time));
  assert.strictEqual(l.plan.route, 'book_slot'); assert(!l.plan.booked && /BOOKING_LINK/.test(l.plan.reply), 'link mode: the clinic never writes the booking itself, the patient confirms on Cal.com');
}
const refused = plan(TEXT, { booking_mode: 'direct' }, book('2026-10-07', '14:00'));
assert(/Free times: Wed 07 Oct (9|10|11|12):\d\d [AP]M/.test(refused.plan.reply) || /Free times: Wed 07 Oct 4:00 PM/.test(refused.plan.reply), refused.plan.reply);
const lunchTalk = plan(TEXT, {}, (d) => ({ ...d, intent: 'availability_check', action: 'offer_slots', booking: { date: '2026-10-07', time: null, time_window: null }, reply: 'Yes, 2 PM tomorrow is free!' }));
assert.strictEqual(lunchTalk.plan.route, 'offer_slots'); assert(!/\b(1|2|3):\d\d PM/.test(afterFree(lunchTalk)), `an invented lunchtime slot is replaced by real times: ${lunchTalk.plan.reply}`);
// rescheduling a WhatsApp booking (direct) is held to the same hours
const WA = { id: 7, fields: { Booking_UID: 'wa-wamid.OLD.7', Lead: 1, Service: 'Knee pain physiotherapy', Start: F.at('2026-10-09', '10:00'), End: F.at('2026-10-09', '10:30'), Status: 'Booked' } };
const resched = (date, time) => (d) => ({ ...d, intent: 'reschedule_appointment', action: 'reschedule_appointment', appointment_ref: 'A1', booking: { date, time, time_window: null }, reply: `Moved to ${time}.` });
for (const [date, time] of [['2026-10-08', '14:00'], ['2026-10-08', '13:00'], ['2026-10-11', '10:00'], ['2026-10-08', '19:45']]) {
  const r = plan(TEXT, { booking_mode: 'direct', _appts: [WA] }, resched(date, time));
  assert.strictEqual(r.plan.route, 'offer_slots', `reschedule to ${date} ${time} refused`); assert(!r.plan.booked && !writesTo(r, 'Appointments').length, 'the existing appointment is left untouched');
}
const rr = plan(TEXT, { booking_mode: 'direct', _appts: [WA] }, resched('2026-10-08', '16:30'));
assert.strictEqual(rr.plan.route, 'rescheduled'); assert.strictEqual(rr.plan.booked.Start, F.at('2026-10-08', '16:30'));
ok('decision path, direct AND link mode: 13:00, 14:00, 15:30, 12:45 (runs into lunch), 08:30, 20:00, 19:45 (runs past closing), Sunday 10:00 / 17:00 are refused with real in-window alternatives, no booking link, nothing written; 09:00, 12:30, 16:00, 19:30 are accepted (start/end correct); an invented 2 PM is replaced; rescheduling is held to the same hours');

// the fact check lets the receptionist state both windows of the day, but no other time
const x = plan(TEXT, {}, (d) => d).x;
const allowed = ai.aiAllowedFacts(x);
for (const m of [540, 780, 960, 1200]) assert(allowed.minutes.has(m), `${HH(m)} may be stated`);
assert(!allowed.minutes.has(14 * 60) && !allowed.minutes.has(15 * 60));
ok('fact check: the window boundaries 09:00, 13:00, 16:00, 20:00 may be quoted; 14:00 and 15:00 may not');

console.log('\nAll split-hours cases pass');
