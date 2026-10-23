// W12 pre-send pause check (n8n/final/tools/patch-w12-pause-check.js) in the simulator: fake Grist, Meta and AI, nothing leaves this computer.
//   node n8n/final/tests/w12-pause.test.js        (PAUSE_FILE=<export.json> tests another export that already carries the check)
//
// What is proved: a W13 patient reply is stopped when Conversations.Automation_Paused is true at the moment W12 is about to send,
// before the send ledger is touched and before Meta is called; anything but an explicit false blocks it (fail closed); the right
// conversation of the right clinic document is read; and nothing else W12 sends (staff alerts, staff replies, W3 / W5 / W6 messages,
// templates) is affected.
// What is NOT proved (and cannot be): the window between W12's last Grist read and the Meta call. It is a few Grist round trips
// (ledger lookup, claim, verify): short, but not zero. A switch flipped inside it still lets that one reply go out.
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
process.env.PROD_FILE = process.env.PAUSE_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const H = require('../../production/tests/harness');
const { patch, unpatch, N, ADDED } = require('../tools/patch-w12-pause-check');
const { run, runItem, inboundRequest, messageBody, sendItem, fakeMeta, ledger, rows, freshGrist, ashaLead, test, finish, clone, P, F, ENV, DAY, DOC } = H;

const after = H.loadWf();
const before = unpatch(after);
const START = 'W12 – When called by another workflow';
const T = Math.floor(DAY / 1000) - 120;

// ---------------------------------------------------------------- fixtures
const MSG = 5; const CONV = 3;
const convRow = (over = {}) => ({ id: CONV, fields: { Lead: 7, Phone: P.ASHA, Last_Inbound_At: T, Unread: 0, Automation_Paused: false, ...over } });
const msgRow = (over = {}) => ({ id: MSG, fields: { Conversation: CONV, Direction: 'In', Body: 'Hello', Created_At: T, ...over } });
const crm = ({ conv = convRow(), msg = msgRow(), extraConvs = [], extraMsgs = [], lead = ashaLead() } = {}) =>
  freshGrist({ LEADS: [lead], Conversations: [...(conv ? [conv] : []), ...extraConvs], Messages: [...(msg ? [msg] : []), ...extraMsgs] });
const reply = (over = {}) => sendItem({
  source_workflow: 'W13-ai-receptionist', w13_kind: 'patient_reply', audience: 'patient', message_type: 'text', template: '', template_params: undefined,
  text_body: 'The first assessment costs 500 rupees.', message_text: 'The first assessment costs 500 rupees.', idem_key: `W13:patient_reply:${MSG}`,
  last_inbound_at: T, lead_row_id: 7, lead_phone: P.ASHA, ...over,
});
const go = (wf, item, { g = crm(), meta = fakeMeta() } = {}) => {
  const res = run(wf, START, [item], { grist: g, meta });
  assert.strictEqual(res.r.error, null, res.r.error && `${res.r.error.node}: ${res.r.error.message}`);
  return { g: res.grist, meta, r: res.r, out: res.r.runData['W12 – Return result'][0].json };
};
const callsTo = (g, table) => g.calls.filter((c) => c.table === table);
const blockedClean = (x, why) => {
  assert.deepStrictEqual([x.out.sent, x.out.send_status, x.meta.calls.length], [false, 'blocked', 0]);
  assert.match(x.out.send_error, why);
  assert.strictEqual(callsTo(x.g, 'Send_Ledger').length, 0, 'the ledger was not read, claimed or written');
  assert.strictEqual(ledger(x.g).length, 0);
};
const breakGrist = (g, test, fn) => { const real = g.handle.bind(g); g.handle = (m, u, q, b) => (test(m, u) ? fn(m, u, q, b) : real(m, u, q, b)); return g; };

// ---------------------------------------------------------------- the build
test('the committed workflow is the build: 5 nodes added, only Prepare request and Return result changed, patch refuses to run twice', () => {
  assert.strictEqual(ADDED.length, 5);
  for (const n of ADDED) assert(after.nodes.some((x) => x.name === n), `${n} is missing`);
  assert.strictEqual(JSON.stringify(patch(before)), JSON.stringify(after), 'patch(unpatch(file)) is the file');
  assert.throws(() => patch(after), /already exists/);
  const was = new Map(before.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = after.nodes.filter((n) => was.has(n.name) && was.get(n.name) !== JSON.stringify(n)).map((n) => n.name).sort();
  assert.deepStrictEqual(changed, [N.prepare, N.result].sort());
  assert.strictEqual(after.nodes.length, before.nodes.length + 5);
});

test('graph: every way to the send ledger passes the pause nodes, and a blocked reply goes straight to the result', () => {
  const edges = []; for (const [from, v] of Object.entries(after.connections)) (v.main || []).forEach((o, i) => (o || []).forEach((c) => edges.push([from, c.node, i])));
  const into = (to) => edges.filter((e) => e[1] === to).map((e) => `${e[0]}#${e[2]}`).sort();
  assert.deepStrictEqual(into(N.ledgerLookup), [`${N.needed}#1`, `${N.stop}#1`], 'the ledger is only reached from the two pause exits');
  assert.deepStrictEqual(into(N.needed), [`${N.consentStop}#1`], 'the pause step comes after the consent step');
  assert.deepStrictEqual(edges.filter((e) => e[0] === N.stop).map((e) => `${e[1]}#${e[2]}`), [`${N.result}#0`, `${N.ledgerLookup}#1`]);
  assert.deepStrictEqual(edges.filter((e) => e[0] === N.needed).map((e) => `${e[1]}#${e[2]}`), [`${N.message}#0`, `${N.ledgerLookup}#1`]);
  assert.deepStrictEqual(edges.filter((e) => e[0] === N.message || e[0] === N.conversation || e[0] === N.decide).map((e) => `${e[0]}>${e[1]}`).sort(), [`${N.conversation}>${N.decide}`, `${N.decide}>${N.stop}`, `${N.message}>${N.conversation}`].sort());
  const named = after.nodes.filter((n) => ADDED.includes(n.name));
  for (const n of named.filter((x) => /httpRequest/.test(x.type))) {
    assert.strictEqual(n.onError, 'continueRegularOutput', `${n.name}: a Grist error must reach the decision, not crash the run`);
    assert.deepStrictEqual(Object.values(n.credentials || {}).map((c) => c.name), ['Header Auth account 2'], n.name);
  }
});

// ---------------------------------------------------------------- the check
test('BEFORE the check: a paused conversation still got the reply (the gap that is being closed)', () => {
  const x = go(before, reply(), { g: crm({ conv: convRow({ Automation_Paused: true }) }) });
  assert.deepStrictEqual([x.out.sent, x.meta.calls.length], [true, 1]);
});

test('not paused: sent exactly once; the conversation was read BEFORE the ledger was touched', () => {
  const x = go(after, reply());
  assert.deepStrictEqual([x.out.sent, x.out.send_status, x.meta.calls.length, ledger(x.g).length], [true, 'accepted', 1, 1]);
  const order = x.g.calls.map((c) => `${c.method} ${c.table}`);
  const firstLedger = order.findIndex((c) => /Send_Ledger/.test(c));
  assert(order.indexOf('GET Messages') >= 0 && order.indexOf('GET Conversations') > order.indexOf('GET Messages') && order.indexOf('GET Conversations') < firstLedger, order.join(' | '));
  assert.deepStrictEqual(callsTo(x.g, 'Messages')[0].query, { filter: JSON.stringify({ id: [MSG] }), limit: '2' });
  assert.deepStrictEqual(callsTo(x.g, 'Conversations')[0].query, { filter: JSON.stringify({ id: [CONV] }), limit: '2' });
});

test('paused (Human handling on): blocked before the ledger and before Meta; nothing claimed, nothing sent', () => {
  const x = go(after, reply(), { g: crm({ conv: convRow({ Automation_Paused: true }) }) });
  blockedClean(x, /paused by staff/);
  assert.strictEqual(x.out.duplicate, false);
});

test('paused, even for a TEST_MODE reply that would go to the clinic\'s own phone: the AI reply is not sent', () => {
  const x = go(after, reply({ decision: { send: true, to: P.TEST, reason: 'test mode', test_mode: true } }), { g: crm({ conv: convRow({ Automation_Paused: true }) }) });
  blockedClean(x, /paused by staff/);
});

test('switched off again: the same reply is sent (a blocked reply never claimed the ledger), and a repeat is still a duplicate', () => {
  const g = crm({ conv: convRow({ Automation_Paused: true }) });
  blockedClean(go(after, reply(), { g }), /paused by staff/);
  g.docs[DOC].Conversations[0].fields.Automation_Paused = false;
  const meta = fakeMeta();
  const a = go(after, reply(), { g, meta });
  const b = go(after, reply(), { g, meta });
  assert.deepStrictEqual([a.out.sent, b.out.sent, b.out.duplicate, meta.calls.length, ledger(g).length], [true, false, true, 1, 1]);
});

test('ambiguous or malformed answers are never read as "not paused": every one blocks, with the ledger untouched', () => {
  const cases = [
    ['Automation_Paused missing', crm({ conv: { id: CONV, fields: { Lead: 7, Phone: P.ASHA } } }), /missing or is not true\/false/],
    ['Automation_Paused null', crm({ conv: convRow({ Automation_Paused: null }) }), /missing or is not true\/false/],
    ['Automation_Paused "false" (text)', crm({ conv: convRow({ Automation_Paused: 'false' }) }), /missing or is not true\/false/],
    ['Automation_Paused 0', crm({ conv: convRow({ Automation_Paused: 0 }) }), /missing or is not true\/false/],
    ['no such message', crm({ msg: null }), /not found exactly once/],
    ['message without a conversation', crm({ msg: msgRow({ Conversation: 0 }) }), /has no conversation/],
    ['conversation row missing', crm({ conv: null }), /conversation 3 was not found exactly once/],
    ['conversation of another lead', crm({ conv: convRow({ Lead: 8 }) }), /another lead/],
    ['conversation of another phone number', crm({ conv: convRow({ Phone: P.BOB }) }), /another phone number/],
  ];
  for (const [name, g, why] of cases) { const x = go(after, reply(), { g }); try { blockedClean(x, why); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
  for (const [name, idem] of [['idem_key without a row id', 'W13:patient_reply:'], ['idem_key not numeric', 'W13:patient_reply:abc'], ['idem_key of another kind', 'W13:staff_alert:5'], ['idem_key with junk after the id', 'W13:patient_reply:5x']]) {
    const x = go(after, reply({ idem_key: idem })); try { blockedClean(x, /does not say which patient message/); } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
  }
});

test('Grist errors and malformed responses fail closed: nothing is sent and the ledger is never touched', () => {
  const down = (table) => (m, u) => m === 'GET' && new RegExp(`/tables/${table}/records`).test(u);
  for (const [name, g, why] of [
    ['messages: Grist down', breakGrist(crm(), down('Messages'), () => { throw new Error('Grist 503'); }), /could not read the patient message/],
    ['conversations: Grist down', breakGrist(crm(), down('Conversations'), () => { throw new Error('Grist 503'); }), /could not read the conversation/],
    ['conversations: records is not a list', breakGrist(crm(), down('Conversations'), () => ({ records: 'nope' })), /could not read the conversation/],
    ['conversations: empty answer', breakGrist(crm(), down('Conversations'), () => null), /could not read the conversation/],
    ['conversations: two rows', breakGrist(crm(), down('Conversations'), (m, u, q, b) => ({ records: [convRow(), convRow({ Automation_Paused: false })] })), /conversation 3 was not found exactly once/],
    ['conversations: another row id', breakGrist(crm(), down('Conversations'), () => ({ records: [{ ...convRow(), id: 99 }] })), /conversation 3 was not found exactly once/],
    ['messages: another row id', breakGrist(crm(), down('Messages'), () => ({ records: [{ ...msgRow(), id: 6 }] })), /not found exactly once/],
  ]) { const x = go(after, reply(), { g }); try { blockedClean(x, why); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
});

test('the right conversation of the right clinic: a paused conversation of someone else, or in another document, does not matter', () => {
  const other = { id: 4, fields: { Lead: 8, Phone: P.BOB, Last_Inbound_At: T, Unread: 0, Automation_Paused: true } };
  const otherMsg = { id: 6, fields: { Conversation: 4, Direction: 'In', Body: 'Hi', Created_At: T } };
  const g = crm({ extraConvs: [other], extraMsgs: [otherMsg] });
  g.docs.DOCB = { Messages: [{ id: MSG, fields: { Conversation: CONV, Direction: 'In', Body: 'x', Created_At: T } }], Conversations: [{ id: CONV, fields: { Lead: 7, Phone: P.ASHA, Automation_Paused: true } }], Send_Ledger: [] };
  const x = go(after, reply(), { g });
  assert.deepStrictEqual([x.out.sent, x.meta.calls.length], [true, 1]);
  assert(x.g.calls.every((c) => c.doc !== 'DOCB'), 'only the clinic document named in the message was read');
  // and the other way round: THIS patient is paused while the neighbour is not
  const g2 = crm({ conv: convRow({ Automation_Paused: true }), extraConvs: [{ ...other, fields: { ...other.fields, Automation_Paused: false } }], extraMsgs: [otherMsg] });
  blockedClean(go(after, reply(), { g: g2 }), /paused by staff/);
  // the reply for the neighbour's message is judged by the neighbour's conversation
  const g3 = crm({ conv: convRow({ Automation_Paused: true }), extraConvs: [{ ...other, fields: { ...other.fields, Lead: 8, Automation_Paused: false } }], extraMsgs: [otherMsg] });
  const y = go(after, reply({ idem_key: 'W13:patient_reply:6', lead_row_id: 8, lead_phone: P.BOB, decision: { send: true, to: P.BOB, reason: 'ok', test_mode: false } }), { g: g3 });
  assert.strictEqual(y.out.sent, true, y.out.send_error);
});

test('nothing else is blocked or even checked: staff alert, staff reply, W3 / W5 / W6 style messages and templates still go out while Human handling is on', () => {
  const paused = () => crm({ conv: convRow({ Automation_Paused: true }) });
  const meta = fakeMeta();
  const items = [
    ['staff alert', { source_workflow: 'W13-ai-receptionist', w13_kind: 'staff_alert', audience: 'staff', template: 'human_handoff_alert', template_params: { clinic_name: 'C', lead_name: 'N', lead_phone: P.ASHA, reason: 'x' }, decision: { send: true, to: P.OWNER, reason: 'ok' }, idem_key: 'W13:staff_alert:5' }],
    ['staff reply (W10)', { source_workflow: 'W10-staff-reply', audience: 'patient', message_type: 'text', template: '', text_body: 'We will see you at 9.', message_text: 'We will see you at 9.', idem_key: 'W10:reply:77', inbox_row_id: 77, last_inbound_at: T }],
    ['W5 reminder (template)', { idem_key: 'W5:reminder_24h:uid-9' }],
    ['W6 follow-up (template)', { source_workflow: 'W6-followups', idem_key: 'W6:follow_up:uid-9' }],
    ['W3 style message', { source_workflow: 'W3-speed-to-lead', idem_key: 'W3:speed:uid-9' }],
  ];
  for (const [name, over] of items) {
    const g = paused();
    const x = go(after, sendItem(over), { g, meta });
    assert.strictEqual(x.out.sent, true, `${name}: ${x.out.send_error}`);
    assert.deepStrictEqual([callsTo(x.g, 'Messages').filter((c) => c.method === 'GET').length, callsTo(x.g, 'Conversations').filter((c) => c.method === 'GET' && c.query && c.query.limit === '2').length], [0, 0], `${name}: the pause nodes did not run`);
  }
  assert.strictEqual(meta.calls.length, items.length);
});

test('the consent check still runs first and still blocks: a template to a patient with no consent is stopped before the pause step', () => {
  const g = crm({ lead: ashaLead({ Consent_WhatsApp: false }) });
  const x = go(after, sendItem({ idem_key: 'W5:reminder_24h:uid-3' }), { g });
  assert.deepStrictEqual([x.out.send_status, x.meta.calls.length, ledger(x.g).length], ['blocked', 0, 0]);
  assert.match(x.out.send_error, /no WhatsApp consent/);
  assert.strictEqual(callsTo(x.g, 'Messages').length, 0);
});

// ---------------------------------------------------------------- end to end: the race itself (W2 -> W13 -> model -> W12 -> Meta)
const T0 = F.sec(F.NOW);
const e2e = (wf, { flip } = {}) => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER }), LEADS: F.leadRows(), Conversations: [], Messages: [] });
  const meta = fakeMeta();
  let asked = 0;
  const cl = F.fakeClaude(() => { asked += 1; if (flip) { const c = g.docs[DOC].Conversations[0]; c.fields.Automation_Paused = true; } return undefined; });
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody('How much is a physio session?', { id: 'wamid.IN.1', from: P.ASHA, name: 'Asha Patel', ts: T0 })), {
    grist: g, now: F.NOW, openrouter: F.fakeOpenRouter(cl), meta, env: { ...ENV, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}`, FLOWHQ_AI_EXTERNAL_ENABLED: 'true' },
  });
  const all = (r) => [r, ...(r.subRuns || []).flatMap(all)];
  for (const x of all(res.r)) assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`);
  const inMsg = rows(g, 'Messages').find((m) => m.Direction === 'In');
  return { g, meta, asked, inMsg, conv: g.docs[DOC].Conversations[0].fields, log: rows(g, 'Run_Log').filter((l) => l.Workflow === 'W13-ai-receptionist'), out: rows(g, 'Messages').filter((m) => m.Direction === 'Out') };
};

test('race, end to end: Human handling switched on WHILE the model is thinking -> the reply is not sent (no ledger claim, no Meta call); the run is recorded as failed and the conversation flagged for a person', () => {
  const x = e2e(after, { flip: true });
  assert.strictEqual(x.asked, 1, 'the model was asked once (the gate saw "not paused")');
  assert.deepStrictEqual([x.meta.calls.length, ledger(x.g).length, x.out.length], [0, 0, 0]);
  assert.deepStrictEqual([x.inMsg.AI_Status, x.inMsg.Needs_Human, x.conv.Needs_Human], ['failed', true, true]);
  assert.match(x.inMsg.AI_Reason, /paused by staff/);
  assert.deepStrictEqual(x.log.map((l) => l.Outcome), ['failed']);
  assert.strictEqual(x.conv.Automation_Paused, true, 'W13 never changes the switch');
});

test('race, end to end: the same message with nobody pausing is answered once; BEFORE the check the paused reply still went out', () => {
  const ok = e2e(after);
  assert.deepStrictEqual([ok.asked, ok.meta.calls.length, ledger(ok.g).length, ok.inMsg.AI_Status, ok.inMsg.Needs_Human], [1, 1, 1, 'replied', false]);
  const gap = e2e(before, { flip: true });
  assert.deepStrictEqual([gap.meta.calls.length, gap.inMsg.AI_Status], [1, 'replied'], 'without the check the reply is sent although staff took over');
});

finish('w12-pause');
