#!/usr/bin/env node
// W12 pre-send pause check. Closes the window the Human handling switch (Conversations.Automation_Paused) left open:
// W13 reads Automation_Paused ONCE, before it asks the AI; while the model thinks (seconds) staff can switch Human handling on,
// and the reply was still sent. W12 is the only sender, so the last Grist read before Meta belongs there.
//
//   node n8n/final/tools/patch-w12-pause-check.js <workflow.json> <output.json>
//
// What it does: for W13 patient replies only (input.w13_kind === 'patient_reply'), after the consent step and BEFORE the send-ledger
// lookup / claim and the Meta call, W12 reads the conversation again from Grist:
//   inbound message row (named by idem_key "W13:patient_reply:<Messages row id>") -> its Conversation -> that Conversations row.
// Automation_Paused === true  -> blocked ("paused by staff"), nothing claimed, Meta not called.
// Anything else than a clean answer (read error, no / several rows, wrong row, a conversation that belongs to another lead or phone,
// Automation_Paused missing or not a boolean) -> blocked too: fail closed. Only an explicit false continues.
// Staff alerts, staff replies (W10), W3 / W5 / W6 / W7 / W8 / W14 messages and every template do not run this check.
//
// Added: 5 nodes. Changed: ONLY "W12 – Prepare request" (one flag), "W12 – Return result" (one more place to read `early` from) and the
// connection that leaves "W12 – Consent stop?". The new HTTP nodes reuse the credential reference of "W12 – Lead consent".
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const N = {
  prepare: 'W12 – Prepare request', consentStop: 'W12 – Consent stop?', consentDecide: 'W12 – Consent decide', ledgerLookup: 'W12 – Ledger lookup', result: 'W12 – Return result', leadConsent: 'W12 – Lead consent',
  needed: 'W12 – Pause check needed?', message: 'W12 – Pause message', conversation: 'W12 – Conversation pause', decide: 'W12 – Pause decide', stop: 'W12 – Pause stop?',
};
const ADDED = [N.needed, N.message, N.conversation, N.decide, N.stop];
const uuid = (seed) => { const h = crypto.createHash('sha1').update(`w12-pause-check:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- the two anchored edits of existing nodes (each anchor must occur exactly once)
const PREP_OLD = "  return { json: { input, cfg, prep: { ...prep, idem_key, needs_consent, consent_phone } } };";
const PREP_NEW = `  // PAUSE re-check: only a W13 patient reply asks W12 to re-read Conversations.Automation_Paused right before sending
  const needs_pause_check = prep.call_meta === true && input.w13_kind === 'patient_reply';
  return { json: { input, cfg, prep: { ...prep, idem_key, needs_consent, consent_phone, needs_pause_check } } };`;
const RES_OLD = "(from('W12 – Ledger winner') || from('W12 – Ledger decide') || from('W12 – Consent decide') || {}).early";
const RES_NEW = "(from('W12 – Ledger winner') || from('W12 – Ledger decide') || from('W12 – Pause decide') || from('W12 – Consent decide') || {}).early";

const P = `$('${N.prepare}').first().json`;
const WANT = `Number((String(${P}.input.idem_key || '').match(/^W13:patient_reply:(\\d+)$/) || [])[1] || 0)`;
const MSG_FILTER = `={{ JSON.stringify({ id: [${WANT}] }) }}`;
const CONV_FILTER = `={{ JSON.stringify({ id: [Number((($('${N.message}').first().json.records || [])[0] || { fields: {} }).fields.Conversation) || 0] }) }}`;

const DECIDE = `// Pause re-check (W13 patient replies only). Only an explicit Automation_Paused === false lets the reply continue.
// Every other answer (a read error, no or several rows, the wrong row, another lead's conversation, a missing or non-boolean value) blocks the send.
const p = $('${N.prepare}').first().json;
const stop = (why) => ({ json: { ...p, early: { send_status: 'blocked', send_error: why, ledger_status: '' } } });
const err = (r) => String((r && r.error && (r.error.message || r.error)) || 'no answer').replace(/\\s+/g, ' ').slice(0, 150);
const want = Number((String((p.input && p.input.idem_key) || '').match(/^W13:patient_reply:(\\d+)$/) || [])[1] || 0);

if (!p.prep || p.prep.needs_pause_check !== true) return stop('pause check: it ran without being requested; nothing was sent');
if (!(want > 0)) return stop('pause check: this reply does not say which patient message it answers (idem_key); nothing was sent');

const msgRes = $('${N.message}').first().json;
if (!Array.isArray(msgRes && msgRes.records)) return stop('pause check: could not read the patient message (' + err(msgRes) + '); nothing was sent');
if (msgRes.records.length !== 1 || !msgRes.records[0] || msgRes.records[0].id !== want || !msgRes.records[0].fields) return stop('pause check: the patient message ' + want + ' was not found exactly once; nothing was sent');
const convId = Number(msgRes.records[0].fields.Conversation);
if (!Number.isInteger(convId) || convId <= 0) return stop('pause check: the patient message has no conversation; nothing was sent');

const res = $json;
if (!Array.isArray(res && res.records)) return stop('pause check: could not read the conversation (' + err(res) + '); nothing was sent');
const conv = res.records.length === 1 ? res.records[0] : null;
if (!conv || conv.id !== convId || !conv.fields || typeof conv.fields !== 'object') return stop('pause check: conversation ' + convId + ' was not found exactly once; nothing was sent');

// it must be this patient's conversation: the lead and the phone must agree wherever both sides say something
const lead = Number(p.input.lead_row_id) || 0;
const cLead = Number(conv.fields.Lead) || 0;
if (lead > 0 && cLead > 0 && lead !== cLead) return stop('pause check: the conversation belongs to another lead; nothing was sent');
const digits = (v) => String(v === null || v === undefined ? '' : v).replace(/\\D/g, '').slice(-10);
const want10 = digits(p.prep.consent_phone);
const have10 = digits(conv.fields.Phone);
if (want10 && have10 && want10 !== have10) return stop('pause check: the conversation belongs to another phone number; nothing was sent');

const paused = conv.fields.Automation_Paused;
if (paused === true) return stop('paused by staff: Human handling is on for this conversation, so the AI reply was not sent');
if (paused !== false) return stop('pause check: Automation_Paused is missing or is not true/false; nothing was sent');
return { json: { ...p, pause_ok: true } };
`;

function replaceOnce(code, from, to, what) {
  const first = code.indexOf(from);
  if (first < 0 || code.indexOf(from, first + 1) >= 0) throw new Error(`${what}: the expected code was not found exactly once (the workflow was edited): nothing written`);
  return code.slice(0, first) + to + code.slice(first + from.length);
}

function patch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.find((x) => x.name === n);
  for (const n of [N.prepare, N.consentStop, N.consentDecide, N.ledgerLookup, N.result, N.leadConsent]) if (!by(n)) throw new Error(`node "${n}" not found: is this the integrated FlowHQ workflow?`);
  for (const n of ADDED) if (by(n)) throw new Error(`"${n}" already exists: the patch was applied before (nothing written)`);
  const conn = out.connections;
  const was = JSON.stringify((conn[N.consentStop] || {}).main);
  if (was !== JSON.stringify([[{ node: N.result, type: 'main', index: 0 }], [{ node: N.ledgerLookup, type: 'main', index: 0 }]])) throw new Error(`"${N.consentStop}" is not connected as expected: ${was} (the workflow was edited): nothing written`);

  const prep = by(N.prepare); const res = by(N.result); const stopTpl = by(N.consentStop); const decideTpl = by(N.consentDecide); const http = by(N.leadConsent);
  prep.parameters.jsCode = replaceOnce(prep.parameters.jsCode, PREP_OLD, PREP_NEW, N.prepare);
  res.parameters.jsCode = replaceOnce(res.parameters.jsCode, RES_OLD, RES_NEW, N.result);

  const [x, y] = stopTpl.position;
  const mk = (tpl, name, position, parameters) => ({ ...clone(tpl), name, id: uuid(name), position, parameters });
  const ifParams = (left, seed) => {
    const c = clone(stopTpl.parameters);
    if (!c.conditions || !c.conditions.conditions || c.conditions.conditions.length !== 1) throw new Error(`unexpected shape of "${N.consentStop}"`);
    c.conditions.conditions[0].leftValue = left; c.conditions.conditions[0].id = uuid(`${seed}-cond`);
    return c;
  };
  const grist = (table, filter) => ({
    url: `={{ ${P}.input.grist_base_url }}/api/docs/{{ ${P}.input.doc_id }}/tables/${table}/records`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendQuery: true,
    queryParameters: { parameters: [{ name: 'filter', value: filter }, { name: 'limit', value: '2' }] }, options: {},
  });
  const needed = mk(stopTpl, N.needed, [x + 224, y - 240], ifParams(`={{ ${P}.prep.needs_pause_check === true }}`, N.needed));
  const message = mk(http, N.message, [x + 448, y - 240], grist('Messages', MSG_FILTER));
  const conversation = mk(http, N.conversation, [x + 672, y - 240], grist('Conversations', CONV_FILTER));
  const decide = mk(decideTpl, N.decide, [x + 896, y - 240], { jsCode: DECIDE });
  const stop = mk(stopTpl, N.stop, [x + 1120, y - 240], ifParams('={{ !!$json.early }}', N.stop));
  out.nodes.push(needed, message, conversation, decide, stop);

  const link = (from, to, idx = 0) => { const c = conn[from] || (conn[from] = { main: [] }); while (c.main.length <= idx) c.main.push([]); c.main[idx].push({ node: to, type: 'main', index: 0 }); };
  conn[N.consentStop] = { main: [[{ node: N.result, type: 'main', index: 0 }], [{ node: N.needed, type: 'main', index: 0 }]] };
  link(N.needed, N.message, 0);          // a W13 patient reply: read the conversation again
  link(N.needed, N.ledgerLookup, 1);     // everything else goes on exactly as before
  link(N.message, N.conversation);
  link(N.conversation, N.decide);
  link(N.decide, N.stop);
  link(N.stop, N.result, 0);             // blocked: straight to the result, the ledger is never touched
  link(N.stop, N.ledgerLookup, 1);       // explicit Automation_Paused === false: on to the ledger and Meta

  // proof that nothing else moved
  const allowedChanged = new Set([N.prepare, N.result]);
  const added = new Set(ADDED);
  const changed = out.nodes.filter((n) => !added.has(n.name) && JSON.stringify(n) !== JSON.stringify(wf.nodes.find((o) => o.name === n.name))).map((n) => n.name);
  if (changed.some((n) => !allowedChanged.has(n)) || changed.length !== allowedChanged.size) throw new Error(`unexpected existing nodes changed: ${changed.join(', ')}`);
  for (const n of [N.prepare, N.result]) {
    const a = by(n); const b = wf.nodes.find((o) => o.name === n);
    if (JSON.stringify({ ...a, parameters: { ...a.parameters, jsCode: 0 } }) !== JSON.stringify({ ...b, parameters: { ...b.parameters, jsCode: 0 } })) throw new Error(`"${n}" changed beyond its code`);
  }
  const connChanged = Object.keys(conn).filter((k) => JSON.stringify(conn[k]) !== JSON.stringify(wf.connections[k])).sort();
  const expect = [N.consentStop, ...ADDED].sort();
  if (JSON.stringify(connChanged) !== JSON.stringify(expect)) throw new Error(`unexpected connection changes: ${connChanged}`);
  for (const k of Object.keys(wf)) if (k !== 'nodes' && k !== 'connections' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  return out;
}

// the export before the patch (the tests use it to show what the check changes)
function unpatch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.find((x) => x.name === n);
  by(N.prepare).parameters.jsCode = replaceOnce(by(N.prepare).parameters.jsCode, PREP_NEW, PREP_OLD, N.prepare);
  by(N.result).parameters.jsCode = replaceOnce(by(N.result).parameters.jsCode, RES_NEW, RES_OLD, N.result);
  out.nodes = out.nodes.filter((n) => !ADDED.includes(n.name));
  for (const k of ADDED) delete out.connections[k];
  out.connections[N.consentStop] = { main: [[{ node: N.result, type: 'main', index: 0 }], [{ node: N.ledgerLookup, type: 'main', index: 0 }]] };
  return out;
}

module.exports = { patch, unpatch, N, ADDED };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node n8n/final/tools/patch-w12-pause-check.js <workflow.json> <output.json>'); process.exit(2); }
  if (require('path').resolve(inFile) === require('path').resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const out = patch(wf);
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`written ${outFile}: 5 nodes added (${wf.nodes.length} -> ${out.nodes.length}), 2 existing nodes changed (one flag, one result read), credentials unchanged`);
}
