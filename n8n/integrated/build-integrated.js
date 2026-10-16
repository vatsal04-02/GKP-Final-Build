// Builds the INTEGRATED master workflow: your live "1 clinic total workflow" (W1-W6, W11, W12, W2) + the AI receptionist
// (OpenRouter) as SECTION W13 inside the same workflow, with ONE execution path and ONE WhatsApp sender (W12).
//
//   node n8n/integrated/build-integrated.js --in <master export.json> [--out <file>] [--keep-private]
//   node n8n/integrated/build-integrated.js --in <master export.json> --redact-only --out <file>   (just the redacted export)
//
// What it changes in the master, and nothing else (validate-integrated.js proves it node by node):
//   1. W12 entry: the master can have only ONE Execute Workflow Trigger (W12's). A new IF "W12 – AI Job?" right after it sends
//      items with w13_job / w13_retry = true to SECTION W13; every other item (W3 / W5 / W6 / W13 sends) goes to "W12 – Config"
//      exactly as before.
//   2. A-01 in W12: the pasted wa-send.js block in "W12 – Prepare request" and "W12 – Read reply" is replaced by the current
//      n8n/snippets/wa-send.js (free text inside the 24 h window + template human_handoff_alert). Templates work as before.
//   3. W2: after "W2 – Prepare Staff Alert" (message stored, conversation updated) -> "W2 – AI Wanted?" -> "W2 – AI Job" (the
//      identifiers W13 reads) -> "W2 – Start AI Receptionist" (this workflow, without waiting) -> "W2 – AI Handed" -> the
//      unchanged "W2 – Build Run Log". Everything before it (webhooks, verify, parse, dedupe, lead, conversation, message) and
//      Build Run Log / Run Log are untouched.
//   4. SECTION W13: the nodes of n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json (OpenRouter provider), without its own
//      Execute Workflow Trigger and Manual Test (one of each per workflow; the standalone demo keeps them for dry runs), with
//      W13 – Config > w12_workflow_id = {{ $workflow.id }} (sends enter THIS workflow's W12). The Anthropic W13 is NOT used.
//   5. active = false. Unless --keep-private: the Meta verify token, the Cal.com secret and the allowlisted phone number are
//      replaced by placeholders (public repo). The file you import keeps them (--keep-private).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.stage1.json'));   // stage 1 of the master (W1-W6, W11-W13); the full master is clinic-autopilot-master-ai.json
const KEEP_PRIVATE = args.includes('--keep-private');
const REDACT_ONLY = args.includes('--redact-only');
if (!IN) { console.error('usage: node build-integrated.js --in <master export.json> [--out file] [--keep-private] [--redact-only]'); process.exit(1); }
const REPO = path.join(__dirname, '..', '..');
const DEMO_FILE = path.join(REPO, 'n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json');

const PH_SECRET = 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT';
const PH_PHONE = 'PASTE_YOUR_TEST_NUMBER';
const PH_VERIFY = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
const uuid = (seed) => {   // deterministic ids for the NEW nodes (rebuilds give the same ids)
  const h = crypto.createHash('sha256').update(`integrated:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (m) => { throw new Error(`build-integrated: ${m}`); };

const master = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = () => Object.fromEntries(master.nodes.map((n) => [n.name, n]));
const assignment = (node, key) => (node.parameters.assignments.assignments || []).find((a) => a.name === key);

// ---------------------------------------------------------------- redaction (public copies only)
function redact(wf, report) {
  const nodes = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const secret = nodes['W4 – Config'] && assignment(nodes['W4 – Config'], 'cal_webhook_secret');
  if (secret && secret.value !== PH_SECRET) { secret.value = PH_SECRET; report.push('W4 – Config > cal_webhook_secret'); }
  const verify = nodes['W2 – Verify Config'] && assignment(nodes['W2 – Verify Config'], 'meta_verify_token');
  if (verify && verify.value !== PH_VERIFY) { verify.value = PH_VERIFY; report.push('W2 – Verify Config > meta_verify_token'); }
  const allow = nodes['W12 – Config'] && assignment(nodes['W12 – Config'], 'w12_allowlist');
  const phones = String(allow ? allow.value : '').split(/[,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10);
  let text = JSON.stringify(wf);
  for (const ph of phones) {
    const tail = ph.slice(-10);
    const re = new RegExp(`(\\+?91[\\s-]?)?${tail.slice(0, 5)}[\\s-]?${tail.slice(5)}`, 'g');
    const hits = (text.match(re) || []).length;
    if (hits) { text = text.replace(re, PH_PHONE); report.push(`${hits} occurrence(s) of the allowlisted phone number`); }
  }
  return JSON.parse(text);
}

if (REDACT_ONLY) {
  const report = [];
  const out = redact(master, report);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT} (redacted export): ${report.join('; ') || 'nothing to redact'}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 0. is this the expected master?
{
  const n = byName();
  for (const need of ['W2 – Webhook Inbound', 'W2 – Prepare Staff Alert', 'W2 – Build Run Log', 'W12 – When called by another workflow', 'W12 – Config', 'W12 – Prepare request', 'W12 – Read reply', 'W12 – Meta send']) if (!n[need]) fail(`node "${need}" not found: is this the master export?`);
  if (master.nodes.some((x) => x.name.startsWith('W13 – '))) fail('the master already contains W13 nodes (already integrated?)');
  const triggers = master.nodes.filter((x) => x.type === 'n8n-nodes-base.executeWorkflowTrigger').map((x) => x.name);
  if (JSON.stringify(triggers) !== JSON.stringify(['W12 – When called by another workflow'])) fail(`expected exactly one Execute Workflow Trigger (W12), found ${JSON.stringify(triggers)}`);
  const trigOut = JSON.stringify(master.connections['W12 – When called by another workflow']);
  if (trigOut !== JSON.stringify({ main: [[{ node: 'W12 – Config', type: 'main', index: 0 }]] })) fail(`unexpected W12 trigger wiring: ${trigOut}`);
  const psaOut = JSON.stringify(master.connections['W2 – Prepare Staff Alert']);
  if (psaOut !== JSON.stringify({ main: [[{ node: 'W2 – Build Run Log', type: 'main', index: 0 }]] })) fail(`unexpected W2 – Prepare Staff Alert wiring: ${psaOut}`);
}
const CHANGES = [];
const link = (from, to, out = 0) => {
  master.connections[from] = master.connections[from] || { main: [] };
  while (master.connections[from].main.length <= out) master.connections[from].main.push([]);
  master.connections[from].main[out].push({ node: to, type: 'main', index: 0 });
};
const ifNode = (name, position, expr) => ({
  id: uuid(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: uuid(`${name}:cond`), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
});
const codeNode = (name, position, jsCode) => ({ id: uuid(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { mode: 'runOnceForEachItem', jsCode } });
const sticky = (name, position, width, height, color, content) => ({ id: uuid(name), name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position, parameters: { content, width, height, color } });

// ---------------------------------------------------------------- 1. A-01 in W12 (exact-text block swap, asserted)
const WA = fs.readFileSync(path.join(REPO, 'n8n/snippets/wa-send.js'), 'utf8');
const WA_BLOCK = WA.slice(WA.indexOf('const WA_TEMPLATES'), WA.indexOf('if (typeof module'));
for (const name of ['W12 – Prepare request', 'W12 – Read reply']) {
  const n = byName()[name];
  const code = n.parameters.jsCode;
  const start = code.indexOf('const WA_TEMPLATES');
  const close = code.indexOf('\n}\n\n', code.indexOf('function waInboxRow', start));
  if (start < 0 || close < 0 || code.indexOf('const WA_TEMPLATES', start + 1) >= 0) fail(`${name}: wa-send.js block not found exactly once`);
  if (code.slice(start, close + 4).includes('WA_TEXT_WINDOW_MS')) fail(`${name}: already has A-01`);
  n.parameters.jsCode = code.slice(0, start) + WA_BLOCK + code.slice(close + 4);
  CHANGES.push(`${name}: A-01 (free text in the 24 h window + human_handoff_alert)`);
}

// ---------------------------------------------------------------- 2. the shared entry: W12 – AI Job?
const trig = byName()['W12 – When called by another workflow'];
const ROUTER = 'W12 – AI Job?';
master.nodes.push(ifNode(ROUTER, [trig.position[0] + 216, trig.position[1] + 200], '$json.w13_job === true || $json.w13_retry === true'));
master.connections['W12 – When called by another workflow'] = { main: [[{ node: ROUTER, type: 'main', index: 0 }]] };
link(ROUTER, 'W13 – Config', 0);
link(ROUTER, 'W12 – Config', 1);
CHANGES.push(`added ${ROUTER}; W12 – When called by another workflow -> ${ROUTER} (true -> W13 – Config, false -> W12 – Config)`);

// ---------------------------------------------------------------- 3. W2 -> the AI receptionist (after the message is stored)
const psa = byName()['W2 – Prepare Staff Alert'];
const [px, py] = psa.position;
const yAi = 2480;   // below the W2 section, above SECTION W3
const W2N = { wanted: 'W2 – AI Wanted?', job: 'W2 – AI Job', start: 'W2 – Start AI Receptionist', handed: 'W2 – AI Handed' };
master.nodes.push(ifNode(W2N.wanted, [px, yAi], "$json.run_outcome === 'ok' && Number($json.message_row_id) > 0 && !$json.test_case"));
master.nodes.push(codeNode(W2N.job, [px + 240, yAi], [
  '// ONE job for the AI receptionist (SECTION W13) per stored patient message. Only identifiers: W13 reads the message text, the',
  '// lead, the conversation and the clinic from Grist itself (the stored row is the source of truth) and its settings from',
  '// W13 – Config. w13_job routes the call at "W12 – AI Job?". text is passed for the record; W13 uses the stored Body.',
  'return {',
  '  json: {',
  '    w13_job: true,',
  '    dry_run: false,',
  '    w13_retry: false,',
  '    wa_phone_number_id: $json.wa_phone_number_id,',
  '    clinic_slug: $json.clinic_slug,',
  '    message_row_id: $json.message_row_id,',
  '    wa_message_id: $json.wa_message_id,',
  '    msg_type: $json.msg_type,',
  '    patient_phone: $json.patient_phone,',
  '    sender_name: $json.sender_name,',
  '    text: $json.body_text,',
  '  },',
  '};',
].join('\n')));
master.nodes.push({
  id: uuid(W2N.start), name: W2N.start, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: [px + 480, yAi], onError: 'continueRegularOutput',
  parameters: {
    workflowId: { __rl: true, value: '={{ $workflow.id }}', mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'each',
    options: { waitForSubWorkflow: false },
  },
});
master.nodes.push(codeNode(W2N.handed, [px + 720, yAi], [
  '// The AI receptionist runs as its own execution (W2 does not wait: Meta already has its 200 and the next message goes on).',
  '// W2 continues with ITS item for this message, so Build Run Log / Run Log work exactly as before. If the AI job could not',
  '// even be started, the message is still stored: Run_Log stays ok and its Error column says so (race_notes, as W2 already does).',
  "const ctx = $('W2 – Prepare Staff Alert').item.json;",
  'const e = $json && $json.error;',
  'if (!e) return { json: ctx };',
  'const why = String(e.message || e.description || e).replace(/\\s+/g, \' \').slice(0, 200);',
  'return { json: { ...ctx, race_notes: [...(Array.isArray(ctx.race_notes) ? ctx.race_notes : []), `AI receptionist not started: ${why}`] } };',
].join('\n')));
master.connections['W2 – Prepare Staff Alert'] = { main: [[{ node: W2N.wanted, type: 'main', index: 0 }]] };
link(W2N.wanted, W2N.job, 0);
link(W2N.wanted, 'W2 – Build Run Log', 1);
link(W2N.job, W2N.start);
link(W2N.start, W2N.handed);
link(W2N.handed, 'W2 – Build Run Log');
master.nodes.push(sticky('W2 – Section G AI', [px - 40, yAi - 140], 1000, 340, 7,
  '## W2 → AI RECEPTIONIST\nOnly a message that W2 **stored** (not a duplicate, status event, invalid payload, unknown clinic or failed Grist write) starts ONE AI job: this workflow is called again with `w13_job = true` (no waiting) and "W12 – AI Job?" sends it to SECTION W13. W2 then logs to Run_Log exactly as before.'));
CHANGES.push(`W2 – Prepare Staff Alert -> ${W2N.wanted} (true -> ${W2N.job} -> ${W2N.start} -> ${W2N.handed} -> W2 – Build Run Log; false -> W2 – Build Run Log)`);

// ---------------------------------------------------------------- 4. SECTION W13 from the OpenRouter demo
const demo = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));
if (!/openrouter\.ai/.test(JSON.stringify(demo)) || /api\.anthropic\.com/.test(JSON.stringify(demo))) fail('the W13 source is not the OpenRouter demo');
const DROP = ['W13 – When Called', 'W13 – Manual Test', 'W13 – Test Messages', 'W13 – Run Each Test', 'W13 – Test Report'];
const keep = demo.nodes.filter((n) => !DROP.includes(n.name) && n.type !== 'n8n-nodes-base.stickyNote');
const xs = keep.map((n) => n.position[0]);
const ys = keep.map((n) => n.position[1]);
const maxY = Math.max(...master.nodes.map((n) => n.position[1] + (n.type === 'n8n-nodes-base.stickyNote' ? n.parameters.height || 0 : 0)));
const top = Math.ceil((maxY + 500) / 16) * 16;
const dx = 200 - Math.min(...xs);
const dy = top + 220 - Math.min(...ys);
const ids = new Set(master.nodes.map((n) => n.id));
const names = new Set(master.nodes.map((n) => n.name));
for (const n of keep) {
  const c = clone(n);
  if (ids.has(c.id) || names.has(c.name)) fail(`W13 node ${c.name} collides with the master`);
  c.position = [c.position[0] + dx, c.position[1] + dy];
  if (c.name === 'W13 – Config') {
    const a = assignment(c, 'w12_workflow_id');
    if (!a || a.value !== 'PASTE_W12_WORKFLOW_ID') fail('W13 – Config > w12_workflow_id is not the shipped placeholder');
    a.value = '={{ $workflow.id }}';
  }
  master.nodes.push(c);
}
const kept = new Set(keep.map((n) => n.name));
const dropped = [];
for (const [from, o] of Object.entries(demo.connections)) {
  o.main.forEach((outs, oi) => (outs || []).forEach((cn) => {
    if (kept.has(from) && kept.has(cn.node)) link(from, cn.node, oi);
    else dropped.push(`${from} -> ${cn.node}`);
  }));
}
const EXPECT_DROPPED = ['W13 – When Called -> W13 – Config', 'W13 – Manual Test -> W13 – Test Messages', 'W13 – Test Messages -> W13 – Run Each Test', 'W13 – Run Each Test -> W13 – Test Report'];
if (JSON.stringify(dropped.sort()) !== JSON.stringify([...EXPECT_DROPPED].sort())) fail(`unexpected W13 connections dropped: ${dropped.join(', ')}`);
master.nodes.push(sticky('Section W13', [0, top], 4200, Math.max(...ys) - Math.min(...ys) + 520, 4,
  '## SECTION W13 — AI RECEPTIONIST (OpenRouter)\n' +
  '**Entry:** "W12 – AI Job?" (items with `w13_job` from W2, or `w13_retry` from the 08:05 run) and **W13 – Every Morning** (08:05: messages deferred overnight). One message per execution.\n\n' +
  '**Does:** reads clinic, Settings, Knowledge, the message, conversation, lead, history, Booked appointments → safety gates (handled, STOP, ai_mode, opted out, paused, Needs_Human, answered, newer message, emergency words → URGENT hand-off, night, media, rate limit) → marks the message `processing` → OpenRouter (Provider Request → Ask Model → Provider Answer) → **W13 – Plan** checks the JSON decision (schema, triage, confidence tiers 0.65 / 0.80 / 0.85, complaint/payment/medical → person, fact check of prices / times / links) → appointment writes → **W12** (this workflow, the only WhatsApp sender) → CRM writes + Run_Log.\n\n' +
  '**Fill after import:** credential **OpenRouter API** on `W13 – Ask Model`. **Switch on per clinic:** Settings `ai_mode` = draft / auto (missing = off). Dry runs: use the standalone "W13 DEMO" workflow (Manual Test).'));
CHANGES.push(`SECTION W13: ${keep.length} nodes from the OpenRouter demo (dropped: ${DROP.join(', ')}); W13 – Config > w12_workflow_id = {{ $workflow.id }}`);

// ---------------------------------------------------------------- 5. out
master.active = false;
const report = [];
const out = KEEP_PRIVATE ? master : redact(master, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
const functional = out.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${functional} functional), active = false`);
for (const c of CHANGES) console.log(`  - ${c}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: your verify token, Cal.com secret and allowlist stay in this file)' : report.join('; ') || 'none needed'}`);
