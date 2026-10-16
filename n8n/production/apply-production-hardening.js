// Production hardening of the integrated FlowHQ workflow.
//   node n8n/production/apply-production-hardening.js --in <workflow.json> [--out <file>] [--report <file>]
// Pipeline: existing patchers (n8n/integrated/apply-*.js, fingerprint-checked) -> steps/NN-*.js (anchor-checked). Anything unexpected = nothing is written.
// The input may be the private upload or the redacted copy; the output never contains a secret (steps replace every secret with $env expressions)
// and is inactive. Run it again on the same input and you get byte-identical output.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { Ctx } = require('./lib');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-production.json'));
const REPORT = arg('--report', path.join(__dirname, 'audit', 'changes.generated.json'));
if (!IN) { console.error('usage: node apply-production-hardening.js --in <workflow.json> [--out file] [--report file]'); process.exit(1); }
const fail = (m) => { console.error(`apply-production-hardening: ${m}\nNothing was written.`); process.exit(1); };

const WORK = path.join(__dirname, '.work');
fs.mkdirSync(WORK, { recursive: true });
const INTEGRATED = path.join(__dirname, '..', 'integrated');

// existing, tested patchers that are part of the production chain
const PRE = [
  { name: 'W2 Meta signature check (enforce)', script: 'apply-w2-signature.js', extra: ['--mode', 'enforce', '--keep-private'] },
];
let current = IN;
PRE.forEach((p, i) => {
  const out = path.join(WORK, `pre-${i + 1}.json`);
  const r = cp.spawnSync(process.execPath, [path.join(INTEGRATED, p.script), '--in', current, '--out', out, ...p.extra], { encoding: 'utf8' });
  if (r.status !== 0) fail(`patcher "${p.name}" refused: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`);
  current = out;
});

const wf = JSON.parse(fs.readFileSync(current, 'utf8'));
const ctx = new Ctx(wf);
const steps = fs.readdirSync(path.join(__dirname, 'steps')).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
const summary = [];
try {
  for (const f of steps) {
    const step = require(path.join(__dirname, 'steps', f));
    const before = wf.nodes.length;
    step.run(ctx);
    summary.push({ step: step.id, title: step.title, nodes_before: before, nodes_after: wf.nodes.length });
  }
} catch (e) { fail(`${e.message}`); }

// connection sanity: every connection endpoint exists
const names = new Set(wf.nodes.map((n) => n.name));
if (names.size !== wf.nodes.length) fail('duplicate node names after hardening');
for (const [from, v] of Object.entries(wf.connections)) {
  if (!names.has(from)) fail(`connection from missing node "${from}"`);
  for (const out of v.main || []) for (const t of out || []) if (!names.has(t.node)) fail(`"${from}" connects to missing node "${t.node}"`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(wf, null, 2)}\n`);
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, `${JSON.stringify({ input_nodes: JSON.parse(fs.readFileSync(IN, 'utf8')).nodes.length, output_nodes: wf.nodes.length, steps: summary, changes: ctx.changes }, null, 2)}\n`);
console.log(`wrote ${OUT}: ${wf.nodes.length} nodes, active = ${wf.active}, id ${wf.id}`);
for (const s of summary) console.log(`  step ${s.step}: ${s.title} (${s.nodes_before} -> ${s.nodes_after} nodes)`);
console.log(`change log: ${REPORT} (${ctx.changes.length} entries)`);
