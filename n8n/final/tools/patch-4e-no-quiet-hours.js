#!/usr/bin/env node
// 4E: no quiet hours for operational messages.   4E = 4D + this patch.   (owner directive, 1 Nov 2026)
//   node n8n/final/tools/patch-4e-no-quiet-hours.js <4d-workflow.json> <output.json>
//
// The 21:00-08:00 IST quiet-hours rule (CLAUDE.md rule 5) no longer holds back:
//   * STAFF messages: new-lead alert (W1), unanswered-lead escalation (W3), human hand-off alert (W13), weekly owner report (W9)
//   * a REPLY to a patient who wrote to us: the AI reply (W13), a staff-typed reply (W10), a booking confirmation (W4)
// It STILL holds back messages WE start: reminders (W5, W15), follow-ups / no-show rebook (W6), outcome check-in (W7), review requests (W8).
// Everything else a message needs is unchanged: opt-out, Automation_Paused, Needs_Human, consent by purpose, the allowlist, TEST_MODE, the 24 h window,
// the ledger / sent flags. Nothing is queued: an alert fires the moment it is triggered.
//
// How: the pasted decideSend() gets one condition (`i.no_quiet_hours !== true &&`), so with no flag it behaves exactly as before; only the callers listed in
// CALLERS pass the flag. W12 (the one sender) applies the same exemption by message audience / source. W13 no longer defers an inbound message overnight.
'use strict';
const crypto = require('crypto');

const D = '–';
const NEW_ID = 'F4eNoQuietHrs001';
const NEW_NAME = 'FlowHQ Clinic Automation 4E candidate (4D + no quiet hours for staff alerts and replies)';
const clone = (o) => JSON.parse(JSON.stringify(o));

const DECIDE_OLD = "if (inQuietHours(i.now_ms)) return skip('quiet hours');";
const DECIDE_NEW = "if (i.no_quiet_hours !== true && inQuietHours(i.now_ms)) return skip('quiet hours');   // 4E: staff alerts and replies pass no_quiet_hours";
// The callers that are exempt, with the number of decideSend({ kind: 'transactional', ... }) calls to change in each.
const CALLERS = {
  [`W1 ${D} Staff alert plan`]: 1,
  [`W3 ${D} Decide send`]: 1,
  [`W4 ${D} Plan writes`]: 1,
  [`W9 ${D} Owner message`]: 1,
  [`W10 ${D} Check`]: 1,
  [`W13 ${D} Build Context`]: 2,
  [`W13 ${D} Plan Ready`]: 2,
  [`W13 ${D} Record Sends`]: 2,
};
// Nodes that keep the quiet hours for messages we start (must NOT be touched).
const KEEP = [`W5 ${D} Decide send`, `W6 ${D} Decide send`, `W7 ${D} Decide send`, `W8 ${D} Decide send`, `W15 ${D} Decide send`];
const CALL_RE = /decideSend\(\{(\s*)kind: 'transactional',/g;
const CALL_NEW = "decideSend({$1kind: 'transactional', no_quiet_hours: true,";

const NIGHT_OLD = 'night: h.inQuietHours(nowMs) || h.inQuietHours(nowMs + 5 * 60000),';
const NIGHT_NEW = 'night: false,   // 4E: an inbound message is answered at once, day or night (the 08:05 deferral is gone)';

const W12 = `W12 ${D} Prepare request`;
const W12_OLD = "if (h.inQuietHours(nowMs)) return stop('blocked', 'quiet hours (21:00-08:00 IST)');";
const W12_NEW = `// 4E: no quiet hours for staff messages, booking confirmations and replies to a patient who wrote to us (W13 AI reply, W10 staff reply).
  // Messages WE start (reminders, follow-ups, outcome check-ins, review requests) still wait for 08:00.
  const quietExempt = input.audience === 'staff' || input.template === 'booking_confirmation' || /^W(13|10)-/.test(String(input.source_workflow || ''));
  if (!quietExempt && h.inQuietHours(nowMs)) return stop('blocked', 'quiet hours (21:00-08:00 IST)');`;

const count = (s, sub) => s.split(sub).length - 1;

function patch(wf) {
  const out = clone(wf);
  if (out.nodes.some((n) => typeof (n.parameters || {}).jsCode === 'string' && n.parameters.jsCode.includes('no_quiet_hours'))) throw new Error('already patched');
  const by = (name) => { const f = out.nodes.filter((n) => n.name === name); if (f.length !== 1) throw new Error(`node "${name}" found ${f.length} times`); return f[0]; };

  // 1. the guard itself: every pasted decideSend copy
  let copies = 0;
  for (const n of out.nodes) {
    const code = (n.parameters || {}).jsCode;
    if (typeof code !== 'string' || !code.includes(DECIDE_OLD)) continue;
    if (count(code, DECIDE_OLD) !== 1) throw new Error(`${n.name}: the quiet-hours line is in it ${count(code, DECIDE_OLD)} times`);
    n.parameters.jsCode = code.replace(DECIDE_OLD, () => DECIDE_NEW); copies++;
  }
  if (copies < 10) throw new Error(`only ${copies} decideSend copies found (expected the pasted guard in 10 or more nodes)`);

  // 2. the exempt callers
  for (const [name, want] of Object.entries(CALLERS)) {
    const n = by(name); const code = n.parameters.jsCode; const got = (code.match(CALL_RE) || []).length;
    if (got !== want) throw new Error(`${name}: expected ${want} transactional decideSend call(s), found ${got}`);
    n.parameters.jsCode = code.replace(CALL_RE, CALL_NEW);
  }
  for (const name of KEEP) if (!by(name).parameters.jsCode.includes(DECIDE_NEW) || by(name).parameters.jsCode.includes('no_quiet_hours: true')) throw new Error(`${name} must keep its quiet hours`);

  // 3. W13: no overnight deferral of an inbound message
  let nights = 0;
  for (const n of out.nodes) {
    const code = (n.parameters || {}).jsCode;
    if (typeof code !== 'string' || !code.includes(NIGHT_OLD)) continue;
    if (count(code, NIGHT_OLD) !== 1) throw new Error(`${n.name}: night line found ${count(code, NIGHT_OLD)} times`);
    n.parameters.jsCode = code.replace(NIGHT_OLD, () => NIGHT_NEW); nights++;
  }
  if (nights < 3) throw new Error(`W13 night line found in ${nights} nodes (expected at least 3)`);

  // 4. W12, the one sender
  const w12 = by(W12);
  if (count(w12.parameters.jsCode, W12_OLD) !== 1) throw new Error('W12 quiet-hours line not found exactly once');
  w12.parameters.jsCode = w12.parameters.jsCode.replace(W12_OLD, () => W12_NEW);

  out.name = NEW_NAME; out.id = NEW_ID; out.active = false;
  return out;
}

module.exports = { patch, NEW_ID, NEW_NAME, CALLERS, KEEP, DECIDE_NEW, W12_NEW };

if (require.main === module) {
  const fs = require('fs');
  const [inp, outp] = process.argv.slice(2);
  if (!inp || !outp) { console.error('usage: node n8n/final/tools/patch-4e-no-quiet-hours.js <4d-workflow.json> <output.json>'); process.exit(2); }
  const res = patch(JSON.parse(fs.readFileSync(inp, 'utf8')));
  fs.writeFileSync(outp, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`wrote ${outp}: ${res.nodes.length} nodes, id ${res.id}, inactive`);
}
void crypto;
