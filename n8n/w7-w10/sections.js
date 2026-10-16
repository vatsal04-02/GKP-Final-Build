// SECTIONS W7, W8, W9 and W10 of the master workflow: nodes, wiring and canvas, built from n8n/w7-w10/code/*.js with the shared
// helpers pasted in VERBATIM from n8n/snippets/ (normalize-phone, send-guard, clinic-modules), so the tested code is the code that runs.
// Used by n8n/integrated/apply-w7-w10.js. Every value that already exists in your workflow (Grist base URL, registry doc id,
// Grist credential, OpenRouter credential and model) is passed in from YOUR workflow, never typed here.
//
//   W7 – outcome check-in   hourly :20  Completed visit 20-72 h ago -> guards -> claim Outcome_Sent -> W12 -> Run_Log
//   W8 – review request     hourly :35  Completed visit 3 h-7 days ago -> guards -> claim Review_Sent -> W12 -> Run_Log
//   W9 – weekly report      Mon 09:00   numbers by code -> one OpenRouter call (summary / recommendations, checked) -> Run_Log
//                                       (+ optional owner WhatsApp through W12)
//   W10 – staff reply       every min   Messages row (Out, Send ticked) -> checks -> claim the row -> W12 -> row / conversation / Run_Log
// Every WhatsApp message goes through "Call 'W12 - WhatsApp send'" (this workflow, W12 section). No node here talks to Meta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE = path.join(__dirname, 'code');
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const fn = (src, name) => { const s = src.indexOf(`function ${name}`); return src.slice(s, src.indexOf('\n}\n', s) + 3); };
const PHONE_GUARD = [
  '// Pasted from n8n/snippets/normalize-phone.js and n8n/snippets/send-guard.js - keep identical.',
  fn(snip('normalize-phone.js'), 'normalizeIndianPhone'),
  ...['isTestMode', 'inQuietHours', 'decideSend'].map((n) => fn(snip('send-guard.js'), n)),
].join('\n');
const CM_SRC = snip('clinic-modules.js');
const CM = `// Pasted from n8n/snippets/clinic-modules.js - keep identical.\n${CM_SRC.slice(CM_SRC.indexOf('const CM_ROLE'), CM_SRC.indexOf('if (typeof module'))}`;
const uuid = (seed) => {   // deterministic ids: a rebuild gives the same ids
  const hx = crypto.createHash('sha256').update(`w7-w10:${seed}`).digest('hex');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-4${hx.slice(13, 16)}-a${hx.slice(17, 20)}-${hx.slice(20, 32)}`;
};

// Canvas: the reserved stickies' places (W11 starts at y 17728), one row per section, 224 px per column.
const SECTION_TOP = { W7: 15008, W8: 15696, W9: 16368, W10: 17056 };
const STICKY_HEIGHT = 640;
const pos = (sec, col, branch = 0) => [288 + col * 224, SECTION_TOP[sec] + 340 + branch * 160];

function buildSections(v) {
  for (const k of ['gristBaseUrl', 'registryDocId', 'gristCredentials', 'openrouterCredentials', 'model']) if (!v[k]) throw new Error(`sections: ${k} missing`);
  const nodes = [];
  const connections = {};
  const code = (f, sec, wf, helpers = []) => {
    const body = fs.readFileSync(path.join(CODE, f), 'utf8').replace(/\s+$/, '\n').replace(/%S%/g, sec).replace(/%WF%/g, wf || '');
    return [...helpers, helpers.length ? '// ---- this node ----' : '', body].filter(Boolean).join('\n');
  };
  const add = (n) => { nodes.push({ ...n, id: uuid(n.name) }); return n.name; };
  const link = (from, to, out = 0) => {
    const c = connections[from] || (connections[from] = { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to, type: 'main', index: 0 });
  };
  const chain = (...names) => names.forEach((n, i) => { if (i) link(names[i - 1], n); });
  const cred = () => JSON.parse(JSON.stringify(v.gristCredentials));
  const trigger = (name, p, rule) => add({ parameters: { rule: { interval: [rule] } }, name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: p });
  const config = (name, p, values) => add({
    parameters: { assignments: { assignments: values.map(([k, val]) => ({ id: uuid(`${name}:${k}`), name: k, value: val, type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string' })) }, options: {} },
    name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: p,
  });
  const grist = (name, p, { url, method, query, body }) => {
    const parameters = { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
    if (method) parameters.method = method;
    if (query) { parameters.sendQuery = true; parameters.queryParameters = { parameters: query.map(([k, val]) => ({ name: k, value: val })) }; }
    if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
    parameters.options = {};
    const ordered = method ? { method, ...parameters } : parameters;
    return add({ parameters: ordered, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: p, credentials: cred() });
  };
  const codeNode = (name, p, jsCode, each) => add({ parameters: each ? { mode: 'runOnceForEachItem', jsCode } : { jsCode }, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: p });
  const ifNode = (name, p, expr) => add({
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid(`${name}:cond`), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
    name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: p,
  });
  const callW12 = (name, p) => add({
    parameters: { workflowId: { __rl: true, value: '={{ $workflow.id }}', mode: 'id' }, workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true }, mode: 'each', options: {} },
    name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: p,
  });
  const docUrl = (from, table) => `={{ ${from}.grist_base_url }}/api/docs/{{ ${from}.doc_id }}/tables/${table}/records`;
  const registry = '={{ $json.grist_base_url }}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records';
  const front = (sec, cfgValues, triggerName, rule) => {   // trigger -> Config -> Clinics -> Split clinics
    const P = `${sec} – `;
    const t = trigger(`${P}${triggerName}`, pos(sec, 0), rule);
    const c = config(`${P}Config`, pos(sec, 1), [['grist_base_url', v.gristBaseUrl], ['registry_doc_id', v.registryDocId], ...cfgValues]);
    const cl = grist(`${P}Clinics`, pos(sec, 2), { url: registry });
    const sp = codeNode(`${P}Split clinics`, pos(sec, 3), code('split-clinics.js', sec));
    chain(t, c, cl, sp);
    return sp;
  };
  const withCm = [CM];
  const withGuard = [PHONE_GUARD];
  const withBoth = [PHONE_GUARD, CM];

  // ---------------------------------------------------------------- W7 / W8: one message per Completed visit, after a delay
  const patientSection = (sec, wf, cfgValues, triggerName, rule, planFile, flagName) => {
    const P = `${sec} – `;
    const split = front(sec, cfgValues, triggerName, rule);
    const settings = grist(`${P}Settings`, pos(sec, 4), { url: docUrl('$json', 'Settings') });
    const addS = codeNode(`${P}Add settings`, pos(sec, 5), code('add-settings.js', sec));
    const S = `$('${P}Add settings').item.json`;
    const statuses = sec === 'W7' ? '["Completed", "Booked"]' : '["Completed"]';   // W7 also needs future Booked visits (hold)
    const appts = grist(`${P}Appointments`, pos(sec, 6), { url: docUrl('$json', 'Appointments'), query: [['filter', `={{ JSON.stringify({ Status: ${statuses} }) }}`]] });
    const leads = grist(`${P}Leads`, pos(sec, 7), { url: docUrl(S, 'LEADS') });
    const convs = grist(`${P}Conversations`, pos(sec, 8), { url: docUrl(S, 'Conversations') });
    const plan = codeNode(`${P}Plan`, pos(sec, 9), code(planFile, sec, wf, withCm));
    chain(split, settings, addS, appts, leads, convs, plan);
    let col = 10;
    let afterPlan = plan;
    if (sec === 'W8') {
      const isReview = ifNode(`${P}Review?`, pos(sec, col), "={{ $json.kind === 'review' }}");
      const warn = grist(`${P}Write warning`, pos(sec, col + 1, 1), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
      link(plan, isReview);
      link(isReview, warn, 1);
      afterPlan = isReview;
      col++;
    }
    const decide = codeNode(`${P}Decide send`, pos(sec, col), code('decide-send.js', sec, wf, withGuard), true);
    const sendQ = ifNode(`${P}Send?`, pos(sec, col + 1), '={{ $json.send }}');
    const build = codeNode(`${P}Build Message`, pos(sec, col + 2), code('build-message.js', sec, wf, withCm), true);
    const claim = grist(`${P}Claim ${flagName}`, pos(sec, col + 3), { method: 'PATCH', url: docUrl('$json', 'Appointments'), body: '={{ JSON.stringify($json.claim) }}' });
    const restore = codeNode(`${P}Restore`, pos(sec, col + 4), code('restore.js', sec, wf), true);
    const call = callW12(`${P}Call 'W12 - WhatsApp send'`, pos(sec, col + 5));
    const prep = codeNode(`${P}Prepare log`, pos(sec, col + 6), code('prepare-log.js', sec, wf), true);
    const write = grist(`${P}Write Run_Log`, pos(sec, col + 7), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
    link(afterPlan, decide);
    chain(decide, sendQ, build, claim, restore, call, prep, write);
    return col + 8;
  };
  const w7cols = patientSection('W7', 'W7-outcome-nudge', [['after_hours', 20], ['max_hours', 72], ['min_days_between', 7], ['max_per_run', 30]],
    'Every hour', { field: 'cronExpression', expression: '20 * * * *' }, 'w7-plan.js', 'Outcome_Sent');
  const w8cols = patientSection('W8', 'W8-review-request', [['after_hours', 3], ['max_days', 7], ['min_days_between', 90], ['max_per_run', 30], ['config_warning_hour', 10]],
    'Every hour', { field: 'cronExpression', expression: '35 * * * *' }, 'w8-plan.js', 'Review_Sent');

  // ---------------------------------------------------------------- W9: weekly report
  {
    const sec = 'W9';
    const P = 'W9 – ';
    const split = front(sec, [['openrouter_model', v.model], ['read_limit', 5000]], 'Monday 09:00', { field: 'cronExpression', expression: '0 9 * * 1' });
    const settings = grist(`${P}Settings`, pos(sec, 4), { url: docUrl('$json', 'Settings') });
    const addS = codeNode(`${P}Add settings`, pos(sec, 5), code('add-settings.js', sec));
    const S = `$('${P}Add settings').item.json`;
    const limit = "={{ $('W9 – Config').first().json.read_limit }}";
    const leads = grist(`${P}Leads`, pos(sec, 6), { url: docUrl('$json', 'LEADS') });
    const appts = grist(`${P}Appointments`, pos(sec, 7), { url: docUrl(S, 'Appointments') });
    const convs = grist(`${P}Conversations`, pos(sec, 8), { url: docUrl(S, 'Conversations') });
    const msgs = grist(`${P}Messages`, pos(sec, 9), { url: docUrl(S, 'Messages'), query: [['sort', '-Created_At'], ['limit', limit]] });
    const logs = grist(`${P}Run_Log`, pos(sec, 10), { url: docUrl(S, 'Run_Log'), query: [['sort', '-At'], ['limit', limit]] });
    const metrics = codeNode(`${P}Metrics`, pos(sec, 11), code('w9-metrics.js', sec, '', withCm));
    const ask = add({
      parameters: {
        method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Title', value: 'Clinic Autopilot weekly report' }] },
        sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: { timeout: 60000 },
      },
      name: `${P}Ask Model`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos(sec, 12),
      retryOnFail: true, maxTries: 2, waitBetweenTries: 5000, credentials: JSON.parse(JSON.stringify(v.openrouterCredentials)), onError: 'continueRegularOutput',
    });
    const report = codeNode(`${P}Report`, pos(sec, 13), code('w9-report.js', sec, '', withCm), true);
    const save = grist(`${P}Save report`, pos(sec, 14), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
    const owner = codeNode(`${P}Owner message`, pos(sec, 15), code('w9-owner-message.js', sec, '', withGuard), true);
    const ownerQ = ifNode(`${P}Owner send?`, pos(sec, 16), '={{ $json.send }}');
    const call = callW12(`${P}Call 'W12 - WhatsApp send'`, pos(sec, 17));
    const olog = codeNode(`${P}Owner log`, pos(sec, 18), code('w9-owner-log.js', sec), true);
    const owrite = grist(`${P}Write owner log`, pos(sec, 19), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
    chain(split, settings, addS, leads, appts, convs, msgs, logs, metrics, ask, report, save, owner, ownerQ, call, olog, owrite);
  }

  // ---------------------------------------------------------------- W10: staff reply from the Grist inbox
  {
    const sec = 'W10';
    const P = 'W10 – ';
    const split = front(sec, [['max_per_run', 20]], 'Every minute', { field: 'minutes', minutesInterval: 1 });
    const pending = grist(`${P}Pending`, pos(sec, 4), { url: docUrl('$json', 'Messages'), query: [['filter', '={{ JSON.stringify({ Send: [true], Direction: ["Out"] }) }}'], ['limit', "={{ $('W10 – Config').first().json.max_per_run }}"]] });
    const collect = codeNode(`${P}Collect`, pos(sec, 5), code('w10-collect.js', sec));
    const C = `$('${P}Collect').item.json`;
    const settings = grist(`${P}Settings`, pos(sec, 6), { url: docUrl('$json', 'Settings') });
    const conv = grist(`${P}Conversation`, pos(sec, 7), { url: docUrl(C, 'Conversations'), query: [['filter', `={{ JSON.stringify({ id: [${C}.conversation_id] }) }}`]] });
    const lead = grist(`${P}Lead`, pos(sec, 8), { url: docUrl(C, 'LEADS'), query: [['filter', '={{ JSON.stringify({ id: [Number((($json.records || [])[0] || { fields: {} }).fields.Lead) || 0] }) }}']] });
    const check = codeNode(`${P}Check`, pos(sec, 9), code('w10-check.js', sec, '', withBoth), true);
    const sendQ = ifNode(`${P}Send?`, pos(sec, 10), '={{ $json.send }}');
    const claim = grist(`${P}Claim row`, pos(sec, 11), { method: 'PATCH', url: docUrl('$json', 'Messages'), body: '={{ JSON.stringify({ records: [{ id: $json.row_id, fields: $json.check.claim }] }) }}' });
    const restore = codeNode(`${P}Restore`, pos(sec, 12), code('w10-restore.js', sec), true);
    const call = callW12(`${P}Call 'W12 - WhatsApp send'`, pos(sec, 13));
    const record = codeNode(`${P}Record`, pos(sec, 14), code('w10-record.js', sec, '', withCm));
    const notSent = codeNode(`${P}Not sent`, pos(sec, 14, 1), code('w10-not-sent.js', sec));
    const write = grist(`${P}Grist write`, pos(sec, 15), { method: '={{ $json.method }}', url: docUrl('$json', '{{ $json.table }}'), body: '={{ JSON.stringify($json.body) }}' });
    chain(split, pending, collect, settings, conv, lead, check, sendQ, claim, restore, call, record, write);
    link(sendQ, notSent, 1);
    link(notSent, write);
  }

  const width = (cols) => 288 + cols * 224 + 60 - 160;
  return { nodes, connections, widths: { W7: width(w7cols), W8: width(w8cols), W9: width(20), W10: width(16) } };
}

// ---------------------------------------------------------------- sticky notes (replace the RESERVED text)
const STICKIES = {
  W7: `## SECTION W7 — OUTCOME CHECK-IN
**Starts from:** W7 – Every hour (cron 20 * * * *). **Sends through:** W7 – Call 'W12 - WhatsApp send' (template \`outcome_check\`, or free text inside the 24 h window).
**Per clinic:** Settings > outcome_checkin = on (missing = off). A **Completed** visit that ended 20-72 h ago (Config: after_hours / max_hours) -> "How are you feeling now? Reply better, the same or worse; tell us if you want another appointment." One per patient; none if a check-in went in the last 7 days, a future visit is Booked, a person owns the conversation (Needs_Human / Assigned_To) or the patient said not interested / STOP.
**Guards:** Opted_Out, Automation_Paused, valid phone, quiet hours 21:00-08:00 IST, TEST_MODE (-> TEST_PHONE), sent flag **Appointments.Outcome_Sent** (new DateTime column) claimed BEFORE the send: a failed claim sends nothing (W11 alerts); one attempt per visit, every attempt in Run_Log (W7-outcome-nudge).
**The answer** comes in through W2 and W13 (Messages.Intent / Conversations.Last_Intent = outcome_better / outcome_same / outcome_worse): better = a short thank-you; same / worse = a person (worse = HIGH, medical, no advice by message); urgent words = URGENT hand-off; "book me again" = the normal Cal.com booking path.`,
  W8: `## SECTION W8 — REVIEW REQUEST
**Starts from:** W8 – Every hour (cron 35 * * * *). **Sends through:** W8 – Call 'W12 - WhatsApp send' (template \`review_request\`, or free text inside the 24 h window).
**Per clinic:** Settings > review_requests = on (missing = off). A **Completed** visit that ended 3 h-7 days ago (Config) -> "we would be grateful for your honest review here: <Settings > review_link> Thank you!". One per patient per 90 days (min_days_between). Same message for everyone: no filtering by mood, outcome or complaints (Google: no review gating), no incentives, no pressure.
**Guards:** Opted_Out, Automation_Paused, valid phone, quiet hours, TEST_MODE, sent flag **Appointments.Review_Sent** claimed BEFORE the send (one attempt per visit, Run_Log W8-review-request).
**No review_link** (or not https://): nothing is sent; at 10:00 IST (config_warning_hour) a Run_Log row (Outcome skipped) says how many requests are waiting. A link is never invented.`,
  W9: `## SECTION W9 — WEEKLY REPORT
**Starts from:** W9 – Monday 09:00 (cron 0 9 * * 1), for the week Monday-Sunday that just ended (IST).
**Numbers: code only** (W9 – Metrics, from LEADS, Appointments, Conversations, Messages, Run_Log). **AI: one OpenRouter call per clinic** (W9 – Ask Model, the "OpenRouter API" credential, the model in Config) writes ONLY the summary, observations and recommendations from those numbers; W9 – Report drops any AI line that quotes a number not in the data. No answer = the report is written from the numbers alone.
**7 sections:** executive summary, leads, appointments, AI / hand-offs, follow-ups, important issues, recommended actions (labelled as suggestions, not facts).
**Saved in Run_Log** (Workflow W9-weekly-report, Record = the report). **Owner WhatsApp** (template \`weekly_owner_report\` to Settings > owner_phone, through W12, once per week): per clinic, OFF until Settings > weekly_report_whatsapp = on (after Meta approves the template).`,
  W10: `## SECTION W10 — STAFF REPLY FROM THE GRIST INBOX
**Starts from:** W10 – Every minute. **Sends through:** W10 – Call 'W12 - WhatsApp send' (free text: only inside WhatsApp's 24 h window).
**Staff:** in the Inbox, add a Messages row in the patient's conversation: Direction = Out, Body = the reply, Template empty, then tick **Send**. Only rows with Send ticked are touched.
**Checks** (else the reason goes in AI_Reason, Status failed / needs_template, Send unticked; fix and tick again): body, conversation, valid phone, Opted_Out, 24 h window, TEST_MODE (-> TEST_PHONE). Quiet hours: it waits and goes at 08:00. Automation_Paused / Needs_Human / Assigned_To do not stop a person's reply and are never changed.
**No double send:** the row is claimed first (Send unticked, Status queued); then Status sent + WA_Message_ID (or failed + reason), Conversations.Unread = 0, Run_Log W10-staff-reply. W13 stays out of a conversation for 24 h after a staff message.`,
};

module.exports = { buildSections, STICKIES, STICKY_HEIGHT, SECTION_TOP, PHONE_GUARD, CM, uuid };
