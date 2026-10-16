// Proves that apply-ai-os.js changed ONLY what A1-A6 needs in your workflow, by comparing it with your export:
//   node n8n/integrated/validate-ai-os.js [--orig <export.json>] [--patched <file>] [--private]
// Defaults: the redacted export in source/ and the public ai-workflow-clinic.ai-os.json. --private = your own (unredacted) pair.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'ai-workflow-clinic.ai-os.json'));
const REPO = path.join(__dirname, '..', '..');
const DEMO = JSON.parse(fs.readFileSync(path.join(REPO, 'n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json'), 'utf8'));
const SCHEMA = fs.readFileSync(path.join(REPO, 'grist/schema.md'), 'utf8');

const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const NEW = 'W3 – Conversations';
const W13_CODE = ['W13 – Start', 'W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const CHANGED = [...W13_CODE, 'W13 – Config', 'W3 – Find due', 'W3 – Build Message', 'W6 – Plan follow-ups'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const without = (n, key) => { const c = JSON.parse(JSON.stringify(n)); const [k1, k2] = key.split('.'); if (k2) delete c[k1][k2]; else delete c[k1]; return c; };
const edges = (wf) => {
  const s = [];
  for (const [from, o] of Object.entries(wf.connections)) for (const [type, outs] of Object.entries(o)) outs.forEach((list, i) => (list || []).forEach((c) => s.push(`${from} [${type} ${i}] -> ${c.node} [${c.type} ${c.index}]`)));
  return s.sort();
};

let failed = 0;
const group = (title, fn) => {
  try { const detail = fn(); console.log(`PASS  ${title}${detail ? ` — ${detail}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${title}\n      ${e.message}`); }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

group('1. the patcher reproduces this file from the export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-os-'));
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-ai-os.js'), '--in', ORIG, '--out', out, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  must(r.status === 0, `apply-ai-os.js failed: ${r.stdout}${r.stderr}`);
  const same2 = fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(same2, 'a fresh run gives a different file');
});

group('2. nodes: 1 added, 0 removed', () => {
  const added = Object.keys(B).filter((n) => !A[n]);
  const removed = Object.keys(A).filter((n) => !B[n]);
  must(same(added, [NEW]), `added: ${added.join(', ')}`);
  must(removed.length === 0, `removed: ${removed.join(', ')}`);
  must(patched.nodes.length === orig.nodes.length + 1, 'node count');
  const ids = patched.nodes.map((n) => n.id);
  must(new Set(ids).size === ids.length, 'duplicate node ids');
  return `${orig.nodes.length} -> ${patched.nodes.length} (added: ${NEW})`;
});

group(`3. changed nodes: exactly ${CHANGED.length}, and only their code / Config values; every other node byte-identical`, () => {
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n]));
  must(same(changed.sort(), [...CHANGED].sort()), `changed: ${changed.join(', ')}`);
  for (const n of CHANGED) {
    const key = n === 'W13 – Config' ? 'parameters.assignments' : 'parameters.jsCode';
    must(same(without(A[n], key), without(B[n], key)), `${n}: something other than ${key} changed (id, position, type, settings...)`);
  }
  return `${orig.nodes.length - CHANGED.length} nodes identical`;
});

group('4. SECTION W13: the code is the rebuilt OpenRouter W13; Config: only the confidence values', () => {
  for (const n of W13_CODE) must(B[n].parameters.jsCode === DEMO.nodes.find((d) => d.name === n).parameters.jsCode, `${n} differs from the W13 build`);
  const a = A['W13 – Config'].parameters.assignments.assignments;
  const b = B['W13 – Config'].parameters.assignments.assignments;
  const get = (list, k) => list.find((x) => x.name === k);
  must(get(a, 'min_confidence').value === 0.7 && get(b, 'min_confidence').value === 0.65, 'min_confidence 0.7 -> 0.65');
  must(get(b, 'confidence_auto').value === 0.8 && get(b, 'confidence_write').value === 0.85, 'confidence_auto / confidence_write');
  must(b.length === a.length + 2, 'assignment count');
  for (const x of a) must(x.name === 'min_confidence' || same(x, get(b, x.name)), `Config > ${x.name} changed`);
  for (const k of ['model_provider', 'openrouter_model', 'w12_workflow_id', 'pause_on_handoff', 'staff_alert_template']) must(same(get(a, k), get(b, k)), `Config > ${k}`);
  return 'model, provider, w12 id, templates, pause_on_handoff unchanged';
});

group('5. connections: only W3 – Leads -> W3 – Conversations -> W3 – Find due', () => {
  const a = edges(orig);
  const b = edges(patched);
  const removed = a.filter((e) => !b.includes(e));
  const added = b.filter((e) => !a.includes(e));
  must(same(removed, ['W3 – Leads [main 0] -> W3 – Find due [main 0]']), `removed: ${removed.join(' | ')}`);
  must(same(added.sort(), ['W3 – Conversations [main 0] -> W3 – Find due [main 0]', 'W3 – Leads [main 0] -> W3 – Conversations [main 0]']), `added: ${added.join(' | ')}`);
  return `${a.length - 1} of ${a.length} connections identical, 1 rerouted through the new node`;
});

group('6. credentials: none changed, none added; the new node uses W3 – Leads\' Grist credential', () => {
  for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), `${n}: credentials changed`);
  must(same(B[NEW].credentials, A['W3 – Leads'].credentials), 'new node credential');
  const ids = (wf) => [...new Set(wf.nodes.flatMap((n) => Object.values(n.credentials || {}).map((c) => `${c.id}:${c.name}`)))].sort();
  must(same(ids(orig), ids(patched)), 'credential set');
  must(!/"(apiKey|token|password|secret)"\s*:\s*"[^"=P]/.test(JSON.stringify(B[NEW])), 'no inline key');
  return `${ids(patched).length} credential references, the same as the export`;
});

group('7. the new node: Grist GET Conversations of the same clinic, errors continue (nothing skipped)', () => {
  const p = B[NEW].parameters;
  must(/^=\{\{ \$\('W3 – Add settings'\)\.item\.json\.grist_base_url \}\}\/api\/docs\/\{\{ \$\('W3 – Add settings'\)\.item\.json\.doc_id \}\}\/tables\/Conversations\/records$/.test(p.url), `url ${p.url}`);
  must(!p.method || p.method === 'GET', 'GET only');
  must(!p.sendBody && !p.jsonBody, 'no body');
  must(B[NEW].onError === 'continueRegularOutput', 'onError');
  must(B[NEW].type === 'n8n-nodes-base.httpRequest', 'type');
});

group('8. W12 stays the only WhatsApp sender; no node starts another workflow or calls Meta / an AI provider in the new code', () => {
  const meta = (n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters));
  const before = orig.nodes.filter(meta).map((n) => n.name).sort();
  const after = patched.nodes.filter(meta).map((n) => n.name).sort();
  must(same(before, after), `Meta nodes: ${after.join(', ')}`);
  for (const n of before) must(same(A[n], B[n]), `${n} changed`);
  const exec = (wf) => wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow').map((n) => JSON.stringify(n)).sort();
  must(same(exec(orig), exec(patched)), 'Execute Workflow nodes changed');
  for (const n of ['W3 – Find due', 'W3 – Build Message', 'W6 – Plan follow-ups', NEW]) {
    must(!/graph\.facebook|openrouter|anthropic|\$http|fetch\(|helpers\.httpRequest/i.test(JSON.stringify(B[n].parameters)), `${n} calls out`);
  }
  must(B['W3 – Build Message'].parameters.jsCode.includes("const template = 'hello_world';"), 'W3 template unchanged');
  return `Meta is called only by: ${after.join(', ')}`;
});

group('9. Grist: no schema change; every column the new code reads is in grist/schema.md', () => {
  const cols = ['Lead_Stage', 'AI_Summary', 'Assigned_To', 'Automation_Paused', 'Needs_Human', 'Last_Intent', 'Last_Inbound_At', 'Next_Action_At', 'Escalated', 'Enquiry'];
  for (const c of cols) must(new RegExp(`\\b${c}\\b`).test(SCHEMA), `${c} not in schema.md`);
  must(/Conversations/.test(SCHEMA), 'Conversations table');
  const code = ['W3 – Find due', 'W6 – Plan follow-ups'].map((n) => B[n].parameters.jsCode).join('\n');
  const used = [...new Set([...code.matchAll(/\b[fc]\.([A-Z][A-Za-z_]+)/g)].map((m) => m[1]))];
  for (const c of used) must(new RegExp(`\\b${c}\\b`).test(SCHEMA), `${c} (used in the code) is not in schema.md`);
  return `columns read: ${used.sort().join(', ')}`;
});

group('10. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'nodeGroups', 'versionId']) must(same(orig[k], patched[k]), `${k} changed`);
  must(patched.active === false, 'active');
  return `"${patched.name}", active = false`;
});

group(`11. ${PRIVATE ? 'private copy: your values kept' : 'public copy: verify token, Cal.com secret and allowlist are placeholders'}`, () => {
  const txt = JSON.stringify(patched);
  const get = (node, k) => ((B[node] || {}).parameters.assignments.assignments || []).find((a) => a.name === k);
  const ph = [get('W4 – Config', 'cal_webhook_secret').value === 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT', get('W2 – Verify Config', 'meta_verify_token').value === 'PASTE_META_WEBHOOK_VERIFY_TOKEN', /PASTE_YOUR_TEST_NUMBER/.test(get('W12 – Config', 'w12_allowlist').value)];
  if (PRIVATE) must(same(get('W4 – Config', 'cal_webhook_secret'), (A['W4 – Config'].parameters.assignments.assignments || []).find((a) => a.name === 'cal_webhook_secret')), 'private values changed');
  else must(ph.every(Boolean), `placeholders: ${ph}`);
  must(!/sk-or-v1-|sk-ant-|EAA[A-Za-z0-9]{20}/.test(txt), 'an API key or Meta token is in the file');
});

console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED (${path.basename(PATCHED)})` : `\nALL 11 CHECK GROUPS PASSED (${path.basename(PATCHED)})`);
process.exit(failed ? 1 : 0);
