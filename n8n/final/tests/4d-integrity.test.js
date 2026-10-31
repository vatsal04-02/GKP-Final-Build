#!/usr/bin/env node
// 4D static integrity (no simulator): graph, webhook ownership, credential roles, the ONE appointment-writing path, environment defaults.
//   node n8n/final/tests/4d-integrity.test.js        (FOURD_FILE=<export.json> checks another export)
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { roleOf } = require('../tools/audit-credentials');

const dir = path.join(__dirname, '..', 'workflows');
const d4 = JSON.parse(fs.readFileSync(process.env.FOURD_FILE || path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4d.json'), 'utf8'));
const c4 = JSON.parse(fs.readFileSync(path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4c.json'), 'utf8'));
const compose = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docker-compose.yml'), 'utf8');
let failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`); } };
const credNames = (n) => Object.values(n.credentials || {}).map((c) => c.name);
const urlOf = (n) => String((n.parameters && n.parameters.url) || '');
const http = d4.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');

// ---------------------------------------------------------------- graph
const TRIGGERS = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.executeWorkflowTrigger']);
const unreachable = (wf) => {
  const next = new Map(); for (const [from, o] of Object.entries(wf.connections)) next.set(from, (o.main || []).flat().map((c) => c.node));
  const seen = new Set(wf.nodes.filter((n) => TRIGGERS.has(n.type)).map((n) => n.name)); const q = [...seen];
  while (q.length) for (const nx of next.get(q.shift()) || []) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
  return wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !seen.has(n.name)).map((n) => n.name).sort();
};
t('graph: unique node names and ids, no connection to or from a missing node', () => {
  const names = new Set(d4.nodes.map((n) => n.name)); assert.strictEqual(names.size, d4.nodes.length);
  assert.strictEqual(new Set(d4.nodes.map((n) => n.id)).size, d4.nodes.length);
  for (const [from, o] of Object.entries(d4.connections)) { assert(names.has(from), `source ${from}`); for (const c of (o.main || []).flat()) assert(names.has(c.node), `target ${c.node}`); }
});
t('graph: 4D leaves no node unreachable that 4C did not already have (the 3 retry nodes are all on a live path)', () => {
  const a = unreachable(d4); const b = unreachable(c4);
  assert.deepStrictEqual(a, b, `4D unreachable: ${a.filter((x) => !b.includes(x)).join(', ')}`);
  for (const n of ['W13 – Ask Model Retry Check', 'W13 – Ask Model Retry?', 'W13 – Ask Model Backoff']) assert(!a.includes(n), n);
});
t('graph: the workflow is inactive and does not carry the id or name of any workflow already deployed (an import must create a NEW workflow)', () => {
  assert.strictEqual(d4.active, false);
  const DEPLOYED_IDS = ['sUaNZ0rqAG67HNih', 'L8HW7J8VYClBOTWn', 'YLu0VkP03fuQfZv1', 'XgIrFraS2AhQUikV', '6FXKBRiYpYE7fuq7', 'IcVPxuueSwTzMnWM', '0Rb2cmnqpr0OdjX7', 'Q5zNQsmtzdKEcYJa', 'VaZ0abHwRICrx6C0'];
  assert(!DEPLOYED_IDS.includes(d4.id), `id ${d4.id} is already deployed`);
  assert(!/V4|NOT DEPLOYED|production candidate\)$/.test(d4.name), `name ${d4.name}`);
});

// ---------------------------------------------------------------- webhooks (ownership when V4 is replaced)
t('webhooks: exactly the paths V4 owns today (website-lead POST, cal POST, whatsapp-inbound GET + POST); unique webhookIds; no test or extra path', () => {
  const w = d4.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => `${n.parameters.httpMethod || 'GET'} ${n.parameters.path}`).sort();
  assert.deepStrictEqual(w, ['GET whatsapp-inbound', 'POST cal', 'POST website-lead', 'POST whatsapp-inbound']);
  const ids = d4.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => n.webhookId); assert.strictEqual(new Set(ids).size, ids.length); assert(ids.every(Boolean));
});
t('webhooks: the website-lead webhook is protected by the DEDICATED credential "FlowHQ W1 Webhook Auth", never by an AI, Grist or WhatsApp credential', () => {
  const w1 = d4.nodes.find((n) => n.name === 'W1 – Webhook'); assert.strictEqual(w1.parameters.authentication, 'headerAuth');
  assert.deepStrictEqual(credNames(w1), ['FlowHQ W1 Webhook Auth']);
  assert.strictEqual(d4.nodes.filter((n) => credNames(n).includes('FlowHQ W1 Webhook Auth')).length, 1, 'used by that one node only');
});

// ---------------------------------------------------------------- credentials by role (the V4 misbinding must not exist here)
t('credentials: every credentialed node has a role, and the role fits what the node calls', () => {
  for (const n of d4.nodes.filter((x) => x.credentials)) assert(roleOf(n), `no role for ${n.name}`);
});
t('credentials: the AI provider credential is used ONLY by nodes that call the model; Grist and WhatsApp credentials never do', () => {
  for (const n of d4.nodes.filter((x) => credNames(x).includes('OpenRouter API'))) assert(/chat\/completions/.test(urlOf(n)), `OpenRouter credential on ${n.name}`);
  for (const n of http.filter((x) => /chat\/completions/.test(urlOf(x)))) assert.deepStrictEqual(credNames(n), ['OpenRouter API'], n.name);
  for (const n of http.filter((x) => credNames(x).includes('Header Auth account 2'))) assert(!/chat\/completions|graph\.facebook|\/api\/booking/.test(urlOf(n)), `Grist credential on ${n.name}`);
});
t('credentials: the WhatsApp credential is used only by the Meta send; the booking credential only by the two booking-API nodes, which call nothing but /api/booking', () => {
  assert.deepStrictEqual(d4.nodes.filter((n) => credNames(n).includes('WhatsApp Cloud API')).map((n) => n.name), ['W12 – Meta send']);
  const booking = d4.nodes.filter((n) => credNames(n).includes('FlowHQ Booking API')).map((n) => n.name).sort();
  assert.deepStrictEqual(booking, ['W13 – Booking API', 'W13 – Booking availability']);
  for (const n of d4.nodes.filter((x) => booking.includes(x.name))) assert(/\/api\/booking\//.test(urlOf(n)) || /\$json\.url|\$json\.req|\{\{/.test(urlOf(n)), n.name);
});
t('credentials: only credentials that exist in production, plus the two to be created (FlowHQ W1 Webhook Auth, FlowHQ Booking API)', () => {
  const PROD = ['Header Auth account 2', 'WhatsApp Cloud API', 'OpenRouter API', 'Telegram account', 'SMTP account'];
  const TO_CREATE = ['FlowHQ W1 Webhook Auth', 'FlowHQ Booking API'];
  const used = [...new Set(d4.nodes.flatMap(credNames))].sort();
  assert.deepStrictEqual(used.filter((c) => ![...PROD, ...TO_CREATE].includes(c)), [], 'unexpected credential names');
  for (const c of TO_CREATE) assert(used.includes(c), `${c} is not used`);
});

// ---------------------------------------------------------------- one appointment-writing path
t('appointments: no HTTP node creates an Appointments row; the only direct Appointments PATCHes are reminder / follow-up flags and the Cal.com sync confirmation', () => {
  const direct = http.filter((n) => /tables\/Appointments\//.test(urlOf(n)) && String(n.parameters.method || 'GET') !== 'GET');
  assert(direct.every((n) => (n.parameters.method === 'PATCH')), 'a static POST to Appointments');
  assert.deepStrictEqual(direct.map((n) => n.name).sort(), ['W4 – Write Confirm_Sent', 'W5 – Set sent flag', 'W7 – Claim Outcome_Sent', 'W8 – Claim Review_Sent']);
});
t('appointments: only W4 (the Cal.com legacy sync) plans Appointments rows; W13, W12, W15 and W2 never name the table in a write', () => {
  const sites = (n) => [...String(n.parameters.jsCode || '').matchAll(/table:\s*'Appointments'/g)].length;
  for (const n of d4.nodes.filter((x) => /^(W13|W12|W15|W2)\b/.test(x.name))) {
    const code = String(n.parameters.jsCode || '');
    assert(!/(method:\s*'(POST|PATCH)'[^;\n]{0,80}table:\s*'Appointments'|table:\s*'Appointments'[^;\n]{0,80}method:\s*'(POST|PATCH)')/.test(code), `${n.name} writes Appointments`);
  }
  const writers = d4.nodes.filter((n) => sites(n) > 0 && /^W(4|6)\b/.test(n.name)).map((n) => n.name).sort();
  assert.deepStrictEqual(writers, ['W4 – Plan appointment', 'W4 – Plan writes', 'W6 – Plan follow-ups']);
});
t('appointments: W13 is hard-wired to central mode (Settings > booking_mode cannot switch it to direct) and reads its API address from FLOWHQ_BOOKING_API_URL only', () => {
  for (const n of ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends']) assert(/booking_mode:\s*'central'/.test(d4.nodes.find((x) => x.name === n).parameters.jsCode), n);
  const a = d4.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((x) => x.name === 'booking_api_url');
  assert(a && /FLOWHQ_BOOKING_API_URL/.test(a.value));
  assert(!/localhost|flowhq:|https?:\/\/[a-z]/.test(a.value.replace('FLOWHQ_BOOKING_API_URL', '')), 'no address is written into the workflow');
});

// ---------------------------------------------------------------- environment
t('environment: every variable 4D reads that docker-compose does NOT pass to n8n has a safe default at every use', () => {
  const raw = JSON.stringify(d4);
  const refs = [...new Set([...raw.matchAll(/\$env\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  const i = compose.indexOf('\n  n8n:'); const section = compose.slice(i, compose.indexOf('\n  grist:', i) > 0 ? compose.indexOf('\n  grist:', i) : undefined);
  const passed = new Set([...section.matchAll(/-\s+([A-Z0-9_]+)=/g)].map((m) => m[1]));
  const loose = refs.filter((r) => !passed.has(r));
  assert.deepStrictEqual(loose.sort(), ['FLOWHQ_AI_BASE_URL', 'FLOWHQ_AI_RETRY_BASE_SECONDS', 'FLOWHQ_AI_RETRY_MAX_ATTEMPTS', 'FLOWHQ_AI_RETRY_MAX_WAIT_SECONDS', 'FLOWHQ_WA_GRAPH_BASE_URL'], 'the set of unpassed variables changed: review it');
  for (const v of loose) for (const m of raw.matchAll(new RegExp(`\\$env\\.${v}(.{0,12})`, 'g'))) assert(/^\s*(\|\||\?\?|\))/.test(m[1]) || /\|\|/.test(m[1]), `${v} has no default here: ${m[1]}`);
  for (const v of ['FLOWHQ_BOOKING_API_URL', 'FLOWHQ_AI_MAX_REPLIES_PER_HOUR', 'FLOWHQ_W2_IMPLIED_CONSENT', 'FLOWHQ_WA_SEND_MODE', 'FLOWHQ_WA_ALLOWLIST']) assert(passed.has(v), `${v} must be passed to n8n by docker-compose.yml`);
});

process.exit(failed ? 1 : 0);
