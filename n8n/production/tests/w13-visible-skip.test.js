// W13 AI receptionist: a closed external-AI gate is VISIBLE (AI_Status = skipped + reason + Run_Log), and every failure path ends safely.
// Everything is fake: Grist, Meta, OpenRouter (no network, nothing is sent). Run: node n8n/production/tests/w13-visible-skip.test.js
//
// Which workflow: the production export, with tools/patch-w13-visible-skip.js applied in memory. To test another export of the same
// workflow (for example the one imported and re-linked in a running n8n) point PROD_FILE at it and, when its credentials have other
// names, give them to the simulator:
//   PROD_FILE=/path/to/export.json SIM_CRED='{"meta":"WhatsApp Cloud API","openrouter":"OpenRouter API","grist":"Header Auth account 2"}' node ...
// A file that already carries the visible-skip edit is used as it is (the "before" case is rebuilt from it by undoing the one-line edit). A file whose W13 – Config
// carries a literal `ai_external_enabled = true` override (the authoritative final export) is tested as supplied ("before") and with the override removed ("after", the
// proposed fix in n8n/final/tools/propose-fixes.js).
'use strict';
const assert = require('assert');
const H = require('./harness');
const { patch, NODE, FIND, REPLACE } = require('../tools/patch-w13-visible-skip');
const { loadWf, run, runItem, inboundRequest, messageBody, fakeMeta, ledger, rows, freshGrist, test, finish, clone, P, F, ENV, PNID } = H;

const { restoreAiEnvGate } = require('../../final/tools/propose-fixes');

const loaded = loadWf();
const bc = (w) => w.nodes.find((n) => n.name === NODE).parameters.jsCode;
const aiAssign = (w) => w.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.filter((a) => a.name === 'ai_external_enabled');
const literalOverride = aiAssign(loaded).some((a) => a.value === true);            // the AI gate is forced open in the node itself
const oldQuietGate = bc(loaded).includes(FIND);                                     // the original silent skip
const alreadyFixed = bc(loaded).includes(REPLACE) || (!oldQuietGate && /quiet: false/.test(bc(loaded)));
const undo = (w) => { const c = clone(w); const n = c.nodes.find((x) => x.name === NODE); n.parameters.jsCode = n.parameters.jsCode.replace(REPLACE, () => FIND); return c; };
const before = bc(loaded).includes(REPLACE) ? undo(loaded) : loaded;
let after = oldQuietGate ? patch(loaded) : loaded;
after = restoreAiEnvGate(after).wf;
const expectedChanged = [...(oldQuietGate ? [NODE] : []), ...(literalOverride ? ['W13 – Config'] : [])].sort();
const T = F.sec(F.NOW);

const leads = (consent = true, extra = {}) => F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: consent, ...extra } }));
const crm = ({ consent = true, leadExtra = {}, settings = {}, convs = [], msgs = [] } = {}) => freshGrist({
  Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER, ...settings }), LEADS: leads(consent, leadExtra), Conversations: clone(convs), Messages: clone(msgs),
});
const all = (r) => [r, ...(r.subRuns || []).flatMap(all)];
const noErr = (res) => all(res.r).forEach((x) => assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`));
const find = (r, node) => { for (const x of all(r)) if (x.runData && x.runData[node]) return x.runData[node][0].json; return null; };

// a patient message arriving through W2 (signed like Meta signs it), then W13 runs behind it
const inbound = (text, { wf = after, ai = 'true', claude, env = {}, g = crm(), meta = fakeMeta(), id = 'wamid.IN.1' } = {}) => {
  const cl = claude || F.fakeClaude();
  const or = F.fakeOpenRouter(cl);
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody(text, { id, from: P.ASHA, name: 'Asha Patel', ts: T })), {
    grist: g, now: F.NOW, openrouter: or, meta, env: { ...ENV, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}`, FLOWHQ_AI_EXTERNAL_ENABLED: ai, ...env },
  });
  return { res, g, cl, or, meta };
};
const inMsg = (g) => rows(g, 'Messages').find((m) => m.Direction === 'In');
const outMsgs = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'Out');
const w13Log = (g) => rows(g, 'Run_Log').filter((l) => l.Workflow === 'W13-ai-receptionist');
const nothingWentOut = (x) => assert.deepStrictEqual([x.meta.calls.length, ledger(x.g).length, outMsgs(x.g).length], [0, 0, 0]);
// W13 started directly (as the morning retry / a test does), for input that W2 would never produce
const startItem = (o) => ({
  grist_base_url: ENV.FLOWHQ_GRIST_URL, registry_doc_id: ENV.FLOWHQ_REGISTRY_DOC_ID, leads_table: 'LEADS', openrouter_model: 'openai/gpt-4o-mini', w12_workflow_id: after.id,
  min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, pause_on_handoff: true,
  staff_alert_template: 'human_handoff_alert', dry_run: false, wa_phone_number_id: PNID, clinic_slug: 'demo-physio', msg_type: 'text', patient_phone: P.ASHA, ...o,
});
const startW13 = (o, { g = crm(), claude = F.fakeClaude(), meta = fakeMeta(), ai = 'true' } = {}) => {
  const res = run(after, 'W13 – Start', [startItem(o)], { grist: g, now: F.NOW, openrouter: F.fakeOpenRouter(claude), meta, env: { ...ENV, FLOWHQ_AI_EXTERNAL_ENABLED: ai, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}` } });
  return { res, g, cl: claude, meta };
};

// ---------------------------------------------------------------- the fix itself
test('the fix changes only what it says (visible-skip line in "W13 – Build Context", the literal AI override in "W13 – Config"): credentials, ids, URLs and connections are identical', () => {
  const changed = after.nodes.filter((n, i) => JSON.stringify(n) !== JSON.stringify(before.nodes[i])).map((n) => n.name).sort();
  const expected = bc(loaded).includes(REPLACE) ? [NODE, ...(literalOverride ? ['W13 – Config'] : [])].sort() : expectedChanged;   // "before" is rebuilt by undoing the visible-skip edit
  assert.deepStrictEqual(changed, expected);
  assert.strictEqual(after.nodes.length, before.nodes.length);
  assert.strictEqual(JSON.stringify(after.connections), JSON.stringify(before.connections));
  for (const k of Object.keys(before)) if (k !== 'nodes') assert.strictEqual(JSON.stringify(after[k]), JSON.stringify(before[k]), `workflow field ${k}`);
  const refs = (w) => JSON.stringify(w.nodes.map((n) => [n.name, n.id, n.credentials || null]));
  assert.strictEqual(refs(after), refs(before));
  if (oldQuietGate) assert.throws(() => patch(after), /exactly once/, 'applying the patch a second time must refuse');
});

test('every connection of the fixed workflow points at a node that exists', () => {
  const names = new Set(after.nodes.map((n) => n.name));
  for (const [from, v] of Object.entries(after.connections)) {
    assert(names.has(from), `connection from unknown node ${from}`);
    for (const outs of v.main || []) for (const c of outs) assert(names.has(c.node), `${from} -> unknown node ${c.node}`);
  }
});

// ---------------------------------------------------------------- the reported symptom
if (oldQuietGate || bc(loaded).includes(REPLACE)) {
  test('BEFORE the fix: AI off = a silent skip (message row stays empty, no Run_Log): this is the reported symptom', () => {
    const x = inbound('Hi service', { wf: before, ai: 'false' });
    noErr(x.res);
    const m = inMsg(x.g);
    assert.deepStrictEqual([m.Status, m.AI_Status || '', m.AI_Action || '', m.Intent || '', Number(m.AI_Confidence) || 0], ['Received', '', '', '', 0]);
    assert.strictEqual(w13Log(x.g).length, 0);
    const done = find(x.res.r, 'W13 – Done');
    assert.deepStrictEqual([done.intent, done.sends.patient, done.sends.staff, done.decision, done.would_send], ['', null, null, null, []]);
  });
}
if (literalOverride) {
  test('AS SUPPLIED (finding F-AI-01): W13 – Config forces ai_external_enabled=true, so FLOWHQ_AI_EXTERNAL_ENABLED=false does NOT stop the AI: the provider IS called', () => {
    const x = inbound('How much is a physio session?', { wf: before, ai: 'false' });
    noErr(x.res);
    assert.strictEqual(x.cl.calls.length, 1, 'the provider was called although the environment says false');
  });
}

test('AFTER the fix: AI off = AI_Status skipped + the reason on the message and in Run_Log; no AI call, nothing sent', () => {
  const x = inbound('Hi service', { ai: 'false' });
  noErr(x.res);
  const m = inMsg(x.g);
  assert.deepStrictEqual([m.AI_Status, m.AI_Action, m.Needs_Human], ['skipped', 'skip', false]);
  assert.match(m.AI_Reason, /FLOWHQ_AI_EXTERNAL_ENABLED/);
  assert.strictEqual(m.AI_Reply || '', '');
  const log = w13Log(x.g);
  assert.deepStrictEqual(log.map((l) => l.Outcome), ['skipped']);
  assert.match(log[0].Error, /external AI is switched off/);
  assert.strictEqual(x.cl.calls.length, 0, 'no provider call');
  nothingWentOut(x);
});

test('AI off does not weaken the safeguards that need no AI: an emergency still alerts staff, STOP still opts out', () => {
  const e = inbound('I have severe chest pain and cannot breathe', { ai: 'false' });
  noErr(e.res);
  assert.strictEqual(e.cl.calls.length, 0);
  assert.deepStrictEqual([inMsg(e.g).AI_Action, inMsg(e.g).Needs_Human], ['handoff', true]);
  assert(e.meta.calls.some((c) => c.body.template && c.body.template.name === 'human_handoff_alert' && c.body.to === P.OWNER.slice(1)), 'staff alert sent to the owner');
  const s = inbound('STOP', { ai: 'false', id: 'wamid.IN.STOP' });
  noErr(s.res);
  assert.strictEqual(s.cl.calls.length, 0);
  assert.strictEqual(rows(s.g, 'LEADS').find((l) => l.Phone === P.ASHA).Opted_Out, true);
});

// ---------------------------------------------------------------- AI on: a valid message gives a valid plan
test('AI on: a valid inbound message gives a valid decision and plan, one provider call with the existing OpenRouter credential/model, one reply', () => {
  const x = inbound('How much is a physio session?');
  noErr(x.res);
  assert.strictEqual(x.cl.calls.length, 1);
  assert.strictEqual(x.or.calls.length, 1);
  assert.match(x.or.calls[0].url, /^https:\/\/openrouter\.ai\//);
  assert.strictEqual(x.or.calls[0].body.model, 'openai/gpt-4o-mini');
  const plan = find(x.res.r, 'W13 – Plan');
  assert(plan.decision && plan.plan, 'a decision and a plan exist');
  assert.deepStrictEqual([plan.plan.route, plan.plan.intent, plan.ai_error], ['reply', 'pricing', '']);
  assert(plan.decision.confidence >= 0.65 && plan.decision.reply.length > 0);
  const m = inMsg(x.g);
  assert.deepStrictEqual([m.Intent, m.AI_Action, m.AI_Status, m.Needs_Human], ['pricing', 'reply', 'replied', false]);
  assert(Number(m.AI_Confidence) > 0.65);
  assert.deepStrictEqual(x.meta.calls.map((c) => c.body.type), ['text']);
  assert.deepStrictEqual(ledger(x.g).map((l) => l.Idem_Key), [`W13:patient_reply:${m.id}`]);
  assert(!/Asha|Patel|9000000011/.test(JSON.stringify(x.or.calls[0].body)), 'no patient name or number reaches the provider');
});

// ---------------------------------------------------------------- failures end safely
test('missing input: a message row that does not exist fails safely (needs a person, no AI call, nothing sent)', () => {
  const x = startW13({ message_row_id: 999, wa_message_id: 'wamid.NOPE' });
  noErr(x.res);
  assert.strictEqual(x.cl.calls.length, 0);
  assert.strictEqual(x.meta.calls.length, 0);
  assert.strictEqual(ledger(x.g).length, 0);
  const done = find(x.res.r, 'W13 – Done');
  assert.deepStrictEqual([done.status, done.needs_human, done.sends.patient, done.sends.staff], ['failed', true, null, null]);
  assert.match(done.reason, /message row was not found/);
  assert.deepStrictEqual(w13Log(x.g).map((l) => l.Outcome), ['failed']);
});

test('missing input: a stored message with an empty body is skipped (visibly) without an AI call or a send', () => {
  const g = crm({ convs: [{ id: 1, fields: { Lead: 1, Phone: P.ASHA, Last_Inbound_At: T - 60 } }], msgs: [{ id: 5, fields: { Conversation: 1, Direction: 'In', Body: '   ', WA_Message_ID: 'wamid.EMPTY', Created_At: T - 60, Status: 'Received' } }] });
  const x = startW13({ message_row_id: 5, wa_message_id: 'wamid.EMPTY' }, { g });
  noErr(x.res);
  assert.strictEqual(x.cl.calls.length, 0);
  assert.strictEqual(x.meta.calls.length, 0);
  assert.strictEqual(ledger(x.g).length, 0);
  const m = rows(x.g, 'Messages').find((r) => r.id === 5);
  assert.deepStrictEqual([m.AI_Status, m.AI_Action], ['skipped', 'skip']);
  assert.match(m.AI_Reason, /empty message/);
});

test('AI unavailable (HTTP 500, timeout): hand-off to staff with the fixed holding text; no AI-written reply; the patient is never left unanswered silently', () => {
  for (const [name, claude] of [['http 500', F.fakeClaude(() => ({ http: { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } } }))], ['timeout', F.fakeClaude(() => ({ throw: 'timeout' }))]]) {
    const x = inbound('Hi service', { claude, id: `wamid.IN.${name.replace(' ', '')}` });
    noErr(x.res);
    const m = inMsg(x.g);
    assert.deepStrictEqual([m.AI_Action, m.AI_Status, m.Needs_Human, Number(m.Intent ? 1 : 0)], ['handoff', 'handed_off', true, 0], name);
    assert.match(m.AI_Reason, /could not decide/, name);
    assert.strictEqual(x.cl.calls.length, 1, name);
    assert(x.meta.calls.some((c) => c.body.template && c.body.template.name === 'human_handoff_alert'), `${name}: staff alerted`);
    const patient = x.meta.calls.filter((c) => c.body.type === 'text');
    assert(patient.length <= 1 && patient.every((c) => /team/i.test(c.body.text.body)), `${name}: only the fixed holding text`);
  }
});

test('invalid AI output (not JSON, wrong schema, unknown intent, out-of-range confidence): hand-off, never sent to the patient as is', () => {
  const bad = {
    'not json': 'this is not json',
    'wrong schema': { hello: 'world' },
    'unknown intent': { ...F.BASE_DECISION, intent: 'sell_everything', action: 'reply', reply: 'BUY NOW' },
    'confidence 7': { ...F.BASE_DECISION, confidence: 7, reply: 'BUY NOW' },
  };
  for (const [name, out] of Object.entries(bad)) {
    const x = inbound('How much is a physio session?', { claude: F.fakeClaude(() => out), id: `wamid.IN.${name.replace(/\W/g, '')}` });
    noErr(x.res);
    const m = inMsg(x.g);
    assert.deepStrictEqual([m.AI_Action, m.AI_Status, m.Needs_Human], ['handoff', 'handed_off', true], name);
    assert(!outMsgs(x.g).some((o) => /BUY NOW/.test(o.Body)), `${name}: the invalid answer was not sent`);
    assert(x.meta.calls.every((c) => !(c.body.text && /BUY NOW/.test(c.body.text.body))), `${name}: nothing invalid reached Meta`);
  }
});

test('consent: without consent W13 sends the patient only a free-text reply inside the 24 h window (patient-initiated); a template needs consent in W12', () => {
  const x = inbound('How much is a physio session?', { g: crm({ consent: false }), env: { FLOWHQ_W2_IMPLIED_CONSENT: 'false' } });
  noErr(x.res);
  assert.strictEqual(rows(x.g, 'LEADS').find((l) => l.Phone === P.ASHA).Consent_WhatsApp, false, 'consent stays off');
  assert(x.meta.calls.every((c) => c.body.type === 'text'), 'no template goes to a patient without consent');
  // W12 itself: a W13-keyed template to a patient without consent is blocked
  const g = crm({ consent: false });
  const meta = fakeMeta();
  const res = run(after, 'W12 – When called by another workflow', [H.sendItem({ source_workflow: 'W13-ai-receptionist', idem_key: 'W13:patient_reply:77', template: 'reminder_24h' })], { grist: g, meta });
  const out = res.r.runData['W12 – Return result'][0].json;
  assert.deepStrictEqual([out.sent, out.send_status, meta.calls.length, ledger(g).length], [false, 'blocked', 0, 0]);
});

test('opt-out and human hand-off: an opted-out lead, a paused conversation and a conversation waiting for a person are never answered by the AI', () => {
  const conv = (f) => [{ id: 1, fields: { Lead: 1, Phone: P.ASHA, Last_Inbound_At: T - 600, ...f } }];
  for (const [name, g] of [
    ['opted out', crm({ leadExtra: { Opted_Out: true } })],
    ['paused', crm({ convs: conv({ Automation_Paused: true }) })],
    ['waiting for a person', crm({ convs: conv({ Needs_Human: true }) })],
  ]) {
    const x = inbound('How much is a physio session?', { g, id: `wamid.IN.${name.replace(/\W/g, '')}` });
    noErr(x.res);
    assert.strictEqual(x.cl.calls.length, 0, `${name}: no provider call`);
    assert.strictEqual(x.meta.calls.length, 0, `${name}: nothing sent`);
    assert.strictEqual(ledger(x.g).length, 0, name);
  }
});

test('human escalation: an emergency never reaches the AI; staff are alerted and the conversation is flagged for a person', () => {
  const x = inbound('I have severe chest pain and cannot breathe');
  noErr(x.res);
  assert.strictEqual(x.cl.calls.length, 0);
  const m = inMsg(x.g);
  assert.deepStrictEqual([m.AI_Action, m.AI_Status, m.Needs_Human], ['handoff', 'handed_off', true]);
  assert.match(m.AI_Reason, /emergency/i);
  assert(x.meta.calls.some((c) => c.body.template && c.body.template.name === 'human_handoff_alert' && c.body.to === P.OWNER.slice(1)));
  assert.strictEqual(rows(x.g, 'Conversations')[0].Needs_Human, true);
});

finish('W13 visible skip');
