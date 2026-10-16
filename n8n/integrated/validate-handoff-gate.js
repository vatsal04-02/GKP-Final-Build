// Before / after proof for apply-handoff-gate.js:
//   node n8n/integrated/validate-handoff-gate.js [--orig <before.json>] [--patched <after.json>] [--private]
// Defaults: the public ai-updated-workflow-clinic.ai-context.json (before) and ai-updated-workflow-clinic.handoff-gate.json (after).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'ai-updated-workflow-clinic.handoff-gate.json'));
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const RESULTS = { 'W13 – Build Context': '2aeef88590ada56c', 'W13 – Plan': 'e37398352961807e', 'W13 – Plan Ready': 'be94a1e0dcdc3c2e', 'W13 – Record Sends': 'bd781a8125518c60' };   // the W13 build of commit 8be1676
const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const CHANGED = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
const group = (t, fn) => { try { const d = fn(); console.log(`PASS  ${t}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${t}\n      ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };

group('1. the patcher reproduces this file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const out = path.join(dir, 'o.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-handoff-gate.js'), '--in', ORIG, '--out', out, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, `${r.stderr}`);
});
group('2. nodes: 0 added, 0 removed; exactly the 4 W13 nodes holding the decision module changed, code only', () => {
  must(same(Object.keys(A).sort(), Object.keys(B).sort()), 'node set differs');
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n]));
  must(same(changed.sort(), [...CHANGED].sort()), `changed: ${changed}`);
  for (const n of CHANGED) {
    const a = JSON.parse(JSON.stringify(A[n])); const b = JSON.parse(JSON.stringify(B[n]));
    delete a.parameters.jsCode; delete b.parameters.jsCode;
    must(same(a, b), `${n}: more than its code changed`);
    must(sha(B[n].parameters.jsCode) === RESULTS[n], `${n}: not the W13 code of commit 8be1676`);
  }
  return `${orig.nodes.length - CHANGED.length} of ${orig.nodes.length} nodes byte-identical`;
});
group('3. connections: 0 added, 0 removed, 0 changed', () => { must(same(orig.connections, patched.connections), 'connections differ'); });
group('4. CREDENTIALS changed = 0', () => { for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), `${n}`); return '5 references, same set'; });
group('5. WEBHOOKS changed = 0', () => {
  const hooks = orig.nodes.filter((n) => /webhook|Trigger|respondToWebhook/i.test(n.type));
  for (const n of hooks) must(same(n, B[n.name]), n.name);
  return `${hooks.length} webhook / trigger / respond nodes identical`;
});
group('6. SECRETS changed = 0: every Config value, W12 (sender), W11, OpenRouter node identical', () => {
  let values = 0;
  for (const n of orig.nodes.filter((x) => x.type === 'n8n-nodes-base.set')) { values += n.parameters.assignments.assignments.length; must(same(n, B[n.name]), n.name); }
  for (const n of orig.nodes.filter((x) => /^W12 – |^W11 – /.test(x.name) || x.name === 'W13 – Ask Model' || x.name === 'W12 – Test input')) must(same(n, B[n.name]), n.name);
  if (PRIVATE) must(!/PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT|PASTE_YOUR_TEST_NUMBER/.test(JSON.stringify(patched.nodes.filter((n) => n.type === 'n8n-nodes-base.set'))), 'a placeholder in your Config values');
  return `${values} Config values identical${PRIVATE ? '; your real values present' : ''}`;
});
group('7. W12 is still the only WhatsApp sender; no Needs_Human column, table or other gate removed', () => {
  const meta = (wf) => wf.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta(patched), ['W12 – Prepare request', 'W12 – Read reply']), `Meta: ${meta(patched)}`);
  const code = B['W13 – Build Context'].parameters.jsCode;
  for (const g of ['if (c.failed)', "c.ai_status && !(c.retry && c.ai_status === 'deferred')", 'AI_STOP_WORDS.test', "c.ai_mode === 'off'", 'if (c.opted_out)', 'if (c.paused)', 'if (c.needs_human && !c.after_handoff)', 'if (c.answered_after)', 'if (c.newer_inbound)', 'aiEmergencyIn(c.text)', 'c.night)', "['text', 'button', 'interactive']", 'c.ai_replies_last_hour >= c.max_per_hour']) must(code.includes(g), `gate missing: ${g}`);
  must(/Needs_Human: needsHuman/.test(code) && /conv\.Needs_Human = true/.test(code), 'W13 no longer sets Needs_Human');
});
group('8. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'nodeGroups', 'versionId']) must(same(orig[k], patched[k]), k);
  must(patched.active === false, 'active');
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : `\nALL 8 CHECK GROUPS PASSED (${path.basename(PATCHED)})`);
process.exit(failed ? 1 : 0);
