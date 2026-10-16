// Builds the W13 - AI receptionist workflow:   node n8n/w13/build-w13.js [--provider anthropic|openrouter] [--out <file>]
//   --provider anthropic  (default)  W13-AI-Receptionist.json: Claude through the Anthropic API ("W13 – Ask Claude").
//   --provider openrouter            W13-AI-Receptionist-Demo-OpenRouter.json, a separate DEMO workflow: only the provider layer
//                                    differs ("W13 – Provider Request" -> "W13 – Ask Model" -> "W13 – Provider Answer", see
//                                    n8n/snippets/ai-provider.js) plus model_provider / openrouter_model in W13 – Config.
// Code-node sources live in n8n/w13/code/*.js; the shared helpers are pasted in VERBATIM from n8n/snippets/ (normalize-phone,
// send-guard, clinic-hours, ai-receptionist) so the tested code is the code that runs. This script wires the nodes and lays out the canvas.
//
// W13 is called by W2 (one call per stored patient message, without waiting), by its own manual test (dry run) and by its own
// 08:05 IST schedule (messages deferred overnight). It asks Claude (Anthropic API) for a decision, checks it, writes the CRM and
// sends through W12 (Execute Workflow -> the workflow that contains W12; W13 never calls Meta itself).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const PROVIDER = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'anthropic';
if (!['anthropic', 'openrouter'].includes(PROVIDER)) throw new Error(`--provider must be anthropic or openrouter, not ${PROVIDER}`);
const OR = PROVIDER === 'openrouter';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, OR ? 'W13-AI-Receptionist-Demo-OpenRouter.json' : 'W13-AI-Receptionist.json');
const CODE = path.join(__dirname, 'code');
const SNIPPETS = path.join(__dirname, '..', 'snippets');

const GRIST_CRED = { httpHeaderAuth: { id: '9J6XxrIQoFDcQZ0Y', name: 'Header Auth account 2' } };   // the existing Grist credential, by reference only
const ANTHROPIC_CRED = { httpHeaderAuth: { id: 'PASTE_ANTHROPIC_CREDENTIAL_ID', name: 'Anthropic API' } };   // create it in n8n (README); no key in this file
const OPENROUTER_CRED = { httpHeaderAuth: { id: 'PASTE_OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter API' } };   // Header Auth: Authorization = Bearer <key>, set in n8n only
const OPENROUTER_MODEL = 'openai/gpt-4o-mini';   // demo default: cheap, strict json_schema structured outputs
const W12_PLACEHOLDER = 'PASTE_W12_WORKFLOW_ID';
const uuid = (seed) => {
  const hx = crypto.createHash('sha256').update(`w13:${seed}`).digest('hex');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-4${hx.slice(13, 16)}-a${hx.slice(17, 20)}-${hx.slice(20, 32)}`;
};
const readCode = (f) => fs.readFileSync(path.join(CODE, f), 'utf8').replace(/\s+$/, '\n');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const fn = (src, name) => { const s = src.indexOf(`function ${name}`); return src.slice(s, src.indexOf('\n}\n', s) + 3); };
const PHONE = fn(snip('normalize-phone.js'), 'normalizeIndianPhone');
const GUARD = ['isTestMode', 'inQuietHours', 'decideSend'].map((n) => fn(snip('send-guard.js'), n)).join('\n');
const HOURS_SRC = snip('clinic-hours.js');
const HOURS = `${HOURS_SRC.match(/const DAY_INDEX = .*\n/)[0]}\n${fn(HOURS_SRC, 'parseClock')}\n${fn(HOURS_SRC, 'parseDays')}`;
const AI_SRC = snip('ai-receptionist.js');
const AI = AI_SRC.slice(AI_SRC.indexOf('const AI_INTENTS'), AI_SRC.indexOf('if (typeof module'));
const LIB = [
  '// ---- pasted from n8n/snippets/ (normalize-phone.js, send-guard.js, clinic-hours.js, ai-receptionist.js) - keep identical ----',
  PHONE, GUARD, HOURS, AI,
  'const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };',
  '// ---- this node ----',
].join('\n');
const withLib = (f) => `${LIB}\n${readCode(f)}`;
const PROV_SRC = snip('ai-provider.js');
const withProvider = (f) => `// ---- pasted from n8n/snippets/ai-provider.js - keep identical ----\n${PROV_SRC.slice(PROV_SRC.indexOf('const AI_OPENROUTER_FINISH'), PROV_SRC.indexOf('if (typeof module'))}// ---- this node ----\n${readCode(f)}`;
const withPhone = (f) => `// Pasted from n8n/snippets/normalize-phone.js - keep identical.\n${PHONE}\n${readCode(f)}`;

const P = 'W13 – ';
const N = {
  called: `${P}When Called`, manual: `${P}Manual Test`, testMessages: `${P}Test Messages`, runTests: `${P}Run Each Test`, testReport: `${P}Test Report`,
  morning: `${P}Every Morning`, morningStart: `${P}Morning Start`, config: `${P}Config`, isMorning: `${P}Morning Run?`,
  morningClinics: `${P}Morning Clinics`, activeClinics: `${P}Active Clinics`, deferred: `${P}Deferred Messages`, pickRetries: `${P}Pick Retries`, retryEach: `${P}Retry Each`,
  start: `${P}Start`, clinics: `${P}Clinics`, resolveClinic: `${P}Resolve Clinic`, clinicOk: `${P}Clinic OK?`, clinicRejected: `${P}Clinic Rejected`,
  settings: `${P}Settings`, knowledge: `${P}Knowledge`, message: `${P}Message`, convKey: `${P}Conversation Key`, conversation: `${P}Conversation`,
  leadKey: `${P}Lead Key`, lead: `${P}Lead`, history: `${P}History`, appointments: `${P}Appointments`, context: `${P}Build Context`,
  askAi: `${P}Ask AI?`, claim: `${P}Claim?`, claimMsg: `${P}Claim Message`, claimFailed: `${P}Claim Failed`, claude: `${P}Ask Claude`, plan: `${P}Plan`,
  provReq: `${P}Provider Request`, askModel: `${P}Ask Model`, provAns: `${P}Provider Answer`,
  actionWrites: `${P}Action Writes?`, splitActions: `${P}Split Action Writes`, writeAction: `${P}Write Action`, checkActions: `${P}Check Action Writes`,
  planReady: `${P}Plan Ready`, splitSends: `${P}Split Sends`, sendQ: `${P}Send?`, callW12: `${P}Call W12`, recordSends: `${P}Record Sends`,
  writeQ: `${P}Write?`, writeCrm: `${P}Write CRM`, done: `${P}Done`,
};

// ---------------------------------------------------------------- node factories
const nodes = [];
const at = (col, row) => [col * 240, row * 176];
const add = (n) => { nodes.push({ ...n, id: uuid(n.name) }); };
const setNode = (name, pos, assignments) => add({
  name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: { assignments: { assignments: assignments.map(([k, v]) => ({ id: uuid(`${name}:${k}`), name: k, value: v, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' })) }, includeOtherFields: true, options: {} },
});
const codeNode = (name, pos, jsCode, mode = 'runOnceForAllItems') => add({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: mode === 'runOnceForAllItems' ? { jsCode } : { mode, jsCode },
});
const ifNode = (name, pos, expr) => add({
  name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: uuid(`${name}:cond`), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
});
const RC = `$('${N.resolveClinic}').first().json`;
const BASE = `={{ ${RC}.grist_base_url }}/api/docs/{{ ${RC}.doc_id }}/tables`;
// Reads continue on error: W13 – Build Context sees { error } and decides (fail safe). Writes say what failed.
const grist = (name, pos, o) => add({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: GRIST_CRED,
  onError: o.onError || 'continueRegularOutput',
  parameters: {
    ...(o.method ? { method: o.method } : {}),
    url: o.url || `${BASE}/${o.table}/records`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    ...(o.query ? { sendQuery: true, queryParameters: { parameters: o.query.map(([k, v]) => ({ name: k, value: v })) } } : {}),
    ...(o.body ? { sendBody: true, specifyBody: 'json', jsonBody: o.body } : {}),
    options: { timeout: 20000 },
  },
});
const execNode = (name, pos, workflowExpr, wait) => add({
  name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: pos, onError: 'continueRegularOutput',
  parameters: {
    workflowId: { __rl: true, value: workflowExpr, mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'each',
    options: wait ? {} : { waitForSubWorkflow: false },
  },
});
const sticky = (name, pos, w, hgt, color, content) => add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos, parameters: { content, width: w, height: hgt, color } });

// ---------------------------------------------------------------- SECTION A: entry points + Config
add({ name: N.called, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: at(0, 0), parameters: { inputSource: 'passthrough' } });
add({ name: N.manual, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: at(0, 3), parameters: {} });
codeNode(N.testMessages, at(1, 3), readCode('test-messages.js'));
execNode(N.runTests, at(2, 3), '={{ $workflow.id }}', true);
codeNode(N.testReport, at(3, 3), readCode('test-report.js'));
add({ name: N.morning, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(0, 5), parameters: { rule: { interval: [{ field: 'cronExpression', expression: '5 8 * * *' }] } } });
setNode(N.morningStart, at(1, 5), [['w13_morning', true]]);
setNode(N.config, at(2, 1), [
  ['grist_base_url', 'http://grist:8484'],
  ['registry_doc_id', 'REGISTRY_DOC_ID_PLACEHOLDER'],
  ['leads_table', 'LEADS'],                           // the live leads table (as in W1-W6 and W2)
  ...(OR ? [['model_provider', 'openrouter'], ['openrouter_model', OPENROUTER_MODEL]] : [['anthropic_model', 'claude-haiku-4-5']]),
  ['w12_workflow_id', W12_PLACEHOLDER],               // id of the workflow that contains W12 (the master workflow), from its URL
  ['min_confidence', 0.65],                           // below: a person answers
  ['confidence_auto', 0.8],                           // below (and >= min_confidence): informational answers only
  ['confidence_write', 0.85],                         // appointment changes (book / cancel / reschedule in Grist) need at least this
  ['max_ai_replies_per_hour', 6],
  ['history_limit', 12],
  ['slot_days', 7],
  ['pause_on_handoff', false],                        // true = a hand-off also ticks Automation_Paused (stops W5 / W6 follow-ups too)
  ['staff_alert_template', 'human_handoff_alert'],
]);
ifNode(N.isMorning, at(3, 1), '$json.w13_morning === true');

// ---------------------------------------------------------------- SECTION B: morning retry of deferred (night) messages
grist(N.morningClinics, at(4, 5), { onError: 'stopWorkflow', url: `={{ $json.grist_base_url }}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records` });
codeNode(N.activeClinics, at(5, 5), readCode('active-clinics.js'));
grist(N.deferred, at(6, 5), {
  url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Messages/records',
  query: [['filter', '={{ JSON.stringify({ AI_Status: ["deferred"] }) }}'], ['limit', '500']],
});
codeNode(N.pickRetries, at(7, 5), readCode('pick-retries.js'));
execNode(N.retryEach, at(8, 5), '={{ $workflow.id }}', true);

// ---------------------------------------------------------------- SECTION C: read everything (one message per run)
const ST = `$('${N.start}').first().json`;
codeNode(N.start, at(4, 1), withPhone('start.js'));
grist(N.clinics, at(5, 1), { onError: 'continueRegularOutput', url: `={{ ${ST}.grist_base_url }}/api/docs/{{ ${ST}.registry_doc_id }}/tables/Clinics/records` });
codeNode(N.resolveClinic, at(6, 1), readCode('resolve-clinic.js'));
ifNode(N.clinicOk, at(7, 1), '$json.clinic_ok === true');
codeNode(N.clinicRejected, at(8, 2), readCode('clinic-rejected.js'));
grist(N.settings, at(0, 9), { table: 'Settings' });
grist(N.knowledge, at(1, 9), { table: 'Knowledge' });
grist(N.message, at(2, 9), {
  table: 'Messages',
  query: [['filter', `={{ JSON.stringify(${ST}.message_row_id ? { id: [${ST}.message_row_id] } : ${ST}.wa_message_id ? { WA_Message_ID: [${ST}.wa_message_id] } : { id: [0] }) }}`]],
});
codeNode(N.convKey, at(3, 9), readCode('conversation-key.js'));
grist(N.conversation, at(4, 9), { table: 'Conversations', query: [['filter', '={{ JSON.stringify($json.conversation_filter) }}']] });
codeNode(N.leadKey, at(5, 9), readCode('lead-key.js'));
grist(N.lead, at(6, 9), { url: `={{ ${RC}.grist_base_url }}/api/docs/{{ ${RC}.doc_id }}/tables/{{ ${ST}.leads_table }}/records`, query: [['filter', '={{ JSON.stringify($json.lead_filter) }}']] });
grist(N.history, at(7, 9), {
  table: 'Messages',
  query: [['filter', `={{ JSON.stringify({ Conversation: [$('${N.leadKey}').first().json.conversation_id] }) }}`], ['sort', '-Created_At'], ['limit', '40']],
});
grist(N.appointments, at(8, 9), { table: 'Appointments', query: [['filter', '={{ JSON.stringify({ Status: ["Booked"] }) }}'], ['sort', '-Start'], ['limit', '500']] });
codeNode(N.context, at(9, 9), withLib('build-context.js'));

// ---------------------------------------------------------------- SECTION D: decide (Claude) and plan
const CTX = `$('${N.context}').first().json`;
ifNode(N.askAi, at(0, 13), "$json.gate.route === 'ai'");
ifNode(N.claim, at(1, 12), '$json.x.dry_run === false');
grist(N.claimMsg, at(2, 11), {
  table: 'Messages', method: 'PATCH', onError: 'continueErrorOutput',
  body: `={{ JSON.stringify({ records: [{ id: ${CTX}.x.msg.row_id, fields: { AI_Status: 'processing' } }] }) }}`,
});
codeNode(N.claimFailed, at(3, 11), readCode('claim-failed.js'));
// ---- PROVIDER LAYER: the only part that differs between the Anthropic workflow and the OpenRouter demo ----
// Both end in an Anthropic-shaped answer for W13 – Plan; same timeout, retries and "continue on error" (a failure = hand-off).
if (!OR) {
  add({
    name: N.claude, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at(3, 12), credentials: ANTHROPIC_CRED,
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify(${CTX}.request) }}`,
      options: { timeout: 45000 },
    },
  });
} else {
  codeNode(N.provReq, at(3, 12), withProvider('provider-request-openrouter.js'));
  add({
    name: N.askModel, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at(3, 13), credentials: OPENROUTER_CRED,
    onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
    parameters: {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Title', value: 'Clinic Autopilot (demo)' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 45000 },
    },
  });
  codeNode(N.provAns, at(3, 14), withProvider('provider-answer-openrouter.js'));
}
const ASK_IN = OR ? N.provReq : N.claude;     // where the provider layer starts
const ASK_OUT = OR ? N.provAns : N.claude;    // its Anthropic-shaped answer goes to W13 – Plan
codeNode(N.plan, at(4, 13), withLib('plan.js'));

// ---------------------------------------------------------------- SECTION E: act (appointments, W12 sends, CRM writes)
ifNode(N.actionWrites, at(5, 13), `$json.plan.action_writes.length > 0 && ${CTX}.x.dry_run === false`);
codeNode(N.splitActions, at(6, 12), readCode('split-action-writes.js'));
const writeNode = (name, pos) => grist(name, pos, {
  method: '={{ $json.method }}', url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/{{ $json.table }}/records',
  body: '={{ JSON.stringify($json.body) }}',
});
writeNode(N.writeAction, at(7, 12));
codeNode(N.checkActions, at(8, 12), readCode('check-action-writes.js'));
codeNode(N.planReady, at(9, 13), withLib('plan-ready.js'));
codeNode(N.splitSends, at(0, 17), readCode('split-sends.js'));
ifNode(N.sendQ, at(1, 17), "$json.w13_kind !== 'none'");
execNode(N.callW12, at(2, 16), `={{ ${ST}.w12_workflow_id }}`, true);
codeNode(N.recordSends, at(3, 17), withLib('record-sends.js'));
ifNode(N.writeQ, at(4, 17), "typeof $json.table === 'string'");
writeNode(N.writeCrm, at(5, 16));
codeNode(N.done, at(6, 17), readCode('done.js'));

// ---------------------------------------------------------------- notes
const W = 2560;
const DEMO_README = '## W13 DEMO – AI receptionist via OpenRouter (demo / testing only)\n' +
  'The SAME workflow as "W13 - AI receptionist" (same gates, checks, hand-offs, CRM writes, W12 sends, decision schema). Only the model provider differs: ' +
  '`W13 – Provider Request` turns the request into OpenRouter Chat Completions (same instructions, facts and JSON schema, strict) -> `W13 – Ask Model` (OpenRouter) -> ' +
  '`W13 – Provider Answer` turns the answer back into the shape `W13 – Plan` checks. The model never sends anything: W12 does, after every check.\n\n' +
  '**Fill after import:** credential **OpenRouter API** (Header Auth, Name `Authorization`, Value `Bearer <your OpenRouter key>`) on `W13 – Ask Model`; ' +
  '`W13 – Config` > `w12_workflow_id` = the master workflow\'s id; model: `W13 – Config` > `openrouter_model` (' + OPENROUTER_MODEL + ').\n\n' +
  '**Use ONE of the two:** point W2 – Config > `ai_workflow_id` at this workflow OR at W13, never activate both (both have the 08:05 run). ' +
  'Back to Anthropic later: put W13\'s id in W2 again.\n\n' +
  '**Test first:** save, then Execute workflow on `W13 – Manual Test` (dry run: real model call, nothing written or sent). See n8n/w13/README.md, section 6.';
sticky(`${P}Section 00 Read Me`, [-60, -720], 1500, 560, 5, OR ? DEMO_README :
  '## W13 – AI receptionist (WhatsApp lead replies)\n' +
  'W2 stores every patient message, then calls W13 once per message (without waiting). W13: reads the clinic, the message, the lead, the recent conversation, ' +
  'the knowledge base and the free appointment times -> **asks Claude for a decision** (JSON: intent, action, reply, confidence, needs_human...) -> **checks it in code** ' +
  '(no invented price / time / link; complaints, payments, medical, low confidence -> a person) -> writes the CRM -> sends through **W12** (free text inside WhatsApp\'s 24 h window; ' +
  'staff alert template for hand-offs). Claude never sends anything and never computes slots or prices.\n\n' +
  '**Fill after import:** credential **Anthropic API** (Header Auth, Name `x-api-key`, Value = your key) on `W13 – Ask Claude`; ' +
  '`W13 – Config` > `w12_workflow_id` = the id of the workflow that contains W12 (your master workflow); W2 – Config > `ai_workflow_id` = THIS workflow\'s id.\n\n' +
  '**Switch on per clinic:** Settings `ai_mode` = `draft` (AI decides, staff send) or `auto` (sent via W12). Missing = off. TEST_MODE / TEST_PHONE and W12\'s allowlist still apply.\n\n' +
  '**Test first:** save, then click Execute workflow on `W13 – Manual Test` (dry run: real Claude, nothing written or sent). See n8n/w13/README.md.');
sticky(`${P}Section A Entry`, [-60, -120], W, 1180, 7, '## SECTION A/B — ENTRY POINTS\n**When Called** (by W2, one message per run) · **Manual Test** (7 dry-run scenarios, each a separate run) · **Every Morning 08:05 IST** (messages that arrived 21:00-08:00 were deferred: the newest per conversation from the last 20 h is answered now).');
sticky(`${P}Section C Read`, [-60, 1460], W, 400, 6, '## SECTION C — READ (nothing is written here)\nClinic from the Agency Registry -> Settings, Knowledge, the message row, its conversation and lead, the last 40 messages, Booked appointments. A failed read is handled in Build Context (fail safe: no AI, no send).');
sticky(`${P}Section D Decide`, [-60, 1900], W, 560, 4, `## SECTION D — DECIDE\nGates first (already handled, STOP, ai_mode, opted out, paused, Needs_Human, newer message, night, media, rate limit). Then the message row is marked \`processing\` (no double replies) and ${OR ? 'the model (OpenRouter: Provider Request -> Ask Model -> Provider Answer)' : 'Claude'} answers with a JSON decision (structured output). W13 – Plan checks it and turns it into a plan; any doubt = hand-off to a person.`);
sticky(`${P}Section E Act`, [-60, 2620], W, 600, 3, '## SECTION E — ACT\nAppointment changes first (direct booking / WhatsApp-booked cancel); if they fail, the reply becomes a hand-off. Then W12 sends (send guard: Opted_Out, quiet hours, TEST_MODE). Then the CRM: message row (intent, action, status, reply), conversation (Last_Intent, Needs_Human), lead (stage, summary, Contacted, follow-up date) and Run_Log.');

// ---------------------------------------------------------------- connections
const connections = {};
const link = (from, to, out = 0) => {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= out) connections[from].main.push([]);
  connections[from].main[out].push({ node: to, type: 'main', index: 0 });
};
// A / B
link(N.called, N.config); link(N.morning, N.morningStart); link(N.morningStart, N.config);
link(N.manual, N.testMessages); link(N.testMessages, N.runTests); link(N.runTests, N.testReport);
link(N.config, N.isMorning); link(N.isMorning, N.morningClinics, 0); link(N.isMorning, N.start, 1);
link(N.morningClinics, N.activeClinics); link(N.activeClinics, N.deferred); link(N.deferred, N.pickRetries); link(N.pickRetries, N.retryEach);
// C
link(N.start, N.clinics); link(N.clinics, N.resolveClinic); link(N.resolveClinic, N.clinicOk);
link(N.clinicOk, N.settings, 0); link(N.clinicOk, N.clinicRejected, 1);
link(N.settings, N.knowledge); link(N.knowledge, N.message); link(N.message, N.convKey); link(N.convKey, N.conversation);
link(N.conversation, N.leadKey); link(N.leadKey, N.lead); link(N.lead, N.history); link(N.history, N.appointments); link(N.appointments, N.context);
// D
link(N.context, N.askAi); link(N.askAi, N.claim, 0); link(N.askAi, N.plan, 1);
link(N.claim, N.claimMsg, 0); link(N.claim, ASK_IN, 1);
link(N.claimMsg, ASK_IN, 0); link(N.claimMsg, N.claimFailed, 1); link(N.claimFailed, N.plan);
if (OR) { link(N.provReq, N.askModel); link(N.askModel, N.provAns); }
link(ASK_OUT, N.plan);
// E
link(N.plan, N.actionWrites); link(N.actionWrites, N.splitActions, 0); link(N.actionWrites, N.planReady, 1);
link(N.splitActions, N.writeAction); link(N.writeAction, N.checkActions); link(N.checkActions, N.planReady);
link(N.planReady, N.splitSends); link(N.splitSends, N.sendQ);
link(N.sendQ, N.callW12, 0); link(N.sendQ, N.recordSends, 1); link(N.callW12, N.recordSends);
link(N.recordSends, N.writeQ); link(N.writeQ, N.writeCrm, 0); link(N.writeQ, N.done, 1); link(N.writeCrm, N.done);

const workflow = {
  name: OR ? 'W13 DEMO - AI receptionist (OpenRouter)' : 'W13 - AI receptionist',
  nodes,
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1', binaryMode: 'separate', timezone: 'Asia/Kolkata', callerPolicy: 'workflowsFromSameOwner' },
  tags: [],
};
fs.writeFileSync(OUT, `${JSON.stringify(workflow, null, 2)}\n`);
const functional = nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
console.log(`wrote ${OUT}: ${nodes.length} nodes (${functional.length} functional + ${nodes.length - functional.length} notes)`);
