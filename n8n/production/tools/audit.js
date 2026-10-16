#!/usr/bin/env node
// Production audit of a Clinic Autopilot n8n export. Every finding of the audit is a CHECK with an id, a severity and evidence taken from the file.
//   node n8n/production/tools/audit.js --in <workflow.json> [--json out.json] [--md out.md] [--compose docker-compose.yml --caddy Caddyfile]
//   exit code 0 always; --fail-on P0|P1|P2|P3 exits 1 when an OPEN finding of that severity (or worse) remains.
// A finding is OPEN when the problem is present in the file. Positive checks (things done right) are reported as OK with the evidence.
// Evidence never contains a secret: values are described by length only.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
if (!IN) { console.error('usage: node audit.js --in <workflow.json> [--json out.json] [--md out.md] [--compose file --caddy file] [--fail-on P0|P1|P2|P3]'); process.exit(1); }

const SEV = ['P0', 'P1', 'P2', 'P3'];
function audit(wf, opts = {}) {
  const N = wf.nodes;
  const by = new Map(N.map((n) => [n.name, n]));
  const real = N.filter((n) => !n.type.endsWith('stickyNote'));
  const conn = wf.connections || {};
  const edges = [];
  for (const [from, v] of Object.entries(conn)) for (const out of (v.main || [])) for (const t of (out || [])) edges.push([from, t.node]);
  const outgoing = new Map(); const incoming = new Map();
  for (const [a, b] of edges) { (outgoing.get(a) || outgoing.set(a, []).get(a)).push(b); (incoming.get(b) || incoming.set(b, []).get(b)).push(a); }
  const typeOf = (n) => n.type.replace('n8n-nodes-base.', '');
  const code = (n) => (n.parameters && n.parameters.jsCode) || '';
  const section = (n) => { const m = n.name.match(/^(W\d+|MCC|REQ|E1)\b/); return m ? m[1] : 'other'; };
  const assignments = (n) => ((n.parameters || {}).assignments || {}).assignments || [];
  const results = [];
  const add = (id, sev, area, title, open, evidence, fix) => results.push({ id, severity: sev, area, title, status: open ? 'OPEN' : 'OK', evidence: [].concat(evidence || []).slice(0, 12), fix: fix || '' });
  const isExpr = (v) => typeof v === 'string' && v.startsWith('=');
  const lit = (v) => typeof v === 'string' ? (v.length ? `${v.length} chars` : 'empty') : String(v);

  // ------------------------------------------------------------------ A. structure
  const triggers = real.filter((n) => /Trigger$|webhook$/.test(n.type));
  const sections = {};
  for (const n of real) sections[section(n)] = (sections[section(n)] || 0) + 1;
  add('S01', 'P3', 'A structure', 'Inventory', false, [`${N.length} nodes (${real.length} executable + ${N.length - real.length} sticky notes), ${Object.keys(conn).length} connection sources, active=${wf.active}`,
    `sections: ${Object.entries(sections).map(([k, v]) => `${k}=${v}`).join(' ')}`, `triggers: ${triggers.map((n) => typeOf(n)).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}) && JSON.stringify(triggers.map((n) => typeOf(n)).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}))}`]);

  const execs = real.filter((n) => n.type.endsWith('executeWorkflow'));
  const badExec = execs.filter((n) => { const id = (n.parameters || {}).workflowId; const v = id && id.value !== undefined ? id.value : id; return !(typeof v === 'string' && /\$workflow\.id|w12_workflow_id/.test(v)); });
  const trigCount = real.filter((n) => n.type.endsWith('executeWorkflowTrigger')).length;
  add('S02', 'P1', 'A structure', 'Every Execute Workflow node targets a workflow that exists and has an Execute Workflow Trigger', badExec.length > 0 || trigCount !== 1,
    [`${execs.length} Execute Workflow nodes, ${trigCount} Execute Workflow Trigger node(s)`, `${execs.length - badExec.length} target "$workflow.id" (this same workflow, valid under any import id)`, ...badExec.map((n) => `literal/unknown target: ${n.name}`)]);

  const reach = new Set(triggers.map((n) => n.name)); const q = [...reach];
  while (q.length) { const x = q.pop(); for (const y of (outgoing.get(x) || [])) if (!reach.has(y)) { reach.add(y); q.push(y); } }
  const unreachable = real.filter((n) => !reach.has(n.name));
  add('S03', 'P2', 'A structure', 'Unreachable nodes (no trigger can ever reach them)', unreachable.length > 0, unreachable.map((n) => n.name));

  const deadTriggers = triggers.filter((n) => !(outgoing.get(n.name) || []).length);
  add('S04', 'P2', 'A structure', 'Triggers that lead nowhere (a registered webhook/schedule that does nothing)', deadTriggers.length > 0, deadTriggers.map((n) => `${n.name} (${typeOf(n)}${n.parameters.path ? ` /${n.parameters.path}` : ''})`),
    'Remove after confirming nothing calls it (W4 – Webhook /cal-w4-test).');

  const hooks = real.filter((n) => n.type.endsWith('.webhook'));
  const seen = new Map(); const dups = [];
  for (const h of hooks) { const k = `${h.parameters.httpMethod || 'GET'} ${h.parameters.path}`; if (seen.has(k)) dups.push(k); seen.set(k, h.name); }
  add('S05', 'P1', 'A structure', 'Duplicate webhook method+path', dups.length > 0, dups.length ? dups : hooks.map((h) => `${h.parameters.httpMethod || 'GET'} /${h.parameters.path} (${h.name})`));

  add('S06', 'P0', 'A structure', 'Export is ACTIVE: importing it into a fresh n8n starts listening/sending before configuration is tested', wf.active === true,
    [`active=${wf.active}`], 'Export with active=false; activate only after configuration, templates and tests.');

  const missingRefs = [];
  const nameRe = /\$\(\s*['"]([^'"]+)['"]\s*\)|\$node\[\s*['"]([^'"]+)['"]\s*\]/g;
  for (const n of N) {
    const texts = [];
    (function walk(o) { if (typeof o === 'string') texts.push(o); else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v); })(n.parameters || {});
    for (const t of texts) { let m; nameRe.lastIndex = 0; while ((m = nameRe.exec(t))) { const nm = m[1] || m[2]; if (!by.has(nm)) missingRefs.push(`${n.name} -> "${nm}"`); } }
  }
  add('S07', 'P1', 'A structure', 'Expressions/code that reference a node name that does not exist', missingRefs.length > 0, [...new Set(missingRefs)]);

  // cycles through main connections, ignoring loops that pass through a Split In Batches node
  const color = new Map(); const cyc = [];
  const dfs = (x, stack) => {
    color.set(x, 1);
    for (const y of (outgoing.get(x) || [])) {
      if (by.get(y) && by.get(y).type.endsWith('splitInBatches')) continue;
      if (color.get(y) === 1) cyc.push([...stack, x, y].slice(-4).join(' -> ')); else if (!color.get(y)) dfs(y, [...stack, x]);
    }
    color.set(x, 2);
  };
  for (const n of real) if (!color.get(n.name)) dfs(n.name, []);
  add('S08', 'P1', 'A structure', 'Accidental circular execution (cycle not guarded by a batch loop)', cyc.length > 0, cyc);

  const st = wf.settings || {};
  add('S09', 'P2', 'A structure', 'Workflow settings: time zone, error handling and execution-data retention are not set in the file', !st.timezone || st.saveDataSuccessExecution === undefined,
    [`settings=${JSON.stringify(st)}`, 'every schedule (W3 10 min, W5 15 min, W6 10:00, W7/W8 hourly, W9 Mon 09:00, W10 1 min, W13 08:05) runs in the INSTANCE time zone unless the workflow sets one',
      'successful executions (which contain patient phone numbers and message text) are kept per the instance default'],
    'Set settings.timezone, saveDataSuccessExecution=none, executionTimeout.');

  const early = hooks.filter((h) => (h.parameters.responseMode || 'onReceived') === 'onReceived');
  add('S10', 'P1', 'A structure', 'Webhooks that answer 200 BEFORE any validation or storage ("onReceived")', early.length > 0, early.map((h) => `${h.name} (${h.parameters.httpMethod} /${h.parameters.path})`),
    'Use "Respond to Webhook" after the real outcome is known.');

  // a webhook counts as authenticated when n8n authenticates it, or when the workflow itself verifies the sender (signature / verify token) on that path
  const SELF_AUTH = { 'POST whatsapp-inbound': 'W2 – Verify Signature', 'GET whatsapp-inbound': 'W2 – Check Verify Token', 'POST cal': 'W4 – Verify & parse' };
  const noAuth = hooks.filter((h) => (h.parameters.authentication || 'none') === 'none' && !(SELF_AUTH[`${h.parameters.httpMethod || 'GET'} ${h.parameters.path}`] && by.has(SELF_AUTH[`${h.parameters.httpMethod || 'GET'} ${h.parameters.path}`]) && ((h.parameters.path === 'cal') ? !!by.get('W4 – Verify & parse') && /rawBody|raw body/i.test(JSON.stringify(h.parameters) + code(by.get('W4 – Verify & parse'))) : true)));
  add('S11', 'P1', 'B-E public endpoints', 'Public webhooks with no n8n authentication (must authenticate in the workflow itself)', noAuth.length > 0,
    noAuth.map((h) => `${h.name} (${h.parameters.httpMethod || 'GET'} /${h.parameters.path})`),
    'Verify the sender inside the workflow (W2: X-Hub-Signature-256 / verify token; W4: HMAC over the raw body).');

  // ------------------------------------------------------------------ Q. quiet hours
  const qh = real.filter((n) => /DISABLE_QUIET_HOURS_FOR_TEST\s*=\s*true/.test(code(n)));
  add('Q01', 'P0', 'Q quiet hours', 'The TEMPORARY quiet-hours test switch is ON: messages can go to patients between 21:00 and 08:00 IST (CLAUDE.md rule 5)', qh.length > 0, qh.map((n) => `${n.name}: DISABLE_QUIET_HOURS_FOR_TEST = true`),
    'Set DISABLE_QUIET_HOURS_FOR_TEST = false (or remove the switch) before any live use.');

  // ------------------------------------------------------------------ B. W1
  const w1 = by.get('W1 – Staff alert (stub)');
  add('B01', 'P0', 'B W1', 'Staff alert is a STUB: the message is built, nothing is delivered, and the run is logged as done', !!w1,
    w1 ? ['node "W1 – Staff alert (stub)" is a Code node with no send; it feeds "W1 – Write Run_Log"'] : []);
  const w1hook = by.get('W1 – Webhook');
  add('B02', 'P0', 'B W1', 'Website enquiry is acknowledged (200) before it is validated or stored', !!(w1hook && (w1hook.parameters.responseMode || 'onReceived') === 'onReceived'),
    w1hook ? [`W1 – Webhook responseMode=${w1hook.parameters.responseMode || 'onReceived'}; "W1 – Create lead" runs AFTER the response, so the website is told success even if storage fails`] : []);
  add('B03', 'P1', 'B/T W1 email', 'No email gateway anywhere (no Send Email / SMTP node)', !real.some((n) => /emailSend|smtp|gmail|sendGrid|mailgun/i.test(n.type)), ['no email node in the workflow']);
  const prepLead = by.get('W1 – Prepare lead');
  add('B04', 'P1', 'B/S W1 consent', 'W1 does not capture consent (source, timestamp, status) for WhatsApp/email contact', prepLead ? !/consent/i.test(code(prepLead)) : true,
    ['"W1 – Prepare lead" has no consent field; the CRM only has Leads.Opted_Out']);

  // ------------------------------------------------------------------ C. W2
  const sigNode = real.find((n) => /x-hub-signature-256/i.test(code(n)));
  const inbound = by.get('W2 – Webhook Inbound');
  add('C01', 'P0', 'C W2', 'Inbound WhatsApp POST is not authenticated: no X-Hub-Signature-256 check, so any caller can inject "patient" messages', !sigNode,
    sigNode ? [`signature check in "${sigNode.name}"`, `Raw Body option: ${!!(inbound && inbound.parameters.options && inbound.parameters.options.rawBody)}`] : ['no node reads x-hub-signature-256; "W2 – Webhook Inbound" goes straight to "W2 – Config"']);
  const vcfg = by.get('W2 – Verify Config');
  const vtoken = vcfg && assignments(vcfg).find((a) => a.name === 'meta_verify_token');
  add('C02', 'P0', 'C/O W2', 'Meta verify token is a literal inside the workflow (Set node), so it is in every export, backup and screenshot', !!(vtoken && !isExpr(vtoken.value) && String(vtoken.value).length),
    vtoken ? [`W2 – Verify Config > meta_verify_token: ${lit(vtoken.value)}`] : []);
  const parse = by.get('W2 – Parse Meta Event');
  const statusWriters = real.filter((n) => section(n) === 'W2' && /Status:\s*['"](delivered|read|failed)/.test(code(n)));
  add('C03', 'P1', 'C/M W2', 'Delivery receipts (statuses[]) are counted but never stored: "accepted by Meta" is never upgraded to delivered/read/failed', !!(parse && /statuses_seen/.test(code(parse))) && statusWriters.length === 0,
    ['"W2 – Parse Meta Event" returns statuses_seen only; no W2 node writes a delivered/read/failed status']);
  add('C04', 'P3', 'C W2', 'Webhook handshake (GET) and message de-duplication are present', false,
    [`GET verify path: ${by.has('W2 – Check Verify Token')}`, `duplicate check by WA_Message_ID: ${by.has('W2 – Check Duplicate Message')}`, 'clinic is resolved from metadata.phone_number_id through the Agency Registry, never from a sender-supplied slug']);

  // ------------------------------------------------------------------ D. W3/W5/W6 messaging
  const helloUsers = real.filter((n) => /const template = 'hello_world'|template = 'hello_world'/.test(code(n)));
  add('D01', 'P0', 'D/F/G W3 W5 W6', "Production messages use Meta's sample template 'hello_world' (patients would receive \"Hello World\")", helloUsers.length > 0, helloUsers.map((n) => n.name),
    'Use approved templates chosen by configuration; send nothing when none is configured.');
  const w3cfg = by.get('W3 – Config'); const tp = w3cfg && assignments(w3cfg).find((a) => a.name === 'test_phone');
  add('D02', 'P1', 'D/O W3', 'A test phone number is stored as a literal in W3 – Config', !!(tp && !isExpr(tp.value) && String(tp.value).length), tp ? [`W3 – Config > test_phone: ${lit(tp.value)}`] : []);
  const staleStub = N.filter((n) => n.type.endsWith('stickyNote') && /is (still )?a STUB|Today the send is a STUB|Messages are a STUB/i.test((n.parameters || {}).content || ''));
  add('D03', 'P2', 'D-G docs', 'Sticky notes still say "the send is a STUB" although the sections already call W12 (misleading to the operator)', staleStub.length > 0, staleStub.map((n) => n.name));
  const direct = (name, call, flag) => { const k = by.get(name); return !!k; };
  const claimBefore = (callName, buildName) => { const b = by.get(buildName); const o = (outgoing.get(buildName) || [])[0]; return !!(o && /Claim|claim/.test(o)); };
  const noClaim = [['W3 – Build Message', 'W3'], ['W5 – Code in JavaScript', 'W5'], ['W6 – Build Message', 'W6']].filter(([b]) => !claimBefore('', b)).map(([b, s]) => s);
  add('D04', 'P1', 'D/F/G W3 W5 W6', 'Sent-flag is written AFTER the send, with no claim before it: two overlapping runs or a retry can send the same message twice', noClaim.length > 0 && !by.has('W12 – Ledger claim'),
    noClaim.map((s) => `${s}: Build Message -> Call W12 -> Sent? -> flag (W7, W8 and W10 claim first)`), 'Central idempotency in W12 (claim a row keyed by the message before calling Meta).');

  // ------------------------------------------------------------------ E. W4
  const w4test = by.get('W4 – Webhook');
  add('E01', 'P1', 'E W4', 'Obsolete unauthenticated test webhook /cal-w4-test is registered and connected to nothing', !!(w4test && w4test.parameters.path === 'cal-w4-test'),
    w4test ? [`W4 – Webhook POST /${w4test.parameters.path}, auth=${w4test.parameters.authentication || 'none'}, outgoing connections=${(outgoing.get('W4 – Webhook') || []).length}`] : []);
  const w4v = by.get('W4 – Verify & parse'); const w4h = by.get('W4 – Webhook1');
  add('E02', 'P1', 'E W4', 'Cal.com HMAC is computed over JSON.stringify(parsed body), not the exact raw bytes', !!(w4v && /JSON\.stringify\(body\)/.test(code(w4v)) && !(w4h && w4h.parameters.options && w4h.parameters.options.rawBody)),
    ['"W4 – Verify & parse" signs a re-serialisation; "W4 – Webhook1" has no Raw Body option'], 'Enable Raw Body and verify the received bytes.');
  add('E03', 'P0', 'E W4', 'Cal.com webhook is answered 200 before the signature is checked ("onReceived"), so a forged or failed booking looks accepted', !!(w4h && (w4h.parameters.responseMode || 'onReceived') === 'onReceived'),
    ['"W4 – Webhook1" responseMode=onReceived; a bad signature only ends in a stop-and-error node after the 200']);
  const w4plan = by.get('W4 – Plan writes');
  add('E04', 'P1', 'E W4', 'Booking confirmation is a STUB: no WhatsApp confirmation is ever sent', !!(w4plan && /stub:\s*true/.test(code(w4plan))), ['"W4 – Plan writes" builds the confirmation with stub: true; W4 has no Call W12 node']);
  add('E05', 'P2', 'E W4', 'No replay window (event time is not checked) and no explicit time-zone handling in W4', !!(w4v && !/createdAt|replay|stale/i.test(code(w4v))), ['"W4 – Verify & parse" does not look at the event time']);

  // ------------------------------------------------------------------ F-K policy checks (positives recorded)
  add('F01', 'P3', 'F W5', 'W5 reminder: schedule every 15 min; sent flag set after send (see D04)', false, ['W5 – Every 15 minutes', 'flags R24_Sent / R2_Sent']);
  const w6cfg = by.get('W6 – Config'); const ml = w6cfg && assignments(w6cfg).find((a) => a.name === 'mark_lost');
  add('G01', 'P3', 'G W6', 'mark_lost is disabled (leads are never marked lost automatically)', !!(ml && String(ml.value) !== 'false'), [ml ? `mark_lost=${ml.value}` : 'mark_lost not found']);
  add('H01', 'P3', 'H W7', 'W7 claims Outcome_Sent before sending; honours Needs_Human / opt-out', false, [`claim node present: ${by.has('W7 – Claim Outcome_Sent')}`]);
  const w8plan = by.get('W8 – Plan');
  add('I01', 'P3', 'I W8', 'Review requests are not filtered by mood and need an https review_link (no deceptive review gating)', !!(w8plan && !/NO filter on mood/i.test(code(w8plan))), ['W8 – Plan: "Deliberately NO filter on mood, outcome"; review link must be https']);
  add('K01', 'P3', 'K W10', 'W10 claims the staff reply row before sending and stops on opt-out / invalid phone / closed 24 h window', false, [`claim node present: ${by.has('W10 – Claim row')}`]);
  const w9 = by.get('W9 – Ask Model');
  add('J01', 'P1', 'J W9', 'W9 sends the weekly metrics to an external AI provider (OpenRouter)', !!w9 && !by.has('W9 – External AI?'), w9 ? [`W9 – Ask Model -> ${String(w9.parameters.url).slice(0, 60)}`] : []);
  const w11 = by.get('W11 – Telegram alert'); const w11c = by.get('W11 – Config');
  const chat = w11c && assignments(w11c).find((a) => a.name === 'telegram_chat_id');
  add('L01', 'P2', 'L W11', 'W11 alert hides tokens/digits but the Telegram chat id is a literal in the Config node', !!(chat && !isExpr(chat.value)), [chat ? `telegram_chat_id: ${lit(chat.value)}` : '']);
  add('L02', 'P3', 'L W11', 'W11 covers the whole workflow because it is one workflow with an Error Trigger (n8n runs a workflow that contains an Error Trigger as its own error workflow)', false, ['Error Trigger present', 'Telegram retried 3 times', 'alerts are throttled and masked']);

  // ------------------------------------------------------------------ M. W12
  const w12cfg = by.get('W12 – Config'); const unc = w12cfg && assignments(w12cfg).find((a) => a.name === 'w12_uncertain_counts_as_sent');
  add('M01', 'P0', 'M W12', 'A timeout / unclear Meta answer counts as SENT (w12_uncertain_counts_as_sent=true): the lead is marked contacted and staff are told it was sent', !!(unc && String(unc.value) === 'true'), unc ? [`w12_uncertain_counts_as_sent=${unc.value}`] : []);
  const gv = w12cfg && assignments(w12cfg).find((a) => a.name === 'w12_graph_api_version');
  add('M02', 'P2', 'M W12', 'Graph API version is a literal in the node (verify it is still supported before go-live)', !!(gv && !isExpr(gv.value)), gv ? [`w12_graph_api_version=${gv.value}`] : []);
  const guard = real.find((n) => section(n) === 'W12' && /Idem|Duplicate|dedupe|Ledger claim/i.test(n.name));
  add('M03', 'P1', 'M W12', 'No central idempotency in W12: nothing stops the same message being sent twice by a retry or a parallel run', !guard, ['no W12 node checks for an earlier send of the same message']);
  const metaSend = by.get('W12 – Meta send');
  add('M04', 'P3', 'M W12', 'Meta send: timeout 15 s, no automatic retry, errors do not throw (neverError), classified accepted / rejected / uncertain', false,
    [`timeout=${metaSend && metaSend.parameters.options.timeout}`, `retryOnFail=${metaSend && metaSend.retryOnFail}`]);
  const uncertain = ['W12 – Read reply'].some((n) => by.has(n) && /uncertain/.test(code(by.get(n))));
  add('M05', 'P1', 'M W12', 'Uncertain sends cannot be reconciled: no callback data is sent with the message, and statuses are ignored (C03)', uncertain && !real.some((n) => /biz_opaque_callback_data/.test(code(n))), ['no biz_opaque_callback_data in the send request']);

  // ------------------------------------------------------------------ N. W13 AI
  const ask = by.get('W13 – Ask Model');
  add('N01', 'P0', 'N/P W13', 'TLS certificate verification is switched OFF for the model request (allowUnauthorizedCerts=true): a man-in-the-middle could read patient text and API key', !!(ask && ask.parameters.options && ask.parameters.options.allowUnauthorizedCerts === true), ['W13 – Ask Model options.allowUnauthorizedCerts=true']);
  const ctx = by.get('W13 – Build Context');
  add('N02', 'P0', 'N W13', 'Patient name, earlier AI summary, first enquiry, appointments and the last conversation messages are sent to an external AI provider without redaction', !!(ctx && /name: \$\{l\.name/.test(code(ctx)) && !real.some((n) => /redactForAi|aiRedact|fhqRedactRequest/.test(code(n)))),
    ['aiFacts() puts "PATIENT - name", "earlier summary", "first enquiry" and RECENT CONVERSATION into the prompt', 'W13 – Provider Request sends it to openrouter.ai unchanged']);
  const w13cfg = by.get('W13 – Config'); const cap = w13cfg && assignments(w13cfg).find((a) => a.name === 'max_ai_replies_per_hour');
  add('N03', 'P1', 'N W13', 'AI reply rate limit is effectively off', !!(cap && Number(cap.value) > 60), cap ? [`max_ai_replies_per_hour=${cap.value} (the repository master has 6)`] : []);
  add('N04', 'P1', 'N W13', 'No global switch that keeps external AI off until the clinic has approved provider, terms, retention and data fields', !real.some((n) => /ai_external_enabled|AI_EXTERNAL/.test(JSON.stringify(n.parameters))),
    ['ai_mode is per clinic (default off: good), but nothing stops a mis-set clinic row from sending patient text abroad']);
  add('N05', 'P3', 'N W13', 'ai_mode defaults to off; replies are fact-checked against the Knowledge table; emergencies and complaints go to a person', false, ['Settings.ai_mode off/draft/auto; W13 – Plan validates schema, prices, times, links and phone numbers']);
  const model = w13cfg && assignments(w13cfg).find((a) => a.name === 'openrouter_model');
  add('N06', 'P2', 'N/O W13', 'AI provider and model are literals', !!(model && !isExpr(model.value)), model ? [`openrouter_model: ${lit(model.value)}`] : []);

  // ------------------------------------------------------------------ O. hard-coded configuration
  const sets = real.filter((n) => n.type.endsWith('.set'));
  const lits = (re, filt) => { const out = []; for (const n of sets) for (const a of assignments(n)) if (re.test(a.name) && !isExpr(a.value) && String(a.value).length && (!filt || filt(a))) out.push(`${n.name} > ${a.name}`); return out; };
  const grist = lits(/^grist_base_url$/); const reg = lits(/^registry_doc_id$/);
  add('O01', 'P1', 'O config', `Grist base URL is a literal in ${grist.length} Config nodes (internal Docker name: only valid where that hostname resolves)`, grist.length > 0, [`${grist.length} nodes, e.g. ${grist.slice(0, 3).join('; ')}`]);
  add('O02', 'P1', 'O config', `Agency Registry document id is a literal in ${reg.length} Config nodes`, reg.length > 0, [`${reg.length} nodes (value not shown)`]);
  const secrets = lits(/token|secret|password|api[_-]?key/i);
  add('O03', 'P0', 'O config', 'Secrets stored as literals in Set nodes', secrets.length > 0, secrets);
  const credNodes = real.filter((n) => n.credentials && Object.keys(n.credentials).length);
  const credNames = {}; for (const n of credNodes) for (const [t, c] of Object.entries(n.credentials)) { const k = `${t} "${c.name}"`; credNames[k] = (credNames[k] || 0) + 1; }
  add('O04', 'P2', 'O config', `${credNodes.length} nodes reference credentials by id: ids do not transfer between n8n installations (re-bind them after import)`, credNodes.some((n) => Object.values(n.credentials).some((c) => !/^Fhq/.test(String(c.id)))), Object.entries(credNames).map(([k, c]) => `${c} x ${k}`));
  const envUses = real.filter((n) => /\$env\./.test(JSON.stringify(n.parameters)));
  add('O05', 'P3', 'O config', 'Number of nodes that read configuration from environment variables', false, [`${envUses.length} nodes use $env`]);

  // ------------------------------------------------------------------ R. phones
  const plus91 = real.filter((n) => /\+91\$\{digits\}/.test(code(n)));
  add('R01', 'P1', 'R phones', 'Phone numbers are forced into +91 (Indian mobile only): international numbers are rejected or mangled', plus91.length > 0, [`${plus91.length} Code nodes carry the +91-only normaliser`]);

  // ------------------------------------------------------------------ U. missed call
  const callHook = hooks.find((h) => /call/i.test(h.parameters.path || ''));
  add('U01', 'P2', 'U telephony', 'Missed-call capture is NOT implemented in this workflow (no telephony webhook, no provider)', !callHook && !wf.nodes.some((n) => /Missed-call capture is NOT part of this workflow/.test(JSON.stringify(n.parameters || {}))), ['no webhook path contains "call"; the website/WhatsApp flow must not be presented as missed-call capture']);

  // ------------------------------------------------------------------ V. operations (files)
  if (opts.compose) {
    const c = opts.compose; const cd = opts.caddy || '';
    add('V01', 'P0', 'V ops', 'Reverse proxy publishes the WHOLE n8n (editor, REST API, webhooks) on the public domain', /reverse_proxy\s+n8n:5678/.test(cd) && !/handle|@webhook|path\s+\/webhook/.test(cd), ['Caddyfile: reverse_proxy n8n:5678 for the whole host, no path restriction']);
    add('V02', 'P1', 'V ops', 'n8n cannot read environment variables in nodes by default (N8N_BLOCK_ENV_ACCESS_IN_NODE not set to false) - needed for env-based secrets', !/N8N_BLOCK_ENV_ACCESS_IN_NODE/.test(c), ['not set in docker-compose.yml']);
    add('V03', 'P1', 'V ops', 'No container health checks or log limits', !/healthcheck:/.test(c), ['no healthcheck in docker-compose.yml']);
    add('V04', 'P1', 'V ops', 'Execution history keeps 14 days of patient message data (EXECUTIONS_DATA_MAX_AGE=336) and saves successful runs', /EXECUTIONS_DATA_MAX_AGE=336/.test(c) && !/EXECUTIONS_DATA_SAVE_ON_SUCCESS/.test(c), ['EXECUTIONS_DATA_MAX_AGE=336; no EXECUTIONS_DATA_SAVE_ON_SUCCESS']);
    add('V05', 'P1', 'V ops', 'No backup / restore automation for the n8n volume and the Grist data', !/backup/i.test(c) && !(opts.composeDir && fs.existsSync(path.join(opts.composeDir, '..', 'scripts', 'backup.sh')) && fs.existsSync(path.join(opts.composeDir, '..', 'scripts', 'restore.sh'))), ['no backup service in docker-compose.yml']);
    add('V06', 'P2', 'V ops', 'No staging environment definition and no mail catcher (Mailpit) for tests', !/mailpit|staging/i.test(c) && !(opts.composeDir && fs.existsSync(path.join(opts.composeDir, 'docker-compose.staging.yml'))), ['none']);
  }
  return results;
}

function render(results, wf) {
  const rank = (s) => SEV.indexOf(s);
  const open = results.filter((r) => r.status === 'OPEN').sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
  const ok = results.filter((r) => r.status === 'OK');
  const lines = [];
  lines.push(`Audit of "${wf.name}" (id ${wf.id}, ${wf.nodes.length} nodes): ${open.length} OPEN, ${ok.length} OK`);
  const count = (s) => open.filter((r) => r.severity === s).length;
  lines.push(`OPEN by severity: P0=${count('P0')} P1=${count('P1')} P2=${count('P2')} P3=${count('P3')}`);
  lines.push('');
  for (const r of open) { lines.push(`[${r.severity}] ${r.id} ${r.area}: ${r.title}`); for (const e of r.evidence) lines.push(`        - ${e}`); }
  lines.push('', 'OK / informational:');
  for (const r of ok) lines.push(`  ${r.id} ${r.area}: ${r.title}`);
  return lines.join('\n');
}

module.exports = { audit, render };

if (require.main === module) {
  const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const opts = {};
  if (arg('--compose')) { opts.compose = fs.readFileSync(arg('--compose'), 'utf8'); opts.composeDir = path.dirname(path.resolve(arg('--compose'))); }
  if (arg('--caddy')) opts.caddy = fs.readFileSync(arg('--caddy'), 'utf8');
  const results = audit(wf, opts);
  console.log(render(results, wf));
  if (arg('--json')) { fs.mkdirSync(path.dirname(arg('--json')), { recursive: true }); fs.writeFileSync(arg('--json'), `${JSON.stringify({ workflow: { name: wf.name, id: wf.id, nodes: wf.nodes.length, active: wf.active }, results }, null, 2)}\n`); }
  const failOn = arg('--fail-on');
  if (failOn && results.some((r) => r.status === 'OPEN' && SEV.indexOf(r.severity) <= SEV.indexOf(failOn))) process.exit(1);
}
