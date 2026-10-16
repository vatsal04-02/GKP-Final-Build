// Regression: the existing suites, unchanged, on your export (BEFORE) and on the patched workflow (AFTER).
//   integrated.test.js (W2 -> W13 -> W12, 18 groups + 10 mutations) and existing-modules.test.js (25 W1/W3/W4/W5/W6/W11/W12
//   scenarios) must pass on both. ai-os.test.js (A1-A6) must pass on BEFORE; on AFTER exactly the two groups whose behaviour this
//   change replaces on purpose may differ (listed below), and nothing else.
// Run: node n8n/integrated/ai-context-regression.test.js      (AI_CTX_FILE / AI_CTX_ORIG = other files)
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = {
  before: process.env.AI_CTX_ORIG || path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json'),
  after: process.env.AI_CTX_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json'),
};
const PRE_A1 = path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json');   // the A1-A6 suite's own "original"
const INTENDED = {
  'A5 W6 day-2 follow-up: skips Needs_Human / cold / not interested / call-back planned / wrote in 48 h; legacy leads as before; rebook unchanged':
    'A5 kept the no-show rebook for a Needs_Human lead; now a rebook waits while a person owns the conversation',
  'A6 W3 message: AI_Summary (else Enquiry) and the stage in the existing staff message; one line; template params keep their keys':
    'the A6 staff text is replaced by the staff brief (who / what / last contact / how hot / next step)',
};
const sh = (file, env) => spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: { ...process.env, ...env } });
const last = (r) => (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
let failed = 0;
for (const [label, file] of Object.entries(FILES)) {
  for (const suite of ['integrated.test.js', 'existing-modules.test.js']) {
    const r = sh(suite, { INTEGRATED_FILE: file, INTEGRATED_LEGACY_NEEDS_HUMAN: '1' });   // both files predate the Needs_Human gate fix
    console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'}  ${label.padEnd(6)} ${suite.padEnd(26)} ${last(r).trim()}`);
    if (r.status !== 0) failed++;
  }
  const r = sh('ai-os.test.js', { AI_OS_FILE: file, AI_OS_ORIG: PRE_A1, AI_OS_NO_MUTATIONS: label === 'after' ? '1' : '' });
  const fails = (r.stdout.match(/^ {2}FAIL (.+)$/gm) || []).map((l) => l.replace(/^ {2}FAIL /, ''));
  if (label === 'before') {
    console.log(`  ${r.status === 0 ? 'ok  ' : 'FAIL'}  before ai-os.test.js (A1-A6)        ${last(r).trim()}`);
    if (r.status !== 0) failed++;
  } else {
    const unexpected = fails.filter((f) => !INTENDED[f]);
    const groups = Number((r.stdout.match(/^ {2}(ok|FAIL) /gm) || []).length);
    console.log(`  ${unexpected.length ? 'FAIL' : 'ok  '}  after  ai-os.test.js (A1-A6)        ${groups - fails.length} of ${groups} groups unchanged; ${fails.length} intended change(s)`);
    for (const f of fails) console.log(`          ${INTENDED[f] ? 'intended' : 'UNEXPECTED'}: ${f.slice(0, 60)}… -> ${INTENDED[f] || 'not an intended change'}`);
    if (unexpected.length || fails.length !== Object.keys(INTENDED).length) failed++;
  }
}
if (failed) { console.log(`\n${failed} regression run(s) FAILED`); process.exit(1); }
console.log('\nAI context regression: existing suites pass before and after; only the 2 intended A5 / A6 differences');
