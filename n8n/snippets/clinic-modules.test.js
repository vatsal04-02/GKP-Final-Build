// Run: node n8n/snippets/clinic-modules.test.js
// The pure functions behind W7 (outcome check-in), W8 (review request), W9 (weekly report) and W10 (staff reply).
const assert = require('assert');
const M = require('./clinic-modules');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend } = require('./send-guard');

const h = { normalizeIndianPhone, decideSend };
const NOW = Date.parse('2026-10-12T11:00:00+05:30');   // Monday 11:00 IST
const T = Math.floor(NOW / 1000);
const H = 3600; const D = 86400;
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const lead = (id, f = {}) => ({ id, fields: { Lead_id: `L-${id}`, Name: `Patient ${id} Kumar`, Phone: `+9190000001${String(id).padStart(2, '0')}`, Status: 'Booked', ...f } });
const appt = (id, leadId, endAgoH, f = {}) => ({ id, fields: { Booking_UID: `uid-${id}`, Lead: leadId, Service: 'Knee rehab', Start: T - endAgoH * H - 45 * 60, End: T - endAgoH * H, Status: 'Completed', ...f } });
const conv = (leadId, f = {}) => ({ id: leadId, fields: { Lead: leadId, Phone: `+9190000001${String(leadId).padStart(2, '0')}`, ...f } });

// ================================================================ W7
console.log('W7 outcome check-in');
const W7 = { after_hours: 20, max_hours: 72, min_days_between: 7 };
let p = M.cmOutcomePlan([appt(1, 1, 22), appt(2, 2, 10), appt(3, 3, 80), appt(4, 4, 22, { Status: 'No-show' }), appt(5, 5, 22, { Outcome_Sent: T - H })],
  [1, 2, 3, 4, 5].map((i) => lead(i)), [], NOW, W7);
assert.deepStrictEqual(p.items.map((i) => i.appt_row_id), [1]);
assert.deepStrictEqual(Object.keys(p.items[0]).sort(), ['appt_end', 'appt_row_id', 'automation_paused', 'booking_uid', 'flag_value', 'kind', 'last_inbound_at', 'lead_id', 'lead_name', 'lead_phone', 'lead_row_id', 'opted_out', 'physio', 'service'].sort());
ok('only Completed visits that ended 20-72 h ago with Outcome_Sent empty (not too early, not old backlog, not no-shows, not already sent)');
p = M.cmOutcomePlan([appt(1, 1, 22), appt(6, 1, 30)], [lead(1)], [], NOW, W7);
assert.deepStrictEqual(p.items.map((i) => i.appt_row_id), [1]);
p = M.cmOutcomePlan([appt(1, 1, 22), appt(7, 1, 200, { Outcome_Sent: T - 3 * D })], [lead(1)], [], NOW, W7);
assert.deepStrictEqual([p.items.length, p.held[0].reason], [0, 'a check-in went to this patient recently']);
p = M.cmOutcomePlan([appt(1, 1, 22), { id: 8, fields: { Lead: 1, Status: 'Booked', Start: T + 2 * D } }], [lead(1)], [], NOW, W7);
assert.deepStrictEqual([p.items.length, p.held[0].reason], [0, 'the patient already has a future appointment']);
ok('one check-in per patient: newest visit only; none within 7 days of the last; none when the next visit is already booked');
for (const [c, why] of [[{ Needs_Human: true }, 'a person owns this conversation'], [{ Assigned_To: 'Ravi' }, 'a person owns this conversation'], [{ Last_Intent: 'opt_out', Last_Inbound_At: T - D }, 'the patient said not interested / stop']]) {
  p = M.cmOutcomePlan([appt(1, 1, 22)], [lead(1)], [conv(1, c)], NOW, W7);
  assert.deepStrictEqual([p.items.length, p.held[0].reason], [0, why]);
}
p = M.cmOutcomePlan([appt(1, 1, 22)], [lead(1, { Opted_Out: true })], [conv(1, { Automation_Paused: true, Last_Inbound_At: T - H })], NOW, W7);
assert.deepStrictEqual([p.items[0].opted_out, p.items[0].automation_paused, p.items[0].last_inbound_at], [true, true, T - H]);
ok('held when a person owns the conversation or the patient said stop; Opted_Out / Automation_Paused are passed on to Decide send');
let m = M.cmPatientMessage(p.items[0], 'Demo Physio', T);
assert.deepStrictEqual([m.message_type, m.template], ['text', '']);
m = M.cmPatientMessage({ ...p.items[0], last_inbound_at: T - 2 * D }, 'Demo Physio', T);
assert.deepStrictEqual([m.message_type, m.template, m.template_params], ['template', 'outcome_check', { name: 'Patient', clinic_name: 'Demo Physio', service: 'Knee rehab' }]);
assert(/How are you feeling now\? Just reply here: better, the same or worse/.test(m.message_text) && !/diagnos|medicine|exercise/i.test(m.message_text));
ok('message: free text inside the 24 h window, else the outcome_check template; first name only; no medical content');

// ================================================================ W8
console.log('W8 review request');
const W8 = { after_hours: 3, max_days: 7, min_days_between: 90 };
const LINK = 'https://g.page/r/demo-physio/review';
let r = M.cmReviewPlan([appt(1, 1, 4), appt(2, 2, 1), appt(3, 3, 24 * 8), appt(4, 4, 4, { Review_Sent: T - H }), appt(5, 5, 4, { Status: 'Cancelled' })], [1, 2, 3, 4, 5].map((i) => lead(i)), [], NOW, W8, LINK);
assert.deepStrictEqual([r.items.map((i) => i.appt_row_id), r.items[0].review_link], [[1], LINK]);
r = M.cmReviewPlan([appt(1, 1, 4), appt(9, 1, 24 * 40, { Review_Sent: T - 40 * D })], [lead(1)], [], NOW, W8, LINK);
assert.strictEqual(r.items.length, 0);
ok('Completed 3 h - 7 days ago, Review_Sent empty, not asked in the last 90 days, one per patient');
r = M.cmReviewPlan([appt(1, 1, 4)], [lead(1)], [conv(1, { Needs_Human: true, Last_Intent: 'complaint' })], NOW, W8, LINK);
assert.strictEqual(r.items.length, 1);
ok('no review gating: an unhappy or complaining patient is asked like everyone else (Google review policy)');
for (const bad of ['', 'http://insecure.example/r', 'javascript:alert(1)', 'not a link']) {
  r = M.cmReviewPlan([appt(1, 1, 4)], [lead(1)], [], NOW, W8, bad);
  assert.deepStrictEqual([r.items.length, r.waiting, r.link_ok], [0, 1, false]);
}
ok('no review link (or not https): nothing is sent, the eligible visits are counted as "waiting" for the config');
m = M.cmPatientMessage({ ...M.cmReviewPlan([appt(1, 1, 4)], [lead(1)], [], NOW, W8, LINK).items[0] }, 'Demo Physio', T);
assert.deepStrictEqual([m.template, m.template_params], ['review_request', { name: 'Patient', clinic_name: 'Demo Physio', review_link: LINK }]);
assert(/honest review/.test(m.message_text) && !/5[- ]star|positive|rate us/i.test(m.message_text));
ok('message: asks for an honest review, never for a rating or a positive review');

// ================================================================ W9
console.log('W9 weekly report');
const win = M.cmWeekWindow(NOW);
assert.deepStrictEqual([win.label, win.end - win.start], ['05 Oct 2026 to 11 Oct 2026', 7 * D]);
assert.deepStrictEqual(M.cmWeekWindow(Date.parse('2026-10-18T23:00:00+05:30')).label, '05 Oct 2026 to 11 Oct 2026');
ok('week = the last full Monday-Sunday in India (Mon 05 Oct - Sun 11 Oct when run on Mon 12 Oct)');
const inW = (dayOff, h0 = 10) => win.start + dayOff * D + h0 * H;
const data = {
  leads: [
    lead(1, { Created_At: inW(0), Source: 'Website', Status: 'Booked', First_Response_At: inW(0) + 600, Lead_Stage: 'hot' }),
    lead(2, { Created_At: inW(1), Source: 'WhatsApp', Status: 'Contacted', First_Response_At: inW(1) + 1800, Lead_Stage: 'warm' }),
    lead(3, { Created_At: inW(2), Source: 'WhatsApp', Status: 'New' }),
    lead(4, { Created_At: inW(-3), Source: 'Website', Status: 'Lost', Opted_Out: true }),
  ],
  appointments: [
    { id: 1, fields: { Lead: 1, Start: inW(3), Status: 'Completed' } }, { id: 2, fields: { Lead: 2, Start: inW(4), Status: 'No-show' } },
    { id: 3, fields: { Lead: 2, Start: inW(5), Status: 'Cancelled' } }, { id: 4, fields: { Lead: 3, Start: inW(5), Status: 'Rescheduled' } },
    { id: 5, fields: { Lead: 3, Start: inW(6), Status: 'Booked' } }, { id: 6, fields: { Lead: 1, Start: T + 2 * D, Status: 'Booked' } },
    { id: 7, fields: { Lead: 1, Start: inW(-2), Status: 'Completed' } },
  ],
  conversations: [conv(1, { Needs_Human: true }), conv(2, { Automation_Paused: true }), conv(3)],
  messages: [
    { id: 1, fields: { Direction: 'In', Created_At: inW(1), AI_Status: 'replied', Intent: 'pricing' } },
    { id: 2, fields: { Direction: 'In', Created_At: inW(1), AI_Status: 'handed_off', Intent: 'complaint' } },
    { id: 3, fields: { Direction: 'In', Created_At: inW(4), AI_Status: 'replied', Intent: 'outcome_better' } },
    { id: 4, fields: { Direction: 'In', Created_At: inW(4), AI_Status: 'handed_off', Intent: 'outcome_worse' } },
    { id: 5, fields: { Direction: 'In', Created_At: inW(-1), AI_Status: 'replied' } },
    { id: 6, fields: { Direction: 'Out', Created_At: inW(2), Sent_By: 'Ravi', Status: 'sent' } },
    { id: 7, fields: { Direction: 'Out', Created_At: inW(2), Sent_By: 'W13-ai-receptionist', Status: 'queued' } },
  ],
  runlog: [
    { id: 1, fields: { Workflow: 'W5-reminders', Outcome: 'ok', At: inW(1) } }, { id: 2, fields: { Workflow: 'W5-reminders', Outcome: 'ok', At: inW(2) } },
    { id: 3, fields: { Workflow: 'W6-followups', Record: 'L-2 (followup)', Outcome: 'ok', At: inW(2) } },
    { id: 4, fields: { Workflow: 'W6-followups', Record: 'uid-2 (rebook) L-2', Outcome: 'ok', At: inW(5) } },
    { id: 5, fields: { Workflow: 'W7-outcome-nudge', Outcome: 'ok', At: inW(4) } }, { id: 6, fields: { Workflow: 'W8-review-request', Outcome: 'ok', At: inW(4) } },
    { id: 7, fields: { Workflow: 'W8-review-request', Outcome: 'failed', At: inW(4) } }, { id: 8, fields: { Workflow: 'W5-reminders', Outcome: 'ok', At: inW(-2) } },
  ],
};
const met = M.cmWeeklyMetrics(data, NOW, win, { messages: 5000, runlog: 5000 });
assert.deepStrictEqual(met.leads, { new: 3, by_source: { Website: 1, WhatsApp: 2 }, contacted: 2, booked: 1, still_new: 1, median_first_response_minutes: 10, stage: { hot: 1, warm: 1, cold: 0, not_rated: 1 }, opted_out_total: 1 });
assert.deepStrictEqual(met.appointments, { this_week: 5, completed: 1, no_show: 1, cancelled: 1, rescheduled: 1, still_marked_booked: 1, booked_next_7_days: 1 });
assert.deepStrictEqual([met.ai.patient_messages, met.ai.replied, met.ai.handed_off, met.ai.outcome_better, met.ai.outcome_worse], [4, 2, 2, 1, 1]);
assert.deepStrictEqual(met.people, { waiting_for_a_person: 1, paused_conversations: 1, staff_replies_sent: 1 });
assert.deepStrictEqual(met.sent, { speed_to_lead_alerts: 0, reminders: 2, day2_followups: 1, noshow_rebooks: 1, outcome_checkins: 1, review_requests: 1, ai_runs: 0 });
assert.deepStrictEqual(met.failures, { total: 1, by_workflow: { 'W8-review-request': 1 } });
ok('lead, appointment, AI / hand-off, people, follow-up and failure counts: only rows inside the week, every status counted exactly');

const allowed = M.cmAllowedNumbers(met);
const good = { choices: [{ message: { content: JSON.stringify({ summary: '3 new leads came in and 1 was booked. 2 messages were handed to staff.', observations: ['1 patient said they feel worse after a visit.', 'Leads grew 50% this week.'], recommendations: ['Call the 1 lead still marked New.', 'Aim for twenty more leads next week.', 'Mark the 1 past appointment still shown as Booked.'] }) } }] };
let ai = M.cmCheckAiReport(good, allowed);
assert.deepStrictEqual(ai.summary, '3 new leads came in and 1 was booked. 2 messages were handed to staff.');
assert.deepStrictEqual(ai.observations, ['1 patient said they feel worse after a visit.']);
assert.deepStrictEqual(ai.recommendations, ['Call the 1 lead still marked New.', 'Mark the 1 past appointment still shown as Booked.']);
assert.strictEqual(ai.dropped, 2);
ok('AI text: every number must be a computed one; "50%" and "twenty" lines are dropped, the rest is kept word for word');
const invented = { choices: [{ message: { content: JSON.stringify({ summary: '27 new leads came in. 1 was booked.', observations: ['Revenue was ₹ 40000.'], recommendations: [] }) } }] };
ai = M.cmCheckAiReport(invented, allowed);
assert.deepStrictEqual([ai.summary, ai.observations, ai.dropped], ['1 was booked.', [], 2]);
for (const bad of [{ error: { message: 'timeout' } }, { choices: [{ message: { content: 'not json' } }] }, { choices: [{ message: { content: '{"summary": 3}' } }] }, null]) {
  assert(M.cmCheckAiReport(bad, allowed).error);
}
ok('an invented number (27, ₹ 40000) never survives; timeout / non-JSON / wrong shape -> no AI text at all');
const rep = M.cmRenderReport(met, M.cmCheckAiReport(good, allowed), 'Demo Physio', win, true);
for (const s of ['1. Executive summary', '2. Lead performance', '3. Appointment performance', '4. AI receptionist and hand-offs', '5. Follow-up performance', '6. Important issues', '7. Recommended actions (AI suggestions, not facts)']) assert(rep.text.includes(s), s);
assert(rep.text.includes('- New leads: 3 (WhatsApp 2, Website 1)') && rep.text.includes('completed 1 | no-show 1 | cancelled 1') && rep.text.includes('handed to staff 2'));
assert.strictEqual(rep.headline, '3 new leads (1 booked), 1 visits completed, 1 no-show, 1 cancelled, 2 AI hand-offs, 1 waiting for a person');
const fallback = M.cmRenderReport(met, M.cmCheckAiReport({ error: { message: 'timeout' } }, allowed), 'Demo Physio', win, false);
assert(fallback.text.includes('This week: 3 new leads (1 booked)') && fallback.text.includes('7. Recommended actions (suggested by the rules, not facts)') && fallback.text.includes('review_link is not set'));
// every number in the whole report comes from the metrics (or the week label)
const reportNums = rep.text.replace(/WEEKLY REPORT[^\n]*\n/, '').replace(/^Numbers: [^\n]*\n/m, '').replace(/^\d\. /gm, '').match(/\d+/g);   // header lines carry "n8n", not data
assert(reportNums.every((x) => allowed.has(x) || x === '7'), reportNums.filter((x) => !allowed.has(x)));
ok('7 sections; sections 2-6 written by code from the numbers; AI down -> rule-based summary and actions; no number outside the data');
const req = M.cmReportRequest(met, 'openai/gpt-4o-mini');
assert.deepStrictEqual([req.model, req.response_format.json_schema.strict, req.messages.length], ['openai/gpt-4o-mini', true, 2]);
assert(!JSON.stringify(req).includes('+9190000001'));
ok('one request per clinic per week, strict JSON schema, numbers only (no names, no phone numbers)');

// ================================================================ W10
console.log('W10 staff reply');
const S = { TEST_MODE: 'false', TEST_PHONE: '+919000000019' };
const row = (f = {}) => ({ id: 50, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, Dr Mehta will call you at 5.', Sent_By: 'Ravi', Send: true, Created_At: T - 60, ...f } });
const CONV = { id: 1, fields: { Lead: 1, Phone: '+919000000011', Last_Inbound_At: T - 2 * H } };
const LEAD = { id: 1, fields: { Name: 'Asha', Phone: '+919000000011' } };
let c = M.cmStaffReplyCheck(row(), CONV, LEAD, S, NOW, h);
assert.deepStrictEqual([c.action, c.decision.to, c.claim, c.message.inbox_row_id, c.message.message_type, c.message.last_inbound_at], ['send', '+919000000011', { Send: false, Status: 'queued', AI_Reason: '' }, 50, 'text', T - 2 * H]);
c = M.cmStaffReplyCheck(row({ Sent_By: '', Created_At: null }), CONV, LEAD, { TEST_MODE: 'true', TEST_PHONE: '+919000000019' }, NOW, h);
assert.deepStrictEqual([c.decision.to, c.claim.Sent_By, c.claim.Created_At], ['+919000000019', 'Staff', T]);
ok('a ticked staff row is claimed (Send off, queued) before W12; TEST_MODE sends it to TEST_PHONE; who / when filled in if empty');
const rej = (r, cv, ld, s = S, now = NOW) => { const x = M.cmStaffReplyCheck(r, cv, ld, s, now, h); return [x.action, x.status, x.reason.slice(0, 30)]; };
assert.deepStrictEqual(rej(row({ WA_Message_ID: 'wamid.X', Status: 'sent' }), CONV, LEAD), ['reject', 'sent', 'already sent: not sent again']);
assert.deepStrictEqual(rej(row({ Body: '  ' }), CONV, LEAD)[0], 'reject');
assert.deepStrictEqual(rej(row(), null, LEAD)[1], 'failed');
assert.deepStrictEqual(rej(row(), { id: 1, fields: { ...CONV.fields, Phone: '12345' } }, { id: 1, fields: { Phone: '' } })[2], 'the conversation has no valid ');
assert.deepStrictEqual(rej(row(), CONV, { id: 1, fields: { ...LEAD.fields, Opted_Out: true } })[2], 'the patient opted out (STOP): ');
assert.deepStrictEqual(rej(row(), { id: 1, fields: { ...CONV.fields, Last_Inbound_At: T - 30 * H } }, LEAD)[1], 'needs_template');
assert.deepStrictEqual(rej(row({ Template: 'reminder_24h' }), CONV, LEAD)[1], 'failed');
assert.deepStrictEqual(M.cmStaffReplyCheck(row({ Send: false }), CONV, LEAD, S, NOW, h).action, 'none');
ok('blocked: already sent (duplicate), empty, no conversation, invalid phone, opted out, outside 24 h (needs_template), template rows');
c = M.cmStaffReplyCheck(row(), { id: 1, fields: { ...CONV.fields, Automation_Paused: true, Needs_Human: true, Assigned_To: 'Ravi' } }, LEAD, S, NOW, h);
assert.strictEqual(c.action, 'send');
ok('Automation_Paused / Needs_Human / Assigned_To do not block a human reply (they stop automated messages only)');
const night = Date.parse('2026-10-12T22:30:00+05:30');
c = M.cmStaffReplyCheck(row(), { id: 1, fields: { ...CONV.fields, Last_Inbound_At: Math.floor(night / 1000) - H } }, LEAD, S, night, h);
assert.deepStrictEqual([c.action, c.patch], ['hold', { AI_Reason: 'waiting: quiet hours (21:00-08:00 IST); it goes out at 08:00' }]);
c = M.cmStaffReplyCheck(row({ AI_Reason: 'waiting: quiet hours (21:00-08:00 IST); it goes out at 08:00' }), { id: 1, fields: { ...CONV.fields, Last_Inbound_At: Math.floor(night / 1000) - H } }, LEAD, S, night, h);
assert.deepStrictEqual([c.action, c.patch], ['hold', null]);
ok('quiet hours: the reply waits (Send stays ticked) and goes out at 08:00; the note is written once');
let res = M.cmStaffReplyResult(50, { sent: true, wa_message_id: 'wamid.OK', decision: { to: '+919000000011', test_mode: false } }, T);
assert.deepStrictEqual(res, { message_patch: { Status: 'sent', WA_Message_ID: 'wamid.OK', AI_Reason: '' }, conversation_patch: { Unread: 0 }, log: { Workflow: 'W10-staff-reply', Record: 'message 50 (staff reply) wamid.OK', Outcome: 'ok', Error: '', At: T } });
res = M.cmStaffReplyResult(50, { sent: false, send_error: 'Meta 131047: outside the 24h window - only templates can be sent', decision: {} }, T);
assert.deepStrictEqual([res.message_patch.Status, res.conversation_patch, res.log.Outcome], ['needs_template', null, 'failed']);
res = M.cmStaffReplyResult(50, { sent: false, send_error: 'not sent - could not reach Meta: ENOTFOUND', decision: {} }, T);
assert.deepStrictEqual([res.message_patch.Status, res.message_patch.AI_Reason, res.log.Error], ['failed', 'not sent - could not reach Meta: ENOTFOUND', 'not sent - could not reach Meta: ENOTFOUND']);
ok('result: sent (WA id, Unread 0, Run_Log ok) | 24 h refusal = needs_template | other failure = failed with the reason, Run_Log failed');
assert.strictEqual(M.cmIsAutomation('W13-ai-receptionist') && M.cmIsAutomation('W5-reminders (TEST_MODE: sent to +91...)') && !M.cmIsAutomation('Ravi') && !M.cmIsAutomation(''), true);

assert.deepStrictEqual(['W12', 'W12 (TEST_MODE: sent to +919000000019)', 'W5-reminders', 'W13-ai-receptionist', 'Ravi', 'Wendy', ''].map((v) => M.cmIsAutomation(v)), [true, true, true, true, false, false, false]);
ok('automation senders (W12, W5-reminders, W13-ai-receptionist...) are not counted as staff replies; a person\'s name is');

console.log('per-clinic switches');
assert.deepStrictEqual(['on', 'ON', ' true ', 'yes', '1', 'off', 'false', '', undefined, null, 'maybe'].map((v) => M.cmOn(v)), [true, true, true, true, true, false, false, false, false, false, false]);
ok('Settings switches outcome_checkin / review_requests / weekly_report_whatsapp: on / true / yes / 1; missing or anything else = off');

console.log(`\nAll ${n} clinic-modules cases pass`);
