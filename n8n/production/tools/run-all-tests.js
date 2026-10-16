#!/usr/bin/env node
// Runs every production test file and writes audit/test-results.json (read by report.js -> TEST_REPORT.md). Nothing is claimed that was not run here.
//   node tools/run-all-tests.js [--real] [--mutation] [--baseline]
//     --real      the real-n8n test (needs N8N_RUNTIME_DIR, N8N_NODE_DIR; optional MAILPIT_BIN, FAKETIME_LIB)
//     --mutation  the mutation check (slow)
//     --baseline  the repository's own suite (node n8n/tests/run-all.js, 77 files, about 2 minutes) to prove the existing behaviour is untouched
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..', '..');
const args = process.argv.slice(2);
const T = (f) => path.join(ROOT, 'tests', f);
const SUITES = [
  { id: 'static', file: T('static.test.js'), category: 'automatic', what: 'structure, secrets, credentials, webhooks, Code-node syntax, config guards' },
  { id: 'phone', file: T('phone.test.js'), category: 'automatic', what: 'E.164 normaliser and its 19 copies' },
  { id: 'ai-redact', file: path.join(ROOT, 'snippets', 'ai-redact.test.js'), category: 'automatic', what: 'privacy filter for the AI provider (pure functions)' },
  { id: 'ops', file: T('ops.test.js'), category: 'automatic', what: 'compose files (docker compose config), Caddyfile, credentials / migration / preflight / backup / restore / health scripts' },
  { id: 'w1', file: T('w1.test.js'), category: 'mocks', what: 'W1 website enquiry (simulator, fake Grist / Meta)' },
  { id: 'w2', file: T('w2.test.js'), category: 'mocks', what: 'W2 inbound + signature + AI gate + delivery receipts (simulator)' },
  { id: 'w4', file: T('w4.test.js'), category: 'mocks', what: 'W4 Cal.com bookings (simulator)' },
  { id: 'w12', file: T('w12.test.js'), category: 'mocks', what: 'W12 sender: ledger, uncertain, templates, quiet hours (simulator)' },
  { id: 'callers', file: T('callers.test.js'), category: 'mocks', what: 'W3 / W5 / W6 (simulator)' },
  { id: 'senders', file: T('senders.test.js'), category: 'mocks', what: 'W7 / W8 / W9 / W10 / W13 through the new W12 (simulator)' },
  { id: 'consent', file: T('consent.test.js'), category: 'mocks', what: 'consent gate and capture (simulator)' },
  { id: 'templates', file: T('templates.test.js'), category: 'automatic', what: 'WhatsApp template list matches W12 and the callers' },
  { id: 'email', file: T('email.test.js'), category: 'mocks', what: 'e-mail gateway (simulator)' },
  { id: 'w14', file: T('w14.test.js'), category: 'mocks', what: 'W14 reconcile + multi-clinic isolation (simulator)' },
  { id: 'website-w1', file: T('website-w1.test.js'), category: 'mocks', what: 'website enquiry -> W1 -> Grist, consent separate from the enquiry, downstream consent enforcement, simultaneous-submission guard (simulator, fake Grist/Meta/AI/SMTP)' },
];
if (args.includes('--real')) SUITES.push({ id: 'real-n8n', file: T('real/real-n8n.test.js'), category: 'real-software', what: 'the installed n8n 2.43.5 + real Mailpit + fake Grist / Meta / AI servers; real HTTP to the real webhooks' });
if (args.includes('--mutation')) SUITES.push({ id: 'mutation', file: T('mutation.test.js'), category: 'meta', what: 'the tests above must fail when the export is broken on purpose' });
const results = [];
for (const s of SUITES) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [s.file], { encoding: 'utf8', timeout: 1500000, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const mm = /(\d+)\/(\d+) mutants killed/.exec(out);
  const a = /all assertions passed/.test(out);
  const rec = { id: s.id, category: s.category, what: s.what, status: r.status === 0 ? 'pass' : r.status === 3 ? 'not-run' : 'FAIL', exit: r.status, seconds: Math.round((Date.now() - t0) / 1000), passed: m ? Number(m[1]) : mm ? Number(mm[1]) : a ? 1 : null, failed: m ? Number(m[2]) : mm ? Number(mm[2]) - Number(mm[1]) : null };
  if (rec.status === 'FAIL') rec.output_tail = out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 6);
  results.push(rec);
  console.log(`${rec.status.padEnd(7)} ${s.id.padEnd(10)} ${rec.passed === null ? '' : `${rec.passed} passed${rec.failed ? `, ${rec.failed} failed` : ''}`} (${rec.seconds}s)`);
}
let baseline = null;
if (args.includes('--baseline')) {
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(REPO, 'n8n', 'tests', 'run-all.js')], { encoding: 'utf8', timeout: 1500000, cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  baseline = { status: r.status === 0 ? 'pass' : 'FAIL', seconds: Math.round((Date.now() - t0) / 1000), summary: out.split('\n').filter((l) => /pass|fail|PASS|FAIL/.test(l)).slice(-4), files: (out.match(/PASS/g) || []).length };
  console.log(`${baseline.status.padEnd(7)} repository suite (${baseline.files} PASS lines, ${baseline.seconds}s)`);
}
const node = process.version;
const n8nV = process.env.N8N_RUNTIME_DIR ? (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.N8N_RUNTIME_DIR, 'node_modules', 'n8n', 'package.json'), 'utf8')).version; } catch (e) { return ''; } })() : '';
fs.mkdirSync(path.join(ROOT, 'audit'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'audit', 'test-results.json'), `${JSON.stringify({ run_at: new Date().toISOString(), node, n8n: n8nV, results, baseline }, null, 2)}\n`);
const failed = results.filter((r) => r.status === 'FAIL').length + (baseline && baseline.status === 'FAIL' ? 1 : 0);
console.log(failed ? `${failed} suite(s) FAILED` : 'all suites that ran passed');
process.exit(failed ? 1 : 0);
