#!/usr/bin/env node
// PROPOSED changes to the authoritative workflow. Nothing here is applied to your n8n: it writes a NEW file you can review, diff and import into a COPY.
//
//   node n8n/final/tools/propose-fixes.js <authoritative.json> <proposed.json>
//
// Fix 1  W13 – Config has TWO `ai_external_enabled` assignments in the authoritative export: the environment expression AND a later literal true. The later one wins,
//        so external AI is ON whatever FLOWHQ_AI_EXTERNAL_ENABLED says (this contradicts the documented safe default "external AI off"). The literal override is
//        removed, leaving the environment expression ={{ $env.FLOWHQ_AI_EXTERNAL_ENABLED === 'true' }}.  Skipped when there is no literal override.
// Fix 2  W1 race guard: two enquiries for one phone at the same moment no longer leave two leads (n8n/production/tools/patch-w1-race-guard.js, 6 nodes added).
//        Skipped when the guard is already there.
// Credentials, ids and every other node are copied unchanged. The script verifies that only the intended nodes differ.
'use strict';
const fs = require('fs');
const path = require('path');
const race = require(path.join(__dirname, '..', '..', 'production', 'tools', 'patch-w1-race-guard.js'));

const ENV_EXPR = "={{ $env.FLOWHQ_AI_EXTERNAL_ENABLED === 'true' }}";
const clone = (o) => JSON.parse(JSON.stringify(o));

function restoreAiEnvGate(wf) {
  const out = clone(wf);
  const node = out.nodes.find((n) => n.name === 'W13 – Config');
  if (!node) throw new Error('node "W13 – Config" not found');
  const list = node.parameters.assignments.assignments;
  const same = list.filter((x) => x.name === 'ai_external_enabled');
  if (!same.length) throw new Error('"W13 – Config" has no ai_external_enabled assignment');
  const literal = same.filter((x) => x.value === true);          // a hard-coded true; in a Set node the LAST assignment of a name wins
  if (!literal.length) return { wf: out, changed: false };
  if (same.length > literal.length) node.parameters.assignments.assignments = list.filter((x) => !literal.includes(x));   // an environment expression is already there: drop the literal override
  else literal[0].value = ENV_EXPR;                                                                                         // only the literal exists: turn it into the expression
  return { wf: out, changed: true };
}

function propose(wf) {
  const notes = [];
  let cur = wf;
  const g = restoreAiEnvGate(cur); cur = g.wf; notes.push(g.changed ? 'W13 – Config: the literal `ai_external_enabled = true` override removed (the environment expression stays)' : 'W13 – Config.ai_external_enabled already an expression (unchanged)');
  if (!cur.nodes.some((n) => n.name === race.N.race)) { cur = race.patch(cur); notes.push('W1 race guard: 6 nodes added'); } else notes.push('W1 race guard already present (unchanged)');
  // proof: only the intended nodes differ
  const before = new Map(wf.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = cur.nodes.filter((n) => before.has(n.name) && before.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
  if (changed.some((n) => n !== 'W13 – Config')) throw new Error(`unexpected changes: ${changed.join(', ')}`);
  return { wf: cur, notes };
}

module.exports = { propose, restoreAiEnvGate, ENV_EXPR };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node propose-fixes.js <authoritative.json> <proposed.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input'); process.exit(2); }
  const { wf, notes } = propose(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  fs.writeFileSync(outFile, `${JSON.stringify(wf, null, 2)}\n`);
  console.log(notes.map((n) => `  - ${n}`).join('\n'));
  console.log(`written ${outFile}`);
}
