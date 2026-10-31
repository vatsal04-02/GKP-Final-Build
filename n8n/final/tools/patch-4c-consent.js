#!/usr/bin/env node
// Slice 4C: reminder consent and message purposes in W5, W12 and W15. Builds a NEW candidate; the input file is never overwritten.
//
//   node n8n/final/tools/patch-4c-consent.js <candidate.json> <output.json>
//
// What changes (decisions D1-D4, docs/booking-decisions.md; the shared rule is n8n/snippets/reminder-consent.js):
//   W12  every message gets ONE purpose (reply / booking_transaction / appointment_reminder / followup_reminder / engagement / staff_alert). The consent gate is
//        decided by the purpose: reminders need Reminder_Consent = Yes, booking confirmations need a Meta opt-in, engagement keeps the old rule.
//        New node "W12 – Reminder consent" reads the Reminder_Consent row of the phone; "W12 – Consent decide" and the tail of "W12 – Prepare request" change.
//   W5   a Pending confirmation appointment is not reminded; the patient need not be a Lead (the phone comes from the lead, the appointment or the patient record);
//        reminders need reminder consent; every reminder that is due but held leaves a reason, written to Run_Log by "W5 – Skip digest". Sent flags, windows, quiet
//        hours, TEST_MODE and the cancel/reschedule hold are untouched.
//   W15  the same consent rule, and a patient with no Lead can be reminded. Its hold reasons are computed by the existing frPlan, then re-decided here.
// Nothing else moves: the tool proves it (the changed nodes, the connections, every other field) and refuses to run twice.
// Not touched on purpose: n8n/snippets/wa-send.js and followup-reminder.js (older lineages validate them byte for byte; the purpose map is a sibling snippet).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N = {
  w12prepare: 'W12 – Prepare request', w12lead: 'W12 – Lead consent', w12consent: 'W12 – Reminder consent', w12decide: 'W12 – Consent decide',
  w5leads: 'W5 – Leads', w5convs: 'W5 – Conversations', w5consent: 'W5 – Reminder consent', w5patients: 'W5 – Patients', w5find: 'W5 – Find due', w5decide: 'W5 – Decide send',
  w5build: 'W5 – Code in JavaScript', w5send: 'W5 – Send?', w5digest: 'W5 – Skip digest', w5digestLog: 'W5 – Write skip log',
  w15leads: 'W15 – Leads', w15convs: 'W15 – Conversations', w15consent: 'W15 – Reminder consent', w15plan: 'W15 – Plan', w15build: 'W15 – Build Message',
};
const ADDED = [N.w12consent, N.w5consent, N.w5patients, N.w5digest, N.w5digestLog, N.w15consent];
const CHANGED = [N.w12prepare, N.w12decide, N.w5find, N.w5decide, N.w5build, N.w15plan, N.w15build];
const CHANGED_CONNECTIONS = [N.w12lead, N.w5leads, N.w5send, N.w15leads];

const uuid = (seed) => { const h = crypto.createHash('sha1').update(`4c-consent:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(code, from, to, what) {
  const first = code.indexOf(from);
  if (first < 0 || code.indexOf(from, first + 1) >= 0) throw new Error(`${what}: the expected code was not found exactly once (the workflow was edited): nothing written`);
  return code.slice(0, first) + to + code.slice(first + from.length);
}

// The pasted shared code. rc = reminder-consent.js without its module.exports line; phone = the normaliser the workflow's nodes already carry (taken from W5 – Decide send).
function rcSnippet() {
  const src = read('../../snippets/reminder-consent.js');
  const from = src.indexOf('const RC_PURPOSE_BY_TEMPLATE');
  const to = src.indexOf('if (typeof module');
  if (from < 0 || to < 0) throw new Error('n8n/snippets/reminder-consent.js is not in the expected shape');
  return src.slice(from, to).trimEnd();
}
function phoneSnippet(wf) {
  const code = wf.nodes.find((n) => n.name === N.w5decide).parameters.jsCode;
  const from = code.indexOf('// E.164 phone normaliser');
  const to = code.indexOf('function isTestMode');
  if (from < 0 || to < 0) throw new Error('W5 – Decide send does not carry the phone normaliser in the expected place');
  return code.slice(from, to).trimEnd();
}
const PASTE = (what) => `// Pasted from ${what} - keep identical.`;

function patch(wf) {
  const out = clone(wf);
  const by = (n) => { const x = out.nodes.find((o) => o.name === n); if (!x) throw new Error(`node "${n}" is missing: this is not the expected candidate`); return x; };
  for (const n of ADDED) if (out.nodes.some((x) => x.name === n)) throw new Error(`"${n}" already exists: the 4C patch was applied already`);
  const rc = rcSnippet();
  const phone = phoneSnippet(wf);
  const code = (n) => by(n).parameters.jsCode;
  const setCode = (n, v) => { by(n).parameters.jsCode = v; };
  const link = (from, to, idx = 0) => { const c = out.connections[from] || (out.connections[from] = { main: [] }); while (c.main.length <= idx) c.main.push([]); c.main[idx].push({ node: to, type: 'main', index: 0 }); };
  const reroute = (from, oldTo, newTo) => {   // from -> oldTo becomes from -> newTo (same output index)
    const c = out.connections[from];
    const hit = c.main.flatMap((o, i) => (o || []).map((x) => [i, x])).filter(([, x]) => x.node === oldTo);
    if (hit.length !== 1) throw new Error(`connection ${from} -> ${oldTo} not found exactly once`);
    hit[0][1].node = newTo;
  };
  const mk = (tpl, name, parameters, dx, dy, extra = {}) => {
    const t = clone(by(tpl));
    return { ...t, ...extra, name, id: uuid(name), position: [t.position[0] + dx, t.position[1] + dy], parameters };
  };

  // ------------------------------------------------------------------ W12
  // Prepare request: the purpose, and "needs_consent" now also covers a reminder sent as free text.
  let prep = code(N.w12prepare);
  prep = replaceOnce(prep, '  // PRODUCTION: idempotency key of one logical message.', `  ${PASTE('n8n/snippets/reminder-consent.js').replace(/\n/g, '\n  ')}\n  ${rc.replace(/\n/g, '\n  ')}\n  // PRODUCTION: idempotency key of one logical message.`, N.w12prepare);
  prep = replaceOnce(prep,
    "  const needs_consent = prep.call_meta === true && input.audience === 'patient' && input.message_type !== 'text' && !((input.decision || {}).test_mode === true);",
    "  // Slice 4C: the purpose decides what consent is needed (W12 – Consent decide). A free-text REPLY needs none; a reminder sent as free text (W15 inside the 24 h window) still does.\n" +
    "  const purpose = rcPurpose(input);\n" +
    "  const needs_consent = prep.call_meta === true && input.audience === 'patient' && (input.message_type !== 'text' || RC_REMINDER_PURPOSES.includes(purpose)) && !((input.decision || {}).test_mode === true);", N.w12prepare);
  prep = replaceOnce(prep, 'prep: { ...prep, idem_key, needs_consent, consent_phone, needs_pause_check } } };', 'prep: { ...prep, idem_key, purpose, needs_consent, consent_phone, needs_pause_check } } };', N.w12prepare);
  setCode(N.w12prepare, prep);

  // Consent decide: replaced (its body is n8n/final/tools/4c/w12-consent-decide.body.js), with the shared code pasted above it.
  setCode(N.w12decide, `${PASTE('n8n/snippets/normalize-phone.js (the production copy) and reminder-consent.js')}\n${phone}\n${rc}\n// ---- this node ----\n${read('4c/w12-consent-decide.body.js')}`);

  // New node: the Reminder_Consent row of the phone. Same shape as "W12 – Lead consent"; an error is passed on (continueRegularOutput) and blocks reminders.
  const leadNode = by(N.w12lead);
  const w12params = clone(leadNode.parameters);
  const phoneFilter = w12params.queryParameters.parameters.find((q) => q.name === 'filter');
  if (!phoneFilter || phoneFilter.value.indexOf('$json.prep.consent_phone') < 0) throw new Error('W12 – Lead consent: the phone filter was not found');
  phoneFilter.value = phoneFilter.value.replace('$json.prep.consent_phone', "$('W12 – Prepare request').first().json.prep.consent_phone");   // its input is the lead answer, not the prepared request
  const w12consent = mk(N.w12lead, N.w12consent, {
    ...w12params,
    url: "={{ $('W12 – Prepare request').first().json.input.grist_base_url }}/api/docs/{{ $('W12 – Prepare request').first().json.input.doc_id }}/tables/Reminder_Consent/records",
  }, 0, 224);
  reroute(N.w12lead, N.w12decide, N.w12consent);
  link(N.w12consent, N.w12decide);

  // ------------------------------------------------------------------ W5
  const convs = by(N.w5convs);
  const w5url = (table) => `={{ $('W5 – Add appointments').item.json.grist_base_url }}/api/docs/{{ $('W5 – Add appointments').item.json.doc_id }}/tables/${table}/records`;
  const w5consent = mk(N.w5convs, N.w5consent, { ...clone(convs.parameters), url: w5url('Reminder_Consent') }, 0, 224, { onError: 'continueRegularOutput' });
  const w5patients = mk(N.w5convs, N.w5patients, { ...clone(convs.parameters), url: w5url('Patients') }, 0, 448, { onError: 'continueRegularOutput' });
  reroute(N.w5leads, N.w5convs, N.w5consent);
  link(N.w5consent, N.w5patients);
  link(N.w5patients, N.w5convs);

  const find = code(N.w5find);
  const anchor = "  const cfg = $('W5 – Config').first().json;";
  if (find.indexOf(anchor) < 0 || find.indexOf(anchor) !== find.lastIndexOf(anchor)) throw new Error('W5 – Find due: the expected start of the node was not found exactly once');
  setCode(N.w5find, `${find.slice(0, find.indexOf(anchor)).trimEnd()}\n\n${PASTE('n8n/snippets/normalize-phone.js (the production copy) and reminder-consent.js')}\n${phone}\n${rc}\n// ---- this node ----\n${read('4c/w5-find-due.body.js')}`);

  // Decide send: an item with a hold_reason is "not sent" with that reason (the send-guard.js rules are untouched for the others).
  setCode(N.w5decide, replaceOnce(code(N.w5decide), '  const decision = decideSend({',
    "  const hold = String($json.hold_reason || '');   // Slice 4C: a reminder held by W5 – Find due (pending, no consent, ...) is reported, never sent\n" +
    "  const decision = hold ? { send: false, to: null, reason: hold, test_mode: isTestMode($json.test_mode) } : decideSend({", N.w5decide));
  setCode(N.w5build, replaceOnce(code(N.w5build), "    source_workflow: 'W5-reminders',", "    source_workflow: 'W5-reminders',\n    purpose: 'appointment_reminder',", N.w5build));

  const write = by("W5 – Write failed log");
  const w5digest = mk('W5 – Prepare failed log', N.w5digest, { jsCode: read('4c/w5-skip-digest.body.js') }, 0, 0);   // a Code node that runs once for all items
  w5digest.position = [by(N.w5send).position[0] + 224, by(N.w5send).position[1] + 224];
  const w5digestLog = mk("W5 – Write failed log", N.w5digestLog, {
    ...clone(write.parameters),
    jsonBody: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}',
    url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Run_Log/records',
  }, 0, 0);
  w5digestLog.position = [w5digest.position[0] + 224, w5digest.position[1]];
  link(N.w5send, N.w5digest, 1);
  link(N.w5digest, N.w5digestLog);

  // ------------------------------------------------------------------ W15
  const c15 = by(N.w15convs);
  const w15consent = mk(N.w15convs, N.w15consent, {
    ...clone(c15.parameters),
    url: "={{ $('W15 – Add settings').item.json.grist_base_url }}/api/docs/{{ $('W15 – Add settings').item.json.doc_id }}/tables/Reminder_Consent/records",
  }, 0, 224, { onError: 'continueRegularOutput' });
  reroute(N.w15leads, N.w15convs, N.w15consent);
  link(N.w15consent, N.w15convs);

  let plan = code(N.w15plan);
  plan = replaceOnce(plan, '// ---- this node ----', `${PASTE('n8n/snippets/reminder-consent.js')}\n${rc}\n` +
`// Slice 4C: follow-up reminders need REMINDER consent (not LEADS.Consent_WhatsApp), and a patient with no lead can have it. frPlan (above) still holds
// the ones with no booking link / no valid phone; the lead-based holds are re-decided here with the same rule W12 enforces.
const FR_LEAD_HOLDS = ['no WhatsApp consent on file (no lead with this phone)', 'no WhatsApp consent on file (LEADS.Consent_WhatsApp)', 'opted out', ''];
function frConsent(it, leadRows, consentRows) {
  if (!FR_LEAD_HOLDS.includes(it.hold_reason)) return it;
  const mine = consentRows === null ? null : consentRows.filter((r) => r && r.fields && normalizeIndianPhone(r.fields.Phone).phone === it.lead_phone);
  const leadsOfPhone = leadRows.filter((r) => r && r.fields && normalizeIndianPhone(r.fields.Phone).phone === it.lead_phone);
  const optedOut = rcOptedOut(leadsOfPhone, it.lead_phone, normalizeIndianPhone);
  const e = rcEffective(mine, optedOut);
  return { ...it, purpose: 'followup_reminder', opted_out: optedOut, hold_reason: e.allowed ? '' : RC_REASON_TEXT[e.reason] };
}
// ---- this node ----`, N.w15plan);
  plan = replaceOnce(plan, "  const plan = frPlan(patients[i].json.records || [], leads[i].json.records || [], conv.json.records || [], now, cfg, c.settings, { normalizeIndianPhone });",
    "  const plan = frPlan(patients[i].json.records || [], leads[i].json.records || [], conv.json.records || [], now, cfg, c.settings, { normalizeIndianPhone });\n" +
    "  const crows = Array.isArray(consents[i] && consents[i].json && consents[i].json.records) ? consents[i].json.records : null;   // null = unreadable\n" +
    "  if (!plan.error) plan.items = plan.items.map((it) => frConsent(it, leads[i].json.records || [], crows));", N.w15plan);
  plan = replaceOnce(plan, "const leads = $('W15 – Leads').all();", `const leads = $('W15 – Leads').all();\nconst consents = $('${N.w15consent}').all();`, N.w15plan);
  setCode(N.w15plan, plan);
  setCode(N.w15build, replaceOnce(code(N.w15build), "    source_workflow: 'W15-followup-reminder',", "    source_workflow: 'W15-followup-reminder',\n    purpose: 'followup_reminder',", N.w15build));

  out.nodes.push(w12consent, w5consent, w5patients, w5digest, w5digestLog, w15consent);

  // ------------------------------------------------------------------ proof that nothing else moved
  const added = new Set(ADDED);
  const changed = out.nodes.filter((n) => !added.has(n.name) && JSON.stringify(n) !== JSON.stringify(wf.nodes.find((o) => o.name === n.name))).map((n) => n.name).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...CHANGED].sort())) throw new Error(`unexpected existing nodes changed: ${changed.join(', ')}`);
  for (const n of CHANGED) {
    const a = by(n); const b = wf.nodes.find((o) => o.name === n);
    if (JSON.stringify({ ...a, parameters: { ...a.parameters, jsCode: 0 } }) !== JSON.stringify({ ...b, parameters: { ...b.parameters, jsCode: 0 } })) throw new Error(`"${n}" changed beyond its code`);
  }
  const connChanged = Object.keys(out.connections).filter((k) => JSON.stringify(out.connections[k]) !== JSON.stringify(wf.connections[k])).sort();
  const expect = [...CHANGED_CONNECTIONS, ...ADDED.filter((n) => out.connections[n])].sort();
  if (JSON.stringify(connChanged) !== JSON.stringify(expect)) throw new Error(`unexpected connection changes: ${connChanged.join(', ')} (expected ${expect.join(', ')})`);
  for (const k of Object.keys(wf)) if (k !== 'nodes' && k !== 'connections' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  for (const n of out.nodes) if (/httpRequest/.test(n.type) && !n.credentials) throw new Error(`HTTP node "${n.name}" has no credential`);
  return out;
}

module.exports = { patch, N, ADDED, CHANGED, CHANGED_CONNECTIONS };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node n8n/final/tools/patch-4c-consent.js <candidate.json> <output.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const res = patch(wf);
  fs.writeFileSync(outFile, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`written ${outFile}: ${ADDED.length} nodes added (${wf.nodes.length} -> ${res.nodes.length}), ${CHANGED.length} existing nodes changed (code only), credentials unchanged; the input file is untouched`);
}
