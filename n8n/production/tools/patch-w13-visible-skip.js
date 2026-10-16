#!/usr/bin/env node
// Makes a closed external-AI gate VISIBLE in W13, and changes nothing else.
//
//   node tools/patch-w13-visible-skip.js <workflow.json> <output.json>
//
// Before: with FLOWHQ_AI_EXTERNAL_ENABLED not "true", W13 - Build Context turned the message into a *quiet* skip: nothing was written
// (no AI_Status, no Run_Log), so the message looked "not handled" and nobody could tell why. After: the same skip is NOT quiet, so the
// existing writers record it: Messages.AI_Status = skipped, AI_Action = skip, AI_Reason = why, and one Run_Log row (Outcome skipped).
// Still no provider call, no message to the patient, no staff alert, no change to consent / opt-out / hand-off logic.
//
// The edit is anchored: the exact original line must occur exactly once in "W13 – Build Context" or nothing is written. Credentials,
// ids, URLs, positions, connections and every other node are copied as they are; the script then re-checks that exactly one node differs.
'use strict';
const fs = require('fs');

const NODE = 'W13 – Build Context';
const FIND = "// PRODUCTION: external AI is closed until the clinic has approved the provider (FLOWHQ_AI_EXTERNAL_ENABLED=true). Closed = the same quiet 'skip' as Settings ai_mode=off.\nif (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true) gate = { route: 'skip', reason: 'external AI is not enabled (FLOWHQ_AI_EXTERNAL_ENABLED)', quiet: true };\n";
const REPLACE = "// PRODUCTION: external AI is closed until the clinic has approved the provider (FLOWHQ_AI_EXTERNAL_ENABLED=true). Closed = a VISIBLE skip (not quiet): the\n// message gets AI_Status = skipped + the reason and a Run_Log row, nothing is sent to any provider or patient, and a person answers as before.\nif (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true) gate = { route: 'skip', reason: 'external AI is switched off (FLOWHQ_AI_EXTERNAL_ENABLED is not true): no AI call was made; staff answer this message', quiet: false };\n";

function patch(wf) {
  const out = JSON.parse(JSON.stringify(wf));
  const node = out.nodes.find((n) => n.name === NODE);
  if (!node) throw new Error(`node "${NODE}" not found: is this the integrated FlowHQ workflow?`);
  const code = node.parameters.jsCode;
  const hits = code.split(FIND).length - 1;
  if (hits !== 1) throw new Error(`expected the closed-gate line exactly once in "${NODE}" but found ${hits} (already patched, or the node was edited): nothing written`);
  node.parameters.jsCode = code.replace(FIND, () => REPLACE);
  // proof that nothing else moved
  const changed = out.nodes.filter((n, i) => JSON.stringify(n) !== JSON.stringify(wf.nodes[i])).map((n) => n.name);
  if (changed.length !== 1 || changed[0] !== NODE || out.nodes.length !== wf.nodes.length) throw new Error(`unexpected change set: ${changed.join(', ')}`);
  if (JSON.stringify(out.connections) !== JSON.stringify(wf.connections)) throw new Error('connections changed');
  for (const k of Object.keys(wf)) if (!['nodes'].includes(k) && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  return out;
}

module.exports = { patch, NODE, FIND, REPLACE };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node tools/patch-w13-visible-skip.js <workflow.json> <output.json>'); process.exit(2); }
  if (require('path').resolve(inFile) === require('path').resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const out = patch(wf);
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  console.log(`written ${outFile}: 1 node changed ("${NODE}"), ${out.nodes.length} nodes, credentials and connections identical`);
}
