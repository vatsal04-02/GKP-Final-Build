// W2 of the PRODUCTION export (inbound WhatsApp + delivery receipts), run in the simulator. Signed like Meta signs. Made-up data.
// Run: node n8n/production/tests/w2.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, runItem, inboundRequest, messageBody, statusBody, fakeMeta, ledger, rows, freshGrist, test, finish, P, ENV, DAY, F, DOC, sendItem } = H;
const wf = loadWf();
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const post = (body, o = {}) => { const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(body, o.req || {}), o); res.codes = res.r.responses.map((x) => x.code); res.runs = allRuns(res.r); return res; };
const noErr = (res) => { for (const x of res.runs) assert.strictEqual(x.error, null, x.error && `${x.error.node}: ${x.error.message}`); };
const writes = (g) => g.calls.filter((c) => c.method !== 'GET');
const mkOpenRouter = () => { const claude = F.fakeClaude(); const fn = F.fakeOpenRouter(claude); const calls = []; const wrap = (...a) => { calls.push(a[3]); return fn(...a); }; wrap.calls = calls; wrap.claude = claude; return wrap; };
const AI_AUTO = { ai_mode: 'auto' };
const gristWith = (settings = {}, extra = {}) => freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...settings }), ...extra });

// ---------------------------------------------------------------- signature, handshake, config
test('unsigned / forged / tampered / re-serialised POSTs get 401 and nothing is read, written or sent', () => {
  const body = messageBody('hello');
  const raw = H.metaRaw(body);
  for (const [name, o] of Object.entries({
    'no signature header': { req: { headers: {} } },
    'wrong secret': { req: { secret: 'another-secret-0123456789abcdef' } },
    'tampered body': { req: { signature: H.sign(raw), binaryRaw: raw.replace('hello', 'hellx') } },
    'no raw body': { req: { binary: false } },
    'malformed header': { req: { headers: { 'x-hub-signature-256': 'sha256=zz' } } },
    'sha1 only': { req: { headers: { 'x-hub-signature-256': 'sha1=abc' } } },
  })) {
    const meta = fakeMeta();
    const res = post(body, { ...o, meta });
    assert.deepStrictEqual(res.codes, [401], name);
    assert.strictEqual(writes(res.grist).length, 0, name);
    assert.strictEqual(meta.calls.length, 0, name);
    assert.strictEqual(res.grist.calls.length, 0, `${name}: not even a read`);
  }
});

test('the App Secret / verify token are required: without them W2 fails closed (config guard), nothing is processed', () => {
  const res = post(messageBody('hello'), { unset: ['FLOWHQ_META_APP_SECRET'] });
  assert.match(res.r.error.message, /FLOWHQ_META_APP_SECRET is not set/);
  assert.strictEqual(res.grist.calls.length, 0);
  const v = runItem(wf, 'W2 – Webhook Verify', { json: { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' } } }, { unset: ['FLOWHQ_META_VERIFY_TOKEN'] });
  assert.match(v.r.error.message, /FLOWHQ_META_VERIFY_TOKEN is not set/);
});

test('handshake: the right token returns the challenge, a wrong token gets 403', () => {
  const ok = runItem(wf, 'W2 – Webhook Verify', { json: { query: { 'hub.mode': 'subscribe', 'hub.verify_token': ENV.FLOWHQ_META_VERIFY_TOKEN, 'hub.challenge': '4711' } } });
  assert.deepStrictEqual([ok.r.error, ok.r.responses[0].code, ok.r.responses[0].body], [null, 200, '4711']);
  const bad = runItem(wf, 'W2 – Webhook Verify', { json: { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '4711' } } });
  assert.deepStrictEqual([bad.r.responses[0].code], [403]);
});

// ---------------------------------------------------------------- inbound messages
test('a signed patient message is stored once: lead, conversation, message; a replay (same WA_Message_ID) creates nothing new', () => {
  const g = gristWith();
  const a = post(messageBody('Hi, do you treat knee pain?', { id: 'wamid.IN.A', from: P.BOB, name: 'Bob Singh' }), { grist: g });
  noErr(a);
  assert.deepStrictEqual(a.codes, [200]);
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert.strictEqual(rows(g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.IN.A').length, 1);
  const before = JSON.stringify(g.docs[DOC]);
  const b = post(messageBody('Hi, do you treat knee pain?', { id: 'wamid.IN.A', from: P.BOB, name: 'Bob Singh' }), { grist: g });
  noErr(b);
  assert.strictEqual(rows(g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.IN.A').length, 1, 'no duplicate message');
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert(JSON.stringify(g.docs[DOC]).length <= before.length + 400, 'a replay writes at most a log row');
});

test('external AI is OFF by default: ai_mode=auto but FLOWHQ_AI_EXTERNAL_ENABLED unset -> the provider is never called and nobody is answered', () => {
  const g = gristWith(AI_AUTO, { Knowledge: H.clone(F.KNOWLEDGE) });
  const or = mkOpenRouter();
  const meta = fakeMeta();
  const res = post(messageBody('How much does it cost?', { id: 'wamid.IN.B', from: P.ASHA }), { grist: g, openrouter: or, meta, now: F.NOW });
  noErr(res);
  assert.strictEqual(or.calls.length, 0, 'no request to the AI provider');
  assert.strictEqual(meta.calls.length, 0, 'no automatic reply');
  assert.strictEqual(rows(g, 'Messages').filter((m) => m.Direction === 'In' && m.WA_Message_ID === 'wamid.IN.B').length, 1, 'the message itself is stored for the staff');
});

test('external AI enabled: ONE provider call, with the name / phone / e-mail masked, and the reply uses the first name', () => {
  const g = gristWith({ ...AI_AUTO, booking_link: 'https://cal.com/demo-physio/assessment' }, { LEADS: F.leadRows(), Conversations: F.conversationRows(), Messages: F.messageRows(), Appointments: F.appointmentRows(), Knowledge: H.clone(F.KNOWLEDGE) });
  const or = mkOpenRouter();
  const meta = fakeMeta();
  const res = post(messageBody('How much does it cost? mail me at asha.patel@example.com or call 98000 00011', { id: 'wamid.IN.C', from: P.ASHA, name: 'Asha Patel' }), { grist: g, openrouter: or, meta, now: F.NOW, env: { FLOWHQ_AI_EXTERNAL_ENABLED: 'true' } });
  noErr(res);
  assert.strictEqual(or.calls.length, 1);
  const sent = JSON.stringify(or.calls[0]);
  assert(!/Asha|Patel|asha\.patel|example\.com|9800000011|98000 00011|9000000011/.test(sent), `identifiers left in the provider request: ${sent.match(/.{40}(Asha|Patel|example\.com|98000|9000000011).{40}/)}`);
  assert(/\[PATIENT\]/.test(sent) && /\[EMAIL\]/.test(sent) && /\[NUMBER\]/.test(sent));
  assert(/₹|KNOWLEDGE/.test(sent), 'the clinic facts still go through (prices are not masked)');
  assert(/2026-10-0\d/.test(sent), 'calendar dates are not masked');
  const sentToMeta = meta.calls.map((c) => JSON.stringify(c.body));
  assert(sentToMeta.length >= 1, 'a reply was sent');
  assert(!sentToMeta.some((b) => /\[PATIENT\]|\[NUMBER\]|\[EMAIL\]/.test(b)), 'no placeholder reaches the patient');
});

test('STOP opts the patient out even when external AI is disabled', () => {
  const g = gristWith(AI_AUTO, { LEADS: F.leadRows(), Conversations: F.conversationRows(), Messages: F.messageRows(), Appointments: F.appointmentRows() });
  const meta = fakeMeta();
  const res = post(messageBody('STOP', { id: 'wamid.IN.STOP', from: P.ASHA }), { grist: g, meta, openrouter: mkOpenRouter(), now: F.NOW });
  noErr(res);
  assert.strictEqual(rows(g, 'LEADS').find((l) => l.Phone === P.ASHA).Opted_Out, true);
  assert.strictEqual(meta.calls.length, 0);
});

test('an unknown phone_number_id is rejected without touching any clinic document', () => {
  const g = gristWith();
  const res = post(messageBody('hello', { pnid: '999999999999' }), { grist: g });
  noErr(res);
  assert.strictEqual(writes(g).filter((c) => c.doc === DOC).length, 0);
});

// ---------------------------------------------------------------- delivery receipts
const sentOnce = (g, over = {}, o = {}) => { const res = run(wf, 'W12 – When called by another workflow', [sendItem(over)], { grist: g, ...o }); assert.strictEqual(res.r.error, null, res.r.error && res.r.error.message); return res; };
const receipt = (g, statuses, o = {}) => { const res = post(statusBody(statuses), { grist: g, ...o }); noErr(res); return res; };
const consenting = () => F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } }));
const setup = () => { const g = gristWith({}, { LEADS: consenting(), Conversations: F.conversationRows() }); sentOnce(g); return g; };
const KEY = 'W5:reminder_24h:uid-1';

test('receipts walk the ledger and the Messages row forward: sent -> delivered -> read; late or repeated receipts never go backwards', () => {
  const g = setup();
  assert.deepStrictEqual([ledger(g)[0].Status, rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.TEST1').Status], ['accepted', 'queued']);
  const st = () => [ledger(g)[0].Status, rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.TEST1').Status];
  receipt(g, [{ id: 'wamid.TEST1', status: 'sent', biz_opaque_callback_data: `fhq:${KEY}` }]);
  assert.deepStrictEqual(st(), ['accepted', 'sent']);
  receipt(g, [{ id: 'wamid.TEST1', status: 'delivered', biz_opaque_callback_data: `fhq:${KEY}` }]);
  assert.deepStrictEqual(st(), ['delivered', 'delivered']);
  receipt(g, [{ id: 'wamid.TEST1', status: 'read', biz_opaque_callback_data: `fhq:${KEY}` }]);
  assert.deepStrictEqual(st(), ['read', 'read']);
  receipt(g, [{ id: 'wamid.TEST1', status: 'delivered', biz_opaque_callback_data: `fhq:${KEY}` }, { id: 'wamid.TEST1', status: 'sent' }, { id: 'wamid.TEST1', status: 'failed', errors: [{ code: 131026, title: 'undeliverable' }] }]);
  assert.deepStrictEqual(st(), ['read', 'read'], 'nothing goes backwards, a failure after "read" is ignored');
  assert.strictEqual(rows(g, 'Run_Log').filter((l) => l.Workflow === 'W2-delivery-status').length, 0);
});

test('a delivery failure marks the ledger and the message failed and is logged', () => {
  const g = setup();
  receipt(g, [{ id: 'wamid.TEST1', status: 'failed', biz_opaque_callback_data: `fhq:${KEY}`, errors: [{ code: 131026, title: 'Message undeliverable' }] }]);
  assert.deepStrictEqual([ledger(g)[0].Status, ledger(g)[0].Error_Code, rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.TEST1').Status], ['failed', 131026, 'failed']);
  const l = rows(g, 'Run_Log').filter((x) => x.Workflow === 'W2-delivery-status');
  assert.deepStrictEqual([l.length, l[0].Outcome], [1, 'failed']);
  assert.match(l[0].Error, /131026/);
  receipt(g, [{ id: 'wamid.TEST1', status: 'failed', biz_opaque_callback_data: `fhq:${KEY}`, errors: [{ code: 131026, title: 'Message undeliverable' }] }]);
  assert.strictEqual(rows(g, 'Run_Log').filter((x) => x.Workflow === 'W2-delivery-status').length, 1, 'the same receipt twice logs once');
});

test('an UNCERTAIN send is settled by its receipt: the ledger learns the message id and the status', () => {
  const g = gristWith({}, { LEADS: consenting(), Conversations: F.conversationRows() });
  sentOnce(g, {}, { meta: fakeMeta(() => { throw new Error('timeout'); }) });
  assert.deepStrictEqual([ledger(g)[0].Status, ledger(g)[0].WA_Message_ID], ['uncertain', '']);
  receipt(g, [{ id: 'wamid.LATE1', status: 'delivered', biz_opaque_callback_data: `fhq:${KEY}` }]);
  assert.deepStrictEqual([ledger(g)[0].Status, ledger(g)[0].WA_Message_ID], ['delivered', 'wamid.LATE1']);
});

test('a receipt without callback data is matched by WA_Message_ID', () => {
  const g = setup();
  receipt(g, [{ id: 'wamid.TEST1', status: 'delivered' }]);
  assert.strictEqual(ledger(g)[0].Status, 'delivered');
});

test('receipts for unknown messages or unknown clinics change nothing; garbage statuses are ignored', () => {
  const g = setup();
  const snapshot = JSON.stringify(g.docs[DOC]);
  receipt(g, [{ id: 'wamid.NOPE', status: 'delivered' }]);
  assert.strictEqual(JSON.stringify(g.docs[DOC]), snapshot);
  const res = post(statusBody([{ id: 'wamid.TEST1', status: 'delivered' }], { pnid: '999999999999' }), { grist: g });
  noErr(res);
  assert.strictEqual(JSON.stringify(g.docs[DOC]), snapshot);
  receipt(g, [{ id: 'wamid.TEST1', status: 'exploded' }, { status: 'read' }]);
  assert.strictEqual(JSON.stringify(g.docs[DOC]), snapshot);
});

test('a payload with a message AND a receipt processes both', () => {
  const g = setup();
  const body = messageBody('Hi', { id: 'wamid.IN.MIX', from: P.BOB, name: 'Bob Singh' });
  body.entry[0].changes[0].value.statuses = [{ id: 'wamid.TEST1', status: 'delivered', recipient_id: P.ASHA.slice(1), timestamp: '1', biz_opaque_callback_data: `fhq:${KEY}` }];
  const res = post(body, { grist: g });
  noErr(res);
  assert.strictEqual(ledger(g)[0].Status, 'delivered');
  assert(rows(g, 'Messages').some((m) => m.WA_Message_ID === 'wamid.IN.MIX'));
});

test('a receipt whose signature is wrong is refused before anything is read', () => {
  const g = setup();
  const calls = g.calls.length;
  const res = post(statusBody([{ id: 'wamid.TEST1', status: 'delivered' }]), { grist: g, req: { secret: 'wrong-secret-0123456789abcdef' } });
  assert.deepStrictEqual(res.codes, [401]);
  assert.strictEqual(g.calls.length, calls);
});

finish('W2 production');
