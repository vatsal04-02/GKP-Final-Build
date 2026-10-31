#!/usr/bin/env node
// 4D = 4C + the AI retry / backoff that the workflow deployed on the production n8n ("SINGLE-MODEL V4 CRM BOOKING CANDIDATE") already has.
//
//   node n8n/final/tools/patch-4d-ai-retry.js <4c-workflow.json> <output.json>
//
// Why: the live V4 workflow retries a rate-limited (429) or temporarily failing (5xx) OpenRouter call with exponential backoff and jitter
// (at most 3 requests, one repeat after a timeout, never on 400/401/402/403/404 or a daily quota) before W13 hands the patient to a person.
// 4C does not have it, so replacing V4 by 4C would silently lose it. The decision logic is V4's, copied verbatim into
// n8n/final/tools/4d/w13-ai-retry-check.body.js (it reads FLOWHQ_AI_RETRY_MAX_ATTEMPTS / _BASE_SECONDS / _MAX_WAIT_SECONDS, all optional).
//
// What this changes in 4C (and nothing else):
//   * "W13 - Ask Model": the HTTP node now returns the full response without failing on an HTTP error (options.response.response), so a 429 or 5xx
//     reaches the retry check as data. A successful answer is passed on UNCHANGED (the retry check returns the OpenRouter body), so
//     "W13 - Provider Answer" (byte-identical in V4 and 4C) keeps working; a give-up becomes an { error } item, which "Provider Answer"
//     already turns into a hand-off to a person. A retry is NEVER passed on as an answer.
//   * 3 new nodes between "Ask Model" and "Provider Answer": "Ask Model Retry Check" (Code), "Ask Model Retry?" (IF), "Ask Model Backoff" (Wait, loops back).
//   * the workflow gets its OWN id and name. 4C carries the id of the originally deployed workflow: importing it by the n8n CLI would OVERWRITE that
//     workflow instead of adding a new inactive one.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const D = '–';   // the en dash used in every node name
const N = { req: `W13 ${D} Provider Request`, ask: `W13 ${D} Ask Model`, ans: `W13 ${D} Provider Answer`, check: `W13 ${D} Ask Model Retry Check`, test: `W13 ${D} Ask Model Retry?`, wait: `W13 ${D} Ask Model Backoff` };
const ADDED = [N.check, N.test, N.wait];
const NEW_NAME = 'FlowHQ Clinic Automation 4D candidate (4C + AI retry and backoff)';
const NEW_ID = 'F4dRetry' + crypto.createHash('sha1').update('4d-ai-retry:workflow-id').digest('hex').slice(0, 8);   // 16 characters, like an n8n id
const uuid = (seed) => { const h = crypto.createHash('sha1').update(`4d-ai-retry:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const CHECK_CODE = fs.readFileSync(path.join(__dirname, '4d', 'w13-ai-retry-check.body.js'), 'utf8');

function patch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.filter((x) => x.name === n);
  for (const n of [N.req, N.ask, N.ans]) if (by(n).length !== 1) throw new Error(`expected exactly one node "${n}" in the input`);
  for (const n of ADDED) if (by(n).length) throw new Error(`"${n}" already exists: this workflow is already patched`);
  const ask = by(N.ask)[0];
  const opts = ask.parameters && ask.parameters.options;
  if (!opts || opts.timeout !== 45000 || opts.response) throw new Error('"Ask Model" is not in the expected 4C shape (options = { timeout: 45000 })');
  const conn = out.connections[N.ask];
  if (!conn || JSON.stringify(conn) !== JSON.stringify({ main: [[{ node: N.ans, type: 'main', index: 0 }]] })) throw new Error('"Ask Model" is not wired only to "Provider Answer"');

  ask.parameters.options = { response: { response: { fullResponse: true, neverError: true } }, timeout: 45000 };
  const [x, y] = ask.position;
  out.nodes.push(
    { parameters: { jsCode: CHECK_CODE }, id: uuid('check'), name: N.check, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x + 240, y + 176] },
    { parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid('cond'), leftValue: '={{ $json.retry === true }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, id: uuid('if'), name: N.test, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [x + 480, y + 176] },
    { parameters: { amount: '={{ $json.wait_seconds }}' }, id: uuid('wait'), name: N.wait, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [x + 240, y + 352], webhookId: uuid('wait-webhook') },
  );
  out.connections[N.ask] = { main: [[{ node: N.check, type: 'main', index: 0 }]] };
  out.connections[N.check] = { main: [[{ node: N.test, type: 'main', index: 0 }]] };
  out.connections[N.test] = { main: [[{ node: N.wait, type: 'main', index: 0 }], [{ node: N.ans, type: 'main', index: 0 }]] };
  out.connections[N.wait] = { main: [[{ node: N.ask, type: 'main', index: 0 }]] };
  out.name = NEW_NAME; out.id = NEW_ID; out.active = false;
  return out;
}

module.exports = { patch, N, ADDED, NEW_NAME, NEW_ID };
if (require.main === module) {
  const [inp, outp] = process.argv.slice(2);
  if (!inp || !outp) { console.error('usage: node n8n/final/tools/patch-4d-ai-retry.js <4c-workflow.json> <output.json>'); process.exit(2); }
  const res = patch(JSON.parse(fs.readFileSync(inp, 'utf8')));
  fs.writeFileSync(outp, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`wrote ${outp}: ${res.nodes.length} nodes (+${ADDED.length}), id ${res.id}, inactive`);
}
