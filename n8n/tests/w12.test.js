// Structure + end-to-end checks for W12-whatsapp-send.json (runs the shipped JSON). Run: node n8n/tests/w12.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate } = require('./n8n-sim');
const { load, withConfig, freshGrist, REPO } = require('./helpers');

const raw = fs.readFileSync(path.join(REPO, 'n8n/workflows/W12-whatsapp-send.json'), 'utf8');
const w12raw = JSON.parse(raw);
const CFG = { w12_allowlist: '98765 43210, +91 90000 00001', w12_graph_api_version: 'v23.0' };
const wf = withConfig(w12raw, CFG);
const DAY = Date.parse('2026-10-05T10:00:00+05:30');
const NIGHT = Date.parse('2026-10-05T22:00:00+05:30');
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const node = (name) => w12raw.nodes.find((x) => x.name === name);

// ---------------------------------------------------------------- fakes
const fakeMeta = (reply) => {
  const calls = [];
  let k = 0;
  const fn = (method, url, body) => {
    calls.push({ method, url, body });
    if (typeof reply === 'function') return reply(method, url, body);
    if (reply) return reply;
    k++;
    return { status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.TEST${k}` }] } };
  };
  fn.calls = calls;
  return fn;
};
const metaError = (status, code, message, details) => ({ status, body: { error: { message, type: 'OAuthException', code, error_data: details ? { messaging_product: 'whatsapp', details } : undefined, fbtrace_id: 'x' } } });
const throwing = (message) => () => { throw new Error(message); };

// A W5-shaped item, as W5 will hand it over once wired (its own fields + what W12 needs).
const w5Item = (over = {}) => ({
  grist_base_url: 'http://grist:8484', doc_id: 'DOCA', clinic_slug: 'demo-physio', registry_clinic_name: 'DEMO-PHYSIO', clinic_name: 'Demo Physio',
  test_mode: 'false', test_phone: '9000000001',
  kind: 'r24', template: 'reminder_24h', flag_column: 'R24_Sent', flag_value: null, appt_row_id: 3, booking_uid: 'uid3',
  service: 'Assessment', physio: 'Dr Rao', start: Math.floor(DAY / 1000) + 23 * 3600, patient_name: 'Asha', patient_phone: '+919876543210', opted_out: false,
  decision: { send: true, to: '+919876543210', reason: 'ok', test_mode: false }, send: true,
  template_params: { name: 'Asha', clinic_name: 'Demo Physio', date: '06 Oct', time: '9:00 AM', service: 'Assessment', physio: 'Dr Rao' },
  message_text: 'Hi Asha, a reminder: your Assessment at Demo Physio is on 06 Oct at 9:00 AM.',
  wa_phone_number_id: '123456789012345', audience: 'patient', lead_row_id: 7, lead_phone: '+919876543210', source_workflow: 'W5-reminders',
  ...over,
});
const run = (item, { meta = fakeMeta(), grist = freshGrist(), now = DAY, w = wf, start = 'When called by another workflow' } = {}) => {
  const r = simulate(w, { start, items: item ? [{ json: item }] : [{ json: {} }], grist, now, meta });
  const out = r.runData['Return result'] ? r.runData['Return result'][0].json : null;
  return { r, out, meta, grist };
};
const RESULT_KEYS = ['sent', 'send_status', 'wa_message_id', 'send_error', 'send_error_code', 'send_http_status', 'inbox_logged', 'inbox_error'];
const msgs = (g, doc = 'DOCA') => (g.docs[doc].Messages || []).map((m) => m.fields);
const convs = (g, doc = 'DOCA') => (g.docs[doc].Conversations || []).map((c) => ({ id: c.id, ...c.fields }));

// ================================================================ structure
console.log('structure');
const names = w12raw.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(w12raw.nodes.map((x) => x.id)).size, names.length);
for (const [from, v] of Object.entries(w12raw.connections)) { assert(names.includes(from)); for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), t.node); }
const trig = node('When called by another workflow');
assert.deepStrictEqual([trig.type, trig.typeVersion, trig.parameters.inputSource], ['n8n-nodes-base.executeWorkflowTrigger', 1.1, 'passthrough']);
assert.strictEqual(node('Manual test').type, 'n8n-nodes-base.manualTrigger');
// every node except the triggers / note must lead to "Return result", and "Return result" must be the only dead end
const succ = (x) => (w12raw.connections[x] || { main: [] }).main.flat().filter(Boolean).map((t) => t.node);
const reaches = (x, seen = new Set()) => x === 'Return result' || (!seen.has(x) && (seen.add(x), succ(x).some((y) => reaches(y, seen))));
for (const x of names.filter((y) => !['Notes'].includes(y))) assert(reaches(x), `${x} does not lead to Return result`);
assert.deepStrictEqual(names.filter((x) => x !== 'Notes' && succ(x).length === 0), ['Return result']);
ok('triggers: "called by another workflow" (accept all data) + Manual test; every path ends in the single "Return result" node');

const meta = node('Meta send');
assert.deepStrictEqual(meta.credentials.httpHeaderAuth.name, 'WhatsApp Cloud API');
assert.deepStrictEqual([meta.retryOnFail, meta.onError], [false, 'continueRegularOutput']);
assert.deepStrictEqual(meta.parameters.options, { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 });
for (const g of ['Find conversation', 'Create conversation', 'Add message']) {
  assert.strictEqual(node(g).credentials.httpHeaderAuth.name, 'Grist API', g);
  assert.strictEqual(node(g).onError, 'continueRegularOutput', g);
}
assert(!w12raw.nodes.some((x) => x.type === 'n8n-nodes-base.code' && x.credentials));
ok('Meta node: WhatsApp credential, NO retry (a retry could double-send), full response + never-error + 15 s timeout, continue on error; Grist logging nodes continue on error');

let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
w12raw.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const snip = (f) => fs.readFileSync(path.join(REPO, 'n8n/snippets', f), 'utf8');
const phoneFn = snip('normalize-phone.js').match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0];
const quietFn = snip('send-guard.js').match(/function inQuietHours[\s\S]*?\n\}\n/)[0];
const ws = snip('wa-send.js'); const waFns = ws.slice(ws.indexOf('const WA_TEMPLATES'), ws.indexOf('if (typeof module'));
for (const nm of ['Prepare request', 'Read reply']) {
  const c = strip(node(nm).parameters.jsCode);
  assert(c.includes(strip(phoneFn)) && c.includes(strip(quietFn)) && c.includes(strip(waFns)), nm);
}
ok('Prepare request and Read reply embed normalize-phone, inQuietHours and wa-send.js exactly as in n8n/snippets/');

const cfgVals = Object.fromEntries(node('Config').parameters.assignments.assignments.map((a) => [a.name, a.value]));
assert.deepStrictEqual(cfgVals, { w12_send_mode: 'allowlist', w12_allowlist: 'REPLACE_WITH_YOUR_NUMBERS', w12_graph_api_version: 'REPLACE_WITH_GRAPH_API_VERSION', w12_default_language: 'en', w12_uncertain_counts_as_sent: true, w12_log_to_inbox: true });
assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw));
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/EAA[A-Za-z0-9]{20,}/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw) && !/\+91[0-9]{10}/.test(raw) && !/"[6-9][0-9]{9}"/.test(raw));
ok('ships safe: send_mode = allowlist, allowlist / Graph version / phone number id are placeholders; no token, phone number or email in the file');

// ================================================================ accepted
console.log('accepted');
let { out, meta: m, grist: g, r } = run(w5Item());
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.strictEqual(m.calls.length, 1);
assert.deepStrictEqual(m.calls[0], {
  method: 'POST', url: 'https://graph.facebook.com/v23.0/123456789012345/messages',
  body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template', template: { name: 'reminder_24h', language: { code: 'en' }, components: [{ type: 'body', parameters: ['Asha', 'Assessment', 'Demo Physio', '06 Oct', '9:00 AM'].map((text) => ({ type: 'text', text })) }] } },
});
ok('ONE call to Meta: POST /v23.0/<phone_number_id>/messages with the template and its variables in order');
assert.deepStrictEqual([out.sent, out.send_status, out.wa_message_id, out.send_error, out.send_http_status], [true, 'accepted', 'wamid.TEST1', '', 200]);
for (const [k, v] of Object.entries(w5Item())) assert.deepStrictEqual(out[k], v, `caller field ${k} must come back unchanged`);
assert.deepStrictEqual(Object.keys(out).filter((k) => !(k in w5Item())).sort(), [...RESULT_KEYS].sort());
assert(!Object.keys(out).some((k) => k.startsWith('w12_')));
ok('returns the caller\'s item UNCHANGED plus only: sent, send_status, wa_message_id, send_error, send_error_code, send_http_status, inbox_logged, inbox_error');
assert.deepStrictEqual(r.visited.filter((x) => x === 'Return result').length, 1);
assert.strictEqual(r.visited[r.visited.length - 1], 'Return result');
ok('"Return result" runs exactly once and last (Execute Workflow hands back the last node\'s output)');

assert.deepStrictEqual(convs(g), [{ id: 1, Phone: '+919876543210', Lead: 7 }]);
assert.deepStrictEqual(msgs(g), [{ Direction: 'Out', Body: w5Item().message_text, Template: 'reminder_24h', Sent_By: 'W5-reminders', WA_Message_ID: 'wamid.TEST1', Status: 'queued', Send: false, Created_At: Math.floor(DAY / 1000), Conversation: 1 }]);
assert.strictEqual(out.inbox_logged, true);
ok('patient message logged to the Grist Inbox: Conversation created (Phone, Lead), Messages row Out / queued / wamid / Send = false');

({ out, grist: g } = run(w5Item(), { grist: g, meta: fakeMeta() }));
assert.deepStrictEqual([convs(g).length, msgs(g).length, msgs(g)[1].Conversation], [1, 2, 1]);
ok('a second message to the same patient reuses their Conversation');

({ out, grist: g, meta: m } = run(w5Item({ audience: 'staff', template: 'lead_escalation', template_params: { clinic_name: 'Demo Physio', lead_name: 'Ravi', lead_phone: '+919811111111', waiting_minutes: 31 } })));
assert.deepStrictEqual([out.sent, out.inbox_logged, g.calls.length], [true, false, 0]);
assert.deepStrictEqual(m.calls[0].body.template.components[0].parameters.map((x) => x.text), ['Demo Physio', 'Ravi', '+919811111111', '31']);
ok('staff alert: sent, and nothing written to the patient Inbox');

// TEST_MODE: delivered to TEST_PHONE but logged in the PATIENT's conversation, marked as a test
({ out, grist: g, meta: m } = run(w5Item({ decision: { send: true, to: '+919000000001', reason: 'test mode: sent to TEST_PHONE', test_mode: true } })));
assert.deepStrictEqual([m.calls[0].body.to, convs(g)[0].Phone, msgs(g)[0].Sent_By], ['919000000001', '+919876543210', 'W5-reminders (TEST_MODE: sent to +919000000001)']);
ok('TEST_MODE: Meta sends to TEST_PHONE (decision.to); the Inbox row sits in the patient\'s conversation and says it was a test');

// ================================================================ rejected / uncertain
console.log('Meta errors and timeouts');
({ out, grist: g, meta: m } = run(w5Item(), { meta: fakeMeta(metaError(400, 131030, '(#131030) Recipient phone number not in allowed list', 'Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.')) }));
assert.deepStrictEqual([out.sent, out.send_status, out.send_error_code, out.send_http_status], [false, 'rejected', 131030, 400]);
assert(out.send_error.includes("allowed list - add it in Meta"), out.send_error);
assert.deepStrictEqual([msgs(g)[0].Status, msgs(g)[0].WA_Message_ID], ['failed', '']);
ok('Meta refuses (131030 not in allowed list): sent = false (caller retries later), clear hint, Inbox row marked failed');
({ out } = run(w5Item(), { meta: fakeMeta(metaError(401, 190, 'Error validating access token: Session has expired')) }));
assert.deepStrictEqual([out.sent, out.send_error_code], [false, 190]);
assert(out.send_error.includes('permanent System User token'));
ok('expired token (190): sent = false with the fix in the message');

({ out, grist: g } = run(w5Item(), { meta: fakeMeta(throwing('timeout of 15000ms exceeded')) }));
assert.deepStrictEqual([out.sent, out.send_status], [true, 'uncertain']);
assert.deepStrictEqual([msgs(g)[0].Status, msgs(g)[0].WA_Message_ID], ['queued', '']);
ok('timeout: uncertain, counted as SENT so the caller sets its flag and never double-sends (rule 4)');
({ out } = run(w5Item(), { meta: fakeMeta(throwing('timeout of 15000ms exceeded')), w: withConfig(w12raw, { ...CFG, w12_uncertain_counts_as_sent: false }) }));
assert.deepStrictEqual([out.sent, out.send_status], [false, 'uncertain']);
ok('...unless w12_uncertain_counts_as_sent = false');
({ out } = run(w5Item(), { meta: fakeMeta(throwing('getaddrinfo ENOTFOUND graph.facebook.com')) }));
assert.deepStrictEqual([out.sent, out.send_status], [false, 'rejected']);
ok('no internet (ENOTFOUND): the request never left, so sent = false (safe to retry)');

// ================================================================ never calls Meta
console.log('cases where Meta is never called');
const never = (item, opts, status) => {
  const res = run(item, opts);
  assert.strictEqual(res.r.error, null, JSON.stringify(res.r.error));
  assert.strictEqual(res.meta.calls.length, 0, 'Meta must not be called');
  assert.deepStrictEqual([res.out.sent, res.out.send_status], [false, status]);
  assert.strictEqual(res.grist.calls.length, 0, 'no Grist writes when nothing was attempted');
  return res.out;
};
assert.strictEqual(never(w5Item({ decision: { send: false, to: null, reason: 'opted out' } }), {}, 'not_requested').send_error, 'guard said no: opted out');
never(w5Item({ decision: undefined }), {}, 'not_requested');
never(w5Item({ decision: { send: true, to: '+919811111111', reason: 'ok' } }), {}, 'blocked');
assert.strictEqual(run(w5Item({ decision: { send: true, to: '+919811111111', reason: 'ok' } }), { w: withConfig(w12raw, { ...CFG, w12_send_mode: 'live' }) }).meta.calls.length, 1);
never(w5Item(), { w: withConfig(w12raw, { ...CFG, w12_send_mode: 'off' }) }, 'blocked');
assert.strictEqual(never(w5Item(), { now: NIGHT }, 'blocked').send_error, 'quiet hours (21:00-08:00 IST)');
ok('guard said no / no decision / number not in allowlist / send_mode off / quiet hours: Meta never called, sent = false; "live" lets any number through');
assert.match(never(w5Item(), { w: w12raw }, 'invalid').send_error, /graph_api_version is not set/);
never(w5Item({ wa_phone_number_id: '' }), {}, 'invalid');
never(w5Item({ template: 'reminder_3h' }), {}, 'invalid');
assert.strictEqual(never(w5Item({ template: 'followup_day2', template_params: { name: 'A', clinic_name: 'D', booking_link: '' } }), {}, 'invalid').send_error, 'template followup_day2: variable "booking_link" is empty');
ok('unset Graph version / missing phone number id / unknown template / empty required variable: refused before Meta with a clear reason');

// ================================================================ Grist problems never change the send result
console.log('Inbox logging is best-effort');
({ out, meta: m } = run(w5Item({ doc_id: 'NO_SUCH_DOC' })));
assert.deepStrictEqual([out.sent, out.send_status, m.calls.length, out.inbox_logged], [true, 'accepted', 1, false]);
assert.match(out.inbox_error, /Grist 404/);
ok('Grist down / wrong doc: the message still counts as SENT (no duplicate next run); inbox_logged = false with the error');
g = freshGrist(); g.docs.DOCA.Conversations = [{ id: 5, fields: { Phone: '+919876543210', Lead: 7 } }];
({ out } = run(w5Item(), { grist: g, meta: fakeMeta() }));
assert.deepStrictEqual([out.inbox_logged, msgs(g)[0].Conversation, convs(g).length], [true, 5, 1]);
ok('existing conversation found by phone is reused');
({ out, grist: g } = run(w5Item(), { w: withConfig(w12raw, { ...CFG, w12_log_to_inbox: false }) }));
assert.deepStrictEqual([out.sent, out.inbox_logged, g.calls.length], [true, false, 0]);
ok('w12_log_to_inbox = false: no Grist calls at all');

// ================================================================ plugs into the existing callers
console.log('compatibility with the existing W5 / W3 / W6 "Sent?" and flag nodes');
const ifOf = (wfName, nodeName) => load(wfName).nodes.find((x) => x.name === nodeName).parameters.conditions.conditions[0].leftValue.replace(/^=\{\{|\}\}$/g, '');
const codeOf = (wfName, nodeName) => load(wfName).nodes.find((x) => x.name === nodeName).parameters.jsCode;
const evalIf = (expr, json) => new Function('$json', `return (${expr});`)(json);
const runCode = (src, json) => new Function('$json', '$', src)(json, () => ({ first: () => ({ json: {} }) })).json;
const accepted = run(w5Item()).out;
const refused = run(w5Item(), { meta: fakeMeta(metaError(400, 131030, 'x')) }).out;
assert.deepStrictEqual([evalIf(ifOf('W5-reminders.json', 'Sent?'), accepted), evalIf(ifOf('W5-reminders.json', 'Sent?'), refused)], [true, false]);
const w5log = runCode(codeOf('W5-reminders.json', 'Prepare sent log'), accepted);
assert.deepStrictEqual([w5log.patch.records[0].id, Object.keys(w5log.patch.records[0].fields)], [3, ['R24_Sent']]);
ok('W5: its real "Sent?" passes W12\'s accepted result and stops the refused one; its "Prepare sent log" ticks R24_Sent on appointment 3');

const w3item = run({ ...w5Item({ audience: 'staff', template: 'lead_escalation', template_params: { clinic_name: 'D', lead_name: 'Ravi', lead_phone: '+919811111111', waiting_minutes: 31 } }), lead_row_id: 12, lead_id: 'L-20261005-0003' }).out;
assert.strictEqual(evalIf(ifOf('W3-speed-to-lead.json', 'Sent?'), w3item), true);
assert.deepStrictEqual(runCode(codeOf('W3-speed-to-lead.json', 'Prepare sent log'), w3item).patch, { records: [{ id: 12, fields: { Escalated: true } }] });
const w6item = run({ ...w5Item({ template: 'followup_day2', template_params: { name: 'A', clinic_name: 'D', booking_link: 'https://cal.com/x' } }), kind: 'followup', flag_table: 'Leads', flag_row_id: 9, flag_column: 'Followup_Sent', lead_id: 'L-9' }).out;
assert.strictEqual(evalIf(ifOf('W6-followups.json', 'Sent?'), w6item), true);
assert.deepStrictEqual(runCode(codeOf('W6-followups.json', 'Prepare writes'), w6item).patch, { records: [{ id: 9, fields: { Followup_Sent: true } }] });
ok('W3 (Escalated) and W6 (Followup_Sent) flag nodes work unchanged on W12\'s output');

// ================================================================ manual test path
console.log('manual test path');
({ out, meta: m } = run(null, { start: 'Manual test' }));
assert.deepStrictEqual([m.calls.length, out.sent, out.send_status], [0, false, 'invalid']);
ok('Execute workflow with the shipped placeholders: nothing sent, send_error says what to fill in');
const edited = JSON.parse(JSON.stringify(wf));
const ti = edited.nodes.find((x) => x.name === 'Test input');
ti.parameters.jsCode = ti.parameters.jsCode.replace("'REPLACE_WITH_PHONE_NUMBER_ID'", "'123456789012345'").replace("'REPLACE_WITH_YOUR_NUMBER'", "'98765 43210'");
({ out, meta: m, grist: g } = run(null, { start: 'Manual test', w: edited }));
assert.deepStrictEqual([out.sent, out.send_status, g.calls.length], [true, 'accepted', 0]);
assert.deepStrictEqual(m.calls[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } });
ok('Test input filled in: hello_world (en_US, no variables) goes to your number');

console.log(`\nW12: ${n} check groups pass`);
