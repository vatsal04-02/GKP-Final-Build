// Before / after proof for apply-ai-context.js: compares the patched workflow with your export.
//   node n8n/integrated/validate-ai-context.js [--orig <export.json>] [--patched <file>] [--private]
// Defaults: the redacted export in source/ and the public ai-updated-workflow-clinic.ai-context.json. --private = your own pair
// (then it also proves every secret value is byte-identical, never a placeholder).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json'));
const REPO = path.join(__dirname, '..', '..');
const SCHEMA = fs.readFileSync(path.join(REPO, 'grist/schema.md'), 'utf8');
const LC_SRC = fs.readFileSync(path.join(REPO, 'n8n/snippets/lead-context.js'), 'utf8');
const LC_BODY = LC_SRC.slice(LC_SRC.indexOf('const LC_STAGE_RANK'), LC_SRC.indexOf('if (typeof module'));

const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const NEW = 'W5 – Conversations';
const CHANGED = ['W3 – Find due', 'W3 – Build Message', 'W4 – Plan appointment', 'W5 – Find due', 'W6 – Plan follow-ups'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const edges = (wf) => {
  const s = [];
  for (const [from, o] of Object.entries(wf.connections)) for (const [type, outs] of Object.entries(o)) outs.forEach((list, i) => (list || []).forEach((c) => s.push(`${from} [${type} ${i}] -> ${c.node} [${c.type} ${c.index}]`)));
  return s.sort();
};
const COUNTS = {};
let failed = 0;
const group = (title, fn) => {
  try { const d = fn(); console.log(`PASS  ${title}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${title}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };

group('1. the patcher reproduces this file from the export', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-'));
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-ai-context.js'), '--in', ORIG, '--out', out, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, `a fresh run gives a different file or fails: ${r.stderr}`);
});

group('2. nodes: 1 added, 0 removed', () => {
  const added = Object.keys(B).filter((n) => !A[n]);
  const removed = Object.keys(A).filter((n) => !B[n]);
  COUNTS.added = added; COUNTS.removed = removed;
  must(same(added, [NEW]) && removed.length === 0, `added ${added} / removed ${removed}`);
  must(new Set(patched.nodes.map((n) => n.id)).size === patched.nodes.length, 'duplicate node ids');
  return `${orig.nodes.length} -> ${patched.nodes.length}`;
});

group(`3. modified nodes: exactly ${CHANGED.length}, code only; every other node byte-identical`, () => {
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n]));
  COUNTS.modified = changed;
  must(same(changed.sort(), [...CHANGED].sort()), `changed: ${changed.join(', ')}`);
  for (const n of CHANGED) {
    const a = JSON.parse(JSON.stringify(A[n])); const b = JSON.parse(JSON.stringify(B[n]));
    delete a.parameters.jsCode; delete b.parameters.jsCode;
    must(same(a, b), `${n}: more than its code changed`);
  }
  return `${orig.nodes.length - CHANGED.length} identical`;
});

group('4. connections: only W5 – Leads -> W5 – Conversations -> W5 – Find due', () => {
  const a = edges(orig); const b = edges(patched);
  COUNTS.edgesRemoved = a.filter((e) => !b.includes(e)); COUNTS.edgesAdded = b.filter((e) => !a.includes(e));
  must(same(COUNTS.edgesRemoved, ['W5 – Leads [main 0] -> W5 – Find due [main 0]']), `removed ${COUNTS.edgesRemoved}`);
  must(same(COUNTS.edgesAdded.sort(), ['W5 – Conversations [main 0] -> W5 – Find due [main 0]', 'W5 – Leads [main 0] -> W5 – Conversations [main 0]']), `added ${COUNTS.edgesAdded}`);
  return `${a.length - 1} of ${a.length} identical`;
});

group('5. CREDENTIALS changed = 0: every node keeps its credential references; none added; the new node reuses W5 – Leads\'', () => {
  let changed = 0;
  for (const n of Object.keys(A)) if (!same(A[n].credentials, B[n].credentials)) changed++;
  const set = (wf) => [...new Set(wf.nodes.flatMap((n) => Object.entries(n.credentials || {}).map(([t, c]) => `${t}:${c.id}:${c.name}`)))].sort();
  must(changed === 0 && same(set(orig), set(patched)), `${changed} node(s) changed credentials`);
  must(same(B[NEW].credentials, A['W5 – Leads'].credentials), 'new node credential');
  COUNTS.credentialsChanged = changed;
  return `credentials changed: 0 (${set(patched).length} references, same set)`;
});

group('6. WEBHOOKS changed = 0: every webhook / trigger node byte-identical (path, webhook id, method, auth, response)', () => {
  const hooks = orig.nodes.filter((n) => /webhook|Trigger|respondToWebhook/i.test(n.type));
  const changed = hooks.filter((n) => !same(n, B[n.name]));
  must(changed.length === 0, `changed: ${changed.map((n) => n.name)}`);
  must(!patched.nodes.some((n) => !A[n.name] && /webhook|Trigger/i.test(n.type)), 'a new webhook / trigger');
  COUNTS.webhooksChanged = 0;
  return `webhooks changed: 0 (${hooks.length} webhook / trigger / respond nodes, ${hooks.filter((n) => n.type.endsWith('.webhook')).map((n) => n.parameters.path).join(', ')})`;
});

group('7. SECRETS changed = 0: every Config value, the W12 test input and the W11 settings byte-identical', () => {
  const sets = orig.nodes.filter((n) => n.type === 'n8n-nodes-base.set');
  let values = 0; let changed = 0;
  for (const n of sets) for (const a of n.parameters.assignments.assignments) { values++; const b = B[n.name].parameters.assignments.assignments.find((x) => x.id === a.id); if (!same(a, b)) changed++; }
  for (const n of ['W12 – Test input', 'W11 – Telegram alert', 'W12 – Meta send', 'W13 – Ask Model']) must(same(A[n], B[n]), `${n} changed`);
  must(changed === 0, `${changed} value(s) changed`);
  if (PRIVATE) {
    const val = (wf, node, key) => wf.nodes.find((x) => x.name === node).parameters.assignments.assignments.find((a) => a.name === key).value;
    for (const [node, key] of [['W4 – Config', 'cal_webhook_secret'], ['W2 – Verify Config', 'meta_verify_token'], ['W12 – Config', 'w12_allowlist'], ['W3 – Config', 'test_phone']]) {
      must(!String(val(patched, node, key)).startsWith('PASTE_'), `${node} > ${key} is a placeholder in your file`);
      must(val(patched, node, key) === val(orig, node, key), `${node} > ${key} differs`);
    }
  }
  COUNTS.secretsChanged = changed;
  return `secrets changed: 0 (${values} Config values in ${sets.length} Set nodes compared${PRIVATE ? '; your real values present, not placeholders' : ''})`;
});

group('8. W12 is still the only WhatsApp sender; no new Execute Workflow node; the new code calls nothing outside Grist', () => {
  const meta = (wf) => wf.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta(orig), meta(patched)) && same(meta(patched), ['W12 – Prepare request', 'W12 – Read reply']), `Meta: ${meta(patched)}`);
  for (const n of meta(orig)) must(same(A[n], B[n]), `${n} changed`);
  const exec = (wf) => wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow').map((n) => JSON.stringify(n)).sort();
  must(same(exec(orig), exec(patched)), 'Execute Workflow nodes changed');
  for (const n of [...CHANGED, NEW]) must(!/graph\.facebook|openrouter|anthropic|\$http|fetch\(|helpers\.httpRequest|executeWorkflow/i.test(JSON.stringify(B[n].parameters)), `${n} calls out`);
  must(/\/tables\/Conversations\/records$/.test(B[NEW].parameters.url) && !B[NEW].parameters.method && B[NEW].onError === 'continueRegularOutput', 'new node: Grist GET Conversations, continue on error');
});

group('9. the AI layer is untouched: OpenRouter + openai/gpt-4o-mini, all 44 W13 nodes identical, no new model call', () => {
  const w13 = orig.nodes.filter((n) => n.name.startsWith('W13 – '));
  must(w13.every((n) => same(n, B[n.name])), 'a W13 node changed');
  const cfg = B['W13 – Config'].parameters.assignments.assignments;
  must(cfg.find((a) => a.name === 'model_provider').value === 'openrouter' && cfg.find((a) => a.name === 'openrouter_model').value === 'openai/gpt-4o-mini', 'provider / model');
  const ai = (wf) => wf.nodes.filter((n) => /openrouter\.ai|anthropic\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name);
  must(same(ai(orig), ai(patched)) && same(ai(patched), ['W13 – Ask Model']), `AI callers: ${ai(patched)}`);
  return `${w13.length} W13 nodes identical; model calls per message: 1 (W13 – Ask Model), as before`;
});

group('10. the lead-context module is pasted verbatim into W3 – Find due, W5 – Find due, W6 – Plan follow-ups', () => {
  for (const n of ['W3 – Find due', 'W5 – Find due', 'W6 – Plan follow-ups']) must(B[n].parameters.jsCode.startsWith(`// Pasted from n8n/snippets/lead-context.js - keep identical.\n${LC_BODY}`), `${n}: not verbatim`);
});

group('11. SCHEMA changed = 0: no table or column added; every column the new code reads exists in grist/schema.md', () => {
  const code = [...CHANGED].map((n) => B[n].parameters.jsCode).join('\n');
  const used = [...new Set([...code.matchAll(/\b(?:f|fields|lead|c)\.([A-Z][A-Za-z0-9_]+)/g)].map((m) => m[1]))];
  for (const c of used) must(new RegExp(`\\b${c}\\b`).test(SCHEMA), `${c} is not in schema.md`);
  for (const t of ['LEADS', 'Appointments', 'Conversations', 'Run_Log']) must(new RegExp(`tables/${t}/|table: '${t}'|tables/\\{\\{ \\$json.table`).test(JSON.stringify(patched)) || t === 'Run_Log', `table ${t}`);
  COUNTS.schemaChanged = 0;
  return `columns read: ${used.sort().join(', ')}`;
});

group('12. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'nodeGroups', 'versionId']) must(same(orig[k], patched[k]), `${k} changed`);
  must(patched.active === false, 'active');
  return `"${patched.name}", active = false (your export had active = ${orig.active})`;
});

group(`13. ${PRIVATE ? 'private copy: no placeholder added (only the ones already in your code, e.g. the W2 guard that refuses one)' : 'public copy: the Meta verify token, Cal.com secret and allowlisted number are placeholders'}`, () => {
  const txt = JSON.stringify(patched);
  const count = (t) => (t.match(/PASTE_(CAL|META|YOUR)[A-Z_]*/g) || []).length;
  if (PRIVATE) must(count(txt) === count(JSON.stringify(orig)), `placeholders: ${count(JSON.stringify(orig))} in your export, ${count(txt)} now`);
  else must(/PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT/.test(txt) && /PASTE_META_WEBHOOK_VERIFY_TOKEN/.test(txt) && /PASTE_YOUR_TEST_NUMBER/.test(txt), 'placeholders');
  must(!/sk-or-v1-|sk-ant-|EAA[A-Za-z0-9]{20}/.test(txt), 'an API key or Meta token is in the file');
});

console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED (${path.basename(PATCHED)})` : `\nALL 13 CHECK GROUPS PASSED (${path.basename(PATCHED)})`);
if (args.includes('--json')) console.log(JSON.stringify(COUNTS));
process.exit(failed ? 1 : 0);
