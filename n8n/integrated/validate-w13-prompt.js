// Before / after proof for apply-w13-prompt.js: ONLY the pasted ai-receptionist.js block in 4 W13 Code nodes changed.
//   node n8n/integrated/validate-w13-prompt.js [--orig <export.json>] [--patched <patched.json>] [--private]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'source', 'ai-updated-workflow-clinic.final-v1.redacted.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'clinic-autopilot-master-ai.json'));
const RELEASE = path.join(__dirname, 'ai-updated-workflow-clinic.w13-v2.2.json');   // the named release copy of the master
const A = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const B = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const byName = (w) => Object.fromEntries(w.nodes.map((n) => [n.name, n]));
const NA = byName(A); const NB = byName(B);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CHANGED = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const SNIP = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'ai-receptionist.js'), 'utf8');
const NEW_BLOCK = SNIP.slice(SNIP.indexOf('const AI_INTENTS'), SNIP.indexOf('if (typeof module'));

let failed = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
const group = (title, fn) => { try { const why = fn(); console.log(`ok    ${title}${why ? `  (${why})` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${title}\n      ${e.message}`); } };

group('1. the patcher reproduces this file from the export', () => {
  const out = path.join(os.tmpdir(), `w13-prompt-${process.pid}.json`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-w13-prompt.js'), '--in', ORIG, '--out', out, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  must(r.status === 0, `apply-w13-prompt.js failed: ${r.stdout}${r.stderr}`);
  const again = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out);
  must(again === fs.readFileSync(PATCHED, 'utf8'), 'the committed file is not what the patcher makes');
});
group('2. nodes: 0 added, 0 removed; every node keeps its id, type, version, position, credentials and settings', () => {
  must(A.nodes.length === B.nodes.length, `${A.nodes.length} -> ${B.nodes.length} nodes`);
  for (const n of A.nodes) {
    const m = NB[n.name];
    must(m, `${n.name} removed`);
    for (const k of ['id', 'type', 'typeVersion', 'position', 'credentials', 'disabled', 'onError', 'retryOnFail', 'alwaysOutputData', 'executeOnce', 'webhookId']) must(same(n[k], m[k]), `${n.name}: ${k} changed`);
  }
  return `${A.nodes.length} nodes`;
});
group('3. connections, workflow settings and static data identical; written inactive', () => {
  must(same(A.connections, B.connections), 'connections changed');
  for (const k of ['settings', 'staticData', 'pinData', 'name']) must(same(A[k], B[k]), `${k} changed`);
  must(B.active === false, 'active must be false (import inactive, activate in n8n yourself)');
  return `${Object.keys(A.connections).length} connection sources; active = false (your export had active = ${A.active})`;
});
group('4. exactly the 4 W13 Code nodes changed, each only by the pasted ai-receptionist.js block', () => {
  const diff = A.nodes.filter((n) => !same(n, NB[n.name])).map((n) => n.name);
  must(same(diff.sort(), [...CHANGED].sort()), `changed: ${diff.join(', ')}`);
  for (const name of CHANGED) {
    const a = NA[name].parameters.jsCode; const b = NB[name].parameters.jsCode;
    const s = a.indexOf('const AI_INTENTS');
    must(b.slice(0, s) === a.slice(0, s), `${name}: code before the block changed`);
    must(b.slice(s, s + NEW_BLOCK.length) === NEW_BLOCK, `${name}: the block is not the current snippet`);
    const restA = a.slice(a.indexOf('\nconst h = { normalizeIndianPhone', s)); const restB = b.slice(b.indexOf('\nconst h = { normalizeIndianPhone', s));
    must(restA === restB, `${name}: code after the block changed`);
    const pa = JSON.parse(JSON.stringify(NA[name].parameters)); const pb = JSON.parse(JSON.stringify(NB[name].parameters)); delete pa.jsCode; delete pb.jsCode;
    must(same(pa, pb), `${name}: a parameter other than the code changed`);
    new Function('$', '$input', '$json', '$getWorkflowStaticData', b);   // compiles
  }
  return 'code before and after the block byte-identical; each node compiles';
});
group('5. quiet-hours test switch untouched (same value in the same 7 nodes)', () => {
  const sw = (w) => w.nodes.filter((n) => /DISABLE_QUIET_HOURS_FOR_TEST = (true|false)/.test((n.parameters || {}).jsCode || '')).map((n) => `${n.name}=${n.parameters.jsCode.match(/DISABLE_QUIET_HOURS_FOR_TEST = (true|false)/)[1]}`);
  must(same(sw(A), sw(B)), `${sw(A)} -> ${sw(B)}`);
  return sw(A).length ? `${sw(A).length} nodes, value ${sw(A)[0].split('=')[1]}` : 'no switch in this file';
});
group('6. model, Config, webhooks, W12 (only sender), W10 (staff replies), W11 and every other section untouched', () => {
  for (const n of A.nodes.filter((x) => !CHANGED.includes(x.name))) must(same(n, NB[n.name]), `${n.name} changed`);
  const models = (w) => w.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest' && /openrouter\.ai|anthropic\.com/.test(String(n.parameters.url))).map((n) => n.name);
  must(same(models(A), models(B)), 'model calls changed');
  const cfg = (w) => (w.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((x) => x.name === 'openrouter_model') || {}).value;
  must(cfg(A) === cfg(B), 'model id changed');
  return `model calls: ${models(B).join(', ')}; W13 model "${cfg(B)}" unchanged`;
});
group('7. nothing secret or placeholder-like added', () => {
  const pat = /sk-or-[A-Za-z0-9]|sk-ant-|Bearer [A-Za-z0-9]{12}|EAA[A-Za-z0-9]{20}|PASTE_|REPLACE_|YOUR_API_KEY/g;
  const count = (w) => (JSON.stringify(w).match(pat) || []).length;
  must(count(B) === count(A), `${count(A)} -> ${count(B)}`);
  return `${count(A)} existing placeholder/marker strings, unchanged`;
});
if (!args.includes('--patched')) group('8. the release copy ai-updated-workflow-clinic.w13-v2.2.json is byte-identical to the master', () => {
  must(fs.existsSync(RELEASE), 'release copy missing');
  must(fs.readFileSync(RELEASE, 'utf8') === fs.readFileSync(PATCHED, 'utf8'), 'release copy differs from clinic-autopilot-master-ai.json');
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : '\nW13 prompt v2.2: only the 4 pasted ai-receptionist.js blocks changed; all check groups pass');
process.exit(failed ? 1 : 0);
