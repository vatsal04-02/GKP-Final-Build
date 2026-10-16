#!/usr/bin/env node
// Makes OpenRouter the one external AI provider of the clinic workflow, with ONE reliable switch, and gives every credential ONE role.
//
//   node n8n/final/tools/apply-openrouter-config.js <as-supplied.json> <out.json>
//
// 1. AI switch. W13 – Config and W9 – Config get exactly one `ai_external_enabled` assignment, the same expression in both:
//      ={{ String($env.FLOWHQ_AI_EXTERNAL_ENABLED || '').trim().toLowerCase() === 'true' }}      (anything else, unset or invalid = OFF)
//    The hard-coded `ai_external_enabled = true` that overrode it in W13 – Config is removed, and the second, more permissive environment check that
//    W13 – Build Context had added is removed, so the gate has ONE source: the Config node.
// 2. Config Guards (W13, W9). When the switch is ON the run stops (before any Grist read, Meta call or AI call) unless FLOWHQ_AI_MODEL looks like
//    `vendor/model` and the endpoint is https://openrouter.ai/... (or a local mock on 127.0.0.1 / localhost): the API key can never be sent to another host.
//    When the switch is OFF the AI settings are not validated (nothing uses them).
// 3. Credentials by ROLE (what the node calls), never by name:
//      Grist nodes        -> the Grist credential already used by most of them        (Header Auth account 2)
//      AI call nodes      -> the OpenRouter credential                                 (OpenRouter API)
//      W1 – Webhook       -> its own website-webhook credential                        (FlowHQ W1 Webhook Auth, id FhqCredW1Hook001: create it, see docs/OPENROUTER.md)
//      WhatsApp, SMTP, Telegram: unchanged.
//    No credential value is read or written; only the references (id + name) of the affected nodes change.
// Everything else (node ids, connections, workflow id, logic) is copied unchanged; the script proves it.
'use strict';
const fs = require('fs');
const path = require('path');
const { audit, roleOf } = require('./audit-credentials');

const clone = (o) => JSON.parse(JSON.stringify(o));
const EXPR = "={{ String($env.FLOWHQ_AI_EXTERNAL_ENABLED || '').trim().toLowerCase() === 'true' }}";

const ROLE_CREDENTIAL = {
  grist: { id: '9J6XxrIQoFDcQZ0Y', name: 'Header Auth account 2' },
  'ai-provider': { id: 'As1GpZb3W665Na7C', name: 'OpenRouter API' },
  'webhook-auth (website enquiries / Cal.com)': { id: 'FhqCredW1Hook001', name: 'FlowHQ W1 Webhook Auth' },
};

const GATE_OLD = String.raw`if (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true && !(['true', '1', 'yes', 'on'].includes(String($env.FLOWHQ_AI_EXTERNAL_ENABLED || '').trim().toLowerCase()))) gate = { route: 'skip', reason: 'external AI is switched off (FLOWHQ_AI_EXTERNAL_ENABLED is not true): no AI call was made; staff answer this message', quiet: false };`;
const GATE_NEW = String.raw`if (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true) gate = { route: 'skip', reason: 'external AI is switched off (FLOWHQ_AI_EXTERNAL_ENABLED is not true): no AI call was made; staff answer this message', quiet: false };`;

const GUARD_MODEL_OLD = String.raw`if (cfg.ai_external_enabled === true) need('openrouter_model', 'FLOWHQ_AI_MODEL');`;
const GUARD_URL_OLD = String.raw`if (!/^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)(\/[^\s]*)?$/.test(String(cfg.ai_base_url || ''))) problems.push('FLOWHQ_AI_BASE_URL must be https:// (or http://127.0.0.1 / localhost for a local mock)');`;
const GUARD_NEW = String.raw`if (cfg.ai_external_enabled === true) {
  // OpenRouter is the only external AI provider. Checked only while the switch is ON; a bad value stops the run before anything is sent anywhere.
  need('openrouter_model', 'FLOWHQ_AI_MODEL');
  if (!blank(cfg.openrouter_model) && !/^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/.test(String(cfg.openrouter_model).trim())) problems.push('FLOWHQ_AI_MODEL must look like vendor/model, for example openai/gpt-4o-mini');
  if (!/^(https:\/\/openrouter\.ai(\/[^\s]*)?|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/.test(String(cfg.ai_base_url || '').trim())) problems.push('FLOWHQ_AI_BASE_URL must be https://openrouter.ai/... (leave it unset for the default https://openrouter.ai/api/v1; http://127.0.0.1 or localhost is accepted for a local mock)');
}`;

function once(code, find, replace, where) {
  const n = code.split(find).length - 1;
  if (n !== 1) throw new Error(`${where}: expected the anchor exactly once but found ${n} (already applied, or the node was edited): nothing written`);
  return code.replace(find, () => replace);
}

function apply(wf) {
  const out = clone(wf);
  const node = (n) => { const x = out.nodes.find((y) => y.name === n); if (!x) throw new Error(`node "${n}" not found`); return x; };
  const log = [];

  // 1. one AI switch
  for (const nm of ['W13 – Config', 'W9 – Config']) {
    const list = node(nm).parameters.assignments.assignments;
    const same = list.filter((a) => a.name === 'ai_external_enabled');
    const expr = same.filter((a) => typeof a.value === 'string' && /FLOWHQ_AI_EXTERNAL_ENABLED/.test(a.value));
    if (!expr.length) throw new Error(`${nm}: no environment expression for ai_external_enabled to keep`);
    const keep = expr[0];
    node(nm).parameters.assignments.assignments = list.filter((a) => a.name !== 'ai_external_enabled' || a === keep);
    if (keep.value !== EXPR) { keep.value = EXPR; }
    keep.type = 'boolean';
    log.push(`${nm}: one ai_external_enabled assignment (${same.length - 1 ? `${same.length - 1} extra removed, ` : ''}environment expression)`);
  }
  const bc = node('W13 – Build Context');
  bc.parameters.jsCode = once(bc.parameters.jsCode, GATE_OLD, GATE_NEW, 'W13 – Build Context');
  log.push('W13 – Build Context: the gate reads only W13 – Config (the extra environment check is gone)');

  // 2. guards
  for (const nm of ['W13 – Config Guard', 'W9 – Config Guard']) {
    const g = node(nm);
    let c = once(g.parameters.jsCode, GUARD_MODEL_OLD, GUARD_NEW, nm);
    c = once(c, GUARD_URL_OLD, '', nm).replace(/\n\n\n/g, '\n\n');
    g.parameters.jsCode = c;
    log.push(`${nm}: OpenRouter model format and endpoint host checked while the switch is ON`);
  }

  // 3. credentials by role
  const touched = [];
  for (const n of out.nodes) {
    if (!n.credentials) continue;
    const role = roleOf(n) || 'other';
    const target = ROLE_CREDENTIAL[role];
    if (!target) continue;
    const type = Object.keys(n.credentials)[0];
    if (type !== 'httpHeaderAuth') continue;
    const cur = n.credentials[type];
    if (cur.id !== target.id || cur.name !== target.name) { n.credentials = { httpHeaderAuth: { ...target } }; touched.push([n.name, role, `${cur.name} -> ${target.name}`]); }
  }
  for (const [name, role, change] of touched) log.push(`credential by role (${role.split(' ')[0]}): ${name}: ${change}`);

  // proof: nothing else moved
  const allowed = new Set(['W13 – Config', 'W9 – Config', 'W13 – Build Context', 'W13 – Config Guard', 'W9 – Config Guard', ...touched.map((t) => t[0])]);
  const before = new Map(wf.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = out.nodes.filter((n) => before.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
  const stray = changed.filter((n) => !allowed.has(n));
  if (stray.length || out.nodes.length !== wf.nodes.length) throw new Error(`unexpected changes: ${stray.join(', ')}`);
  if (JSON.stringify(out.connections) !== JSON.stringify(wf.connections)) throw new Error('connections changed');
  for (const k of Object.keys(wf)) if (k !== 'nodes' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  const shared = audit(out).credentials.filter((c) => c.shared);
  if (shared.length) throw new Error(`a credential still serves several roles: ${shared.map((c) => c.credentialName).join(', ')}`);
  return { wf: out, log, changed };
}

module.exports = { apply, EXPR, ROLE_CREDENTIAL };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node apply-openrouter-config.js <as-supplied.json> <out.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input'); process.exit(2); }
  const { wf, log, changed } = apply(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  fs.writeFileSync(outFile, `${JSON.stringify(wf, null, 2)}\n`);
  console.log(log.map((l) => `  - ${l}`).join('\n'));
  console.log(`${changed.length} node(s) changed of ${wf.nodes.length}; written ${outFile}`);
}
