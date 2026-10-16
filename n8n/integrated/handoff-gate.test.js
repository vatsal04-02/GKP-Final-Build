// The W13 Needs_Human gate, end to end as in production: Meta webhook -> W2 (store) -> W13 (gates, OpenRouter, checks, CRM)
// -> W12 (the only sender) -> fake Meta. The 7 requested cases on the patched workflow, each also run on the workflow BEFORE the
// fix where the behaviour is meant to differ. Fake Grist / Meta / OpenRouter (reads the real prompt); made-up numbers only.
// Run: node n8n/integrated/handoff-gate.test.js       (HANDOFF_FILE / HANDOFF_ORIG = other files, e.g. your private pair)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.HANDOFF_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.handoff-gate.json');
const ORIG_FILE = process.env.HANDOFF_ORIG || path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const prepare = (file) => {
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  set('W12 – Config', 'w12_allowlist', `+${P_ASHA},${OWNER},${TESTP}`);
  set('W2 – Verify Config', 'meta_verify_token', 'test-verify-token-123');
  return w;
};
const NEW = prepare(FILE);
const OLD = prepare(ORIG_FILE);
const crm = (convOver = {}) => new FakeGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false' }), Knowledge: clone(F.KNOWLEDGE), LEADS: clone(F.leadRows()),
    Conversations: F.conversationRows().map((c) => ({ ...c, fields: { ...c.fields, ...convOver } })), Messages: clone(F.messageRows()), Appointments: clone(F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = () => { const calls = []; const fn = (m, url, body) => { calls.push({ url, body }); return { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; }; fn.calls = calls; return fn; };
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const metaBody = (id, text, ts) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
  contacts: [{ profile: { name: 'Asha Patel' }, wa_id: P_ASHA }], messages: [{ from: P_ASHA, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });

// One conversation over time: each step is a new patient message on the same fake Grist / Meta / AI.
function session(w, convOver) {
  const s = { w, g: crm(convOver), meta: fakeMeta(), answers: {}, t: 0 };
  s.claude = F.fakeClaude((req, n) => s.answers[n]);
  s.post = (text, o = {}) => {
    s.t += 1;
    const now = F.NOW + s.t * 120000;
    const id = o.id || `wamid.IN.${s.t}`;
    const before = { ai: s.claude.calls.length, meta: s.meta.calls.length };
    if (o.ai) s.answers[s.claude.calls.length + 1] = o.ai;
    const r = simulate(w, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body: metaBody(id, text, F.sec(now) - 5) } }], grist: s.g, now, workflowId: 'MASTER', workflows: {}, meta: s.meta, openrouter: F.fakeOpenRouter(s.claude) });
    const runs = allRuns(r);
    for (const x of runs) assert.strictEqual(x.error, null, `${x.visited[0]}: ${JSON.stringify(x.error)}`);
    const w12 = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
    assert.strictEqual(s.meta.calls.length - before.meta, w12.length, 'a Meta call that did not come from W12');
    const sent = s.meta.calls.slice(before.meta).map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${c.body.template.components[0].parameters[3].text}`));
    return { r, aiCalls: s.claude.calls.length - before.ai, sent, msg: s.msg(id), conv: s.conv(), lead: s.lead() };
  };
  s.msg = (wamid) => s.g.docs.DOCA.Messages.map((m) => ({ id: m.id, ...m.fields })).find((m) => m.WA_Message_ID === wamid);
  s.conv = () => s.g.docs.DOCA.Conversations[0].fields;
  s.lead = () => s.g.docs.DOCA.LEADS.find((l) => l.fields.Phone === F.ASHA).fields;
  s.lastRequest = () => JSON.stringify(s.claude.calls[s.claude.calls.length - 1].body);
  return s;
};
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';
const PRICE = 'The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.';
const handedOff = (w) => { const s = session(w); const h = s.post('Do you accept the XYZ health insurance card?'); return { s, h }; };

const results = [];
const check = (id, title, fn) => { try { results.push({ id, title, ok: true, why: fn() }); } catch (e) { results.push({ id, title, ok: false, why: e.message.replace(/\s+/g, ' ').slice(0, 400) }); } };

check('1', 'Normal question, no hand-off -> AI answers', () => {
  const s = session(NEW); const x = s.post('How much does this cost?');
  assert.deepStrictEqual([x.aiCalls, x.sent, x.msg.AI_Status, x.msg.Needs_Human, !!x.conv.Needs_Human], [1, [`${P_ASHA}: ${PRICE}`], 'replied', false, false]);
  return 'AI asked once; knowledge-base price sent through W12; AI_Status replied; Needs_Human off';
});
check('2', 'AI hands off -> Needs_Human = true', () => {
  const { h } = handedOff(NEW);
  assert.deepStrictEqual([h.sent, h.msg.AI_Status, h.msg.Needs_Human, h.conv.Needs_Human, h.conv.Handoff_Reason, h.lead.Escalated],
    [[`${P_ASHA}: ${HOLD}`, `${OWNER.slice(1)}: [human_handoff_alert] question not covered by the knowledge base`], 'handed_off', true, true, 'question not covered by the knowledge base', true]);
  return 'holding reply + human_handoff_alert via W12; message + conversation Needs_Human = true; Handoff_Reason set; lead Escalated';
});
check('3', 'Patient sends a new normal question -> AI answers', () => {
  const { s } = handedOff(NEW);
  const x = s.post('How much does this cost?');
  assert.deepStrictEqual([x.aiCalls, x.sent, x.msg.AI_Status, x.msg.Needs_Human], [1, [`${P_ASHA}: ${PRICE}`], 'replied', false]);
  assert.deepStrictEqual([x.conv.Needs_Human, x.conv.Handoff_Reason], [true, 'question not covered by the knowledge base'], 'the earlier hand-off stays for staff');
  assert(!s.lastRequest().includes('question not covered by the knowledge base'), 'the old Handoff_Reason reached the AI');
  assert(/new patient message after a hand-off/.test(x.msg.AI_Reason));
  const { s: o } = handedOff(OLD); const y = o.post('How much does this cost?');
  assert.deepStrictEqual([y.aiCalls, y.sent.length, y.msg.AI_Status], [0, 0, 'skipped'], 'before the fix it was skipped');
  return 'answered (price via W12); the earlier hand-off (Needs_Human, Handoff_Reason) stays for staff; old reason not in the prompt. BEFORE the fix: skipped, AI never asked';
});
for (const [id, label, text, ai, reason] of [
  ['4a', 'medical', 'My knee is swollen, should I take ibuprofen?', { ...F.BASE_DECISION, intent: 'medical_question', action: 'reply', needs_human: false, confidence: 0.95, reply: 'Take 400 mg ibuprofen twice a day.' }, /^medical question/],
  ['4b', 'complaint', 'The therapist was rude to me yesterday', { ...F.BASE_DECISION, intent: 'complaint', action: 'handoff', needs_human: true, sentiment: 'negative', handoff_reason: 'complaint about therapist', priority: 'high', risk_flags: ['complaint'], staff_note: 'Unhappy with the therapist, wants a call. Suggest: call today.' }, /^HIGH · Unhappy with the therapist/],
  ['4c', 'payment', 'I paid twice by UPI, please refund', { ...F.BASE_DECISION, intent: 'payment_issue', action: 'reply', needs_human: false, confidence: 0.9, reply: 'Your refund is done.' }, /^payment issue/],
]) {
  check(id, `Patient sends a new ${label} question -> AI hands off again`, () => {
    const { s } = handedOff(NEW);
    const x = s.post(text, { ai });
    assert.strictEqual(x.aiCalls, 1, 'the new message reached the AI');
    assert.deepStrictEqual([x.sent.length, x.sent[0], x.msg.AI_Status, x.msg.Needs_Human, x.conv.Needs_Human], [2, `${P_ASHA}: ${HOLD}`, 'handed_off', true, true]);
    assert(reason.test(x.conv.Handoff_Reason), `Handoff_Reason = ${x.conv.Handoff_Reason}`);
    assert(/human_handoff_alert/.test(x.sent[1]) && !/ibuprofen|refund is done/i.test(JSON.stringify(s.meta.calls)), 'the AI text was sent');
    return `AI asked; its answer is NOT sent; holding reply + NEW staff alert; Needs_Human set again; Handoff_Reason = "${x.conv.Handoff_Reason.slice(0, 40)}…"`;
  });
}
check('5', 'Human has not replied, patient sends nothing -> AI remains stopped', () => {
  const { s, h } = handedOff(NEW);
  const calls = s.claude.calls.length; const sends = s.meta.calls.length;
  // the 08:05 morning run, a re-delivery of the same webhook by Meta, and a direct re-run of W13 on the handed-off message
  const morning = simulate(NEW, { start: 'W13 – Every Morning', items: [{ json: {} }], grist: s.g, now: Date.parse('2026-10-07T08:05:00+05:30'), workflowId: 'MASTER', workflows: {}, meta: s.meta, openrouter: F.fakeOpenRouter(s.claude) });
  for (const x of allRuns(morning)) assert.strictEqual(x.error, null);
  const again = simulate(NEW, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body: metaBody('wamid.IN.1', 'Do you accept the XYZ health insurance card?', F.sec(F.NOW)) } }], grist: s.g, now: F.NOW + 600000, workflowId: 'MASTER', workflows: {}, meta: s.meta, openrouter: F.fakeOpenRouter(s.claude) });
  for (const x of allRuns(again)) assert.strictEqual(x.error, null);
  const rerun = simulate(NEW, { start: 'W12 – When called by another workflow', items: [{ json: { w13_job: true, dry_run: false, w13_retry: false, wa_phone_number_id: PNID, clinic_slug: 'demo-clinic', message_row_id: h.msg.id, wa_message_id: 'wamid.IN.1', msg_type: 'text', patient_phone: F.ASHA, sender_name: 'Asha Patel', text: '' } }], grist: s.g, now: F.NOW + 900000, workflowId: 'MASTER', workflows: {}, meta: s.meta, openrouter: F.fakeOpenRouter(s.claude) });
  for (const x of allRuns(rerun)) assert.strictEqual(x.error, null);
  assert.deepStrictEqual([s.claude.calls.length - calls, s.meta.calls.length - sends, s.conv().Needs_Human, s.msg('wamid.IN.1').AI_Status], [0, 0, true, 'handed_off']);
  // Needs_Human ticked BY HAND (no hand-off by W13): a new message is still not answered
  const m = session(NEW, { Needs_Human: true }); const y = m.post('How much does this cost?');
  assert.deepStrictEqual([y.aiCalls, y.sent.length, y.msg.AI_Status, /waiting for a person/.test(y.msg.AI_Reason)], [0, 0, 'skipped', true]);
  return 'morning retry, Meta re-delivery and a W13 re-run: 0 AI calls, 0 sends, Needs_Human stays true; Needs_Human ticked by hand: a new message is still skipped';
});
check('6', 'STOP still works', () => {
  const { s } = handedOff(NEW);
  const x = s.post('STOP');
  const y = s.post('How much does this cost?');
  assert.deepStrictEqual([x.aiCalls, x.sent.length, x.msg.AI_Status, x.lead.Opted_Out, y.aiCalls, y.sent.length, y.msg.AI_Reason], [0, 0, 'opted_out', true, 0, 0, 'the lead has opted out']);
  return 'STOP after a hand-off: Opted_Out, nothing sent, no AI call; the next message is not answered';
});
check('7', 'Duplicate messages do not trigger AI twice', () => {
  const { s } = handedOff(NEW);
  const x = s.post('How much does this cost?', { id: 'wamid.DUP' });
  const y = s.post('How much does this cost?', { id: 'wamid.DUP' });
  assert.deepStrictEqual([x.aiCalls, x.sent.length, y.aiCalls, y.sent.length, s.g.docs.DOCA.Messages.filter((m) => m.fields.WA_Message_ID === 'wamid.DUP').length], [1, 1, 0, 0, 1]);
  return 'the same WhatsApp message twice after a hand-off: stored once, ONE AI call, ONE reply';
});

const width = Math.max(...results.map((r) => `${r.id}. ${r.title}`.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${`${r.id}. ${r.title}`.padEnd(width)}  ${r.why}`);
const bad = results.filter((r) => !r.ok);
if (process.env.HANDOFF_REPORT) fs.writeFileSync(process.env.HANDOFF_REPORT, JSON.stringify(results, null, 2));
if (bad.length) { console.log(`\n${bad.length} of ${results.length} FAILED`); process.exit(1); }
console.log(`\nNeeds_Human gate: all ${results.length} cases pass on ${path.basename(FILE)}`);
