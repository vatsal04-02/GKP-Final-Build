// The other senders (W7, W8, W9, W10, W13) of the PRODUCTION export through the new W12: keys, ledger, consent, AI gate. Fake Grist / Meta / AI.
// (Their business logic is unchanged and covered by the repository's own suites; this proves they still work with the hardened W12.)
// Run: node n8n/production/tests/senders.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, runItem, inboundRequest, messageBody, fakeMeta, ledger, rows, freshGrist, test, finish, P, F, ENV, DOC } = H;
const wf = loadWf();
const T = F.sec(F.NOW);
const HOUR = 3600;
const consenting = () => F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } }));
const crm = ({ settings = {}, appts = [], msgs, convs, extra = {} } = {}) => freshGrist({
  Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: undefined, outcome_checkin: 'on', review_requests: 'on', review_link: 'https://g.page/r/demo-physio-test/review', owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...settings }),
  LEADS: consenting(), Conversations: H.clone(convs || F.conversationRows()), Messages: H.clone(msgs || F.messageRows()), Appointments: appts, ...extra,
});
const ENVX = { FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER},${P.TEST},+919000000012,+919000000013,+919000000014` };
const tick = (start, o = {}) => run(wf, start, [{}], { now: F.NOW, env: ENVX, ...o });
const all = (r) => [r, ...r.subRuns.flatMap(all)];
const noErr = (r) => all(r).forEach((x) => assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`));

test('W7: a completed visit -> outcome_check; flag set; ledger key from the booking; a second hour sends nothing', () => {
  const g = crm({ appts: [{ id: 11, fields: { Booking_UID: 'cal-w7-asha', Lead: 1, Service: 'Knee pain physiotherapy', Physio: 'Dr. Mehta', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'Completed' } }] });
  const meta = fakeMeta();
  const a = tick('W7 – Every hour', { grist: g, meta });
  noErr(a.r);
  assert.deepStrictEqual(meta.calls.map((c) => c.body.template.name), ['outcome_check']);
  assert.deepStrictEqual(ledger(g).map((l) => [l.Idem_Key, l.Status]), [['W7-outcome-nudge:outcome_check:cal-w7-asha', 'accepted']]);
  assert.strictEqual(rows(g, 'Appointments')[0].Outcome_Sent, T);
  tick('W7 – Every hour', { grist: g, meta });
  assert.strictEqual(meta.calls.length, 1);
});

test('W7: no WhatsApp consent on the lead -> nothing is sent (blocked by the consent gate), the flag is still claimed', () => {
  const g = crm({ appts: [{ id: 11, fields: { Booking_UID: 'cal-w7-asha', Lead: 1, Service: 'Knee pain physiotherapy', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'Completed' } }] });
  g.docs[DOC].LEADS[0].fields.Consent_WhatsApp = false;
  const meta = fakeMeta();
  noErr(tick('W7 – Every hour', { grist: g, meta }).r);
  assert.strictEqual(meta.calls.length, 0);
  const l = rows(g, 'Run_Log').filter((x) => x.Workflow === 'W7-outcome-nudge');
  assert.deepStrictEqual([l.length, l[0].Outcome], [1, 'failed']);
  assert.match(l[0].Error, /no WhatsApp consent/);
});

test('W8: a completed visit -> review_request with the review link', () => {
  const g = crm({ appts: [{ id: 21, fields: { Booking_UID: 'cal-w8-asha', Lead: 1, Service: 'Knee pain physiotherapy', Start: T - 5 * HOUR, End: T - 4 * HOUR, Status: 'Completed' } }] });
  const meta = fakeMeta();
  noErr(tick('W8 – Every hour', { grist: g, meta }).r);
  assert.deepStrictEqual(meta.calls.map((c) => c.body.template.name), ['review_request']);
  assert.match(JSON.stringify(meta.calls[0].body), /g\.page\/r\/demo-physio-test\/review/);
  assert.strictEqual(ledger(g)[0].Idem_Key, 'W8-review-request:review_request:cal-w8-asha');
});

test('W9: the weekly report goes to the owner; with external AI disabled the provider is NOT called and the report is written from the numbers alone', () => {
  const MON = Date.parse('2026-10-12T09:00:00+05:30');
  const g = crm({ settings: { weekly_report_whatsapp: 'on' }, appts: [{ id: 201, fields: { Booking_UID: 'u201', Lead: 1, Service: 'Physio', Start: F.sec(MON) - 3 * 86400, End: F.sec(MON) - 3 * 86400 + 2700, Status: 'Completed' } }] });
  const calls = [];
  const openrouter = (...a) => { calls.push(a); throw new Error('the provider must not be called'); };
  const meta = fakeMeta();
  const x = run(wf, 'W9 – Monday 09:00', [{}], { grist: g, now: MON, meta, openrouter, env: ENVX });
  noErr(x.r);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(meta.calls.map((c) => [c.body.template.name, c.body.to]), [['weekly_owner_report', P.OWNER.slice(1)]]);
  const rep = rows(g, 'Run_Log').find((l) => /^WEEKLY REPORT/.test(l.Record));
  assert(rep, 'the report is saved');
  assert.match(ledger(g)[0].Idem_Key, /^W9-weekly-report:weekly_owner_report:/);
});

test('W9 with external AI enabled calls the provider once, with the computed numbers only (no phone numbers, no names)', () => {
  const MON = Date.parse('2026-10-12T09:00:00+05:30');
  const g = crm({ settings: { weekly_report_whatsapp: 'on' }, appts: [{ id: 201, fields: { Booking_UID: 'u201', Lead: 1, Service: 'Physio', Start: F.sec(MON) - 3 * 86400, End: F.sec(MON) - 3 * 86400 + 2700, Status: 'Completed' } }] });
  const bodies = [];
  const openrouter = (m, u, h, body) => { bodies.push(JSON.stringify(body)); return { status: 200, body: { id: 'g', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'A quiet week.', observations: [], recommendations: [] }) } }] } }; };
  const x = run(wf, 'W9 – Monday 09:00', [{}], { grist: g, now: MON, meta: fakeMeta(), openrouter, env: { ...ENVX, FLOWHQ_AI_EXTERNAL_ENABLED: 'true' } });
  noErr(x.r);
  assert.strictEqual(bodies.length, 1);
  assert(!/Asha|Patel|\+91\d{10}|9000000011/.test(bodies[0]), 'no patient identifiers in the weekly-report request');
});

test('W10: a staff reply ticked in the inbox is sent as text inside the 24 h window; key from the row; a second minute sends nothing', () => {
  const g = crm({ convs: [{ id: 1, fields: { Lead: 1, Phone: P.ASHA, Last_Inbound_At: T - 2 * HOUR, Unread: 1, Automation_Paused: false } }], msgs: [...F.messageRows(), { id: 50, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, Dr Mehta can see you today at 5 pm.', Sent_By: 'Ravi (front desk)', Send: true, Created_At: T - 60 } }] });
  const meta = fakeMeta();
  noErr(tick('W10 – Every minute', { grist: g, meta }).r);
  assert.deepStrictEqual(meta.calls.map((c) => [c.body.type, c.body.text.body]), [['text', 'Hi Asha, Dr Mehta can see you today at 5 pm.']]);
  assert.strictEqual(ledger(g)[0].Idem_Key, 'W10-staff-reply:text:50');
  tick('W10 – Every minute', { grist: g, meta });
  assert.strictEqual(meta.calls.length, 1);
});

test('W13 (external AI enabled): a question outside the knowledge base -> holding reply to the patient + staff alert, each with its own key', () => {
  const g = crm({ settings: { ai_mode: 'auto' } });
  const claude = F.fakeClaude(); const or = F.fakeOpenRouter(claude);
  const meta = fakeMeta();
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody('Do you accept the XYZ health insurance card?', { id: 'wamid.IN.H', from: P.ASHA, name: 'Asha Patel', ts: T })), { grist: g, now: F.NOW, openrouter: or, meta, env: { ...ENVX, FLOWHQ_AI_EXTERNAL_ENABLED: 'true' } });
  all(res.r).forEach((x) => assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`));
  const keys = ledger(g).map((l) => l.Idem_Key);
  assert.strictEqual(keys.length, 2, JSON.stringify(keys));
  assert(keys.every((k) => /^W13:[a-z_]+:\d+$/.test(k)), JSON.stringify(keys));
  assert.deepStrictEqual(meta.calls.map((c) => c.body.type).sort(), ['template', 'text']);
  const staff = meta.calls.find((c) => c.body.type === 'template');
  assert.deepStrictEqual([staff.body.template.name, staff.body.to], ['human_handoff_alert', P.OWNER.slice(1)]);
  assert.strictEqual(claude.calls.length, 1);
});

finish('other senders');
