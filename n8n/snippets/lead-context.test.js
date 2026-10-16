// Run: node n8n/snippets/lead-context.test.js
// The lead-intelligence module used by W3 / W5 / W6: context from AI-derived CRM fields, the next best action per purpose,
// the staff brief. Includes the safety property: it only ever HOLDS BACK, never creates a step.
const assert = require('assert');
const L = require('./lead-context');

const NOW = Date.parse('2026-10-06T11:00:00+05:30');
const sec = (ms) => Math.floor(ms / 1000);
const H = 3600 * 1000;
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const lead = (fields = {}, id = 7) => ({ id, fields: { Name: 'Asha', Phone: '+919000000011', Status: 'New', Enquiry: 'knee pain', ...fields } });
const conv = (fields = {}) => L.lcConversations([{ id: 1, fields: { Lead: 7, ...fields } }])['7'];
const ctx = (lf, cf) => L.leadContext(lead(lf), cf === undefined ? undefined : conv(cf), NOW);

// ---------------------------------------------------------------- context
console.log('context from the CRM');
let x = ctx({});
assert.deepStrictEqual([x.stage, x.rank, x.summary, x.last_intent, x.minutes_since_inbound, x.next_action_future, x.needs_human, x.paused, x.assigned_to, x.opted_out], ['', 1, '', '', null, false, false, false, '', false]);
x = ctx({ Lead_Stage: 'hot', AI_Summary: '  Wants a knee\nassessment.  ', Likely_Service: 'Knee pain physiotherapy', Next_Action_At: sec(NOW + 2 * 86400000), Opted_Out: true },
  { Needs_Human: true, Automation_Paused: true, Assigned_To: ' Dr. Mehta ', Last_Intent: 'pricing', Last_Inbound_At: sec(NOW - 90 * 60000), Handoff_Reason: 'HIGH · wants a call' });
assert.deepStrictEqual([x.stage, x.rank, x.summary, x.service, x.last_intent, x.minutes_since_inbound, x.next_action_future, x.needs_human, x.paused, x.assigned_to, x.opted_out, x.handoff_note],
  ['hot', 0, 'Wants a knee assessment.', 'Knee pain physiotherapy', 'pricing', 90, true, true, true, 'Dr. Mehta', true, 'HIGH · wants a call']);
ok('no AI data -> everything unknown (rank 1 = warm); every AI / staff field read and cleaned');

x = ctx({ Lead_Stage: 'HOT', Next_Action_At: 'tomorrow' }, { Needs_Human: 'yes', Last_Inbound_At: '1700000000', Lead: 'abc' });
assert.deepStrictEqual([x.stage, x.rank, x.next_action_at, x.needs_human, x.minutes_since_inbound], ['', 1, null, false, null]);
assert.deepStrictEqual(L.lcConversations([{ fields: { Lead: 0, Needs_Human: true } }, { fields: { Lead: 'x' } }, null, { fields: {} }]), {});
assert.deepStrictEqual(L.lcConversations('not a list'), {});
ok('unknown stage, text dates, "yes" toggles, broken lead references are ignored, never guessed');

const merged = L.lcConversations([
  { fields: { Lead: 7, Last_Intent: 'pricing', Last_Inbound_At: sec(NOW - 5 * H), Handoff_Reason: 'old' } },
  { fields: { Lead: 7, Last_Intent: 'cancel_appointment', Last_Inbound_At: sec(NOW - 1 * H), Needs_Human: true } },
  { fields: { Lead: 7, Last_Intent: 'thanks_ack', Last_Inbound_At: sec(NOW - 9 * H), Automation_Paused: true } },
])['7'];
assert.deepStrictEqual([merged.last_intent, merged.needs_human, merged.paused, merged.last_inbound_at], ['cancel_appointment', true, true, sec(NOW - 1 * H)]);
ok('two or more conversations for one lead: any Needs_Human / paused counts, the newest message decides the intent');

// ---------------------------------------------------------------- next best action
console.log('next best action');
const nba = (lf, cf, purpose, o) => L.nextBestAction(ctx(lf, cf), purpose, o);
const a = (r) => [r.action, r.allowed];
// W3 escalation
assert.deepStrictEqual(a(nba({}, undefined, 'escalation')), ['follow_up', true]);
assert.deepStrictEqual(a(nba({ Lead_Stage: 'hot' }, undefined, 'escalation')), ['reply_now', true]);
assert.deepStrictEqual(a(nba({}, { Last_Inbound_At: sec(NOW - 20 * 60000) }, 'escalation')), ['reply_now', true]);
assert.deepStrictEqual(a(nba({}, { Needs_Human: true, Handoff_Reason: 'HIGH · complaint' }, 'escalation')), ['human_handoff', true]);
assert.strictEqual(nba({}, { Needs_Human: true, Handoff_Reason: 'HIGH · complaint' }, 'escalation').reason, 'AI hand-off: HIGH · complaint');
assert.deepStrictEqual(a(nba({}, { Assigned_To: 'Ravi' }, 'escalation')), ['wait', false]);
assert.deepStrictEqual(a(nba({}, { Automation_Paused: true }, 'escalation')), ['wait', false]);
assert.deepStrictEqual(a(nba({ Opted_Out: true }, undefined, 'escalation')), ['no_action', false]);
assert.deepStrictEqual(a(nba({}, { Last_Intent: 'not_interested' }, 'escalation')), ['no_action', false]);
assert.deepStrictEqual(a(nba({ Next_Action_At: sec(NOW + 86400000) }, undefined, 'escalation')), ['wait', false]);
assert.strictEqual(nba({ Next_Action_At: sec(NOW + 86400000) }, undefined, 'escalation').reason, 'next contact planned for 2026-10-07');
assert.deepStrictEqual(a(nba({ Next_Action_At: sec(NOW - 86400000) }, undefined, 'escalation')), ['follow_up', true]);
ok('W3: hot / just wrote -> reply now; failed AI hand-off -> escalate with the AI note; owned, opted out, not interested, planned -> held');
// W5 reminders
assert.deepStrictEqual(a(nba({}, undefined, 'reminder', { kind: 'r24' })), ['appointment_reminder', true]);
const pending = { Needs_Human: true, Last_Intent: 'cancel_appointment', Last_Inbound_At: sec(NOW - 3 * H) };
assert.deepStrictEqual(a(nba({}, pending, 'reminder', { kind: 'r24' })), ['human_handoff', false]);
assert(/asked to cancel on WhatsApp 3 h ago/.test(nba({}, pending, 'reminder', { kind: 'r24' }).reason));
assert.deepStrictEqual(a(nba({}, pending, 'reminder', { kind: 'r2' })), ['appointment_reminder', true], 'the 2 h reminder always goes');
assert.deepStrictEqual(a(nba({}, { ...pending, Last_Inbound_At: sec(NOW - 25 * H) }, 'reminder', { kind: 'r24' })), ['appointment_reminder', true], 'old request');
assert.deepStrictEqual(a(nba({}, { ...pending, Needs_Human: false }, 'reminder', { kind: 'r24' })), ['appointment_reminder', true], 'request handled');
for (const cf of [{ Needs_Human: true, Last_Intent: 'complaint', Last_Inbound_At: sec(NOW - H) }, { Automation_Paused: true }, { Assigned_To: 'Ravi' }]) assert.deepStrictEqual(a(nba({ Lead_Stage: 'cold' }, cf, 'reminder', { kind: 'r24' })), ['appointment_reminder', true]);
ok('W5: only a pending cancel / reschedule request (< 24 h, staff not done) holds the 24 h reminder; the 2 h one, complaints, paused, assigned still get reminders');
// W6 day 2
assert.deepStrictEqual(a(nba({}, undefined, 'followup')), ['follow_up', true]);
assert.deepStrictEqual(a(nba({ Lead_Stage: 'hot' }, undefined, 'followup')), ['follow_up', true]);
assert.deepStrictEqual(a(nba({ Lead_Stage: 'cold' }, undefined, 'followup')), ['nurture', false]);
assert.deepStrictEqual(a(nba({}, { Needs_Human: true }, 'followup')), ['human_handoff', false]);
assert.deepStrictEqual(a(nba({}, { Assigned_To: 'Ravi' }, 'followup')), ['wait', false]);
assert.deepStrictEqual(a(nba({}, { Last_Intent: 'opt_out' }, 'followup')), ['no_action', false]);
assert.deepStrictEqual(a(nba({ Next_Action_At: sec(NOW + 86400000) }, undefined, 'followup')), ['wait', false]);
assert.deepStrictEqual(a(nba({}, { Last_Inbound_At: sec(NOW - 10 * H) }, 'followup')), ['wait', false]);
assert.deepStrictEqual(a(nba({}, { Last_Inbound_At: sec(NOW - 50 * H) }, 'followup')), ['follow_up', true]);
assert.deepStrictEqual(a(nba({}, { Automation_Paused: true }, 'followup')), ['follow_up', true], 'paused / opted out: W6 – Decide send stops it, as before');
ok('W6 day 2: person needed, assigned, not interested / stop, planned, wrote < 48 h, cold -> held; paused / opted out left to Decide send');
// W6 rebook
const missed = sec(NOW - 26 * H);
assert.deepStrictEqual(a(nba({}, undefined, 'rebook', { since: missed })), ['rebook', true]);
assert.deepStrictEqual(a(nba({ Lead_Stage: 'cold' }, { Last_Inbound_At: sec(NOW - 30 * H) }, 'rebook', { since: missed })), ['rebook', true], 'wrote BEFORE the missed visit, cold: still rebook');
assert.deepStrictEqual(a(nba({}, { Last_Inbound_At: sec(NOW - 2 * H) }, 'rebook', { since: missed })), ['wait', false]);
assert.deepStrictEqual(a(nba({}, { Needs_Human: true }, 'rebook', { since: missed })), ['human_handoff', false]);
assert.deepStrictEqual(a(nba({}, { Assigned_To: 'Ravi' }, 'rebook', { since: missed })), ['wait', false]);
assert.deepStrictEqual(a(nba({ Next_Action_At: sec(NOW + 86400000) }, undefined, 'rebook', { since: missed })), ['wait', false]);
assert.throws(() => nba({}, undefined, 'marketing'), /unknown purpose/);
ok('W6 rebook: held when a person owns it, a call is planned, or the patient wrote after the missed visit');

// ---------------------------------------------------------------- safety: it only holds back
console.log('safety property');
const pick = (arr, i) => arr[i % arr.length];
let checked = 0;
for (let i = 0; i < 4000; i++) {
  const lf = { Lead_Stage: pick(['hot', 'warm', 'cold', '', 'HOT', null, 42], i), AI_Summary: pick(['', 'x', null], i >> 1), Opted_Out: pick([true, false, undefined, 'true'], i >> 2), Next_Action_At: pick([undefined, sec(NOW + 3600000), sec(NOW - 3600000), 'soon', 0], i >> 3) };
  const cf = pick([undefined, { Needs_Human: pick([true, false, 'x'], i) , Automation_Paused: pick([true, false], i >> 1), Assigned_To: pick(['', 'R', null], i >> 2), Last_Intent: pick(['', 'not_interested', 'opt_out', 'cancel_appointment', 'pricing', 'reschedule_appointment', 'garbage'], i >> 3), Last_Inbound_At: pick([undefined, sec(NOW - 5 * 60000), sec(NOW - 30 * H), sec(NOW - 80 * H), 'x'], i >> 4) }], i >> 5);
  for (const [purpose, o] of [['escalation', {}], ['reminder', { kind: 'r24' }], ['reminder', { kind: 'r2' }], ['followup', {}], ['rebook', { since: missed }]]) {
    const r = nba(lf, cf, purpose, o);
    assert.strictEqual(typeof r.allowed, 'boolean');
    assert(['reply_now', 'follow_up', 'wait', 'human_handoff', 'appointment_reminder', 'no_action', 'rebook', 'nurture'].includes(r.action));
    if (purpose === 'reminder' && o.kind === 'r2') assert.strictEqual(r.allowed, true, 'the 2 h reminder is never held');
    checked++;
  }
  assert.deepStrictEqual(a(L.nextBestAction(L.leadContext(lead({}), undefined, NOW), 'reminder', { kind: 'r24' })), ['appointment_reminder', true]);
}
ok(`${checked} random CRM states (good and broken values): always one of the 8 actions, a yes / no answer, never throws; the 2 h reminder is never held`);

// ---------------------------------------------------------------- staff brief
console.log('staff brief');
x = ctx({ Lead_Stage: 'hot', AI_Summary: 'Wants a knee assessment tomorrow evening.', Likely_Service: 'Knee pain physiotherapy' }, { Last_Intent: 'availability_check', Last_Inbound_At: sec(NOW - 12 * 60000) });
let b = L.lcStaffBrief(x, L.nextBestAction(x, 'escalation'), { name: 'Asha', phone: '+919000000011', clinic: 'Demo Physio', waiting_minutes: 42 });
assert.strictEqual(b.text, 'New lead [HOT] Asha (+919000000011) for Demo Physio, waiting 42 min. Wants a knee assessment tomorrow evening (Knee pain physiotherapy). Last: availability check, wrote 12 min ago. Next: reply on WhatsApp now, the patient is active.');
assert.strictEqual(b.brief, '[HOT] Wants a knee assessment tomorrow evening (Knee pain physiotherapy). Last: availability check, wrote 12 min ago. Next: reply on WhatsApp now, the patient is active.');
x = ctx({ Enquiry: 'back\npain' });
b = L.lcStaffBrief(x, L.nextBestAction(x, 'escalation'), { name: 'Ravi', phone: '+919000000015', clinic: 'Demo Physio', waiting_minutes: 31 });
assert.strictEqual(b.text, 'New lead Ravi (+919000000015) for Demo Physio, waiting 31 min. back pain. Next: call or message today.');
x = ctx({}, { Needs_Human: true, Handoff_Reason: 'HIGH · wants a call.' });
assert(L.lcStaffBrief(x, L.nextBestAction(x, 'escalation'), { name: 'A', phone: 'p', clinic: 'c', waiting_minutes: 1 }).brief.endsWith('Next: AI hand-off: HIGH · wants a call.'), 'no double full stop');
x = ctx({ AI_Summary: 'y'.repeat(400) });
b = L.lcStaffBrief(x, L.nextBestAction(x, 'escalation'), { name: 'A', phone: 'p', clinic: 'c', waiting_minutes: 1 });
assert(b.brief.length <= 240 && b.text.length <= 500 && !/\n/.test(b.brief + b.text));
ok('WHO / WHAT / RECENT / HOW HOT / NEXT in one line; no AI data = the enquiry; capped, one line (template-safe)');

console.log(`\nAll ${n} lead-context cases pass`);
