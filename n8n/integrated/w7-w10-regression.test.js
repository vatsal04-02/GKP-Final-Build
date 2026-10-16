// Regression for W7-W10: every existing end-to-end suite, unchanged, on the workflow after apply-w7-w10.js
// (ai-updated-workflow-clinic.w7-w10.json): W2 -> W13 -> W12 with its mutations, the 25 W1/W3/W4/W5/W6/W11/W12 scenarios, the
// 83-check system test with its 15 mutations, the 7 Needs_Human cases, and the A1-A6 suite (only its 2 known, earlier differences).
// Run: node n8n/integrated/w7-w10-regression.test.js      (W7W10_FILE = another file, e.g. your private one)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { redact } = require('./redact');

const FILE = process.env.W7W10_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json');
const SOURCE = path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json');
const PRE_A1 = path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json');
const PRE_GATE = path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json');
const KNOWN_A1_A6 = ['A5 W6 day-2 follow-up', 'A6 W3 message'];   // replaced on purpose by apply-ai-context.js (see AI-CONTEXT-REPORT.md)
// existing-modules.test.js checks the file "as committed" (placeholders for the Cal.com secret and the test number). Your own file
// keeps your values, so that suite gets its redacted form; every other suite runs on your file as it is. Nothing is printed but
// pass / fail lines (no assertion details: they could quote one of your values).
const changed = [];
const redacted = redact(JSON.parse(fs.readFileSync(FILE, 'utf8')), changed);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w7w10-reg-'));
const AS_COMMITTED = changed.length ? path.join(tmp, 'redacted.json') : FILE;
if (changed.length) fs.writeFileSync(AS_COMMITTED, JSON.stringify(redacted));
const sh = (file, env) => spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: { ...process.env, ...env } });
const last = (r) => (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
let failed = 0;
for (const [suite, env] of [
  ['integrated.test.js', { INTEGRATED_FILE: FILE }],
  ['existing-modules.test.js', { INTEGRATED_FILE: AS_COMMITTED }],
  ['system.test.js', { AI_CTX_FILE: FILE, AI_CTX_ORIG: SOURCE }],
  ['ai-context-mutations.test.js', { AI_CTX_FILE: FILE, AI_CTX_ORIG: SOURCE }],
  ['handoff-gate.test.js', { HANDOFF_FILE: FILE, HANDOFF_ORIG: PRE_GATE }],
]) {
  const r = sh(suite, env);
  console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'}  ${suite.padEnd(30)} ${last(r).trim()}`);
  if (r.status !== 0) { failed++; console.log((r.stdout || '').split('\n').filter((l) => /^(FAIL|\s+FAIL)/.test(l)).map((l) => l.slice(0, 70)).slice(0, 5).join('\n')); }
}
const r = sh('ai-os.test.js', { AI_OS_FILE: FILE, AI_OS_ORIG: PRE_A1, AI_OS_NO_MUTATIONS: '1' });
const fails = (r.stdout.match(/^ {2}FAIL (.+)$/gm) || []).map((l) => l.replace(/^ {2}FAIL /, ''));
const unexpected = fails.filter((f) => !KNOWN_A1_A6.some((k) => f.startsWith(k)));
console.log(`  ${unexpected.length ? 'FAIL' : 'ok  '}  ${'ai-os.test.js (A1-A6)'.padEnd(30)} ${14 - fails.length} of 14 groups pass; ${fails.length} known earlier change(s)${unexpected.length ? `; UNEXPECTED: ${unexpected.join(' | ')}` : ''}`);
if (unexpected.length) failed++;
fs.rmSync(tmp, { recursive: true, force: true });
if (changed.length) console.log(`  (existing-modules.test.js ran on the redacted form of your file: ${changed.length} value(s) replaced by placeholders, in a temp copy)`);
if (failed) { console.log(`\n${failed} suite run(s) FAILED`); process.exit(1); }
console.log('\nW7-W10 regression: every existing suite passes on the workflow with W7-W10');
