#!/usr/bin/env node
// W15 follow-up reminder. The day before a patient's follow-up date (Patients.Follow_Up_On, which FLOW HQ copies from the prescription
// the doctor writes), one WhatsApp reminder with the clinic's booking link. Built like W7 (the outcome check-in), section by section.
//
//   node n8n/final/tools/patch-w15-followup.js <workflow.json> <output.json>
//
// The rules (CLAUDE.md):
//   rule 4  sent flag Patients.Followup_Reminded_For (Date) = the follow-up date already reminded. Claimed BEFORE the send and never
//           cleared (as W7: a broken template or number cannot make the section message the patient again and again). A new
//           follow-up date is a new reminder. W12's send ledger (idem_key "W15:followup_reminder:<Patient_ID>:<date>") is the second lock.
//   rule 5  Opted_Out (the lead with the patient's phone), Automation_Paused (that lead's conversation), quiet hours, TEST_MODE:
//           send-guard.js, as every section. W12 still checks quiet hours, the allowlist and WhatsApp consent before Meta.
//   rule 7  phones through normalize-phone.js (the copy every Code node carries).
//   rule 8  no AI: the words are fixed (n8n/snippets/followup-reminder.js), the template is followup_reminder.
//   Clinic lookup: every active clinic of the Agency Registry, never a hard-coded one; only clinics with Settings > followup_reminders = on.
// Patients W12 would refuse (no lead with the phone, no LEADS.Consent_WhatsApp, opted out) or that cannot get a useful message
// (no https booking_link, no valid phone) are HELD: not claimed, not sent, one Run_Log summary line per clinic per day.
//
// Added: 21 nodes (section W15). Changed: ONLY the WA_TEMPLATES list in "W12 – Prepare request" and "W12 – Read reply" (one entry each).
// n8n/snippets/wa-send.js is deliberately NOT changed: the older lineage exports (n8n/integrated, n8n/merged, n8n/workflows) are each
// validated to embed that exact snippet, so the followup_reminder entry lives in this workflow's W12 only (the W12 that runs).
// The new nodes are copies of their W7 counterparts (same node types, versions and the Grist credential reference) with W15 parameters.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const W7 = (s) => `W7 – ${s}`;
const N = {
  trigger: 'W15 – Every hour', config: 'W15 – Config', guard: 'W15 – Config Guard', clinics: 'W15 – Clinics', split: 'W15 – Split clinics',
  settings: 'W15 – Settings', addSettings: 'W15 – Add settings', patients: 'W15 – Patients', leads: 'W15 – Leads', convs: 'W15 – Conversations',
  plan: 'W15 – Plan', decide: 'W15 – Decide send', send: 'W15 – Send?', build: 'W15 – Build Message', claim: 'W15 – Claim reminder',
  restore: 'W15 – Restore', call: "W15 – Call 'W12 - WhatsApp send'", prepLog: 'W15 – Prepare log', writeLog: 'W15 – Write Run_Log',
  held: 'W15 – Held summary', writeHeld: 'W15 – Write held log',
  w12prepare: 'W12 – Prepare request', w12read: 'W12 – Read reply',
};
const ADDED = [N.trigger, N.config, N.guard, N.clinics, N.split, N.settings, N.addSettings, N.patients, N.leads, N.convs, N.plan, N.decide, N.send,
  N.build, N.claim, N.restore, N.call, N.prepLog, N.writeLog, N.held, N.writeHeld];
const CHANGED = [N.w12prepare, N.w12read];
const uuid = (seed) => { const h = crypto.createHash('sha1').update(`w15-followup:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- the one anchored edit of existing code: W12 learns the new template (both pasted copies of WA_TEMPLATES)
const TPL_OLD = "  weekly_owner_report: { params: ['clinic_name', 'week', 'summary', { key: 'action', fallback: 'see the full report in Grist' }] },   // W9\n};";
const TPL_NEW = "  weekly_owner_report: { params: ['clinic_name', 'week', 'summary', { key: 'action', fallback: 'see the full report in Grist' }] },   // W9\n  followup_reminder: { params: ['name', 'clinic_name', 'date', 'booking_link'] },                              // W15\n};";

// ---- the pasted snippet (n8n/snippets/followup-reminder.js, without its module.exports line): the workflow carries exactly that code
function snippet() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'snippets', 'followup-reminder.js'), 'utf8').replace(/\r\n/g, '\n');
  const from = src.indexOf('const FR_IST_MS');
  const to = src.indexOf('if (typeof module');
  if (from < 0 || to < 0) throw new Error('n8n/snippets/followup-reminder.js is not in the expected shape');
  return `// Pasted from n8n/snippets/followup-reminder.js - keep identical.\n${src.slice(from, to).trimEnd()}\n`;
}

function replaceOnce(code, from, to, what) {
  const first = code.indexOf(from);
  if (first < 0 || code.indexOf(from, first + 1) >= 0) throw new Error(`${what}: the expected code was not found exactly once (the workflow was edited): nothing written`);
  return code.slice(0, first) + to + code.slice(first + from.length);
}

// The code of the new Code nodes. `phone` = the normalize-phone.js copy W7 – Decide send carries; `guardCode` = W7 – Decide send's
// pasted part (normalize-phone.js + send-guard.js + the quiet-hours test switch), reused as it is.
function codes(phone, guardCode, w7guard, w7split, w7add) {
  const FR = snippet();
  return {
    guard: replaceOnce(w7guard, 'FlowHQ configuration incomplete in W7:', 'FlowHQ configuration incomplete in W15:', N.guard).replace('// W7 CONFIG GUARD', '// W15 CONFIG GUARD'),
    split: replaceOnce(w7split, "$('W7 – Config')", `$('${N.config}')`, N.split),
    addSettings: replaceOnce(w7add, "$('W7 – Split clinics')", `$('${N.split}')`, N.addSettings),
    plan: `// Pasted from n8n/snippets/normalize-phone.js - keep identical.
${phone}
${FR}
// ---- this node ----
// Who gets a follow-up reminder now (frPlan): Active patients whose Follow_Up_On is days_before days away and who were not reminded
// for that date yet, from send_hour IST until quiet hours. Only clinics with Settings > followup_reminders = on (missing = off: switch it
// on once the followup_reminder template is approved). Held patients (hold_reason) travel on to "Held summary" and are never claimed.
const cfg = $('${N.config}').first().json;
const clinics = $('${N.addSettings}').all();
const patients = $('${N.patients}').all();
const leads = $('${N.leads}').all();
const now = Date.now();
const out = [];
$input.all().forEach((conv, i) => {
  const c = clinics[i].json;
  if (!frOn(c.settings.followup_reminders)) return;
  const plan = frPlan(patients[i].json.records || [], leads[i].json.records || [], conv.json.records || [], now, cfg, c.settings, { normalizeIndianPhone });
  if (plan.error) throw new Error(plan.error);
  const ready = plan.items.filter((it) => !it.hold_reason).slice(0, Number(cfg.max_per_run) || 30);
  const held = plan.items.filter((it) => it.hold_reason);
  for (const it of [...ready, ...held]) {
    out.push({
      json: { grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name, wa_phone_number_id: c.wa_phone_number_id, test_mode: c.settings.TEST_MODE, test_phone: c.settings.TEST_PHONE, ...it },
      pairedItem: { item: i },
    });
  }
});
return out;
`,
    decide: `${guardCode}// ---- this node ----
// CLAUDE.md rules 4 and 5: sent flag, Opted_Out, Automation_Paused (a reminder is not a confirmation: paused blocks it), quiet hours,
// TEST_MODE. A held patient (hold_reason from W15 – Plan) is not sent and goes to the summary. No valid phone = never messaged.
const { phone: patient_phone } = normalizeIndianPhone($json.lead_phone);
const { phone: test_phone } = normalizeIndianPhone($json.test_phone);
const decision = $json.hold_reason
  ? { send: false, to: null, reason: $json.hold_reason, test_mode: isTestMode($json.test_mode) }
  : patient_phone
    ? decideSend({
      kind: 'marketing',
      flag_value: $json.flag_value,
      opted_out: $json.opted_out,
      automation_paused: $json.automation_paused,
      patient_phone,
      test_mode: $json.test_mode,
      test_phone,
      now_ms: Date.now(),
    })
    : { send: false, to: null, reason: 'no valid patient phone', test_mode: isTestMode($json.test_mode) };
return { json: { ...$json, patient_phone, decision, send: decision.send } };
`,
    build: `${FR}
// ---- this node ----
// The item for W12 (free text inside the 24 h window, else the approved template) + the claim: Followup_Reminded_For is written BEFORE
// the send (next node). If that write fails, nothing is sent and W11 alerts; a reminder is never sent twice for the same date.
const now = Math.floor(Date.now() / 1000);
const message = frMessage($json, $json.clinic_name, now);
return {
  json: {
    ...$json,
    ...message,
    audience: 'patient',
    source_workflow: 'W15-followup-reminder',
    lead_phone: $json.patient_phone,
    idem_key: frIdemKey($json),
    claim: { records: [{ id: $json.patient_row_id, fields: { Followup_Reminded_For: frDateSec($json.follow_up_on) } }] },
  },
};
`,
    restore: `// The claim write answered; carry on with the message item.\nreturn { json: $('${N.build}').item.json };\n`,
    prepLog: `// One Run_Log row per attempt. Not sent = failed, with W12's reason; the flag stays set (one attempt per follow-up date: a broken
// template or number can never make this section message the patient again and again).
const ok = $json.sent === true;
const d = $json.decision || {};
return {
  json: {
    ...$json,
    log: {
      Workflow: 'W15-followup-reminder',
      Record: \`\${$json.patient_id} follow-up \${$json.follow_up_on}\${d.test_mode ? ' (TEST_MODE)' : ''}\`.slice(0, 200),
      Outcome: ok ? 'ok' : 'failed',
      Error: ok ? '' : String($json.send_error || $json.send_status || 'not sent').slice(0, 500),
      At: Math.floor(Date.now() / 1000),
    },
  },
};
`,
    held: `${FR}
// ---- this node ----
// The patients NOT sent this run (held by W15 – Plan, or refused by send-guard.js) -> ONE Run_Log line per clinic, written only in the
// send_hour run so the log gets one line a day, not one an hour. Nothing is claimed for them: a reminder still goes if the reason is fixed in time.
const cfg = $('${N.config}').first().json;
if (frIstHour(Date.now()) !== Number(cfg.send_hour)) return [];
const byDoc = {};
for (const it of $input.all()) {
  const j = it.json;
  (byDoc[j.doc_id] = byDoc[j.doc_id] || { j, reasons: [] }).reasons.push((j.decision && j.decision.reason) || j.hold_reason || 'not sent');
}
return Object.values(byDoc).map(({ j, reasons }) => ({
  json: { grist_base_url: j.grist_base_url, doc_id: j.doc_id, log: { Workflow: 'W15-followup-reminder', Record: frHeldSummary(reasons).text, Outcome: 'skipped', Error: '', At: Math.floor(Date.now() / 1000) } },
}));
`,
  };
}

function patch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.find((x) => x.name === n);
  const need = [W7('Every hour'), W7('Config'), W7('Config Guard'), W7('Clinics'), W7('Split clinics'), W7('Settings'), W7('Add settings'), W7('Appointments'), W7('Leads'),
    W7('Conversations'), W7('Plan'), W7('Decide send'), W7('Send?'), W7('Build Message'), W7('Claim Outcome_Sent'), W7('Restore'), W7("Call 'W12 - WhatsApp send'"),
    W7('Prepare log'), W7('Write Run_Log'), N.w12prepare, N.w12read];
  for (const n of need) if (!by(n)) throw new Error(`node "${n}" not found: is this the integrated FlowHQ workflow?`);
  for (const n of ADDED) if (by(n)) throw new Error(`"${n}" already exists: the patch was applied before (nothing written)`);

  // W12 learns followup_reminder (both copies of WA_TEMPLATES)
  for (const n of CHANGED) by(n).parameters.jsCode = replaceOnce(by(n).parameters.jsCode, TPL_OLD, TPL_NEW, n);

  const w7decide = by(W7('Decide send')).parameters.jsCode;
  const cut = w7decide.indexOf('// ---- this node ----');
  const pf = w7decide.indexOf('// E.164'); const pt = w7decide.indexOf('function isTestMode');   // the normaliser with its header, as every copy carries it
  if (cut < 0 || pf < 0 || pt < 0 || pt < pf) throw new Error(`"${W7('Decide send')}" is not in the expected shape: nothing written`);
  const C = codes(w7decide.slice(pf, pt).trimEnd(), w7decide.slice(0, cut), by(W7('Config Guard')).parameters.jsCode, by(W7('Split clinics')).parameters.jsCode, by(W7('Add settings')).parameters.jsCode);

  // layout: one row below the lowest section, W7's spacing
  const Y = Math.max(...out.nodes.map((n) => n.position[1])) + 720;
  let col = 0;
  const pos = (row = 0) => [464 + 224 * col++, Y + 192 * row];
  const mk = (tplName, name, parameters, position) => {
    const t = clone(by(tplName));
    return { ...t, name, id: uuid(name), position, parameters };
  };
  const P = (n) => clone(by(n).parameters);
  const grist = (table, extra = {}) => ({ ...P(W7('Settings')), url: `={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/${table}/records`, ...extra });
  const fromAdd = (table) => ({ ...P(W7('Leads')), url: `={{ $('${N.addSettings}').item.json.grist_base_url }}/api/docs/{{ $('${N.addSettings}').item.json.doc_id }}/tables/${table}/records` });
  const ifP = (seed) => { const c = P(W7('Send?')); c.conditions.conditions[0].id = uuid(`${seed}-cond`); return c; };
  const cfgP = () => {
    const c = P(W7('Config'));
    const keep = c.assignments.assignments.filter((a) => a.name === 'grist_base_url' || a.name === 'registry_doc_id').map((a) => ({ ...a, id: uuid(`config-${a.name}`) }));
    const num = (name, value) => ({ id: uuid(`config-${name}`), name, value, type: 'number' });
    c.assignments.assignments = [...keep, num('send_hour', 10), num('days_before', 1), num('max_per_run', 30)];
    return c;
  };
  const trig = P(W7('Every hour'));
  trig.rule.interval[0].expression = '25 * * * *';

  const nodes = [
    mk(W7('Every hour'), N.trigger, trig, pos()),
    mk(W7('Config'), N.config, cfgP(), pos()),
    mk(W7('Config Guard'), N.guard, { jsCode: C.guard }, pos()),
    mk(W7('Clinics'), N.clinics, P(W7('Clinics')), pos()),
    mk(W7('Split clinics'), N.split, { jsCode: C.split }, pos()),
    mk(W7('Settings'), N.settings, P(W7('Settings')), pos()),
    mk(W7('Add settings'), N.addSettings, { jsCode: C.addSettings }, pos()),
    mk(W7('Appointments'), N.patients, grist('Patients', { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: '={{ JSON.stringify({ Status: ["Active"] }) }}' }] } }), pos()),
    mk(W7('Leads'), N.leads, fromAdd('LEADS'), pos()),
    mk(W7('Conversations'), N.convs, fromAdd('Conversations'), pos()),
    mk(W7('Plan'), N.plan, { jsCode: C.plan }, pos()),
    mk(W7('Decide send'), N.decide, { ...P(W7('Decide send')), jsCode: C.decide }, pos()),
    mk(W7('Send?'), N.send, ifP(N.send), pos()),
  ];
  const sendCol = col;
  nodes.push(
    mk(W7('Build Message'), N.build, { ...P(W7('Build Message')), jsCode: C.build }, pos()),
    mk(W7('Claim Outcome_Sent'), N.claim, { ...P(W7('Claim Outcome_Sent')), url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Patients/records' }, pos()),
    mk(W7('Restore'), N.restore, { ...P(W7('Restore')), jsCode: C.restore }, pos()),
    mk(W7("Call 'W12 - WhatsApp send'"), N.call, P(W7("Call 'W12 - WhatsApp send'")), pos()),
    mk(W7('Prepare log'), N.prepLog, { ...P(W7('Prepare log')), jsCode: C.prepLog }, pos()),
    mk(W7('Write Run_Log'), N.writeLog, P(W7('Write Run_Log')), pos()),
  );
  col = sendCol;
  // the held branch: a Code node that runs once for all items (W7 – Split clinics' settings: no "mode" = all items)
  nodes.push(
    mk(W7('Split clinics'), N.held, { jsCode: C.held }, pos(1)),
    mk(W7('Write Run_Log'), N.writeHeld, P(W7('Write Run_Log')), pos(1)),
  );
  if (nodes.length !== ADDED.length) throw new Error('W15: wrong number of nodes built');
  out.nodes.push(...nodes);

  const conn = out.connections;
  const link = (from, to, idx = 0) => { const c = conn[from] || (conn[from] = { main: [] }); while (c.main.length <= idx) c.main.push([]); c.main[idx].push({ node: to, type: 'main', index: 0 }); };
  const chain = [N.trigger, N.config, N.guard, N.clinics, N.split, N.settings, N.addSettings, N.patients, N.leads, N.convs, N.plan, N.decide, N.send];
  for (let i = 0; i < chain.length - 1; i++) link(chain[i], chain[i + 1]);
  link(N.send, N.build, 0);                // send: claim the flag, then W12
  link(N.send, N.held, 1);                 // not sent: one summary line per clinic
  for (const [a, b] of [[N.build, N.claim], [N.claim, N.restore], [N.restore, N.call], [N.call, N.prepLog], [N.prepLog, N.writeLog], [N.held, N.writeHeld]]) link(a, b);

  // proof that nothing else moved
  const added = new Set(ADDED);
  const changed = out.nodes.filter((n) => !added.has(n.name) && JSON.stringify(n) !== JSON.stringify(wf.nodes.find((o) => o.name === n.name))).map((n) => n.name).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...CHANGED].sort())) throw new Error(`unexpected existing nodes changed: ${changed.join(', ')}`);
  for (const n of CHANGED) {
    const a = by(n); const b = wf.nodes.find((o) => o.name === n);
    if (JSON.stringify({ ...a, parameters: { ...a.parameters, jsCode: 0 } }) !== JSON.stringify({ ...b, parameters: { ...b.parameters, jsCode: 0 } })) throw new Error(`"${n}" changed beyond its code`);
    if (a.parameters.jsCode !== b.parameters.jsCode.replace(TPL_OLD, TPL_NEW)) throw new Error(`"${n}" changed beyond the template list`);
  }
  const connChanged = Object.keys(conn).filter((k) => JSON.stringify(conn[k]) !== JSON.stringify(wf.connections[k])).sort();
  const expect = ADDED.filter((n) => conn[n]).sort();
  if (JSON.stringify(connChanged) !== JSON.stringify(expect)) throw new Error(`unexpected connection changes: ${connChanged}`);
  for (const k of Object.keys(wf)) if (k !== 'nodes' && k !== 'connections' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  return out;
}

// the export before the patch (the tests use it to show what W15 adds)
function unpatch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.find((x) => x.name === n);
  for (const n of CHANGED) by(n).parameters.jsCode = replaceOnce(by(n).parameters.jsCode, TPL_NEW, TPL_OLD, n);
  out.nodes = out.nodes.filter((n) => !ADDED.includes(n.name));
  for (const k of ADDED) delete out.connections[k];
  return out;
}

module.exports = { patch, unpatch, N, ADDED, CHANGED };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node n8n/final/tools/patch-w15-followup.js <workflow.json> <output.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const res = patch(wf);
  fs.writeFileSync(outFile, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`written ${outFile}: ${ADDED.length} nodes added (${wf.nodes.length} -> ${res.nodes.length}), 2 existing nodes changed (the template list), credentials unchanged`);
}
