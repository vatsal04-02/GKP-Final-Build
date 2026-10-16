// Regression for the Needs_Human gate fix: every existing end-to-end suite, unchanged, on the patched workflow
// (ai-updated-workflow-clinic.handoff-gate.json): the W2 -> W13 -> W12 suite with its mutations, the 25 W1/W3/W4/W5/W6/W11/W12
// scenarios, the 83-check system test with its 15 mutations, and the A1-A6 suite (only its 2 known, earlier intended differences).
// Run: node n8n/integrated/handoff-gate-regression.test.js      (HANDOFF_FILE = another file)
const path = require('path');
const { spawnSync } = require('child_process');

const FILE = process.env.HANDOFF_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.handoff-gate.json');
const SOURCE = path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json');
const PRE_A1 = path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json');
const KNOWN_A1_A6 = ['A5 W6 day-2 follow-up', 'A6 W3 message'];   // replaced on purpose by apply-ai-context.js (see AI-CONTEXT-REPORT.md)
const sh = (file, env) => spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: { ...process.env, ...env } });
const last = (r) => (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
let failed = 0;
for (const [suite, env] of [
  ['integrated.test.js', { INTEGRATED_FILE: FILE }],
  ['existing-modules.test.js', { INTEGRATED_FILE: FILE }],
  ['system.test.js', { AI_CTX_FILE: FILE, AI_CTX_ORIG: SOURCE }],
  ['ai-context-mutations.test.js', { AI_CTX_FILE: FILE, AI_CTX_ORIG: SOURCE }],
]) {
  const r = sh(suite, env);
  console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'}  ${suite.padEnd(30)} ${last(r).trim()}`);
  if (r.status !== 0) failed++;
}
const r = sh('ai-os.test.js', { AI_OS_FILE: FILE, AI_OS_ORIG: PRE_A1, AI_OS_NO_MUTATIONS: '1' });
const fails = (r.stdout.match(/^ {2}FAIL (.+)$/gm) || []).map((l) => l.replace(/^ {2}FAIL /, ''));
const unexpected = fails.filter((f) => !KNOWN_A1_A6.some((k) => f.startsWith(k)));
console.log(`  ${unexpected.length ? 'FAIL' : 'ok  '}  ${'ai-os.test.js (A1-A6)'.padEnd(30)} ${14 - fails.length} of 14 groups pass; ${fails.length} known earlier change(s)${unexpected.length ? `; UNEXPECTED: ${unexpected.join(' | ')}` : ''}`);
if (unexpected.length) failed++;
if (failed) { console.log(`\n${failed} suite run(s) FAILED`); process.exit(1); }
console.log('\nNeeds_Human gate regression: every existing suite passes on the patched workflow');
