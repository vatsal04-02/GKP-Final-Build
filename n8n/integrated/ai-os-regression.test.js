// The existing suites, unchanged, on your patched workflow (ai-workflow-clinic.ai-os.json) and on the original export:
//   integrated.test.js (18 end-to-end check groups + 10 mutations: W2 -> AI -> W12) and existing-modules.test.js
//   (25 W1 / W3 / W4 / W5 / W6 / W11 / W12 scenarios). A1-A6 must not change any of them.
// Run: node n8n/integrated/ai-os-regression.test.js      (AI_OS_FILE / AI_OS_ORIG = other files)
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = {
  patched: process.env.AI_OS_FILE || path.join(__dirname, 'ai-workflow-clinic.ai-os.json'),
  original: process.env.AI_OS_ORIG || path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json'),
};
let failed = 0;
for (const [label, file] of Object.entries(FILES)) {
  for (const suite of ['integrated.test.js', 'existing-modules.test.js']) {
    // the original export predates the Needs_Human gate fix (handoff-gate.test.js): test 6 checks its old behaviour there
    const legacy = label === 'original' ? { INTEGRATED_LEGACY_NEEDS_HUMAN: '1' } : {};
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { encoding: 'utf8', env: { ...process.env, INTEGRATED_FILE: file, ...legacy } });
    const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'}  ${label.padEnd(8)} ${suite.padEnd(26)} ${last.trim()}`);
    if (r.status !== 0) { failed++; console.log(r.stdout.split('\n').filter((l) => /FAIL|MISSED/.test(l)).join('\n')); }
  }
}
if (failed) { console.log(`\n${failed} suite run(s) FAILED`); process.exit(1); }
console.log('\nAI OS regression: the existing suites pass on the patched workflow and on the original');
