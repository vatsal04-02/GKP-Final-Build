#!/usr/bin/env node
// Rebuilds the selected workflow from the as-supplied copy, in two documented steps (nothing else changes; each step proves it):
//   1. apply-openrouter-config.js   OpenRouter as the one AI provider, one AI switch, credentials by role  (16 nodes)
//   2. patch-w1-race-guard.js       W1 duplicate-lead race guard                                           (6 nodes added, 0 changed)
//   node n8n/final/tools/build-selected.js <as-supplied.json> <out.json>
'use strict';
const fs = require('fs');
const path = require('path');
const { apply } = require('./apply-openrouter-config');
const race = require(path.join(__dirname, '..', '..', 'production', 'tools', 'patch-w1-race-guard.js'));

function build(supplied) {
  const a = apply(supplied);
  const wf = race.patch(a.wf);
  const had = new Map(a.wf.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const moved = wf.nodes.filter((n) => had.has(n.name) && had.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
  if (moved.length || wf.nodes.length !== a.wf.nodes.length + 6) throw new Error(`race guard changed existing nodes or added the wrong number: ${moved.join(', ')}`);
  return { wf, log: a.log, changed: a.changed };
}
module.exports = { build };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node build-selected.js <as-supplied.json> <out.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input'); process.exit(2); }
  const { wf, log } = build(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  fs.writeFileSync(outFile, `${JSON.stringify(wf, null, 2)}\n`);
  console.log(log.map((l) => `  - ${l}`).join('\n'));
  console.log(`written ${outFile} (${wf.nodes.length} nodes)`);
}
