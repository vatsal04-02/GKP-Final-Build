// W3 / W5 / W6 of the PRODUCTION export, run from their schedule triggers in the simulator (fake Grist, fake Meta):
// approved templates only, idempotency, honest sent flag and Run_Log, uncertain sends never retried.
// Run: node n8n/production/tests/callers.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, fakeMeta, metaError, ledger, rows, freshGrist, test, finish, DAY, P, ENV, DOC, F } = H;
const wf = loadWf();
const S = (ms) => Math.floor(ms / 1000);
const HOUR = 3600;

const lead = (over = {}) => ({ id: 7, fields: { Lead_id: 'L-20261010-0001', Created_At: S(DAY) - 3 * 86400, Name: 'Asha', Phone: P.ASHA, Source: 'Website', Status: 'New', Enquiry: 'knee pain', Opted_Out: false, Escalated: false, Followup_Sent: false, Consent_WhatsApp: true, Consent_Source: 'website-form', ...over } });
const settings = (more = {}) => F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, booking_link: 'https://cal.example.test/demo', ...more });
const grist = (docA) => freshGrist({ Settings: settings(docA && docA.settings), ...Object.fromEntries(Object.entries(docA || {}).filter(([k]) => k !== 'settings')) });
const log = (g) => rows(g, 'Run_Log');
const names = (r) => r.visited.filter((v, i, a) => a.indexOf(v) === i);

// ---------------------------------------------------------------- W5
const apptIn = (hours) => ({ id: 3, fields: { Booking_UID: 'uid-3', Lead: 7, Service: 'Assessment', Physio: 'Dr Rao', Start: S(DAY) + Math.round(hours * HOUR), End: S(DAY) + Math.round(hours * HOUR) + 2700, Status: 'Booked', R24_Sent: null, R2_Sent: null } });
const w5 = (g, o = {}) => run(wf, 'W5 – Every 15 minutes', [{}], { grist: g, ...o });

test('W5: a 24 h reminder goes out with the approved template, a ledger row, the flag and an honest log', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(23)] });
  const meta = fakeMeta();
  const { r } = w5(g, { meta });
  assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'reminder_24h');
  assert.notStrictEqual(meta.calls[0].body.template.name, 'hello_world');
  assert.deepStrictEqual(meta.calls[0].body.template.components[0].parameters.map((p) => p.text).slice(0, 3), ['Asha', 'Assessment', 'Demo Physio']);
  assert.strictEqual(meta.calls[0].body.to, P.ASHA.slice(1));
  assert.deepStrictEqual(ledger(g).map((l) => [l.Idem_Key, l.Status]), [['W5:reminder_24h:uid-3', 'accepted']]);
  assert.strictEqual(typeof rows(g, 'Appointments')[0].R24_Sent, 'number');
  assert.deepStrictEqual(log(g).map((l) => [l.Workflow, l.Outcome, l.Error]), [['W5-reminders', 'ok', '']]);
  assert.strictEqual(rows(g, 'Conversations').length, 1, 'the send is written to the inbox');
});

test('W5: the 2 h reminder uses reminder_2h', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(1.5)] });
  const meta = fakeMeta();
  assert.strictEqual(w5(g, { meta }).r.error, null);
  assert.strictEqual(meta.calls[0].body.template.name, 'reminder_2h');
  assert.strictEqual(ledger(g)[0].Idem_Key, 'W5:reminder_2h:uid-3');
});

test('W5: second run does nothing (flag set, ledger row exists)', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(23)] });
  const meta = fakeMeta();
  w5(g, { meta }); w5(g, { meta });
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(log(g).length, 1);
});

test('W5: flag lost but the ledger remembers -> duplicate: no second message, flag set again, log "skipped"', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(23)] });
  const meta = fakeMeta();
  w5(g, { meta });
  g.docs[DOC].Appointments[0].fields.R24_Sent = null;                 // the flag write was lost
  const { r } = w5(g, { meta });
  assert.strictEqual(r.error, null, r.error && r.error.message);
  assert.strictEqual(meta.calls.length, 1, 'no second WhatsApp message');
  assert.strictEqual(typeof rows(g, 'Appointments')[0].R24_Sent, 'number');
  assert.deepStrictEqual(log(g).map((l) => l.Outcome), ['ok', 'skipped']);
});

test('W5: Meta timeout = uncertain: the flag is set (never retried), Run_Log says failed/uncertain, one ledger row "uncertain"', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(23)] });
  const meta = fakeMeta(() => { throw new Error('timeout of 15000ms exceeded'); });
  assert.strictEqual(w5(g, { meta }).r.error, null);
  assert.strictEqual(typeof rows(g, 'Appointments')[0].R24_Sent, 'number');
  const l = log(g);
  assert.deepStrictEqual([l.length, l[0].Outcome], [1, 'failed']);
  assert.match(l[0].Error, /^uncertain:/);
  assert.strictEqual(ledger(g)[0].Status, 'uncertain');
  const meta2 = fakeMeta();
  w5(g, { meta: meta2 });
  assert.strictEqual(meta2.calls.length, 0);
});

test('W5: Meta rejects (template missing): logged as failed, flag NOT set, ledger "rejected"; the next run tries again', () => {
  const g = grist({ LEADS: [lead()], Appointments: [apptIn(23)] });
  const bad = fakeMeta(metaError(400, 132001, 'Template name does not exist'));
  assert.strictEqual(w5(g, { meta: bad }).r.error, null);
  assert.strictEqual(rows(g, 'Appointments')[0].R24_Sent, null);
  assert.deepStrictEqual(log(g).map((l) => [l.Outcome, /132001/.test(l.Error)]), [['failed', true]]);
  assert.strictEqual(ledger(g)[0].Status, 'rejected');
  const good = fakeMeta();
  w5(g, { meta: good });
  assert.strictEqual(good.calls.length, 1);
  assert.strictEqual(typeof rows(g, 'Appointments')[0].R24_Sent, 'number');
});

test('W5: quiet hours: nothing is sent, nothing is flagged, nothing is logged as a failure', () => {
  const g = grist({ LEADS: [lead()], Appointments: [{ id: 3, fields: { ...apptIn(23).fields, Start: S(H.NIGHT) + 23 * HOUR, End: S(H.NIGHT) + 23 * HOUR + 2700 } }] });
  const meta = fakeMeta();
  const { r } = w5(g, { meta, now: H.NIGHT });
  assert.strictEqual(r.error, null);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(g, 'Appointments')[0].R24_Sent, null);
  assert.strictEqual(log(g).length, 0);
});

test('W5: TEST_MODE on: the message goes to TEST_PHONE, never to the patient', () => {
  const g = grist({ settings: { TEST_MODE: 'true' }, LEADS: [lead()], Appointments: [apptIn(23)] });
  const meta = fakeMeta();
  w5(g, { meta });
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.to, P.TEST.slice(1));
});

test('W5: an opted-out patient is never messaged', () => {
  const g = grist({ LEADS: [lead({ Opted_Out: true })], Appointments: [apptIn(23)] });
  const meta = fakeMeta();
  w5(g, { meta });
  assert.strictEqual(meta.calls.length, 0);
});

// ---------------------------------------------------------------- W3
const w3 = (g, o = {}) => run(wf, 'W3 – Every 10 minutes', [{}], { grist: g, ...o });
const newLead = (over = {}) => lead({ Created_At: S(DAY) - 45 * 60, Enquiry: 'back pain', ...over });

test('W3: an unanswered new lead alerts the owner with new_lead_staff_alert (not hello_world); Escalated is set; Run_Log ok', () => {
  const g = grist({ LEADS: [newLead()] });
  const meta = fakeMeta();
  const { r } = w3(g, { meta });
  assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'new_lead_staff_alert');
  assert.strictEqual(meta.calls[0].body.to, P.OWNER.slice(1));
  assert.deepStrictEqual(ledger(g).map((l) => [l.Idem_Key, l.Status, l.Audience]), [['W3:new_lead_staff_alert:7', 'accepted', 'staff']]);
  assert.strictEqual(rows(g, 'LEADS')[0].Escalated, true);
  assert.deepStrictEqual(log(g).map((l) => [l.Workflow, l.Outcome]), [['W3-speed-to-lead', 'ok']]);
  assert.strictEqual(rows(g, 'Conversations').length, 0, 'staff alerts are not written to the patient inbox');
});

test('W3: uncertain -> Escalated set, no resend, log failed/uncertain', () => {
  const g = grist({ LEADS: [newLead()] });
  const meta = fakeMeta(() => { throw new Error('socket hang up'); });
  assert.strictEqual(w3(g, { meta }).r.error, null);
  assert.strictEqual(rows(g, 'LEADS')[0].Escalated, true);
  assert.match(log(g)[0].Error, /^uncertain:/);
  const meta2 = fakeMeta();
  w3(g, { meta: meta2 });
  assert.strictEqual(meta2.calls.length, 0);
});

test('W3: no owner number configured: nothing is sent and nothing is flagged', () => {
  const g = grist({ settings: { owner_phone: '' }, LEADS: [newLead()] });
  const meta = fakeMeta();
  assert.strictEqual(w3(g, { meta }).r.error, null);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(g, 'LEADS')[0].Escalated, false);
});

// ---------------------------------------------------------------- W6
const w6 = (g, o = {}) => run(wf, 'W6 – Daily 10:00', [{}], { grist: g, ...o });
const noShow = () => ({ id: 5, fields: { Booking_UID: 'uid-5', Lead: 7, Service: 'Assessment', Start: S(DAY) - 26 * HOUR, End: S(DAY) - 26 * HOUR + 2700, Status: 'No-show', Rebook_Sent: null } });

test('W6: a no-show gets noshow_rebook with the booking link, Rebook_Sent is set', () => {
  const g = grist({ LEADS: [lead({ Created_At: S(DAY) - 10 * 86400, Status: 'Booked' })], Appointments: [noShow()] });
  const meta = fakeMeta();
  const { r } = w6(g, { meta });
  assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'noshow_rebook');
  assert.match(JSON.stringify(meta.calls[0].body), /cal\.example\.test/);
  assert.deepStrictEqual(ledger(g).map((l) => l.Idem_Key), ['W6:noshow_rebook:5']);
  assert.strictEqual(typeof rows(g, 'Appointments')[0].Rebook_Sent, 'number');
});

test('W6: a 3-day-old open lead gets ONE followup_day2 (never hello_world); Followup_Sent is set; a second run sends nothing', () => {
  const g = grist({ LEADS: [lead()] });
  const meta = fakeMeta();
  assert.strictEqual(w6(g, { meta }).r.error, null);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'followup_day2');
  assert.strictEqual(rows(g, 'LEADS')[0].Followup_Sent, true);
  w6(g, { meta });
  assert.strictEqual(meta.calls.length, 1);
});

test('W6: no booking link in Settings: nothing is sent, the failure is logged (not silent), the flag stays off', () => {
  const g = grist({ settings: { booking_link: '' }, LEADS: [lead()] });
  const meta = fakeMeta();
  assert.strictEqual(w6(g, { meta }).r.error, null);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(g, 'LEADS')[0].Followup_Sent, false);
  const l = log(g);
  assert.deepStrictEqual([l.length, l[0].Outcome], [1, 'failed']);
  assert.match(l[0].Error, /booking_link/);
});

test('no node of W3 / W5 / W6 mentions hello_world any more', () => {
  for (const n of wf.nodes.filter((x) => /^W[356] –/.test(x.name))) assert(!/template\s*[:=]\s*'hello_world'/.test(JSON.stringify(n.parameters).replace(/\\n/g, '\n')), n.name);
});

finish('W3/W5/W6 production');
