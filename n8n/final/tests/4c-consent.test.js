// Slice 4C: reminder consent and message purposes in W5 / W12 / W15 (n8n/final/tools/patch-4c-consent.js), run in the simulator: fake Grist, Meta and AI.
//   node n8n/final/tests/4c-consent.test.js        (FOURC_FILE=<export.json> tests another export that already carries the patch)
// Nothing leaves this computer. This proves the WORKFLOW LOGIC against a simulator; it is not a test of a running n8n or of WhatsApp (see docs/n8n-staging.md).
'use strict';
const path = require('path');
const assert = require('assert');
process.env.PROD_FILE = process.env.FOURC_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4c.json');
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const fs = require('fs');
const H = require('../../production/tests/harness');
const { build, ADDED, CHANGED, consent: consentPatch } = require('../tools/build-4c');
const { run, fakeMeta, freshGrist, ashaLead, rows, ledger, sendItem, test, finish, F, P, DAY, DOC } = H;

// ---- the booking / consent columns the simulator's fake Grist has to know (grist/booking-schema.md, grist/clinic-records-schema.md)
const S = H.sim;
S.COLUMNS.Appointments.push('Patient_ID', 'Patient_Name', 'Patient_Phone', 'Doctor_ID', 'Shift', 'Slot_Key', 'Booking_Source', 'Appt_Stage', 'Reason', 'Idem_Key', 'Cancel_Reason', 'Created_At', 'Updated_At', 'Created_By', 'Audit_ID');
S.COLUMNS.Reminder_Consent = ['Consent_ID', 'Phone', 'Patient_ID', 'Reminder_Consent', 'Reminder_Consent_At', 'Reminder_Consent_Source', 'Evidence_Ref', 'Evidence_Date', 'Form_Version', 'Recorded_By', 'Previous_Value', 'Updated_At', 'Audit_ID'];
S.COLUMNS.Patients = ['Patient_ID', 'Serial_No', 'Name', 'Phone', 'Address', 'Age', 'Sex', 'Referred_By', 'Occupation', 'Main_Complaint', 'Registered_On', 'Status', 'Follow_Up_On', 'Followup_Reminded_For', 'Source_Lead_ID', 'Notes', 'Created_At', 'Created_By'];
for (const c of ['Registered_On', 'Follow_Up_On', 'Followup_Reminded_For', 'Created_At']) S.DATETIME.add(`Patients.${c}`);
for (const c of ['Created_At', 'Updated_At']) S.DATETIME.add(`Appointments.${c}`);
S.DATETIME.add('Reminder_Consent.Reminder_Consent_At'); S.DATETIME.add('Reminder_Consent.Updated_At');

const wf = H.loadWf();
const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidatefinal.json'), 'utf8'));
const sec = (ms) => Math.floor(ms / 1000);
const HOUR = 3600;
const settings = (more = {}) => F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...more });
const crm = (docA = {}) => { const { set, ...rest } = docA; return freshGrist({ Settings: settings(set), Reminder_Consent: [], Patients: [], ...rest }); };
const consent = (value, phone = P.ASHA, id = 1) => ({ id, fields: { Consent_ID: `RC-${id}`, Phone: phone, Reminder_Consent: value, Reminder_Consent_Source: 'Told staff in person', Evidence_Ref: 'test' } });
const appt = (hours, over = {}, id = 3) => ({ id, fields: { Booking_UID: `uid-${id}`, Lead: 7, Service: 'Assessment', Physio: 'Dr Rao', Start: sec(DAY) + Math.round(hours * HOUR), End: sec(DAY) + Math.round(hours * HOUR) + 1800, Status: 'Booked', R24_Sent: null, R2_Sent: null, ...over } });
const w5 = (g, o = {}) => { const meta = o.meta || fakeMeta(); const res = run(wf, 'W5 – Every 15 minutes', [{}], { grist: g, meta, now: o.now, env: o.env }); assert.strictEqual(res.r.error, null, res.r.error && `${res.r.error.node}: ${res.r.error.message}`); return { g: res.grist, meta, r: res.r }; };
const log = (g) => rows(g, 'Run_Log');
const digest = (g) => log(g).filter((l) => l.Workflow === 'W5-reminders' && l.Outcome === 'skipped');
const flag = (g, id = 3) => rows(g, 'Appointments').find((a) => a.id === id).R24_Sent;
const unreadable = (g, table) => { const real = g.handle.bind(g); g.handle = (m, u, q, b) => { if (new RegExp(`/tables/${table}/`).test(u)) throw new Error('Grist 404: no such table'); return real(m, u, q, b); }; return g; };

// ---------------------------------------------------------------- the build
test('build: 13 nodes added (6 consent + 7 W13 booking), 15 changed, the 4C candidate is exactly build(candidate), and the patches refuse to run twice', () => {
  assert.strictEqual(ADDED.length, 13);
  assert.strictEqual(consentPatch.ADDED.length, 6);
  // The 4D file is 4C + the AI retry nodes (n8n/final/tools/patch-4d-ai-retry.js): the same identity holds one layer up, and everything below is checked on the 4C part.
  const is4d = wf.nodes.some((x) => x.name === 'W13 – Ask Model Retry Check');
  const wf4c = is4d ? JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4c.json'), 'utf8')) : wf;
  if (is4d) assert.strictEqual(JSON.stringify(require('../tools/build-4d').build(wf4c)), JSON.stringify(wf), 'the committed 4D candidate is exactly build4d(4C)');
  assert.strictEqual(wf4c.nodes.length, base.nodes.length + 13);
  for (const n of ADDED) { assert(wf.nodes.some((x) => x.name === n), `${n} missing`); assert(!base.nodes.some((x) => x.name === n), `${n} was already in the base`); }
  assert.strictEqual(JSON.stringify(build(base)), JSON.stringify(wf4c), 'the committed 4C candidate is exactly build(candidate)');
  assert.throws(() => build(wf4c), /already exists/);
  const was = new Map(base.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = wf4c.nodes.filter((n) => was.has(n.name) && was.get(n.name) !== JSON.stringify(n)).map((n) => n.name).sort();
  assert.deepStrictEqual(changed, [...CHANGED].sort());
  assert.strictEqual(wf.active, false, 'the candidate is not active');
  // credentials by role: the booking API has its OWN credential and nothing else may use it; every other new HTTP node uses the Grist credential only
  const BOOKING_NODES = ['W13 – Booking availability', 'W13 – Booking API'];
  for (const n of wf.nodes.filter((x) => ADDED.includes(x.name) && /httpRequest/.test(x.type))) assert.deepStrictEqual(Object.values(n.credentials || {}).map((c) => c.name), [BOOKING_NODES.includes(n.name) ? 'FlowHQ Booking API' : 'Header Auth account 2'], n.name);
  assert.deepStrictEqual(wf.nodes.filter((x) => JSON.stringify(x.credentials || {}).includes('FlowHQ Booking API')).map((x) => x.name).sort(), [...BOOKING_NODES].sort());
});

test('graph: the consent reads sit before the decision, and nothing reaches W12 except through the same path as before', () => {
  const edges = []; for (const [from, v] of Object.entries(wf.connections)) (v.main || []).forEach((o, i) => (o || []).forEach((c) => edges.push([from, c.node, i])));
  const out = (n) => edges.filter((e) => e[0] === n).map((e) => `${e[1]}#${e[2]}`);
  assert.deepStrictEqual(out('W12 – Lead consent'), ['W12 – Reminder consent#0']);
  assert.deepStrictEqual(out('W12 – Reminder consent'), ['W12 – Consent decide#0']);
  assert.deepStrictEqual(out('W5 – Leads'), ['W5 – Reminder consent#0']);
  assert.deepStrictEqual(out('W5 – Reminder consent'), ['W5 – Patients#0']);
  assert.deepStrictEqual(out('W5 – Patients'), ['W5 – Conversations#0']);
  assert.deepStrictEqual(out('W5 – Send?'), ['W5 – Code in JavaScript#0', 'W5 – Skip digest#1']);
  assert.deepStrictEqual(out('W15 – Leads'), ['W15 – Reminder consent#0']);
  assert.deepStrictEqual(out('W15 – Reminder consent'), ['W15 – Conversations#0']);
  assert.deepStrictEqual(edges.filter((e) => e[1] === "W5 – Call 'W12 - WhatsApp send'").map((e) => e[0]), ['W5 – Code in JavaScript']);
  const appointmentWriters = wf.nodes.filter((n) => /httpRequest/.test(n.type) && /tables\/Appointments\/records/.test(JSON.stringify(n.parameters)) && n.parameters.method && n.parameters.method !== 'GET' && ADDED.includes(n.name));
  assert.deepStrictEqual(appointmentWriters.map((n) => n.name), [], 'the new nodes never write to Appointments');
});

// ---------------------------------------------------------------- W5
test('W5: Yes + a lead = the reminder goes (template, ledger, flag, log), exactly as before', () => {
  const x = w5(crm({ LEADS: [ashaLead()], Appointments: [appt(23)], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(x.meta.calls.length, 1);
  assert.strictEqual(x.meta.calls[0].body.template.name, 'reminder_24h');
  assert.strictEqual(typeof flag(x.g), 'number');
  assert.deepStrictEqual(ledger(x.g).map((l) => [l.Idem_Key, l.Status]), [['W5:reminder_24h:uid-3', 'accepted']]);
  assert.deepStrictEqual(digest(x.g), []);
});

test('W5: Unknown (no row), No, or opted out = nothing sent, nothing claimed, and the reason is in Run_Log without a phone number', () => {
  for (const [name, docA, why] of [
    ['unknown', { LEADS: [ashaLead()], Reminder_Consent: [] }, /no reminder consent on file/],
    ['blank value', { LEADS: [ashaLead()], Reminder_Consent: [consent('')] }, /no reminder consent on file/],
    ['No', { LEADS: [ashaLead()], Reminder_Consent: [consent('No')] }, /reminder consent is No/],
    ['opted out beats Yes', { LEADS: [ashaLead({ Opted_Out: true })], Reminder_Consent: [consent('Yes')] }, /opted out/],
    ['another phone\'s Yes', { LEADS: [ashaLead()], Reminder_Consent: [consent('Yes', P.BOB)] }, /no reminder consent on file/],
  ]) {
    const x = w5(crm({ ...docA, Appointments: [appt(23)] }));
    assert.strictEqual(x.meta.calls.length, 0, name);
    assert.strictEqual(flag(x.g), null, `${name}: the sent flag stays clear, so the reminder can still go once consent is recorded`);
    assert.strictEqual(ledger(x.g).length, 0, name);
    const d = digest(x.g);
    assert.strictEqual(d.length, 1, name);
    assert.match(d[0].Error, why, name);
    assert.match(d[0].Error, /uid-3/, `${name}: names the booking`);
    assert(!/\+?91\d{8,}/.test(`${d[0].Record} ${d[0].Error}`), `${name}: no phone number in the log`);
  }
});

test('W5: legacy lead consent (Consent_WhatsApp, whatsapp-inbound) is NOT reminder consent: the old default of reminding every lead-linked patient is gone, on purpose', () => {
  const x = w5(crm({ LEADS: [ashaLead({ Consent_WhatsApp: true, Consent_Source: 'whatsapp-inbound' })], Appointments: [appt(23)] }));
  assert.strictEqual(x.meta.calls.length, 0);
  assert.match(digest(x.g)[0].Error, /no reminder consent on file/);
});

test('W5: a Pending confirmation appointment is never reminded; once staff confirm it, it is (the normal window still applies)', () => {
  const pending = { Appt_Stage: 'Pending confirmation' };
  const a = w5(crm({ LEADS: [ashaLead()], Appointments: [appt(23, pending)], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(a.meta.calls.length, 0);
  assert.match(digest(a.g)[0].Error, /pending confirmation/);
  assert.strictEqual(flag(a.g), null);
  rows(a.g, 'Appointments');                                              // confirm it, run again
  a.g.docs[DOC].Appointments[0].fields.Appt_Stage = 'Confirmed';
  const b = w5(a.g);
  assert.strictEqual(b.meta.calls.length, 1);
  for (const stage of ['Confirmed', 'Checked in', undefined]) {
    const x = w5(crm({ LEADS: [ashaLead()], Appointments: [appt(23, stage ? { Appt_Stage: stage } : {})], Reminder_Consent: [consent('Yes')] }));
    assert.strictEqual(x.meta.calls.length, 1, `stage ${stage}: a legacy row without Appt_Stage takes the old path`);
  }
});

test('W5: a patient WITHOUT a Lead is reminded from Patient_Phone / Patient_Name, or from the Patients row; no Lead is created', () => {
  const own = w5(crm({ LEADS: [], Appointments: [appt(23, { Lead: undefined, Patient_Phone: P.BOB, Patient_Name: 'Bob Walkin', Patient_ID: 'GK-P-000009' })], Reminder_Consent: [consent('Yes', P.BOB)] }));
  assert.strictEqual(own.meta.calls.length, 1);
  assert.strictEqual(own.meta.calls[0].body.to, P.BOB.slice(1));
  assert.strictEqual(own.meta.calls[0].body.template.components[0].parameters[0].text, 'Bob Walkin');
  assert.strictEqual(rows(own.g, 'LEADS').length, 0, 'no lead was created for the patient');
  const viaPatient = w5(crm({ LEADS: [], Appointments: [appt(23, { Lead: undefined, Patient_ID: 'GK-P-000009' })], Patients: [{ id: 1, fields: { Patient_ID: 'GK-P-000009', Name: 'Carol Record', Phone: P.INTL, Status: 'Active' } }], Reminder_Consent: [consent('Yes', P.INTL)] }));
  assert.strictEqual(viaPatient.meta.calls.length, 1);
  assert.strictEqual(viaPatient.meta.calls[0].body.template.components[0].parameters[0].text, 'Carol Record');
  const none = w5(crm({ LEADS: [], Appointments: [appt(23, { Lead: undefined })], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(none.meta.calls.length, 0);
  assert.match(digest(none.g)[0].Error, /no valid phone/);
  const noYes = w5(crm({ LEADS: [], Appointments: [appt(23, { Lead: undefined, Patient_Phone: P.BOB })] }));
  assert.strictEqual(noYes.meta.calls.length, 0, 'no lead and no consent: nothing');
});

test('W5: Reminder_Consent unreadable (not provisioned, Grist error) = every reminder held, with that reason', () => {
  const x = w5(unreadable(crm({ LEADS: [ashaLead()], Appointments: [appt(23)], Reminder_Consent: [consent('Yes')] }), 'Reminder_Consent'));
  assert.strictEqual(x.meta.calls.length, 0);
  assert.match(digest(x.g)[0].Error, /reminder consent could not be read/);
  const patientsDown = w5(unreadable(crm({ LEADS: [ashaLead()], Appointments: [appt(23)], Reminder_Consent: [consent('Yes')] }), 'Patients'));
  assert.strictEqual(patientsDown.meta.calls.length, 1, 'the Patients table is only a fallback for the phone: a lead-linked reminder still goes');
});

test('W5: the cancel / reschedule hold still applies to a lead-linked 24 h reminder, and is now reported', () => {
  const conv = { id: 1, fields: { Lead: 7, Phone: P.ASHA, Needs_Human: true, Last_Intent: 'cancel_appointment', Last_Inbound_At: sec(DAY) - 3600 } };
  const x = w5(crm({ LEADS: [ashaLead()], Conversations: [conv], Appointments: [appt(23)], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(x.meta.calls.length, 0);
  assert.match(digest(x.g)[0].Error, /asked to cancel/);
  const two = w5(crm({ LEADS: [ashaLead()], Conversations: [conv], Appointments: [appt(1.5)], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(two.meta.calls.length, 1, 'the 2 h reminder always goes');
});

test('W5: TEST_MODE sends only what would really be sent, to TEST_PHONE; an Unknown patient does not even get a test message', () => {
  const yes = w5(crm({ set: { TEST_MODE: 'true' }, LEADS: [ashaLead()], Appointments: [appt(23)], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(yes.meta.calls.length, 1);
  assert.strictEqual(yes.meta.calls[0].body.to, P.TEST.slice(1));
  const unknown = w5(crm({ set: { TEST_MODE: 'true' }, LEADS: [ashaLead()], Appointments: [appt(23)] }));
  assert.strictEqual(unknown.meta.calls.length, 0);
});

test('W5: quiet hours and the sent flag are unchanged; a held reminder is reported once an hour, not every 15 minutes', () => {
  const night = Date.parse('2026-10-14T22:30:00+05:30');
  const q = w5(crm({ LEADS: [ashaLead()], Appointments: [appt(23).fields && { id: 3, fields: { ...appt(23).fields, Start: sec(night) + 23 * HOUR, End: sec(night) + 23 * HOUR + 1800 } }], Reminder_Consent: [consent('Yes')] }), { now: night });
  assert.strictEqual(q.meta.calls.length, 0, 'quiet hours');
  assert.strictEqual(digest(q.g).length, 0, 'quiet hours are silent, as before');
  const sent = w5(crm({ LEADS: [ashaLead()], Appointments: [appt(23, { R24_Sent: sec(DAY) - 60 })], Reminder_Consent: [consent('Yes')] }));
  assert.strictEqual(sent.meta.calls.length, 0, 'flag already set');
  assert.strictEqual(digest(sent.g).length, 0);
  const quarter = DAY + 30 * 60 * 1000;                                    // 11:30 IST: not the first run of the hour
  const held = w5(crm({ LEADS: [ashaLead()], Appointments: [{ id: 3, fields: { ...appt(23).fields, Start: sec(quarter) + 23 * HOUR, End: sec(quarter) + 23 * HOUR + 1800 } }] }), { now: quarter });
  assert.strictEqual(held.meta.calls.length, 0);
  assert.strictEqual(digest(held.g).length, 0, 'the hourly digest is written in the first run of the hour only');
});

test('W5: two runs 15 minutes apart do not send twice (flag), and a held reminder claims nothing so it is retried when consent arrives', () => {
  const g = crm({ LEADS: [ashaLead()], Appointments: [appt(23)] });
  const a = w5(g);
  assert.strictEqual(a.meta.calls.length, 0);
  g.docs[DOC].Reminder_Consent.push(consent('Yes'));
  const b = w5(g, { now: DAY + 15 * 60 * 1000 });
  const c = w5(g, { now: DAY + 30 * 60 * 1000 });
  assert.strictEqual(b.meta.calls.length, 1, 'consent recorded: the next run sends');
  assert.strictEqual(c.meta.calls.length, 0, 'and not again');
});

// ---------------------------------------------------------------- W12
const START12 = 'W12 – When called by another workflow';
const send = (over, docA, meta = fakeMeta()) => {
  const res = run(wf, START12, [sendItem(over)], { grist: crm(docA), meta });
  assert.strictEqual(res.r.error, null, res.r.error && `${res.r.error.node}: ${res.r.error.message}`);
  return { out: res.r.runData['W12 – Return result'][0].json, meta, g: res.grist };
};
const blocked = (x, why) => { assert.deepStrictEqual([x.out.sent, x.out.send_status, x.meta.calls.length], [false, 'blocked', 0]); if (why) assert.match(x.out.send_error, why); };
const sentOk = (x) => { assert.strictEqual(x.out.sent, true, x.out.send_error); assert.strictEqual(x.meta.calls.length, 1); };
const TEXT = { message_type: 'text', text_body: 'Sure, 9 AM works.', template: '', idem_key: 'W13:patient_reply:5', last_inbound_at: sec(DAY) - 120 };

test('W12 reminder purposes: reminder_24h / reminder_2h / followup_reminder need a recorded Yes; legacy lead consent does not unlock them', () => {
  for (const template of ['reminder_24h', 'reminder_2h', 'followup_reminder']) {
    const over = { template, idem_key: `T:${template}`, template_params: { name: 'Asha', clinic_name: 'Demo Physio', date: '15 Oct 2026', time: '9:00 AM', service: 'Assessment', booking_link: 'https://example.test/book' } };
    blocked(send(over, { LEADS: [ashaLead()] }), /no reminder consent on file.*record reminder consent/);
    blocked(send(over, { LEADS: [ashaLead()], Reminder_Consent: [consent('No')] }), /reminder consent is No/);
    blocked(send(over, { LEADS: [ashaLead({ Opted_Out: true })], Reminder_Consent: [consent('Yes')] }), /opted out/);
    sentOk(send(over, { LEADS: [ashaLead()], Reminder_Consent: [consent('Yes')] }));
    sentOk(send(over, { LEADS: [], Reminder_Consent: [consent('Yes')] }));
    blocked(send(over, { LEADS: [ashaLead({ Consent_WhatsApp: false })] }), /no reminder consent/);
  }
});

test('W12: a reminder sent as free text (W15 inside the 24 h window) still needs reminder consent; a plain reply does not', () => {
  blocked(send({ ...TEXT, purpose: 'followup_reminder' }, { LEADS: [ashaLead()] }), /no reminder consent/);
  sentOk(send({ ...TEXT, purpose: 'followup_reminder' }, { LEADS: [ashaLead()], Reminder_Consent: [consent('Yes')] }));
  sentOk(send(TEXT, { LEADS: [] }));
});

test('W12: a caller cannot lower a reminder to a reply or a staff alert', () => {
  blocked(send({ purpose: 'reply' }, { LEADS: [ashaLead()] }), /no reminder consent/);
  blocked(send({ purpose: 'staff_alert' }, { LEADS: [ashaLead()] }), /no reminder consent/);
});

test('W12 booking_confirmation (booking_transaction): needs a Meta opt-in, not reminder consent; an opt-out blocks; declining reminders does not block it', () => {
  const over = { template: 'booking_confirmation', idem_key: 'W4:booking_confirmation:uid-9', template_params: { name: 'Asha', service: 'Assessment', clinic_name: 'Demo Physio', date: '15 Oct 2026', time: '9:00 AM' } };
  sentOk(send(over, { LEADS: [ashaLead()] }));
  sentOk(send(over, { LEADS: [ashaLead()], Reminder_Consent: [consent('No')] }));
  sentOk(send(over, { LEADS: [], Reminder_Consent: [consent('Yes')] }));
  blocked(send(over, { LEADS: [ashaLead({ Consent_WhatsApp: false })] }), /no WhatsApp opt-in on file/);
  blocked(send(over, { LEADS: [] }), /no WhatsApp opt-in on file/);
  blocked(send(over, { LEADS: [ashaLead({ Opted_Out: true })], Reminder_Consent: [consent('Yes')] }), /opted out/);
});

test('W12 engagement (follow-up, rebook, outcome check, review): the existing rule, unchanged; a reminder Yes does not unlock it', () => {
  for (const template of ['followup_day2', 'noshow_rebook', 'outcome_check', 'review_request']) {
    const over = { template, idem_key: `T:${template}`, template_params: { name: 'Asha', clinic_name: 'Demo Physio', service: 'Assessment', date: '15 Oct 2026', booking_link: 'https://example.test/book', review_link: 'https://example.test/r' } };
    sentOk(send(over, { LEADS: [ashaLead()] }));
    blocked(send(over, { LEADS: [ashaLead({ Consent_WhatsApp: false })], Reminder_Consent: [consent('Yes')] }), /no WhatsApp consent on file for this lead/);
    blocked(send(over, { LEADS: [] }), /no lead with this phone number/);
    blocked(send(over, { LEADS: [ashaLead({ Opted_Out: true })] }), /opted out/);
  }
});

test('W12 multi-clinic: reminder consent is read from the clinic\'s OWN document; another clinic\'s Yes (or a missing table) never unlocks a reminder', () => {
  const g = crm({ LEADS: [ashaLead()], Reminder_Consent: [consent('Yes')] });                                    // clinic A: Yes
  g.docs.DOCB = { LEADS: [ashaLead()], Reminder_Consent: [], Send_Ledger: [], Conversations: [], Messages: [], Run_Log: [], Settings: [] };   // clinic B: the same phone, nothing recorded
  const meta = fakeMeta();
  const a = run(wf, START12, [sendItem()], { grist: g, meta });
  const b = run(wf, START12, [sendItem({ doc_id: 'DOCB', idem_key: 'W5:reminder_24h:uid-B' })], { grist: g, meta });
  assert.strictEqual(a.r.runData['W12 – Return result'][0].json.sent, true);
  assert.strictEqual(b.r.runData['W12 – Return result'][0].json.send_status, 'blocked');
  assert.match(b.r.runData['W12 – Return result'][0].json.send_error, /no reminder consent on file/);
  delete g.docs.DOCB.Reminder_Consent;                                                                              // clinic B has no consent table at all
  const c = run(wf, START12, [sendItem({ doc_id: 'DOCB', idem_key: 'W5:reminder_24h:uid-C' })], { grist: g, meta });
  assert.strictEqual(c.r.runData['W12 – Return result'][0].json.send_status, 'blocked');
  assert.strictEqual(meta.calls.length, 1);
});

test('W12: staff alerts, TEST_MODE sends and replies are not consent-checked; an unreadable consent table blocks reminders but not the rest', () => {
  const alert = { audience: 'staff', template: 'new_lead_staff_alert', template_params: { clinic_name: 'C', lead_name: 'N', lead_phone: P.ASHA, enquiry: 'x' }, decision: { send: true, to: P.OWNER, reason: 'ok' }, idem_key: 'W3:alert:1' };
  sentOk(send(alert, { LEADS: [] }));
  sentOk(send({ decision: { send: true, to: P.TEST, reason: 'test mode', test_mode: true } }, { LEADS: [] }));
  const down = (over, docA) => { const res = run(wf, START12, [sendItem(over)], { grist: unreadable(crm(docA), 'Reminder_Consent'), meta: fakeMeta() }); return { out: res.r.runData['W12 – Return result'][0].json, meta: res.r && fakeMeta() }; };
  const rem = down({}, { LEADS: [ashaLead()] });
  assert.strictEqual(rem.out.sent, false);
  assert.match(rem.out.send_error, /reminder consent could not be read/);
  const book = down({ template: 'booking_confirmation', idem_key: 'T:b', template_params: { name: 'A', service: 'S', clinic_name: 'C', date: 'd', time: 't' } }, { LEADS: [ashaLead()] });
  assert.strictEqual(book.out.sent, true, 'a booking confirmation does not depend on the reminder table');
});

// ---------------------------------------------------------------- W15
const AT = Date.parse('2026-10-14T10:25:00+05:30');                        // Wednesday 10:25 IST: Thursday 15 Oct follow-ups
const TOMORROW = Date.UTC(2026, 9, 15) / 1000;
const patient = (over = {}, id = 3) => ({ id, fields: { Patient_ID: `GK-P-00000${id}`, Name: 'Asha Patel', Phone: P.ASHA, Status: 'Active', Follow_Up_On: TOMORROW, ...over } });
const w15 = (docA, o = {}) => { const meta = o.meta || fakeMeta(); const res = run(wf, 'W15 – Every hour', [{}], { grist: crm({ set: { followup_reminders: 'on', booking_link: 'https://example.test/book' }, ...docA }), meta, now: AT }); assert.strictEqual(res.r.error, null, res.r.error && `${res.r.error.node}: ${res.r.error.message}`); return { g: res.grist, meta }; };
const claimed = (x) => rows(x.g, 'Patients').find((p) => p.id === 3).Followup_Reminded_For;

test('W15: a follow-up reminder needs reminder consent; a patient with NO lead can be reminded; nothing is claimed for a held patient', () => {
  const noLead = w15({ Patients: [patient()], LEADS: [], Reminder_Consent: [consent('Yes')] });
  assert.strictEqual(noLead.meta.calls.length, 1, 'no lead needed');
  assert.strictEqual(noLead.meta.calls[0].body.template.name, 'followup_reminder');
  assert(claimed(noLead), 'claimed before the send');
  for (const [name, docA] of [
    ['legacy lead consent only', { LEADS: [ashaLead()], Reminder_Consent: [] }],
    ['No', { LEADS: [ashaLead()], Reminder_Consent: [consent('No')] }],
    ['opted out', { LEADS: [ashaLead({ Opted_Out: true })], Reminder_Consent: [consent('Yes')] }],
    ['no lead, no consent', { LEADS: [], Reminder_Consent: [] }],
  ]) {
    const x = w15({ Patients: [patient()], ...docA });
    assert.strictEqual(x.meta.calls.length, 0, name);
    assert(!claimed(x), `${name}: not claimed, so it still goes if consent is recorded before the day`);
  }
});

test('W15: the reminder is not sent when the consent table cannot be read, and the in-window free-text version needs consent too', () => {
  const g = unreadable(crm({ set: { followup_reminders: 'on', booking_link: 'https://example.test/book' }, Patients: [patient()], LEADS: [ashaLead()], Reminder_Consent: [consent('Yes')] }), 'Reminder_Consent');
  const meta = fakeMeta();
  const res = run(wf, 'W15 – Every hour', [{}], { grist: g, meta, now: AT });
  assert.strictEqual(res.r.error, null, res.r.error && res.r.error.message);
  assert.strictEqual(meta.calls.length, 0);
  const conv = { id: 1, fields: { Lead: 7, Phone: P.ASHA, Last_Inbound_At: sec(AT) - 600 } };
  const noConsent = w15({ Patients: [patient()], LEADS: [ashaLead()], Conversations: [conv], Reminder_Consent: [] });
  assert.strictEqual(noConsent.meta.calls.length, 0);
  const yes = w15({ Patients: [patient()], LEADS: [ashaLead()], Conversations: [conv], Reminder_Consent: [consent('Yes')] });
  assert.strictEqual(yes.meta.calls.length, 1);
  assert.strictEqual(yes.meta.calls[0].body.type, 'text', 'inside the 24 h window the same words go as text');
});

test('W15: a held patient is reminded as soon as reminder consent is recorded the same day; the held reasons are the new ones', () => {
  const g = crm({ set: { followup_reminders: 'on', booking_link: 'https://example.test/book' }, Patients: [patient(), patient({ Name: 'Opted Out', Phone: P.BOB }, 4)], LEADS: [ashaLead(), ashaLead({ Phone: P.BOB, Opted_Out: true }), ], Reminder_Consent: [consent('Yes', P.BOB, 2)] });
  g.docs[DOC].LEADS[1].id = 8;
  const meta = fakeMeta();
  const first = run(wf, 'W15 – Every hour', [{}], { grist: g, meta, now: AT });
  assert.strictEqual(first.r.error, null, first.r.error && first.r.error.message);
  assert.strictEqual(meta.calls.length, 0);
  const summary = rows(g, 'Run_Log').filter((l) => l.Workflow === 'W15-followup-reminder');
  assert.strictEqual(summary.length, 1);
  assert.match(summary[0].Record, /no reminder consent on file 1/);
  assert.match(summary[0].Record, /opted out 1/);
  g.docs[DOC].Reminder_Consent.push(consent('Yes', P.ASHA, 3));
  const later = run(wf, 'W15 – Every hour', [{}], { grist: g, meta, now: AT + 5 * HOUR * 1000 });
  assert.strictEqual(later.r.error, null, later.r.error && later.r.error.message);
  assert.strictEqual(meta.calls.length, 1, 'consent recorded at 15:25: the reminder goes the same day');
  assert.strictEqual(meta.calls[0].body.to, P.ASHA.slice(1));
});

// ---------------------------------------------------------------- Cal.com is not a booking link any more (W6 follow-ups, W15 reminders)
test('W6: a Cal.com booking_link counts as no link (nothing sent, the failure is logged, the flag stays off); a clinic\'s own link still works', () => {
  const oldLead = () => ({ id: 7, fields: { Lead_id: 'L-1', Created_At: sec(DAY) - 3 * 86400, Name: 'Asha', Phone: P.ASHA, Source: 'Website', Status: 'New', Enquiry: 'knee', Opted_Out: false, Escalated: false, Followup_Sent: false, Consent_WhatsApp: true, Consent_Source: 'website-form' } });
  const w6 = (link) => { const g = crm({ set: { booking_link: link }, LEADS: [oldLead()] }); const meta = fakeMeta(); const res = run(wf, 'W6 – Daily 10:00', [{}], { grist: g, meta }); assert.strictEqual(res.r.error, null, res.r.error && res.r.error.message); return { g, meta }; };
  for (const cal of ['https://cal.com/demo-physio/assessment', 'https://app.cal.com/x', 'https://CAL.COM/x', 'https://demo.cal.eu/x']) {
    const x = w6(cal);
    assert.strictEqual(x.meta.calls.length, 0, cal);
    assert.strictEqual(rows(x.g, 'LEADS')[0].Followup_Sent, false, cal);
    assert.match(rows(x.g, 'Run_Log')[0].Error, /booking_link/, cal);
  }
  const own = w6('https://www.demophysio.example/book');
  assert.strictEqual(own.meta.calls.length, 1);
  assert.match(JSON.stringify(own.meta.calls[0].body), /demophysio\.example/);
  assert(!/cal\.com/i.test(JSON.stringify(own.meta.calls[0].body)));
});

test('W15: a Cal.com booking_link holds the follow-up reminder (counted in the daily summary with the reason); a clinic\'s own link sends it', () => {
  const held = w15({ Patients: [patient()], LEADS: [], Reminder_Consent: [consent('Yes')], set: { followup_reminders: 'on', booking_link: 'https://cal.com/demo-physio/assessment' } });
  assert.strictEqual(held.meta.calls.length, 0);
  assert(!claimed(held));
  assert.match(rows(held.g, 'Run_Log').filter((l) => l.Workflow === 'W15-followup-reminder')[0].Record, /booking_link is not set \(an https link that is not Cal\.com\)/);
  const ok = w15({ Patients: [patient()], LEADS: [], Reminder_Consent: [consent('Yes')], set: { followup_reminders: 'on', booking_link: 'https://www.demophysio.example/book' } });
  assert.strictEqual(ok.meta.calls.length, 1);
  assert.match(JSON.stringify(ok.meta.calls[0].body), /demophysio\.example/);
});

// ---------------------------------------------------------------- the earlier W12 pause check still comes after the consent step
const CONV = 3; const MSG = 5; const T = sec(DAY) - 120;
const convRow = (over = {}) => ({ id: CONV, fields: { Lead: 7, Phone: P.ASHA, Last_Inbound_At: T, Unread: 0, Automation_Paused: false, ...over } });
const msgRow = () => ({ id: MSG, fields: { Conversation: CONV, Direction: 'In', Body: 'Hello', Created_At: T } });
const reply = (over = {}) => sendItem({ source_workflow: 'W13-ai-receptionist', w13_kind: 'patient_reply', audience: 'patient', message_type: 'text', template: '', template_params: undefined,
  text_body: 'The first assessment costs 500 rupees.', message_text: 'The first assessment costs 500 rupees.', idem_key: `W13:patient_reply:${MSG}`, last_inbound_at: T, lead_row_id: 7, lead_phone: P.ASHA, ...over });

test('W12: a W13 reply is still sent when the conversation is live and stopped when it is paused (the pause check follows the consent step, unchanged)', () => {
  const live = run(wf, START12, [reply()], { grist: crm({ LEADS: [ashaLead()], Conversations: [convRow()], Messages: [msgRow()] }), meta: fakeMeta() });
  assert.strictEqual(live.r.runData['W12 – Return result'][0].json.sent, true, live.r.runData['W12 – Return result'][0].json.send_error);
  const meta = fakeMeta();
  const paused = run(wf, START12, [reply()], { grist: crm({ LEADS: [ashaLead()], Conversations: [convRow({ Automation_Paused: true })], Messages: [msgRow()] }), meta });
  const out = paused.r.runData['W12 – Return result'][0].json;
  assert.deepStrictEqual([out.sent, out.send_status, meta.calls.length], [false, 'blocked', 0]);
  assert.match(out.send_error, /paus/i);
});

finish('4c-consent');
