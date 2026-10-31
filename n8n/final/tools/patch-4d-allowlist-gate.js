#!/usr/bin/env node
// 4D safety fix: no AI call for a number that is not on the WhatsApp allowlist.
//
//   (used by n8n/final/tools/build-4d.js)
//
// Problem found while preparing the cutover: FLOWHQ_WA_SEND_MODE=allowlist is enforced only in W12, at the SEND. W13 asks the AI model BEFORE that, so with
// external AI switched on for the supervised test, every real patient's message would still be sent to the AI provider even though the reply is then blocked.
// Fix: while the send mode is "allowlist", W13 - Build Context turns the route into a visible skip for any number that is not on FLOWHQ_WA_ALLOWLIST
// (nothing is sent to the provider; a person answers, as when external AI is off). In "live" mode nothing changes. Fails closed: a missing phone is not allowed.
//
// Changes: "W13 - Config" gets two assignments (wa_send_mode, wa_allowlist, read from the environment like every other W13 setting) and
// "W13 - Build Context" gets one block directly after the existing external-AI gate. Nothing else.
'use strict';
const crypto = require('crypto');

const D = '–';
const CONFIG = `W13 ${D} Config`;
const BUILD = `W13 ${D} Build Context`;
const uuid = (seed) => { const h = crypto.createHash('sha1').update(`4d-allowlist-gate:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

const ANCHOR = "if (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true) gate = { route: 'skip', reason: 'external AI is switched off (FLOWHQ_AI_EXTERNAL_ENABLED is not true): no AI call was made; staff answer this message', quiet: false };";
const BLOCK = `
// 4D: while WhatsApp sends are limited to an allowlist (supervised testing), a message from any OTHER number is not sent to the AI provider either:
// the allowlist is otherwise enforced only at the send, after the text has already gone to the model. Visible skip; a person answers as before.
if (gate.route === 'ai') {
  const wa = $('W13 – Config').first().json;
  const allowed = String(wa.wa_allowlist || '').split(/[,;]+/).map((s) => h.normalizeIndianPhone(s).phone).filter(Boolean);
  if (String(wa.wa_send_mode || '').trim().toLowerCase() === 'allowlist' && !allowed.includes(h.normalizeIndianPhone(x.lead.phone).phone)) gate = { route: 'skip', reason: 'WhatsApp send mode is allowlist and this number is not on it: the message was not sent to the AI provider; staff answer it', quiet: false };
}`;
const ASSIGN = [
  { name: 'wa_send_mode', value: "={{ String($env.FLOWHQ_WA_SEND_MODE || '').trim().toLowerCase() }}" },
  { name: 'wa_allowlist', value: "={{ String($env.FLOWHQ_WA_ALLOWLIST || '') }}" },
];

function patch(wf) {
  const out = clone(wf);
  const cfg = out.nodes.filter((n) => n.name === CONFIG); const build = out.nodes.filter((n) => n.name === BUILD);
  if (cfg.length !== 1 || build.length !== 1) throw new Error('W13 Config / Build Context not found exactly once');
  const list = cfg[0].parameters.assignments.assignments;
  for (const a of ASSIGN) if (list.some((x) => x.name === a.name)) throw new Error(`${a.name} already exists: this workflow is already patched`);
  const code = build[0].parameters.jsCode;
  if (code.split(ANCHOR).length !== 2) throw new Error('the external-AI gate line was not found exactly once in W13 Build Context');
  build[0].parameters.jsCode = code.replace(ANCHOR, () => ANCHOR + BLOCK);
  for (const a of ASSIGN) list.push({ id: uuid(a.name), name: a.name, value: a.value, type: 'string' });
  return out;
}

module.exports = { patch, BLOCK, ANCHOR, ASSIGN, CONFIG, BUILD };
