// Proves the integrated master is your master + ONLY the intended changes, with one WhatsApp sender and no secrets.
//   node n8n/integrated/validate-integrated.js [--file <integrated.json>] [--source <master export>] [--private]
// --private: the file is your private import file (it may hold your verify token, Cal.com secret and allowlist; they must equal
// the source's). Without it, the file must hold only placeholders (public repo copy).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPO = path.join(__dirname, '..', '..');
const FILE = arg('--file', path.join(__dirname, 'clinic-autopilot-master-ai.stage1.json'));
const SOURCE = arg('--source', path.join(__dirname, 'source', 'master-export.redacted.json'));
const PRIVATE = args.includes('--private');
const T = {
  webhook: 'n8n-nodes-base.webhook', schedule: 'n8n-nodes-base.scheduleTrigger', error: 'n8n-nodes-base.errorTrigger', called: 'n8n-nodes-base.executeWorkflowTrigger',
  manual: 'n8n-nodes-base.manualTrigger', exec: 'n8n-nodes-base.executeWorkflow', sticky: 'n8n-nodes-base.stickyNote', http: 'n8n-nodes-base.httpRequest', code: 'n8n-nodes-base.code',
};
const lines = [];
let group = 0;
const check = (title, fn) => {
  group++;
  try { const d = fn(); lines.push(`PASS ${String(group).padStart(2)}. ${title}${d ? ` — ${d}` : ''}`); } catch (e) {
    lines.push(`FAIL ${String(group).padStart(2)}. ${title} — ${e.message.split('\n')[0]}`);
    console.log(lines.join('\n'));
    process.exit(1);
  }
};

const raw = fs.readFileSync(FILE, 'utf8');
const wf = JSON.parse(raw);
const src = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const demo = JSON.parse(fs.readFileSync(path.join(REPO, 'n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json'), 'utf8'));
const byName = (w) => Object.fromEntries(w.nodes.map((n) => [n.name, n]));
const N = byName(wf);
const S = byName(src);
const D = byName(demo);
const functional = (w) => w.nodes.filter((n) => n.type !== T.sticky);
const NEW_W2 = ['W2 – AI Wanted?', 'W2 – AI Job', 'W2 – Start AI Receptionist', 'W2 – AI Handed'];
const ROUTER = 'W12 – AI Job?';
const A01 = ['W12 – Prepare request', 'W12 – Read reply'];
const DROPPED = ['W13 – When Called', 'W13 – Manual Test', 'W13 – Test Messages', 'W13 – Run Each Test', 'W13 – Test Report'];
const W13 = functional(demo).filter((n) => !DROPPED.includes(n.name)).map((n) => n.name);
const PRIVATE_KEYS = [['W4 – Config', 'cal_webhook_secret'], ['W2 – Verify Config', 'meta_verify_token'], ['W12 – Config', 'w12_allowlist']];
const value = (w, n, k) => byName(w)[n].parameters.assignments.assignments.find((a) => a.name === k).value;

check('n8n workflow shape; unique node names and ids; INACTIVE; same name, id and settings as your master', () => {
  assert(Array.isArray(wf.nodes) && wf.connections && wf.settings);
  assert.strictEqual(new Set(wf.nodes.map((n) => n.name)).size, wf.nodes.length, 'duplicate node names');
  assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length, 'duplicate node ids');
  assert.strictEqual(wf.active, false, 'the integrated master must be imported inactive');
  assert.deepStrictEqual([wf.name, wf.id, wf.settings], [src.name, src.id, src.settings]);
  return `${wf.nodes.length} nodes (${functional(wf).length} functional), "${wf.name}"`;
});

check('every node of your master is unchanged (id, type, version, credentials, settings, position, parameters) except A-01 in 2 W12 nodes', () => {
  const WA = fs.readFileSync(path.join(REPO, 'n8n/snippets/wa-send.js'), 'utf8');
  const block = WA.slice(WA.indexOf('const WA_TEMPLATES'), WA.indexOf('if (typeof module'));
  let same = 0;
  for (const s of src.nodes) {
    const n = N[s.name];
    assert(n, `${s.name} is missing`);
    const a = { ...n, parameters: { ...n.parameters } };
    const b = { ...s, parameters: { ...s.parameters } };
    if (A01.includes(s.name)) {
      const code = n.parameters.jsCode;
      assert.strictEqual(code.split(block).length, 2, `${s.name} does not embed the current wa-send.js`);
      const old = s.parameters.jsCode;
      const start = old.indexOf('const WA_TEMPLATES');
      const end = old.indexOf('\n}\n\n', old.indexOf('function waInboxRow', start)) + 4;
      assert.strictEqual(code, old.slice(0, start) + block + old.slice(end), `${s.name}: something besides the wa-send.js block changed`);
      a.parameters.jsCode = b.parameters.jsCode = '';
    }
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `${s.name} changed`);   // the private file is compared with your private export, the public one with the redacted export
    same++;
  }
  return `${same - A01.length} identical, ${A01.length} differ only by the wa-send.js block (${A01.join(', ')})`;
});

check('connections of your master are unchanged except the 2 rewired outputs', () => {
  const changed = [];
  for (const [from, o] of Object.entries(src.connections)) if (JSON.stringify(wf.connections[from]) !== JSON.stringify(o)) changed.push(from);
  assert.deepStrictEqual(changed.sort(), ['W12 – When called by another workflow', 'W2 – Prepare Staff Alert'].sort());
  assert.deepStrictEqual(wf.connections['W12 – When called by another workflow'], { main: [[{ node: ROUTER, type: 'main', index: 0 }]] });
  assert.deepStrictEqual(wf.connections[ROUTER], { main: [[{ node: 'W13 – Config', type: 'main', index: 0 }], [{ node: 'W12 – Config', type: 'main', index: 0 }]] });
  assert.deepStrictEqual(wf.connections['W2 – Prepare Staff Alert'], { main: [[{ node: 'W2 – AI Wanted?', type: 'main', index: 0 }]] });
  assert.deepStrictEqual(wf.connections['W2 – AI Wanted?'], { main: [[{ node: 'W2 – AI Job', type: 'main', index: 0 }], [{ node: 'W2 – Build Run Log', type: 'main', index: 0 }]] });
  for (const [a, b] of [['W2 – AI Job', 'W2 – Start AI Receptionist'], ['W2 – Start AI Receptionist', 'W2 – AI Handed'], ['W2 – AI Handed', 'W2 – Build Run Log']]) assert.deepStrictEqual(wf.connections[a], { main: [[{ node: b, type: 'main', index: 0 }]] });
  return `${Object.keys(src.connections).length - 2} unchanged; W12 trigger -> ${ROUTER} (true W13 – Config / false W12 – Config); W2 – Prepare Staff Alert -> W2 – AI Wanted? -> AI Job -> Start AI Receptionist -> AI Handed -> W2 – Build Run Log`;
});

check('added nodes are exactly: the router, 4 W2 nodes, SECTION W13 (OpenRouter demo minus its own trigger / manual test), 2 notes', () => {
  const added = wf.nodes.filter((n) => !S[n.name]).map((n) => n.name);
  const expect = [ROUTER, ...NEW_W2, ...W13, 'W2 – Section G AI', 'Section W13'];
  assert.deepStrictEqual([...added].sort(), [...expect].sort());
  for (const d of DROPPED) assert(!N[d], `${d} must not be in the master`);
  return `${added.length} added (${W13.length} in SECTION W13)`;
});

check('SECTION W13 is the OpenRouter demo node for node (only positions and W13 – Config > w12_workflow_id = {{ $workflow.id }} differ)', () => {
  for (const name of W13) {
    const a = JSON.parse(JSON.stringify(N[name]));
    const b = JSON.parse(JSON.stringify(D[name]));
    delete a.position; delete b.position;
    if (name === 'W13 – Config') {
      const x = a.parameters.assignments.assignments.find((v) => v.name === 'w12_workflow_id');
      assert.strictEqual(x.value, '={{ $workflow.id }}');
      x.value = b.parameters.assignments.assignments.find((v) => v.name === 'w12_workflow_id').value;
    }
    assert.deepStrictEqual(a, b, `${name} differs from the demo`);
  }
  const cfg = Object.fromEntries(N['W13 – Config'].parameters.assignments.assignments.map((v) => [v.name, v.value]));
  assert.deepStrictEqual([cfg.model_provider, cfg.openrouter_model], ['openrouter', 'openai/gpt-4o-mini']);
  for (const [from, o] of Object.entries(demo.connections)) {
    if (DROPPED.includes(from)) continue;
    const kept = { main: o.main.map((outs) => (outs || []).filter((c) => !DROPPED.includes(c.node))) };
    assert.deepStrictEqual(wf.connections[from], kept, `connections of ${from}`);
  }
  return 'gates, Plan (validation + fact check), Plan Ready, Record Sends, provider layer (OpenRouter) identical; model_provider = openrouter, openrouter_model = openai/gpt-4o-mini';
});

check('entry points: ONE Execute Workflow Trigger (shared by W12 and the AI via the router), one Manual Trigger, one Error Trigger; webhooks unchanged', () => {
  const of = (t) => wf.nodes.filter((n) => n.type === t).map((n) => n.name);
  assert.deepStrictEqual(of(T.called), ['W12 – When called by another workflow']);
  assert.deepStrictEqual(of(T.manual), ['W12 – Manual test']);
  assert.deepStrictEqual(of(T.error), ['W11 – Error Trigger']);
  const hooks = (w) => w.nodes.filter((n) => n.type === T.webhook).map((n) => `${n.parameters.httpMethod || 'GET'} ${n.parameters.path} ${n.webhookId}`).sort();
  assert.deepStrictEqual(hooks(wf), hooks(src));
  assert.deepStrictEqual(of(T.schedule).sort(), [...src.nodes.filter((n) => n.type === T.schedule).map((n) => n.name), 'W13 – Every Morning'].sort());
  const cond = N[ROUTER].parameters.conditions.conditions[0].leftValue;
  assert.strictEqual(cond, '={{ $json.w13_job === true || $json.w13_retry === true }}');
  return `webhooks: ${hooks(wf).map((x) => x.split(' ').slice(0, 2).join(' ')).join(', ')}; schedules +W13 – Every Morning`;
});

check('every Execute Workflow node calls THIS workflow ($workflow.id): no external workflow, no W13 DEMO id, no Anthropic W13', () => {
  const calls = wf.nodes.filter((n) => n.type === T.exec).map((n) => [n.name, n.parameters.workflowId.value, n.parameters.options.waitForSubWorkflow !== false]);
  for (const [name, v] of calls) {
    if (name === 'W13 – Call W12') assert.strictEqual(v, "={{ $('W13 – Start').first().json.w12_workflow_id }}");
    else assert.strictEqual(v, '={{ $workflow.id }}', name);
  }
  assert(!raw.includes('s2MWUdL0DsA9bKNh'), 'the standalone W13 DEMO must not be called');
  assert(!/api\.anthropic\.com/.test(raw) && !raw.includes('"name": "Anthropic API"') && !N['W13 – Ask Claude'], 'the Anthropic W13 must not be integrated');
  assert(!N['W13 – Config'].parameters.assignments.assignments.some((v) => v.name === 'anthropic_model'), 'no Anthropic model configured');
  const start = calls.find((c) => c[0] === 'W2 – Start AI Receptionist');
  assert.strictEqual(start[2], false, 'W2 must not wait for the AI');
  return calls.map(([n, , w]) => `${n}${w ? '' : ' (no wait)'}`).join(', ');
});

check('W12 is the ONLY WhatsApp sender: one node calls Meta, with the only use of the WhatsApp credential; the AI calls only OpenRouter', () => {
  const http = wf.nodes.filter((n) => n.type === T.http);
  const meta = http.filter((n) => /graph\.facebook\.com|meta_url/.test(JSON.stringify(n.parameters)));
  assert.deepStrictEqual(meta.map((n) => [n.name, n.parameters.url]), [['W12 – Meta send', '={{ $json.prep.meta_url }}']]);
  const mentions = wf.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name);
  assert.deepStrictEqual(mentions, ['W12 – Prepare request', 'W12 – Read reply'], 'only W12 builds Meta URLs');
  assert.deepStrictEqual(wf.nodes.filter((n) => JSON.stringify(n.credentials || {}).includes('WhatsApp Cloud API')).map((n) => n.name), ['W12 – Meta send']);
  const or = http.filter((n) => /openrouter\.ai/.test(JSON.stringify(n.parameters)));
  assert.deepStrictEqual(or.map((n) => [n.name, n.credentials.httpHeaderAuth.name]), [['W13 – Ask Model', 'OpenRouter API']]);
  assert.deepStrictEqual(wf.nodes.filter((n) => JSON.stringify(n.credentials || {}).includes('OpenRouter API')).map((n) => n.name), ['W13 – Ask Model']);
  assert(!wf.nodes.some((n) => n.type === 'n8n-nodes-base.whatsApp'), 'no WhatsApp node besides W12');
  const w13Calls = wf.nodes.filter((n) => n.name.startsWith('W13 – ') && n.type === T.exec).map((n) => n.name);
  assert.deepStrictEqual(w13Calls.sort(), ['W13 – Call W12', 'W13 – Retry Each'].sort());
  return 'W12 – Meta send (WhatsApp Cloud API); W13 – Ask Model (OpenRouter API); every AI send goes W13 – Call W12 -> W12 – AI Job? (false) -> W12';
});

check('W2 hand-off: only stored messages, ONE job per message, the exact identifiers W13 – Start reads', () => {
  assert.strictEqual(N['W2 – AI Wanted?'].parameters.conditions.conditions[0].leftValue, "={{ $json.run_outcome === 'ok' && Number($json.message_row_id) > 0 && !$json.test_case }}");
  const code = N['W2 – AI Job'].parameters.jsCode;
  const keys = [...code.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.deepStrictEqual(keys, ['w13_job', 'dry_run', 'w13_retry', 'wa_phone_number_id', 'clinic_slug', 'message_row_id', 'wa_message_id', 'msg_type', 'patient_phone', 'sender_name', 'text']);
  const start = N['W13 – Start'].parameters.jsCode;
  for (const k of keys.filter((x) => x !== 'w13_job')) assert(start.includes(`j.${k}`), `W13 – Start does not read ${k}`);
  assert.deepStrictEqual([N['W2 – Start AI Receptionist'].parameters.mode, N['W2 – Start AI Receptionist'].onError], ['each', 'continueRegularOutput']);
  return keys.join(', ');
});

check('no secrets in the file; every credential is referenced by name / id only', () => {
  assert(!/sk-or-[A-Za-z0-9]|sk-ant-[A-Za-z0-9]|EAA[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9]{8,}|ts\.net/.test(raw), 'a token-like string');
  assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw), 'an email address');
  if (!PRIVATE) {
    for (const [n, k] of PRIVATE_KEYS) assert(/^PASTE_/.test(String(value(wf, n, k))), `${n} > ${k} must be a placeholder in the public copy`);
    const phones = (raw.match(/\+91\d{10}|\b91[6-9]\d{9}\b/g) || []).filter((p) => !/9000000\d\d\d$/.test(p));
    assert.deepStrictEqual(phones, [], 'only made-up numbers');
  } else {
    for (const [n, k] of PRIVATE_KEYS) assert.strictEqual(value(wf, n, k), value(src, n, k), `${n} > ${k} must equal your export`);
  }
  const creds = new Set(wf.nodes.filter((n) => n.credentials).map((n) => JSON.stringify(n.credentials)));
  return `${PRIVATE ? 'private import file: your 3 private values kept exactly as exported' : 'public copy: verify token, Cal.com secret, allowlist = placeholders'}; ${creds.size} credential references, no key values`;
});

check('every working node is reachable from a trigger (except what was already unconnected in your export)', () => {
  const triggers = functional(wf).filter((n) => [T.webhook, T.schedule, T.error, T.called, T.manual].includes(n.type)).map((n) => n.name);
  const seen = new Set(triggers);
  const q = [...triggers];
  while (q.length) for (const o of (wf.connections[q.shift()] || { main: [] }).main) for (const c of o || []) if (!seen.has(c.node)) { seen.add(c.node); q.push(c.node); }
  const unreachable = functional(wf).filter((n) => !seen.has(n.name)).map((n) => n.name);
  const srcSeen = new Set(src.nodes.filter((n) => [T.webhook, T.schedule, T.error, T.called, T.manual].includes(n.type)).map((n) => n.name));
  const q2 = [...srcSeen];
  while (q2.length) for (const o of (src.connections[q2.shift()] || { main: [] }).main) for (const c of o || []) if (!srcSeen.has(c.node)) { srcSeen.add(c.node); q2.push(c.node); }
  const before = functional(src).filter((n) => !srcSeen.has(n.name)).map((n) => n.name);
  assert.deepStrictEqual(unreachable, before);
  return before.length ? `already unconnected in your export (left as is): ${before.join(', ')}` : 'all reachable';
});

console.log(lines.join('\n'));
console.log(`\nALL ${group} CHECK GROUPS PASSED (${path.basename(FILE)})`);
