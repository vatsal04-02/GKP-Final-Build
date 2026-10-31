// W15 follow-up reminder (n8n/final/tools/patch-w15-followup.js) in the simulator: fake Grist, Meta and AI, nothing leaves this computer.
//   node n8n/final/tests/w15-followup.test.js        (W15_FILE=<export.json> tests another export that already carries W15)
//
// What is proved: the day before a patient's follow-up date ONE reminder goes through W12 (template followup_reminder, or the same words
// as free text inside the 24 h window); the flag Patients.Followup_Reminded_For is claimed before the send and blocks a second one; a new
// follow-up date is reminded again; opted out / Automation_Paused / no WhatsApp consent / no booking link / switch off / before 10:00 IST
// send nothing and claim nothing; TEST_MODE sends to TEST_PHONE; a refused send keeps the flag (one attempt per date); held patients are
// counted in ONE Run_Log line, written only in the send_hour run; the config guard stops the section before Grist is read.
'use strict';
const path = require('path');
const assert = require('assert');
process.env.PROD_FILE = process.env.W15_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const H = require('../../production/tests/harness');
const { patch, unpatch, N, ADDED, CHANGED } = require('../tools/patch-w15-followup');
const { run, fakeMeta, metaError, freshGrist, ashaLead, rows, ledger, test, finish, F, P } = H;

// the Clinic Records table W15 reads (grist/clinic-records-schema.md): taught to the fake Grist here, Dates are epoch seconds like Grist's
const PATIENT_COLS = ['Patient_ID', 'Serial_No', 'Name', 'Phone', 'Address', 'Age', 'Sex', 'Referred_By', 'Occupation', 'Main_Complaint', 'Registered_On', 'Status',
  'Follow_Up_On', 'Followup_Reminded_For', 'Source_Lead_ID', 'Notes', 'Created_At', 'Created_By'];
H.sim.COLUMNS.Patients = PATIENT_COLS;
for (const c of ['Registered_On', 'Follow_Up_On', 'Followup_Reminded_For', 'Created_At']) H.sim.DATETIME.add(`Patients.${c}`);

const wf = H.loadWf();
const before = unpatch(wf);
const START = N.trigger;
const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const AT = ist('2026-10-14', '10:25');                          // Wednesday 10:25 IST: Thursday 15 Oct follow-ups get their reminder
const D = (iso) => Date.UTC(...iso.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 1000;
const TOMORROW = D('2026-10-15');

const patient = (over = {}, id = 3) => ({ id, fields: { Patient_ID: `GK-P-00000${id}`, Name: 'Asha Patel', Phone: P.ASHA, Status: 'Active', Follow_Up_On: TOMORROW, ...over } });
const settings = (over = {}) => F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, followup_reminders: 'on', ...over });
const crm = ({ patients = [patient()], leads = [ashaLead()], convs = [], set = {} } = {}) => freshGrist({ Settings: settings(set), Patients: patients, LEADS: leads, Conversations: convs });
const go = (o = {}) => {
  const meta = o.meta || fakeMeta();
  const res = run(wf, START, [{}], { grist: o.g || crm(o), meta, now: o.now || AT, env: o.env, unset: o.unset });
  return { g: res.grist, r: res.r, meta };
};
const okRun = (x) => { assert.strictEqual(x.r.error, null, x.r.error && `${x.r.error.node}: ${x.r.error.message}`); return x; };
const pat = (x, id = 3) => rows(x.g, 'Patients').find((p) => p.id === id);
const logs = (x) => rows(x.g, 'Run_Log').filter((l) => l.Workflow === 'W15-followup-reminder');
const sentNothing = (x) => {
  assert.strictEqual(x.meta.calls.length, 0, 'Meta was not called');
  assert(!pat(x).Followup_Reminded_For, 'nothing was claimed');
  assert.strictEqual(logs(x).filter((l) => l.Outcome !== 'skipped').length, 0, 'no send was logged');
};

// ---------------------------------------------------------------- the build
test('the committed workflow carries W15: 21 nodes added, only the two W12 template lists changed, patch refuses to run twice', () => {
  assert.strictEqual(ADDED.length, 21);
  for (const n of ADDED) assert(wf.nodes.some((x) => x.name === n), `${n} is missing`);
  assert.strictEqual(JSON.stringify(patch(before)), JSON.stringify(wf), 'patch(unpatch(file)) is the file');
  assert.throws(() => patch(wf), /already exists/);
  const was = new Map(before.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = wf.nodes.filter((n) => was.has(n.name) && was.get(n.name) !== JSON.stringify(n)).map((n) => n.name).sort();
  assert.deepStrictEqual(changed, [...CHANGED].sort());
  for (const n of CHANGED) assert(/followup_reminder: \{ params: \['name', 'clinic_name', 'date', 'booking_link'\] \}/.test(wf.nodes.find((x) => x.name === n).parameters.jsCode), `${n} knows the template`);
});

test('graph: Send? true claims then calls W12; false goes only to the held summary; every HTTP node uses the Grist credential', () => {
  const edges = []; for (const [from, v] of Object.entries(wf.connections)) (v.main || []).forEach((o, i) => (o || []).forEach((c) => edges.push([from, c.node, i])));
  const out = (n) => edges.filter((e) => e[0] === n).map((e) => `${e[1]}#${e[2]}`);
  assert.deepStrictEqual(out(N.send), [`${N.build}#0`, `${N.held}#1`]);
  assert.deepStrictEqual(out(N.build), [`${N.claim}#0`], 'the flag is written before anything else');
  assert.deepStrictEqual(out(N.claim), [`${N.restore}#0`]);
  assert.deepStrictEqual(out(N.restore), [`${N.call}#0`], 'W12 only after the claim answered');
  assert.deepStrictEqual(edges.filter((e) => e[1] === N.call).map((e) => e[0]), [N.restore], 'nothing else reaches W12');
  for (const n of wf.nodes.filter((x) => ADDED.includes(x.name) && /httpRequest/.test(x.type))) assert.deepStrictEqual(Object.values(n.credentials || {}).map((c) => c.name), ['Header Auth account 2'], n.name);
  assert.strictEqual(wf.nodes.find((x) => x.name === N.call).parameters.workflowId.value, '={{ $workflow.id }}', 'W12 is this workflow\'s own sender');
});

test('the config guard stops W15 before Grist is read when the registry id is missing', () => {
  const x = go({ unset: ['FLOWHQ_REGISTRY_DOC_ID'] });
  assert(x.r.error && /FlowHQ configuration incomplete in W15: .*FLOWHQ_REGISTRY_DOC_ID is not set/.test(x.r.error.message), x.r.error && x.r.error.message);
  assert.strictEqual(x.g.calls.length, 0);
  assert.strictEqual(x.meta.calls.length, 0);
});

// ---------------------------------------------------------------- sending
test('the day before: ONE followup_reminder template to the patient, flag claimed with the date, ledger key, Run_Log ok', () => {
  const x = okRun(go());
  assert.strictEqual(x.meta.calls.length, 1);
  const body = x.meta.calls[0].body;
  assert.strictEqual(body.to, P.ASHA.slice(1));
  assert.strictEqual(body.template.name, 'followup_reminder');
  assert.deepStrictEqual(body.template.components[0].parameters.map((p) => p.text), ['Asha', 'Demo Physio', '15 Oct 2026', 'https://cal.com/demo-physio/assessment']);
  assert.strictEqual(pat(x).Followup_Reminded_For, TOMORROW, 'rule 4: the reminded date is stored');
  assert(ledger(x.g).some((l) => /^W15:followup_reminder:GK-P-000003:2026-10-15$/.test(l.Idem_Key || l.Key || '')), `ledger: ${JSON.stringify(ledger(x.g))}`);
  const l = logs(x);
  assert.deepStrictEqual(l.map((r) => [r.Outcome, r.Record]), [['ok', 'GK-P-000003 follow-up 2026-10-15']]);
  const claimAt = x.g.calls.findIndex((c) => c.method === 'PATCH' && c.table === 'Patients');
  const ledgerAt = x.g.calls.findIndex((c) => c.table === 'Send_Ledger');
  assert(claimAt >= 0 && claimAt < ledgerAt, 'the flag was written before W12 touched the ledger');
});

test('a second run the same day sends nothing (flag), and a NEW follow-up date is reminded again', () => {
  const g = crm();
  const a = okRun(go({ g }));
  assert.strictEqual(a.meta.calls.length, 1);
  const b = okRun(go({ g, now: ist('2026-10-14', '11:25') }));
  assert.strictEqual(b.meta.calls.length, 0, 'never twice for the same date');
  // the flag alone (an empty send ledger, as after a ledger clean-up): W15 itself must not plan it, not only W12's ledger refuse it
  const flagOnly = okRun(go({ patients: [patient({ Followup_Reminded_For: TOMORROW })] }));
  assert.strictEqual(flagOnly.meta.calls.length, 0, 'already reminded for this date: not planned');
  assert.strictEqual(flagOnly.g.calls.filter((c) => c.table === 'Send_Ledger').length, 0, 'W12 was never asked');
  const c = okRun(go({ patients: [patient({ Follow_Up_On: TOMORROW, Followup_Reminded_For: D('2026-09-30') })] }));
  assert.strictEqual(c.meta.calls.length, 1, 'reminded for an older date: the new one is reminded');
});

test('inside the 24 h window the same words go as free text', () => {
  const convs = [{ id: 1, fields: { Lead: 7, Phone: P.ASHA, Last_Inbound_At: Math.floor(AT / 1000) - 3600, Automation_Paused: false } }];
  const x = okRun(go({ convs }));
  assert.strictEqual(x.meta.calls.length, 1);
  assert.strictEqual(x.meta.calls[0].body.type, 'text');
  assert.strictEqual(x.meta.calls[0].body.text.body, 'Hi Asha, a reminder from Demo Physio: your follow-up visit is due on 15 Oct 2026. Please book or confirm your time here: https://cal.com/demo-physio/assessment or simply reply to this message.');
});

test('TEST_MODE: the reminder goes to TEST_PHONE, not the patient', () => {
  const x = okRun(go({ set: { TEST_MODE: 'true' } }));
  assert.strictEqual(x.meta.calls.length, 1);
  assert.strictEqual(x.meta.calls[0].body.to, P.TEST.slice(1));
  assert(/\(TEST_MODE\)/.test(logs(x)[0].Record));
});

test('a send W12 refuses is logged failed and the flag stays (one attempt per follow-up date)', () => {
  const x = okRun(go({ meta: fakeMeta(metaError(400, 132001, 'template not found')) }));
  assert.strictEqual(x.meta.calls.length, 1);
  assert.strictEqual(pat(x).Followup_Reminded_For, TOMORROW);
  assert.deepStrictEqual(logs(x).map((l) => l.Outcome), ['failed']);
  assert(/132001/.test(logs(x)[0].Error), logs(x)[0].Error);
});

// ---------------------------------------------------------------- nothing sent, nothing claimed
test('switch off (followup_reminders missing): nothing planned, nothing sent', () => {
  const x = okRun(go({ set: { followup_reminders: undefined } }));
  sentNothing(x);
  assert.strictEqual(logs(x).length, 0);
});

test('before 10:00 IST and after the follow-up date: nothing', () => {
  sentNothing(okRun(go({ now: ist('2026-10-14', '09:25') })));
  sentNothing(okRun(go({ patients: [patient({ Follow_Up_On: D('2026-10-14') })] })));
  sentNothing(okRun(go({ patients: [patient({ Follow_Up_On: D('2026-10-16') })] })));
  sentNothing(okRun(go({ patients: [patient({ Status: 'Completed' })] })));
});

test('held, not claimed, ONE summary line: no consent, no lead, opted out, no booking link', () => {
  const cases = [
    [{ leads: [ashaLead({ Consent_WhatsApp: false })] }, /no WhatsApp consent on file \(LEADS\.Consent_WhatsApp\) 1/],
    [{ leads: [] }, /no lead with this phone/],
    [{ leads: [ashaLead({ Opted_Out: true })] }, /opted out 1/],
    [{ set: { booking_link: '' } }, /booking_link is not set/],
  ];
  for (const [o, why] of cases) {
    const x = okRun(go(o));
    sentNothing(x);
    const l = logs(x);
    assert.strictEqual(l.length, 1, `one summary line: ${JSON.stringify(l)}`);
    assert.strictEqual(l[0].Outcome, 'skipped');
    assert.match(l[0].Record, why);
  }
});

test('Automation_Paused (rule 5): not sent, not claimed, counted', () => {
  const convs = [{ id: 1, fields: { Lead: 7, Phone: P.ASHA, Automation_Paused: true } }];
  const x = okRun(go({ convs }));
  sentNothing(x);
  assert.match(logs(x)[0].Record, /automation paused 1/);
});

test('the summary is written once a day (send_hour run), and a held patient is reminded as soon as consent is recorded', () => {
  const g = crm({ leads: [ashaLead({ Consent_WhatsApp: false })] });
  assert.strictEqual(logs(okRun(go({ g }))).length, 1);
  const later = okRun(go({ g, now: ist('2026-10-14', '12:25') }));
  assert.strictEqual(logs(later).length, 1, 'no second summary line at 12:25');
  g.docs.DOCA.LEADS[0].fields.Consent_WhatsApp = true;
  const fixed = okRun(go({ g, now: ist('2026-10-14', '15:25') }));
  assert.strictEqual(fixed.meta.calls.length, 1, 'consent recorded at 15:00: the reminder goes the same day');
});

test('several patients: each gets their own reminder; the others in the clinic are untouched', () => {
  const x = okRun(go({
    patients: [patient(), patient({ Name: 'Bob Kumar', Phone: P.BOB }, 4), patient({ Name: 'Later Patient', Follow_Up_On: D('2026-10-20') }, 5)],
    leads: [ashaLead(), ashaLead({ Lead_id: 'L-2', Name: 'Bob', Phone: P.BOB })].map((l, i) => ({ ...l, id: 7 + i })),
  }));
  assert.deepStrictEqual(x.meta.calls.map((c) => c.body.to).sort(), [P.ASHA.slice(1), P.BOB.slice(1)].sort());
  assert.strictEqual(pat(x, 5).Followup_Reminded_For, undefined, 'a later follow-up is not touched');
});

finish('W15 follow-up reminder');
