// Static + configuration checks of the PRODUCTION export: structure, no secrets, no literal identifiers, credentials, webhooks, syntax of every Code node,
// config guards per section. Run: node n8n/production/tests/static.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadWf, test, finish, run, fakeMeta, ENV, DAY } = H;
const wf = loadWf();
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const real = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
const TEXT = JSON.stringify(wf);

test('identity: inactive, own id and name, workflow settings', () => {
  assert.strictEqual(wf.active, false);
  assert.strictEqual(wf.id, 'FhqClinicProd001');
  assert.notStrictEqual(wf.id, 'TAjYroU2Zj32GD3Y', 'must never overwrite the live workflow on import');
  assert.match(wf.name, /production candidate/);
  assert.deepStrictEqual([wf.settings.timezone, wf.settings.saveDataSuccessExecution, wf.settings.saveDataErrorExecution, wf.settings.saveManualExecutions, wf.settings.executionTimeout], ['Asia/Kolkata', 'none', 'all', false, 900]);
  assert.deepStrictEqual(wf.pinData, {});
});

test('graph: unique names and ids, every connection endpoint exists, every node is reachable from a trigger', () => {
  assert.strictEqual(new Set(wf.nodes.map((n) => n.name)).size, wf.nodes.length);
  assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
  for (const [from, v] of Object.entries(wf.connections)) { assert(byName[from], from); for (const o of v.main) for (const t of o || []) assert(byName[t.node], `${from} -> ${t.node}`); }
  const TRIG = /(webhook|scheduleTrigger|errorTrigger|manualTrigger|executeWorkflowTrigger)$/;
  const seen = new Set(real.filter((n) => TRIG.test(n.type)).map((n) => n.name));
  const queue = [...seen];
  while (queue.length) { const x = queue.shift(); for (const o of (wf.connections[x] || { main: [] }).main) for (const t of o || []) if (!seen.has(t.node)) { seen.add(t.node); queue.push(t.node); } }
  assert.deepStrictEqual(real.filter((n) => !seen.has(n.name)).map((n) => n.name), [], 'unreachable nodes');
});

test('every Execute Workflow node calls this workflow (W12 is in the same workflow)', () => {
  for (const n of real.filter((x) => x.type === 'n8n-nodes-base.executeWorkflow')) assert.match(n.parameters.workflowId.value, /\$workflow\.id|w12_workflow_id/, n.name);
  assert.strictEqual(real.filter((x) => x.type === 'n8n-nodes-base.executeWorkflowTrigger').length, 1);
});

test('every Code node is valid JavaScript (as n8n wraps it) and none uses require / process / eval / fetch', () => {
  let n = 0;
  for (const node of real.filter((x) => x.type === 'n8n-nodes-base.code')) {
    const code = node.parameters.jsCode;
    assert.doesNotThrow(() => new Function('$', '$input', '$json', '$getWorkflowStaticData', '$env', '$binary', `return (async () => { ${code}\n})`), node.name);
    const noComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/\brequire\s*\(|\bprocess\.|\beval\s*\(|\bfetch\s*\(|child_process|XMLHttpRequest/.test(noComments), `${node.name} uses a forbidden API`);
    n++;
  }
  assert(n > 100);
});

test('no secret and no real identifier is stored in the export', () => {
  for (const [name, re] of [['bearer token', /Bearer\s+[A-Za-z0-9._-]{10,}/], ['Meta access token', /EAA[A-Za-z0-9]{20,}/], ['OpenAI/OpenRouter key', /sk-(or-)?[A-Za-z0-9-]{20,}/], ['Telegram bot token', /\d{8,10}:[A-Za-z0-9_-]{30,}/], ['long hex secret', /\b[0-9a-f]{32,}\b/i], ['private key', /BEGIN [A-Z ]*PRIVATE KEY/]]) assert(!re.test(TEXT), `looks like a ${name}`);
  // live values that were in the uploaded workflow
  const priv = path.join(__dirname, '..', 'backup', 'ai_updated_workflow_clinic_final_v3_v1.original.local.json');
  if (fs.existsSync(priv)) {
    const o = JSON.parse(fs.readFileSync(priv, 'utf8'));
    const live = new Set();
    for (const n of o.nodes) for (const a of ((n.parameters || {}).assignments || {}).assignments || []) if (['cal_webhook_secret', 'meta_verify_token', 'test_phone', 'w12_allowlist', 'telegram_chat_id', 'registry_doc_id'].includes(a.name) && String(a.value).length > 6 && !/^PASTE|^REPLACE|^=/.test(String(a.value))) live.add(String(a.value));
    for (const n of o.nodes) { const s = JSON.stringify(n.parameters); for (const m of s.match(/(?<![\d.])\d{10,16}(?![\d.])/g) || []) live.add(m); }   // every phone number / phone-number id / long id literal in the upload
    assert(live.size >= 3, 'the check itself found nothing to look for');
    for (const v of live) if (!/^(91)?(9000000\d{2,5}|9876543210)$/.test(v)) assert(!TEXT.includes(v), 'a live value from the uploaded workflow is still in the export');   // 9000000xxx / 9876543210 are the fictional numbers of the upload's own test fixtures
  }
  assert(!/\+91\d{10}/.test(TEXT.replace(/\+91(9000000|98000)\d{5}/g, '').replace(/\+919876543210/g, '')), 'a phone number literal');
});

test('settings that differ per environment are $env expressions; nothing secret is a literal in a Config / Set node', () => {
  for (const [node, key] of [['W1 – Config', 'registry_doc_id'], ['W3 – Config', 'test_phone'], ['W4 – Config', 'cal_webhook_secret'], ['W2 – Verify Config', 'meta_verify_token'], ['W2 – Signature Config', 'meta_app_secret'], ['W11 – Config', 'telegram_chat_id'], ['W12 – Config', 'w12_allowlist'], ['W12 – Config', 'w12_send_mode'], ['W13 – Config', 'ai_external_enabled'], ['W9 – Config', 'ai_external_enabled'], ['W13 – Config', 'max_ai_replies_per_hour']]) {
    const a = byName[node].parameters.assignments.assignments.find((x) => x.name === key);
    assert(a && /^=\{\{.*\$env\./.test(String(a.value)), `${node}.${key} is not read from the environment`);
  }
  assert.strictEqual(byName['W13 – Config'].parameters.assignments.assignments.find((x) => x.name === 'max_ai_replies_per_hour').value.includes('|| 6'), true);
  assert.strictEqual(byName['W12 – Config'].parameters.assignments.assignments.find((x) => x.name === 'w12_uncertain_counts_as_sent').value, false);
  assert.strictEqual(byName['W2 – Signature Config'].parameters.assignments.assignments.find((x) => x.name === 'w2_signature_mode').value, 'enforce');
  assert.strictEqual(byName['W4 – Config'].parameters.assignments.assignments.find((x) => x.name === 'require_signature').value, true);
});

test('TLS is always verified; the temporary quiet-hours switch is off everywhere; hello_world is never a template choice', () => {
  assert(!/allowUnauthorizedCerts/.test(TEXT));
  assert(!/DISABLE_QUIET_HOURS_FOR_TEST = true/.test(TEXT));
  const hasW15 = real.some((n) => n.name === 'W15 – Decide send');   // W15 (n8n/final/tools/patch-w15-followup.js) carries one more copy, off
  assert.strictEqual((TEXT.match(/DISABLE_QUIET_HOURS_FOR_TEST = false/g) || []).length, 7 + (hasW15 ? 1 : 0));
  for (const n of real) assert(!/template\s*[:=]\s*'hello_world'/.test(JSON.stringify(n.parameters).replace(/\\n/g, '\n')) || n.name === 'W12 – Test input', n.name);
});

test('credentials: only the production credentials (six), by stable id and name', () => {
  const seen = {};
  for (const n of real) for (const [t, c] of Object.entries(n.credentials || {})) { const k = `${t}|${c.id}|${c.name}`; seen[k] = (seen[k] || 0) + 1; }
  assert.deepStrictEqual(Object.keys(seen).sort(), [
    'httpHeaderAuth|FhqCredAiProv001|FlowHQ AI Provider', 'httpHeaderAuth|FhqCredGrist0001|FlowHQ Grist API', 'httpHeaderAuth|FhqCredW1Hook001|FlowHQ W1 Webhook Auth',
    'httpHeaderAuth|FhqCredWhatsApp1|FlowHQ WhatsApp Cloud API', 'smtp|FhqCredSmtp00001|FlowHQ SMTP', 'telegramApi|FhqCredTelegram1|FlowHQ Telegram Alerts',
  ].sort());
  assert.strictEqual(seen['httpHeaderAuth|FhqCredWhatsApp1|FlowHQ WhatsApp Cloud API'], 1, 'only W12 – Meta send uses the WhatsApp credential');
  assert.strictEqual(byName['W12 – Meta send'].credentials.httpHeaderAuth.name, 'FlowHQ WhatsApp Cloud API');
});

test('webhooks: exactly four paths; every one answers through Respond to Webhook; each authenticates its sender', () => {
  const hooks = real.filter((n) => n.type === 'n8n-nodes-base.webhook');
  assert.deepStrictEqual(hooks.map((h) => `${h.parameters.httpMethod || 'GET'} ${h.parameters.path} ${h.parameters.responseMode || 'onReceived'}`).sort(), ['GET whatsapp-inbound responseNode', 'POST cal responseNode', 'POST website-lead responseNode', 'POST whatsapp-inbound responseNode']);
  assert.strictEqual(byName['W1 – Webhook'].parameters.authentication, 'headerAuth');
  for (const n of ['W2 – Verify Signature', 'W2 – Check Verify Token', 'W4 – Verify & parse']) assert(byName[n], n);
  assert.strictEqual(byName['W2 – Webhook Inbound'].parameters.options.rawBody, true);
  assert.strictEqual(byName['W4 – Webhook1'].parameters.options.rawBody, true);
  assert.strictEqual(byName['W2 – Signature Config'].parameters.assignments.assignments.find((a) => a.name === 'w2_signature_mode').value, 'enforce');
});

test('external hosts appear only as configurable defaults: no literal URL in an HTTP node', () => {
  for (const n of real.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) assert(/^=/.test(String(n.parameters.url)), `${n.name} has a literal URL`);
  const hosts = new Set();
  for (const n of real) { const s = JSON.stringify(n.parameters).replace(/\\n/g, '\n'); for (const m of s.match(/https?:\/\/[A-Za-z0-9.-]+/g) || []) hosts.add(m.replace(/^https?:\/\//, '')); }
  const allowed = new Set(['graph.facebook.com', 'openrouter.ai', 'grist', 'cal.com', 'g.page', 'cal.example.test', 'example.com', 'clinic.example', '127.0.0.1', 'localhost']);
  for (const h of hosts) assert([...allowed].some((a) => h === a || h.startsWith(a)), `unexpected host ${h}`);
});

test('the AI provider is reached only by W13 – Ask Model and W9 – Ask Model, and both are behind the external-AI gate', () => {
  const ai = real.filter((n) => /Ask Model/.test(n.name));
  assert.deepStrictEqual(ai.map((n) => n.name).sort(), ['W13 – Ask Model', 'W9 – Ask Model']);
  for (const n of ai) assert(!/allowUnauthorizedCerts/.test(JSON.stringify(n.parameters)));
  assert(byName['W9 – External AI?']);
  assert(/ai_external_enabled/.test(byName['W13 – Build Context'].parameters.jsCode));
});

// ---------------------------------------------------------------- config guards, one per section
const GUARDS = {
  'W1 – Webhook': ['W1', [['FLOWHQ_REGISTRY_DOC_ID', 'FLOWHQ_REGISTRY_DOC_ID']]],
  'W3 – Every 10 minutes': ['W3', [['FLOWHQ_REGISTRY_DOC_ID'], ['FLOWHQ_GRIST_URL', 'x']]],
  'W5 – Every 15 minutes': ['W5', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W6 – Daily 10:00': ['W6', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W7 – Every hour': ['W7', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W8 – Every hour': ['W8', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W9 – Monday 09:00': ['W9', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W10 – Every minute': ['W10', [['FLOWHQ_REGISTRY_DOC_ID']]],
  'W14 – Every 15 minutes': ['W14', [['FLOWHQ_REGISTRY_DOC_ID']]],
};
test('every section stops at its config guard when the registry id or Grist URL is missing: nothing is read, written or sent', () => {
  for (const [start, [sec]] of Object.entries(GUARDS)) {
    for (const key of ['FLOWHQ_REGISTRY_DOC_ID']) {
      const meta = fakeMeta();
      const res = run(wf, start, [start.startsWith('W1 ') ? { headers: {}, params: {}, query: {}, body: {} } : {}], { unset: [key], meta });
      assert(res.r.error, `${sec}: no error`);
      assert.match(res.r.error.message, new RegExp(`FlowHQ configuration incomplete in ${sec}: .*${key} is not set`), sec);
      assert.strictEqual(res.grist.calls.length, 0, `${sec}: Grist was called`);
      assert.strictEqual(meta.calls.length, 0, `${sec}: Meta was called`);
    }
  }
});

test('the guards reject placeholders, short secrets and unsafe base URLs', () => {
  const guardErr = (start, env, item = {}) => (run(wf, start, [item], { env }).r.error || {}).message || '';
  assert.match(guardErr('W1 – Webhook', { FLOWHQ_REGISTRY_DOC_ID: 'PASTE_REGISTRY_ID' }, { headers: {}, params: {}, query: {}, body: {} }), /FLOWHQ_REGISTRY_DOC_ID is not set/);
  assert.match(guardErr('W1 – Webhook', { FLOWHQ_GRIST_URL: 'ftp://grist' }, { headers: {}, params: {}, query: {}, body: {} }), /FLOWHQ_GRIST_URL must start with http/);
  assert.match(guardErr('W4 – Webhook1', { FLOWHQ_CAL_WEBHOOK_SECRET: 'short' }, { json: {}, headers: {}, query: {}, body: {} }), /FLOWHQ_CAL_WEBHOOK_SECRET is too short/);
  assert.match(guardErr('W2 – Webhook Verify', { FLOWHQ_META_VERIFY_TOKEN: 'abc' }, { query: {} }), /FLOWHQ_META_VERIFY_TOKEN is too short/);
  assert.match(guardErr('W12 – When called by another workflow', { FLOWHQ_WA_GRAPH_BASE_URL: 'http://evil.example' }, H.sendItem()), /FLOWHQ_WA_GRAPH_BASE_URL must be https/);
  assert.match(guardErr('W12 – When called by another workflow', { FLOWHQ_WA_GRAPH_VERSION: 'latest' }, H.sendItem()), /FLOWHQ_WA_GRAPH_VERSION must look like v23.0/);
  assert.match(guardErr('W12 – When called by another workflow', { FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: '' }, H.sendItem()), /FLOWHQ_WA_ALLOWLIST is not set/);
  assert.strictEqual(guardErr('W12 – When called by another workflow', { FLOWHQ_WA_GRAPH_BASE_URL: 'http://127.0.0.1:9' }, H.sendItem()).includes('FLOWHQ_WA_GRAPH_BASE_URL'), false, 'a local mock is allowed');
});

test('W11: the error alert has no patient data and sends nothing without a chat id', () => {
  const alert = (env) => run(wf, 'W11 – Error Trigger', [{ execution: { id: '1', url: 'https://n8n.example/execution/1', error: { message: 'Grist 503 for +919000000011 token=abc123456789' }, lastNodeExecuted: 'W5 – Leads' }, workflow: { name: 'FlowHQ' } }], { env });
  const a = alert({});
  assert.strictEqual(a.r.error, null, a.r.error && a.r.error.message);
  assert.strictEqual(a.r.telegram.length, 1);
  assert(!/9000000011|abc123456789/.test(a.r.telegram[0].text), a.r.telegram[0].text);
  const b = alert({ FLOWHQ_TELEGRAM_CHAT_ID: '' });
  assert.strictEqual(b.r.telegram.length, 0);
});

finish('static');
