#!/usr/bin/env node
// Builds the 4D candidate from the 4C candidate:  4D = allowlist gate( AI retry/backoff( 4C ) )
//   node n8n/final/tools/build-4d.js <4c-workflow.json> <output.json>
// Stage 1: patch-4d-ai-retry.js (the retry/backoff the deployed V4 has). Stage 2: patch-4d-allowlist-gate.js (no AI call for a non-allowlisted number).
// The result gets its own workflow id and name (set in stage 1), is inactive, and is committed as FlowHQ_Clinic_Automation_production_candidate4d.json.
'use strict';
const fs = require('fs');
const retry = require('./patch-4d-ai-retry');
const gate = require('./patch-4d-allowlist-gate');

const build = (wf) => gate.patch(retry.patch(wf));
module.exports = { build, retry, gate };

if (require.main === module) {
  const [inp, outp] = process.argv.slice(2);
  if (!inp || !outp) { console.error('usage: node n8n/final/tools/build-4d.js <4c-workflow.json> <output.json>'); process.exit(2); }
  const res = build(JSON.parse(fs.readFileSync(inp, 'utf8')));
  fs.writeFileSync(outp, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`wrote ${outp}: ${res.nodes.length} nodes, id ${res.id}, inactive`);
}
