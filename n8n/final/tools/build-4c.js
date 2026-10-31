#!/usr/bin/env node
// Builds the Slice 4C candidate from the earlier candidate (the input file is never overwritten):
//   1. patch-4c-consent.js     reminder consent and message purposes in W5 / W12 / W15
//   2. patch-4c-w13-booking.js W13 books, cancels and moves appointments only through the FLOW HQ booking API (and writes n8n/snippets/ai-receptionist-central.js)
//
//   node n8n/final/tools/build-4c.js [<candidate.json> [<output.json>]]
// Defaults: n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json -> ..._candidate4c.json
'use strict';
const fs = require('fs');
const path = require('path');
const consent = require('./patch-4c-consent');
const w13 = require('./patch-4c-w13-booking');

const ADDED = [...consent.ADDED, ...w13.ADDED];
const CHANGED = [...new Set([...consent.CHANGED, ...w13.CHANGED])];
const SNIPPETS = path.join(__dirname, '..', '..', 'snippets');
const standalone = { file: path.join(SNIPPETS, 'ai-receptionist-central.js'), from: path.join(SNIPPETS, 'ai-receptionist.js') };

// writeSnippet = false for tests that only compare (they must not touch the repo)
function build(base, writeSnippet = false) { return w13.patch(consent.patch(base), writeSnippet ? standalone : null); }

module.exports = { build, ADDED, CHANGED, consent, w13 };

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'workflows');
  const inFile = process.argv[2] || path.join(dir, 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
  const outFile = process.argv[3] || path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4c.json');
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const res = build(wf, true);
  fs.writeFileSync(outFile, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`written ${path.relative(process.cwd(), outFile)}: ${ADDED.length} nodes added (${wf.nodes.length} -> ${res.nodes.length}), ${CHANGED.length} existing nodes changed; ${path.relative(process.cwd(), standalone.file)} regenerated; the input is untouched`);
}
