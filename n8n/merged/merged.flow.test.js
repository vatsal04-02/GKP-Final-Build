// Runs the merged single workflow (clinic-autopilot-single-workflow.json) end to end in the simulator, one trigger at a
// time, with a fake Grist and a fake Meta. Proves: each trigger runs only its own section, W3 / W5 / W6 reach the ONE
// W12 engine and get their own result back, W11 alerts name the failing module, and the merge kept the behaviour as
// exported (including the issues listed in README.md, which are asserted here so they cannot change silently).
// Run: node n8n/merged/merged.flow.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');

const FILE = process.env.MERGED_FILE || path.join(__dirname, 'clinic-autopilot-single-workflow.json');   // MERGED_FILE: test another build
const merged = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const SELF = 'MERGED_WF_ID';              // the id n8n gives the workflow on import; {{ $workflow.id }} resolves to it
const SECRET = 'testsecret-123';
const TEST_PHONE = '9000000001';          // fake numbers only
const OWNER = '9000000002';
const PATIENT = '9876543210';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';               // registry_doc_id as exported (the fake Grist uses it as a doc key)
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const moduleOf = (name) => (name.match(/^(W\d+) – /) || [])[1];

// The live Grist uses table LEADS with column Lead_id (the repo schema still says Leads / Lead_ID).
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));

// Fill the "after import" placeholders with test values.
const wfWith = ({ allowlist = TEST_PHONE, secret = SECRET } = {}) => {
  const w = clone(merged);
  const set = (node, key, v) => { const a = w.nodes.find((x) => x.name === node).parameters.assignments.assignments.find((x) => x.name === key); a.value = v; };
  set('W4 – Config', 'cal_webhook_secret', secret);
  set('W12 – Config', 'w12_allowlist', allowlist);
  return w;
};
const NOW = Date.parse('2026-10-05T11:00:00+05:30');   // a Monday, 11:00 IST
const sec = (ms) => Math.floor(ms / 1000);
const settings = (over = {}) => Object.entries({ clinic_name: 'Demo Physio', TEST_MODE: 'TRUE', TEST_PHONE, owner_phone: OWNER, booking_link: 'https://cal.com/demo', ...over })
  .map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } }));
const grist = ({ leads = [], appts = [], set = {} } = {}) => new FakeGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true } }] },
  DOCA: { LEADS: clone(leads), Appointments: clone(appts), Run_Log: [], Settings: settings(set), Conversations: [], Messages: [] },
});
const fakeMeta = () => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); return { status: 200, body: { messages: [{ id: `wamid.T${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const run = (start, items, { w = wfWith(), g = grist(), meta = fakeMeta(), now = NOW } = {}) => {
  const r = simulate(w, { start, items, grist: g, now, meta, workflowId: SELF });
  return { r, g, meta };
};
const rows = (g, t) => g.docs.DOCA[t].map((x) => x.fields);
const onlyModule = (r, m) => {
  const bad = r.visited.filter((x) => moduleOf(x) !== m);
  assert(!bad.length, `left section ${m}: ${bad}`);
  for (const s of r.subRuns) {
    assert.strictEqual(s.visited[0], 'W12 – When called by another workflow');
    assert.strictEqual(s.visited[s.visited.length - 1], 'W12 – Return result');
    assert(s.visited.every((x) => moduleOf(x) === 'W12'), 'sub-run left W12');
  }
};

// ================================================================ W1
console.log('W1 website leads');
{
  const body = { clinic_slug: 'demo-physio', name: 'Asha Rao', phone: `+91 ${PATIENT}`, enquiry: 'knee pain', page_url: 'https://site/x', utm_campaign: 'oct', website: '' };
  const { r, g, meta } = run('W1 – Webhook', [{ json: { headers: {}, params: {}, query: {}, body } }]);
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W1');
  const lead = rows(g, 'LEADS')[0];
  assert.strictEqual(lead.Phone, `+91${PATIENT}`); assert.match(lead.Lead_id, /^L-20261005-0001$/); assert.strictEqual(lead.Status, 'New');
  assert.deepStrictEqual(rows(g, 'Run_Log').map((x) => [x.Workflow, x.Outcome]), [['W1-website-lead', 'ok']]);
  assert.strictEqual(meta.calls.length, 0); assert.strictEqual(r.subRuns.length, 0);
  ok('lead created in LEADS (Lead_id L-YYYYMMDD-0001) + Run_Log; staff alert still a stub: no W12 call, no Meta call');
  const again = simulate(wfWith(), { start: 'W1 – Webhook', items: [{ json: { headers: {}, params: {}, query: {}, body } }], grist: g, now: NOW + 60000, meta, workflowId: SELF });
  assert.strictEqual(again.error, null);
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert.deepStrictEqual(rows(g, 'Run_Log')[1], { Workflow: 'W1-website-lead', Record: `+91${PATIENT}`, Outcome: 'skipped', Error: 'duplicate submission', At: sec(NOW + 60000) });
  ok('same form twice: no second lead, logged as skipped "duplicate submission"');
  const bad = run('W1 – Webhook', [{ json: { headers: {}, params: {}, query: {}, body: { ...body, clinic_slug: 'nope' } } }]);
  assert.strictEqual(bad.r.error.node, 'W1 – Unknown clinic');
  ok('unknown clinic stops at "W1 – Unknown clinic" (the W11 alert then names W1)');
}

// ================================================================ W3 -> W12 -> W3
console.log('W3 speed to lead (through the W12 engine)');
const newLead = (id, minutesAgo, over = {}) => ({ id, fields: { Lead_id: `L-1-${id}`, Created_At: sec(NOW - minutesAgo * 60000), Name: `Lead ${id}`, Phone: `+91${PATIENT}`, Source: 'Website', Status: 'New', Enquiry: 'back pain', ...over } });
{
  const { r, g, meta } = run('W3 – Every 10 minutes', [{ json: {} }], { g: grist({ leads: [newLead(1, 40), newLead(2, 45), newLead(3, 10)] }) });
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W3');
  assert.strictEqual(r.subRuns.length, 2, 'one W12 run per due lead (mode each)');
  assert.strictEqual(meta.calls.length, 2);
  for (const c of meta.calls) {
    assert.strictEqual(c.url, 'https://graph.facebook.com/v23.0/123456789012345/messages');
    assert.strictEqual(c.body.to, `91${TEST_PHONE}`, 'TEST_MODE: staff alert goes to TEST_PHONE');
    assert.strictEqual(c.body.template.name, 'hello_world');
  }
  const back = r.runData["W3 – Call 'W12 - WhatsApp send'"];
  assert.deepStrictEqual(back.map((x) => [x.json.lead_row_id, x.json.sent, x.json.send_status, x.json.source_workflow]), [[2, true, 'accepted', 'W3-speed-to-lead'], [1, true, 'accepted', 'W3-speed-to-lead']], 'oldest first, each result on its own item');
  assert.deepStrictEqual(back.map((x) => x.json.wa_message_id), ['wamid.T1', 'wamid.T2']);
  assert.deepStrictEqual(rows(g, 'LEADS').map((x) => !!x.Escalated), [true, true, false]);
  assert.deepStrictEqual(rows(g, 'Run_Log').map((x) => x.Record), ['L-1-2 (escalated)', 'L-1-1 (escalated)']);
  assert.strictEqual(rows(g, 'Messages').length, 0, 'staff alerts are not written to the patient inbox');
  ok('2 due leads -> 2 separate W12 runs -> each result comes back to its own W3 item -> Escalated + Run_Log');

  const blocked = run('W3 – Every 10 minutes', [{ json: {} }], { w: wfWith({ allowlist: '9111111111' }), g: grist({ leads: [newLead(1, 40)] }) });
  assert.strictEqual(blocked.r.error, null);
  assert.strictEqual(blocked.meta.calls.length, 0);
  assert.match(blocked.r.runData["W3 – Call 'W12 - WhatsApp send'"][0].json.send_error, /not in the W12 allowlist/);
  assert.strictEqual(rows(blocked.g, 'LEADS')[0].Escalated, undefined);
  assert.strictEqual(rows(blocked.g, 'Run_Log').length, 0, 'ISSUE: a blocked / failed send leaves no Run_Log row (Sent? false goes nowhere)');
  ok('number not in the W12 allowlist: Meta never called, sent=false back in W3, flag not set (and no Run_Log row - issue I-08)');

  const night = run('W3 – Every 10 minutes', [{ json: {} }], { g: grist({ leads: [newLead(1, 40)] }), now: Date.parse('2026-10-05T22:00:00+05:30') });
  assert.strictEqual(night.r.subRuns.length, 0); assert.strictEqual(night.meta.calls.length, 0);
  ok('22:00 IST: W3\'s own guard stops it before W12 (quiet hours still enforced on this path)');
}

// ================================================================ W5 -> W12 -> W5
console.log('W5 reminders (through the W12 engine)');
const appt = (id, lead, startInMin, over = {}, at = NOW) => ({ id, fields: { Booking_UID: `uid${id}`, Lead: lead, Service: 'Assessment', Physio: 'Dr Rao', Start: sec(at + startInMin * 60000), End: sec(at + (startInMin + 45) * 60000), Status: 'Booked', ...over } });
const PATIENT2 = '9811111111';
const patients = () => [newLead(1, 3000, { Status: 'Booked', Phone: `+91${PATIENT}` }), newLead(2, 3000, { Status: 'Booked', Phone: `+91${PATIENT2}` })];
const toMeta = (meta) => meta.calls.map((c) => c.body.to);
{
  const leads = patients();
  const appts = [appt(1, 1, 23 * 60), appt(2, 2, 22 * 60)];
  // Both patients are on the W12 allowlist ON PURPOSE: if the TEST_MODE re-route were lost, W12 would let them through.
  const wide = wfWith({ allowlist: `${TEST_PHONE}, ${PATIENT}, ${PATIENT2}` });
  const { r, g, meta } = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, g: grist({ leads, appts }) });
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W5');
  assert.strictEqual(r.runData['W5 – Find due'].length, 2, 'two reminders are due');
  assert.strictEqual(r.runData['W5 – Decide send'].length, 2, 'FIX I-02: every due reminder goes through Decide send');
  assert.strictEqual(r.runData['W5 – Code in JavaScript'].length, 2, 'FIX I-01: both items leave "Code in JavaScript" (per-item mode)');
  assert.strictEqual(r.subRuns.length, 2);
  r.runData['W5 – Decide send'].forEach((d, i) => {
    assert.strictEqual(d.json.decision.to, `+91${TEST_PHONE}`, 'the guard picked TEST_PHONE (TEST_MODE is TRUE)');
    assert.deepStrictEqual(r.runData['W5 – Code in JavaScript'][i].json.decision, d.json.decision, 'FIX I-01: the decision reaches W12 exactly as Decide send made it');
  });
  assert.deepStrictEqual(toMeta(meta), [`91${TEST_PHONE}`, `91${TEST_PHONE}`], 'FIX I-01: with TEST_MODE on, Meta only ever gets TEST_PHONE');
  assert(!meta.calls.some((c) => [PATIENT, PATIENT2].some((p) => c.body.to.endsWith(p))), 'a patient number reached Meta in TEST_MODE');
  assert.deepStrictEqual(rows(g, 'Appointments').map((x) => x.R24_Sent), [sec(NOW), sec(NOW)], 'both reminders: flag set after the send');
  assert.deepStrictEqual(rows(g, 'Run_Log').map((x) => x.Record), ['uid1 (r24)', 'uid2 (r24)']);
  ok('FIX I-01 + I-02: 2 due reminders -> both processed; TEST_MODE keeps both on TEST_PHONE even though both patients are allowlisted in W12; flags + Run_Log for both');

  const conv = g.docs.DOCA.Conversations.map((c) => c.fields.Phone);
  assert.deepStrictEqual(conv, [`+91${PATIENT}`, `+91${PATIENT2}`], 'inbox conversations belong to the PATIENTS');
  assert.deepStrictEqual(rows(g, 'Messages').map((m) => [m.Direction, m.Template, m.Status, m.Sent_By.startsWith('W5-reminders (TEST_MODE: sent to +91' + TEST_PHONE + ')')]), [['Out', 'hello_world', 'queued', true], ['Out', 'hello_world', 'queued', true]]);
  assert(r.runData["W5 – Call 'W12 - WhatsApp send'"].every((x) => x.json.inbox_logged === true));
  ok('inbox: each reminder is logged to the patient\'s conversation and marked as sent to TEST_PHONE by TEST_MODE');

  // TEST_MODE off: the recipient is the patient (decision.to), W12 still needs the allowlist.
  const live = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, g: grist({ leads, appts, set: { TEST_MODE: 'false' } }) });
  assert.strictEqual(live.r.error, null, JSON.stringify(live.r.error));
  assert.deepStrictEqual(toMeta(live.meta), [`91${PATIENT}`, `91${PATIENT2}`]);
  const blocked = run('W5 – Every 15 minutes', [{ json: {} }], { g: grist({ leads, appts, set: { TEST_MODE: 'false' } }) });   // allowlist = TEST_PHONE only
  assert.strictEqual(blocked.meta.calls.length, 0);
  assert(blocked.r.runData["W5 – Call 'W12 - WhatsApp send'"].every((x) => x.json.sent === false && /not in the W12 allowlist/.test(x.json.send_error)));
  assert.deepStrictEqual(rows(blocked.g, 'Appointments').map((x) => x.R24_Sent), [undefined, undefined], 'blocked: flag stays unset');
  ok('TEST_MODE=false: recipient = patient from the guard decision; the W12 allowlist still blocks everyone not on it');

  const missing = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, g: grist({ leads, appts, set: { TEST_MODE: undefined } }) });
  assert.deepStrictEqual(toMeta(missing.meta), [`91${TEST_PHONE}`, `91${TEST_PHONE}`]);
  ok('TEST_MODE missing/empty: fails safe to ON (TEST_PHONE)');

  const optOut = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, g: grist({ leads: [{ ...leads[0], fields: { ...leads[0].fields, Opted_Out: true } }, leads[1]], appts }) });
  assert.deepStrictEqual(toMeta(optOut.meta), [`91${TEST_PHONE}`]);
  assert.deepStrictEqual(rows(optOut.g, 'Appointments').map((x) => x.R24_Sent), [undefined, sec(NOW)]);
  ok('Opted_Out patient: no send, no flag; the other reminder still goes');

  const sent = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, g: grist({ leads, appts: [appt(1, 1, 23 * 60, { R24_Sent: sec(NOW) - 3600 }), appts[1]] }) });
  assert.deepStrictEqual(toMeta(sent.meta), [`91${TEST_PHONE}`]);
  ok('already-sent flag (R24_Sent): that reminder is skipped, no double message');

  for (const [label, at, sends] of [['22:00', '2026-10-05T22:00:00+05:30', false], ['03:00', '2026-10-05T03:00:00+05:30', false], ['11:00', '2026-10-05T11:00:00+05:30', true]]) {
    const t = Date.parse(at);
    const q = run('W5 – Every 15 minutes', [{ json: {} }], { w: wide, now: t, g: grist({ leads, appts: [appt(1, 1, 23 * 60, {}, t), appt(2, 2, 22 * 60, {}, t)] }) });
    assert.strictEqual(q.r.error, null);
    assert.strictEqual(q.meta.calls.length, sends ? 2 : 0, `W5 at ${label}`);
    if (!sends) assert(q.r.runData['W5 – Decide send'].every((d) => d.json.decision.reason === 'quiet hours'));
  }
  ok('W5 quiet hours: nothing is sent at 22:00 or 03:00 IST ("quiet hours" decision), 11:00 sends');

  // The node itself, fed unsafe input: it must not turn "no" into "yes" or invent a recipient.
  const feed = (decision, extra = {}) => run('W5 – Code in JavaScript', [{ json: { patient_name: 'A', patient_phone: `+91${PATIENT}`, doc_id: 'DOCA', wa_phone_number_id: '123456789012345', test_mode: 'false', ...extra, ...(decision === undefined ? {} : { decision }) } }], { w: wide });
  const noDecision = feed(undefined);
  assert.strictEqual(noDecision.r.runData['W5 – Code in JavaScript'][0].json.decision.send, false);
  assert.strictEqual(noDecision.meta.calls.length, 0);
  const no = feed({ send: false, to: null, reason: 'opted out', test_mode: false });
  assert.deepStrictEqual(no.r.runData['W5 – Code in JavaScript'][0].json.decision, { send: false, to: null, reason: 'opted out', test_mode: false });
  assert.strictEqual(no.meta.calls.length, 0);
  const yes = { send: true, to: `+91${TEST_PHONE}`, reason: 'test mode: sent to TEST_PHONE', test_mode: true };
  const through = feed(yes, { test_mode: 'TRUE' });
  assert.deepStrictEqual(through.r.runData['W5 – Code in JavaScript'][0].json.decision, yes);
  assert.deepStrictEqual(toMeta(through.meta), [`91${TEST_PHONE}`]);
  ok('"W5 – Code in JavaScript": no decision -> no send; send:false stays false; a decision to TEST_PHONE reaches Meta unchanged');
}

// ================================================================ W6 -> W12 -> W6
console.log('W6 follow-ups (through the W12 engine)');
{
  const leads = [newLead(1, 3 * 1440), newLead(2, 3 * 1440, { Status: 'Contacted', Phone: '+919811111111' }), newLead(3, 10 * 1440)];
  const { r, g, meta } = run('W6 – Daily 10:00', [{ json: {} }], { g: grist({ leads }) });
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W6');
  assert.strictEqual(r.subRuns.length, 2);
  assert.deepStrictEqual(meta.calls.map((c) => [c.body.to, c.body.template.name]), [[`91${TEST_PHONE}`, 'hello_world'], [`91${TEST_PHONE}`, 'hello_world']]);
  assert.deepStrictEqual(rows(g, 'LEADS').map((x) => [x.Followup_Sent, x.Status]), [[true, 'New'], [true, 'Contacted'], [undefined, 'New']]);
  assert.deepStrictEqual(rows(g, 'Run_Log').map((x) => x.Record), ['row 1 (followup)', 'row 2 (followup)'], 'issue I-12 (not fixed): W6 reads Lead_ID, the column is Lead_id');
  const back = r.runData["W6 – Call 'W12 - WhatsApp send'"].map((x) => x.json);
  assert(back.every((x) => x.sent === true && x.inbox_logged === true && x.inbox_error === ''), 'FIX I-04: the inbox is written with the Grist credential');
  assert.deepStrictEqual(g.docs.DOCA.Conversations.map((c) => [c.fields.Phone, c.fields.Lead]), [[`+91${PATIENT}`, 1], ['+919811111111', 2]]);
  assert.deepStrictEqual(rows(g, 'Messages').map((m) => [m.Conversation, m.Direction, m.Template, m.Status]), [[1, 'Out', 'hello_world', 'queued'], [2, 'Out', 'hello_world', 'queued']]);
  ok('FIX I-04: 2 follow-ups -> W12 (TEST_PHONE) -> Followup_Sent + Run_Log + inbox rows (Conversations + Messages); 10-day-old lead not marked Lost (mark_lost = false)');

  const before = g.docs.DOCA.Conversations.length;
  const again = simulate(wfWith(), { start: 'W12 – When called by another workflow', items: [{ json: { ...r.runData['W6 – Build Message'][0].json } }], grist: g, now: NOW, meta, workflowId: SELF });
  assert.strictEqual(again.error, null, JSON.stringify(again.error));
  assert.strictEqual(g.docs.DOCA.Conversations.length, before, 'the existing conversation is reused');
  assert.strictEqual(rows(g, 'Messages').length, 3); assert.strictEqual(rows(g, 'Messages')[2].Conversation, 1);
  ok('inbox: a second message to the same patient reuses the conversation (no duplicate)');

  for (const [label, at, sends] of [['21:00', '2026-10-05T21:00:00+05:30', false], ['22:00', '2026-10-05T22:00:00+05:30', false], ['03:00', '2026-10-05T03:00:00+05:30', false], ['07:59', '2026-10-05T07:59:00+05:30', false], ['08:00', '2026-10-05T08:00:00+05:30', true], ['20:59', '2026-10-05T20:59:00+05:30', true]]) {
    const q = run('W6 – Daily 10:00', [{ json: {} }], { g: grist({ leads }), now: Date.parse(at) });
    assert.strictEqual(q.r.error, null);
    assert.strictEqual(q.meta.calls.length, sends ? 2 : 0, `W6 at ${label}`);
    assert.strictEqual(rows(q.g, 'LEADS').filter((x) => x.Followup_Sent).length, sends ? 2 : 0);
    if (!sends) assert(q.r.runData['W6 – Decide send'].every((d) => d.json.decision.reason === 'quiet hours' && d.json.send === false), `${label}: not "quiet hours"`);
  }
  ok('FIX I-05: W6 quiet hours follow the real clock (07:59 / 21:00 / 22:00 / 03:00 blocked, 08:00 / 20:59 send)');
}

// ================================================================ W4
console.log('W4 booking');
{
  const real = require('../tests/fixtures/cal-booking-created.sample.json');
  const body = clone(real.body);
  Object.assign(body.payload, { uid: 'UIDM1', startTime: '2026-10-06T03:30:00.000Z', endTime: '2026-10-06T04:15:00.000Z', status: 'ACCEPTED', eventTitle: 'Assessment' });
  body.payload.attendees = [{ ...body.payload.attendees[0], name: 'Asha Rao', phoneNumber: `+91${PATIENT}` }];
  body.payload.responses.attendeePhoneNumber = { label: 'phone_number', value: `+91${PATIENT}`, isHidden: false };
  const sig = crypto.createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  const hook = (s) => [{ json: { headers: { 'content-type': 'application/json', 'x-cal-signature-256': s }, params: {}, query: { clinic: 'demo-physio' }, body } }];
  const { r, g, meta } = run('W4 – Webhook1', hook(sig));
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W4');
  assert.deepStrictEqual(rows(g, 'Appointments').map((x) => [x.Booking_UID, x.Status, x.Lead]), [['UIDM1', 'Booked', 1]]);
  assert.strictEqual(rows(g, 'LEADS')[0].Status, 'Booked');
  assert.match(rows(g, 'Run_Log')[0].Record, /^UIDM1 \(created\) L-20261005-0001$/);
  assert.strictEqual(meta.calls.length, 0);
  ok('signed BOOKING_CREATED on /webhook/cal -> Appointments + LEADS + Run_Log; confirmation still a stub (no W12 call)');

  const placeholder = run('W4 – Webhook1', hook(sig), { w: (() => { const w = clone(merged); const a = w.nodes.find((x) => x.name === 'W4 – Config').parameters.assignments.assignments.find((x) => x.name === 'cal_webhook_secret'); assert.strictEqual(a.value, 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT'); return w; })() });
  assert.strictEqual(placeholder.r.error.node, 'W4 – Reject');
  assert.strictEqual(placeholder.g.calls.length, 0);
  ok('file as committed (secret placeholder): every Cal.com call is rejected until the real secret is pasted in (fails safe)');
}

// ================================================================ W11
console.log('W11 error handler');
{
  const errItem = { execution: { id: '77', url: 'https://n8n.example/workflow/x/executions/77', error: { message: 'W4: bad signature' }, lastNodeExecuted: 'W4 – Reject', mode: 'webhook' }, workflow: { id: SELF, name: merged.name } };
  const { r } = run('W11 – Error Trigger', [{ json: errItem }]);
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  onlyModule(r, 'W11');
  assert.strictEqual(r.telegram.length, 1);
  assert(r.telegram[0].text.includes(`Workflow: ${merged.name}\nStep: W4 – Reject\nError: W4: bad signature`), r.telegram[0].text);
  ok('alert names the merged workflow and the failing node "W4 – Reject" (the prefix tells you the module)');
}

// ================================================================ W12 engine: real clock + guards, called directly
console.log('W12 engine');
{
  const item = (over = {}) => ({ grist_base_url: 'http://grist:8484', doc_id: 'DOCA', source_workflow: 'engine-test', audience: 'staff', template: 'hello_world', template_params: {}, message_text: 't',
    wa_phone_number_id: '123456789012345', decision: { send: true, to: `+91${TEST_PHONE}`, reason: 't', test_mode: true }, lead_phone: `+91${PATIENT}`, lead_row_id: 1, ...over });
  const call = (it, now) => { const x = run('W12 – When called by another workflow', [{ json: it }], { now }); return { ...x, out: x.r.runData['W12 – Return result'][0].json }; };
  for (const [label, at, sends] of [['07:59', '2026-10-05T07:59:00+05:30', false], ['08:00', '2026-10-05T08:00:00+05:30', true], ['20:59', '2026-10-05T20:59:00+05:30', true], ['21:00', '2026-10-05T21:00:00+05:30', false], ['22:00', '2026-10-05T22:00:00+05:30', false], ['03:00', '2026-10-05T03:00:00+05:30', false]]) {
    const { out, meta } = call(item(), Date.parse(at));
    assert.strictEqual(out.sent, sends, `W12 at ${label}: ${out.send_error}`);
    assert.strictEqual(meta.calls.length, sends ? 1 : 0);
    if (!sends) { assert.strictEqual(out.send_status, 'blocked'); assert.match(out.send_error, /quiet hours/); }
  }
  ok('FIX I-03: W12\'s own quiet-hours check uses the real clock (blocked 21:00-07:59 IST, sends 08:00-20:59), independent of the caller');
  const notAllowed = call(item({ decision: { send: true, to: '+919111111111', reason: 't', test_mode: false } }), NOW);
  assert.strictEqual(notAllowed.out.sent, false); assert.match(notAllowed.out.send_error, /not in the W12 allowlist/); assert.strictEqual(notAllowed.meta.calls.length, 0);
  const no = call(item({ decision: { send: false, to: null, reason: 'opted out', test_mode: false } }), NOW);
  assert.strictEqual(no.out.send_status, 'not_requested'); assert.strictEqual(no.meta.calls.length, 0);
  ok('W12 guards unchanged: not allowlisted -> blocked, caller said no -> not_requested; Meta never called');

  const g = grist();
  const p1 = run('W12 – When called by another workflow', [{ json: item({ audience: 'patient', message_text: 'hello' }) }], { g });
  assert.strictEqual(p1.r.error, null, JSON.stringify(p1.r.error));
  const o1 = p1.r.runData['W12 – Return result'][0].json;
  assert(o1.sent === true && o1.inbox_logged === true && o1.inbox_error === '', JSON.stringify(o1));
  assert.deepStrictEqual(g.docs.DOCA.Conversations.map((c) => c.fields), [{ Phone: `+91${PATIENT}`, Lead: 1 }]);
  assert.deepStrictEqual(rows(g, 'Messages').map((m) => [m.Direction, m.Body, m.Template, m.WA_Message_ID, m.Status, m.Send]), [['Out', 'hello', 'hello_world', 'wamid.T1', 'queued', false]]);
  ok('FIX I-04: patient message -> Conversations + Messages written with the Grist credential; the Meta call used only "WhatsApp Cloud API" (the simulator rejects any mix-up)');
}

// ================================================================ W12 manual test + independence
console.log('W12 manual test and independence');
{
  const { r, meta } = run('W12 – Manual test', [{ json: {} }]);
  assert.strictEqual(r.error, null);
  onlyModule(r, 'W12');
  const out = r.runData['W12 – Return result'][0].json;
  assert.strictEqual(out.sent, false); assert.match(out.send_error, /decision\.to is not a valid/); assert.strictEqual(meta.calls.length, 0);
  ok('Manual test as committed: the test number is a placeholder -> "invalid", nothing sent (paste your number after import)');

  const triggers = merged.nodes.filter((x) => /Trigger|webhook|trigger/.test(x.type) && x.type !== 'n8n-nodes-base.stickyNote');
  for (const t of triggers) {
    const m = moduleOf(t.name);
    const { r: rr } = run(t.name, [{ json: t.type.endsWith('errorTrigger') ? { execution: { error: { message: 'x' }, lastNodeExecuted: 'W1 – Config' }, workflow: { name: merged.name } } : { headers: {}, query: {}, body: {} } }]);
    assert(rr.visited.every((x) => moduleOf(x) === m), `${t.name} reached another section: ${rr.visited.filter((x) => moduleOf(x) !== m)}`);
  }
  ok(`each of the ${triggers.length} triggers only runs nodes of its own section (W12 only via a separate call)`);
}

console.log(`\nMERGED WORKFLOW: ${n} simulated scenarios pass`);
