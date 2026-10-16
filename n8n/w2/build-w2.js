// Builds the STANDALONE W2 - WhatsApp Inbound workflow:   node n8n/w2/build-w2.js [--out <file>]
// Code-node sources live in n8n/w2/code/*.js (readable, testable); this script embeds them, wires the nodes and lays out the canvas.
// W2 sends nothing and never calls Meta. Its one link to another workflow: after a patient message is stored it starts W13 (AI
// receptionist) for that message WITHOUT waiting ("W2 – Hand To AI"), only when "W2 – Config" > ai_workflow_id holds a real workflow id
// (the shipped placeholder = off, W2 then behaves exactly as before). Its only credential is the existing Grist "Header Auth account 2".
// The Meta verify token is a PLACEHOLDER in "W2 – Verify Config" (paste your own after import).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, 'W2-WhatsApp-Inbound.json');
const CODE = path.join(__dirname, 'code');
const SNIPPETS = path.join(__dirname, '..', 'snippets');

const GRIST_CRED = { httpHeaderAuth: { id: '9J6XxrIQoFDcQZ0Y', name: 'Header Auth account 2' } };   // the existing Grist credential, by reference only
const VERIFY_PLACEHOLDER = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
const uuid = (seed) => {                       // deterministic ids: a rebuild gives the same ids
  const h = crypto.createHash('sha256').update(`w2:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const readCode = (f) => fs.readFileSync(path.join(CODE, f), 'utf8').replace(/\s+$/, '\n');
const phoneFunction = () => {                  // the SAME function as W12 / W1 (n8n/snippets/normalize-phone.js), copied verbatim at build time
  const src = fs.readFileSync(path.join(SNIPPETS, 'normalize-phone.js'), 'utf8');
  const start = src.indexOf('function normalizeIndianPhone');
  const end = src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
};

const P = 'W2 – ';
const N = {
  verifyHook: `${P}Webhook Verify`, verifyConfig: `${P}Verify Config`, checkToken: `${P}Check Verify Token`, verifyOk: `${P}Verify OK?`,
  respondChallenge: `${P}Respond Challenge`, respondForbidden: `${P}Respond Forbidden`,
  inboundHook: `${P}Webhook Inbound`, manual: `${P}Manual Test`, testCases: `${P}Test Cases`, config: `${P}Config`, parse: `${P}Parse Meta Event`,
  isWebhook: `${P}Webhook Source?`, respond: `${P}Respond`, validEvent: `${P}Valid Event?`, split: `${P}Split Messages`, loop: `${P}Loop Over Messages`,
  clinics: `${P}Clinics`, resolveClinic: `${P}Resolve Clinic`, clinicFound: `${P}Clinic Found?`, clinicRejected: `${P}Clinic Rejected`,
  normalize: `${P}Normalize Phone`, phoneValid: `${P}Phone Valid?`,
  checkDup: `${P}Check Duplicate Message`, readDup: `${P}Read Duplicate`, isDup: `${P}Duplicate?`,
  findLead: `${P}Find Lead`, readLead: `${P}Read Lead`, leadExists: `${P}Lead Exists?`, recentLeads: `${P}Recent Leads`, buildLead: `${P}Build New Lead`,
  createLead: `${P}Create Lead`, recheckLead: `${P}Recheck Lead`, readCreatedLead: `${P}Read Created Lead`, leadResolved: `${P}Lead Resolved?`, leadReady: `${P}Lead Ready`,
  findConv: `${P}Find Conversation`, readConv: `${P}Read Conversation`, convExists: `${P}Conversation Exists?`, createConv: `${P}Create Conversation`,
  recheckConv: `${P}Recheck Conversation`, readCreatedConv: `${P}Read Created Conversation`, convResolved: `${P}Conversation Resolved?`, convReady: `${P}Conversation Ready`,
  addMessage: `${P}Add Message`, messageSaved: `${P}Message Saved`, updateConv: `${P}Update Conversation`, staffAlert: `${P}Prepare Staff Alert`,
  buildLog: `${P}Build Run Log`, canLog: `${P}Can Log?`, runLog: `${P}Run Log`,
  aiWanted: `${P}AI Wanted?`, handToAi: `${P}Hand To AI`, aiHanded: `${P}AI Handed`,
};

// ---------------------------------------------------------------- node factories
const nodes = [];
const at = (col, row) => [col * 240, row * 176];
const add = (n) => { nodes.push({ ...n, id: uuid(n.name) }); };
const setNode = (name, pos, assignments) => add({
  name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos,
  parameters: { assignments: { assignments: assignments.map(([k, v, t]) => ({ id: uuid(`${name}:${k}`), name: k, value: v, type: t || (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string') })) }, includeOtherFields: true, options: {} },
});
const codeNode = (name, pos, jsCode, mode = 'runOnceForEachItem') => add({
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
const BASE = '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables';
const grist = (name, pos, o) => add({
  name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: GRIST_CRED,
  onError: o.onError || 'continueErrorOutput',          // output 1 = failed items (they go to "W2 – Build Run Log"); no retries, so no retry loops
  parameters: {
    ...(o.method ? { method: o.method } : {}),
    url: o.url || `${BASE}/${o.table}/records`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    ...(o.query ? { sendQuery: true, queryParameters: { parameters: o.query.map(([k, v]) => ({ name: k, value: v })) } } : {}),
    ...(o.body ? { sendBody: true, specifyBody: 'json', jsonBody: o.body } : {}),
    options: {},
  },
});
const respond = (name, pos, { body, code, type }) => add({
  name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: pos,
  parameters: { respondWith: 'text', responseBody: body, options: { responseCode: code, responseHeaders: { entries: [{ name: 'Content-Type', value: type }] } } },
});
const sticky = (name, pos, w, h, color, content) => add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos, parameters: { content, width: w, height: h, color } });

// ---------------------------------------------------------------- SECTION A: Meta webhook verification (GET)
add({ name: N.verifyHook, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0, 0), webhookId: uuid('webhook:verify'),
  parameters: { httpMethod: 'GET', path: 'whatsapp-inbound', responseMode: 'responseNode', options: {} } });
setNode(N.verifyConfig, at(1, 0), [['meta_verify_token', VERIFY_PLACEHOLDER]]);
codeNode(N.checkToken, at(2, 0), readCode('check-verify-token.js'));
ifNode(N.verifyOk, at(3, 0), '$json.ok === true');
respond(N.respondChallenge, at(4, 0), { body: '={{ $json.challenge }}', code: 200, type: 'text/plain' });
respond(N.respondForbidden, at(4, 1), { body: 'Verification failed', code: '={{ $json.status_code }}', type: 'text/plain' });

// ---------------------------------------------------------------- SECTION B: inbound entry (POST + manual test), parse, answer Meta
add({ name: N.inboundHook, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0, 4), webhookId: uuid('webhook:inbound'),
  parameters: { httpMethod: 'POST', path: 'whatsapp-inbound', responseMode: 'responseNode', options: {} } });
add({ name: N.manual, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: at(0, 6), parameters: {} });
codeNode(N.testCases, at(1, 6), readCode('test-cases.js'), 'runOnceForAllItems');
setNode(N.config, at(2, 5), [
  ['grist_base_url', 'http://grist:8484'],
  ['registry_doc_id', 'REGISTRY_DOC_ID_PLACEHOLDER'],
  ['leads_table', 'LEADS'],                              // the live table is LEADS (as in W1/W3/W4/W5/W6); change here if yours is named differently
  ['message_direction_in', 'In'],                        // grist/schema.md: Messages.Direction is a Choice "In" / "Out"
  ['message_status_in', 'Received'],                      // not in the schema's Status choices; add it to the Choice column in Grist, or change it here
  ['unread_mode', 'count'],                              // 'count' = Conversations.Unread is an Integer (schema.md); 'flag' = a Toggle
  ['message_sent_by', 'Patient'],
  ['default_lead_name', 'WhatsApp Lead'],
  ['ai_workflow_id', 'PASTE_W13_WORKFLOW_ID'],           // W13 - AI receptionist's id (from its URL); the placeholder = AI hand-off off
]);
codeNode(N.parse, at(3, 5), readCode('parse-meta-event.js'));
ifNode(N.isWebhook, at(4, 5), "$json.source === 'webhook'");
respond(N.respond, at(5, 4), { body: '={{ $json.response_body }}', code: '={{ $json.http_status }}', type: 'application/json' });
ifNode(N.validEvent, at(6, 5), "$json.kind === 'message'");
codeNode(N.split, at(7, 5), readCode('split-messages.js'), 'runOnceForAllItems');
add({ name: N.loop, type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: at(8, 5), parameters: { batchSize: 1, options: {} } });

// ---------------------------------------------------------------- SECTION C: clinic, phone, duplicate check
grist(N.clinics, at(0, 9), { url: `${'={{ $json.grist_base_url }}'}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records` });
codeNode(N.resolveClinic, at(1, 9), readCode('resolve-clinic.js'));
ifNode(N.clinicFound, at(2, 9), '$json.clinic_found === true');
codeNode(N.clinicRejected, at(2, 10), readCode('clinic-rejected.js'));
codeNode(N.normalize, at(3, 9), `// Pasted from n8n/snippets/normalize-phone.js (the same function W12 uses) - keep identical.\n${phoneFunction()}\n${readCode('normalize-phone.js')}`);
ifNode(N.phoneValid, at(4, 9), '$json.phone_valid === true');
grist(N.checkDup, at(5, 9), { table: 'Messages', query: [['filter', '={{ JSON.stringify({ WA_Message_ID: [$json.wa_message_id] }) }}'], ['limit', '1']] });
codeNode(N.readDup, at(6, 9), readCode('read-duplicate.js'));
ifNode(N.isDup, at(7, 9), '$json.is_duplicate === true');

// ---------------------------------------------------------------- SECTION D: lead
const LEADS = `${BASE}/{{ $json.leads_table }}/records`;
grist(N.findLead, at(0, 13), { url: LEADS, query: [['filter', '={{ JSON.stringify({ Phone: [$json.patient_phone] }) }}'], ['limit', '1']] });
codeNode(N.readLead, at(1, 13), readCode('read-lead.js'));
ifNode(N.leadExists, at(2, 13), '$json.lead_found === true');
grist(N.recentLeads, at(3, 14), { url: LEADS, query: [['sort', '-Created_At'], ['limit', '200']] });
codeNode(N.buildLead, at(4, 14), readCode('build-new-lead.js'));
grist(N.createLead, at(5, 14), { url: LEADS, method: 'POST', body: '={{ JSON.stringify($json.create) }}' });
const B = `$('${N.buildLead}').item.json`;
grist(N.recheckLead, at(6, 14), {
  url: `={{ ${B}.grist_base_url }}/api/docs/{{ ${B}.doc_id }}/tables/{{ ${B}.leads_table }}/records`,
  query: [['filter', `={{ JSON.stringify({ Phone: [${B}.patient_phone] }) }}`]],
});
codeNode(N.readCreatedLead, at(7, 14), readCode('read-created-lead.js'));
ifNode(N.leadResolved, at(8, 14), 'Number($json.lead_row_id) > 0');
codeNode(N.leadReady, at(9, 13), readCode('lead-ready.js'));

// ---------------------------------------------------------------- SECTION E: conversation, message
grist(N.findConv, at(0, 18), { table: 'Conversations', query: [['filter', '={{ JSON.stringify({ Phone: [$json.patient_phone] }) }}']] });
codeNode(N.readConv, at(1, 18), readCode('read-conversation.js'));
ifNode(N.convExists, at(2, 18), '$json.conversation_found === true');
grist(N.createConv, at(3, 19), { table: 'Conversations', method: 'POST', body: '={{ JSON.stringify({ records: [{ fields: { Phone: $json.patient_phone, Lead: $json.lead_row_id } }] }) }}' });
const C = `$('${N.readConv}').item.json`;
grist(N.recheckConv, at(4, 19), {
  url: `={{ ${C}.grist_base_url }}/api/docs/{{ ${C}.doc_id }}/tables/Conversations/records`,
  query: [['filter', `={{ JSON.stringify({ Phone: [${C}.patient_phone] }) }}`]],
});
codeNode(N.readCreatedConv, at(5, 19), readCode('read-created-conversation.js'));
ifNode(N.convResolved, at(6, 19), 'Number($json.conversation_id) > 0');
codeNode(N.convReady, at(7, 18), readCode('conversation-ready.js'));
grist(N.addMessage, at(0, 22), {
  table: 'Messages', method: 'POST',
  body: '={{ JSON.stringify({ records: [{ fields: { Conversation: $json.conversation_id, Direction: $json.message_direction_in, Body: $json.body_text, Sent_By: $json.message_sent_by, WA_Message_ID: $json.wa_message_id, Status: $json.message_status_in, Created_At: $json.msg_timestamp } }] }) }}',
});
codeNode(N.messageSaved, at(1, 22), readCode('message-saved.js'));
grist(N.updateConv, at(2, 22), { table: 'Conversations', method: 'PATCH', body: '={{ JSON.stringify($json.conv_update) }}' });

// ---------------------------------------------------------------- SECTION F: staff alert (payload only) + Run_Log
codeNode(N.staffAlert, at(3, 22), readCode('prepare-staff-alert.js'));
// W13 gets the stored message (not for the manual test's fake data). Fire and forget: Meta's 200 was already sent, W2 moves on.
ifNode(N.aiWanted, at(4, 22), "$json.run_outcome === 'ok' && !$json.test_case && /^[A-Za-z0-9]{8,32}$/.test(String($json.ai_workflow_id || ''))");
add({
  name: N.handToAi, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: at(5, 21), onError: 'continueRegularOutput',
  parameters: {
    workflowId: { __rl: true, value: '={{ $json.ai_workflow_id }}', mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'each',
    options: { waitForSubWorkflow: false },
  },
});
codeNode(N.aiHanded, at(6, 21), readCode('ai-handed.js'));
codeNode(N.buildLog, at(7, 22), readCode('build-run-log.js'));
ifNode(N.canLog, at(8, 22), '$json.can_log === true');
grist(N.runLog, at(9, 22), { table: 'Run_Log', method: 'POST', onError: 'continueRegularOutput', body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });

// ---------------------------------------------------------------- notes (sections)
const W = 2500;
sticky(`${P}Section 00 Read Me`, [-60, -560], 1180, 400, 5,
  `## W2 – WhatsApp Inbound (STANDALONE)\nMeta WhatsApp Cloud API -> n8n -> the clinic's Grist CRM. **Not connected to any other workflow.** Sends nothing to WhatsApp.\n\n` +
  `**Webhook:** GET + POST \`/webhook/whatsapp-inbound\` (test URL: \`/webhook-test/whatsapp-inbound\`). Meta needs the PRODUCTION URL, so the workflow must be **Active**.\n\n` +
  `**Fill after import:** \`W2 – Verify Config\` > meta_verify_token (any string you choose; paste the SAME string in Meta). Nothing else is secret: Grist uses the existing credential "Header Auth account 2".\n\n` +
  `**Check in \`W2 – Config\`:** leads_table (LEADS), message_direction_in (In), message_status_in (Received), unread_mode (count). These follow grist/schema.md; see the README.\n\n` +
  `**Test first:** click Execute workflow on \`W2 – Manual Test\` (fake data only), then see README.md.\n\n` +
  `**Safe by design:** answers Meta 200 first, then processes one message at a time; duplicates (same WA_Message_ID) change nothing; no deletes; failures go to Run_Log.`);
sticky(`${P}Section A Verify`, [-60, -80], W, 400, 7, '## SECTION A — META WEBHOOK VERIFY (GET)\nMeta calls this once when you save the webhook. It sends hub.mode, hub.verify_token and hub.challenge. The token must match "W2 – Verify Config"; then the challenge is echoed back as plain text. A wrong or unconfigured token answers 403.');
sticky(`${P}Section B Inbound`, [-60, 620], W, 620, 4, '## SECTION B — INBOUND POST + MANUAL TEST\nMeta POST (or the manual test data) -> Config -> Parse. Webhook calls are answered right away (200 for anything Meta-shaped, 400 for garbage), then processing continues. Delivery receipts and other events are ignored. Messages are processed ONE AT A TIME.');
sticky(`${P}Section C Clinic`, [-60, 1500], W, 400, 6, '## SECTION C — CLINIC, PHONE, DUPLICATE CHECK\nphone_number_id -> Agency Registry Clinics (Active must be TRUE) -> unknown / inactive clinic stops here. Sender -> +91XXXXXXXXXX. Same WA_Message_ID already in Messages = duplicate: nothing is created.');
sticky(`${P}Section D Lead`, [-60, 2200], W, 400, 3, '## SECTION D — LEAD\nFind the lead by normalized phone; if none, create one (Source WhatsApp, Status New, Lead_id L-YYYYMMDD-NNNN). After creating, look again: parallel messages from one new patient converge on the lowest row id.');
sticky(`${P}Section E Conversation`, [-60, 3040], W, 420, 2, '## SECTION E — CONVERSATION\nFind the conversation by normalized phone; if none, create it (Phone + Lead). After creating, look again: parallel messages converge on the lowest row id.');
sticky(`${P}Section F Message and Log`, [-60, 3780], W, 420, 5, '## SECTION F — MESSAGE, STAFF ALERT PAYLOAD, RUN_LOG\nAdd the Messages row (Direction In, WA_Message_ID), then update Last_Inbound_At / Unread (Automation_Paused and Assigned_To are never touched). A new lead prepares a staff-alert payload for W12 (decision.send = false: NOT sent from here). Every message ends in one Run_Log row: ok, skipped (duplicate, bad number) or failed (with the reason). A failing Run_Log write ends quietly: no retries, no loops.');
sticky(`${P}Section G AI`, [-60, 4260], W, 260, 7, '## SECTION G — AI RECEPTIONIST (W13)\nEvery stored patient message is handed to W13 (one run per message, W2 does not wait). W13 decides with Claude, writes the CRM and replies through W12. Off until W2 – Config > ai_workflow_id is set (and the clinic has Settings ai_mode). The new-lead staff-alert payload is still prepared only (not sent).');

// ---------------------------------------------------------------- connections
const connections = {};
const link = (from, to, out = 0) => {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= out) connections[from].main.push([]);
  connections[from].main[out].push({ node: to, type: 'main', index: 0 });
};
// A
link(N.verifyHook, N.verifyConfig); link(N.verifyConfig, N.checkToken); link(N.checkToken, N.verifyOk);
link(N.verifyOk, N.respondChallenge, 0); link(N.verifyOk, N.respondForbidden, 1);
// B
link(N.inboundHook, N.config); link(N.manual, N.testCases); link(N.testCases, N.config);
link(N.config, N.parse); link(N.parse, N.isWebhook);
link(N.isWebhook, N.respond, 0); link(N.isWebhook, N.validEvent, 1); link(N.respond, N.validEvent);
link(N.validEvent, N.split, 0); link(N.split, N.loop);
link(N.loop, N.clinics, 1);
// C
link(N.clinics, N.resolveClinic, 0); link(N.clinics, N.buildLog, 1);
link(N.resolveClinic, N.clinicFound);
link(N.clinicFound, N.normalize, 0); link(N.clinicFound, N.clinicRejected, 1); link(N.clinicRejected, N.loop);
link(N.normalize, N.phoneValid);
link(N.phoneValid, N.checkDup, 0); link(N.phoneValid, N.buildLog, 1);
link(N.checkDup, N.readDup, 0); link(N.checkDup, N.buildLog, 1);
link(N.readDup, N.isDup);
link(N.isDup, N.buildLog, 0); link(N.isDup, N.findLead, 1);
// D
link(N.findLead, N.readLead, 0); link(N.findLead, N.buildLog, 1);
link(N.readLead, N.leadExists);
link(N.leadExists, N.leadReady, 0); link(N.leadExists, N.recentLeads, 1);
link(N.recentLeads, N.buildLead, 0); link(N.recentLeads, N.buildLog, 1);
link(N.buildLead, N.createLead);
link(N.createLead, N.recheckLead, 0); link(N.createLead, N.buildLog, 1);
link(N.recheckLead, N.readCreatedLead, 0); link(N.recheckLead, N.buildLog, 1);
link(N.readCreatedLead, N.leadResolved);
link(N.leadResolved, N.leadReady, 0); link(N.leadResolved, N.buildLog, 1);
link(N.leadReady, N.findConv);
// E
link(N.findConv, N.readConv, 0); link(N.findConv, N.buildLog, 1);
link(N.readConv, N.convExists);
link(N.convExists, N.convReady, 0); link(N.convExists, N.createConv, 1);
link(N.createConv, N.recheckConv, 0); link(N.createConv, N.buildLog, 1);
link(N.recheckConv, N.readCreatedConv, 0); link(N.recheckConv, N.buildLog, 1);
link(N.readCreatedConv, N.convResolved);
link(N.convResolved, N.convReady, 0); link(N.convResolved, N.buildLog, 1);
link(N.convReady, N.addMessage);
link(N.addMessage, N.messageSaved, 0); link(N.addMessage, N.buildLog, 1);
link(N.messageSaved, N.updateConv);
link(N.updateConv, N.staffAlert, 0); link(N.updateConv, N.buildLog, 1);
// F
link(N.staffAlert, N.aiWanted); link(N.aiWanted, N.handToAi, 0); link(N.aiWanted, N.buildLog, 1);
link(N.handToAi, N.aiHanded); link(N.aiHanded, N.buildLog);
link(N.buildLog, N.canLog);
link(N.canLog, N.runLog, 0); link(N.canLog, N.loop, 1);
link(N.runLog, N.loop);

const workflow = {
  name: 'W2 - WhatsApp inbound (standalone)',
  nodes,
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1', binaryMode: 'separate' },
  tags: [],
};
fs.writeFileSync(OUT, `${JSON.stringify(workflow, null, 2)}\n`);
const functional = nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
console.log(`wrote ${OUT}: ${nodes.length} nodes (${functional.length} functional + ${nodes.length - functional.length} notes)`);
