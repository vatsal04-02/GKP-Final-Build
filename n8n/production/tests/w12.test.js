// W12 of the PRODUCTION export, run in the simulator: uncertain state, send ledger (idempotency), callback data, template policy, quiet hours.
// Run: node n8n/production/tests/w12.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, sendItem, fakeMeta, metaError, ledger, freshGrist, test, finish, DAY, NIGHT, P, ENV } = H;
const wf = loadWf();
const START = 'W12 – When called by another workflow';
const out = (res) => (res.r.runData['W12 – Return result'] || [])[0].json;
const fg = () => freshGrist({ LEADS: [H.ashaLead()] });
const go = (over, o) => { const res = run(wf, START, [sendItem(over)], { grist: fg(), ...o }); assert.strictEqual(res.r.error, null, res.r.error && `${res.r.error.node}: ${res.r.error.message}`); return { ...res, out: out(res) }; };

test('a template send: Meta is called once, with callback data; the ledger row ends "accepted" with the message id', () => {
  const meta = fakeMeta();
  const { out: o, grist } = go({}, { meta });
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.biz_opaque_callback_data, 'fhq:W5:reminder_24h:uid-1');
  assert.strictEqual(meta.calls[0].body.template.name, 'reminder_24h');
  assert.strictEqual(meta.calls[0].url, 'https://graph.facebook.com/v23.0/123456789012345/messages');
  assert.deepStrictEqual([o.sent, o.uncertain, o.duplicate, o.send_status, o.wa_message_id, o.idem_key], [true, false, false, 'accepted', 'wamid.TEST1', 'W5:reminder_24h:uid-1']);
  const l = ledger(grist);
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual([l[0].Idem_Key, l[0].Status, l[0].WA_Message_ID, l[0].Template, l[0].Audience], ['W5:reminder_24h:uid-1', 'accepted', 'wamid.TEST1', 'reminder_24h', 'patient']);
  assert(!JSON.stringify(l).includes('9000000011'), 'the ledger must not hold the phone number');
});

test('the same key again: duplicate, Meta is NOT called', () => {
  const meta = fakeMeta();
  const grist = fg();
  go({}, { meta, grist });
  const second = go({}, { meta, grist });
  assert.strictEqual(meta.calls.length, 1);
  assert.deepStrictEqual([second.out.sent, second.out.duplicate, second.out.send_status], [false, true, 'duplicate']);
  assert.match(second.out.send_error, /already handled.*"accepted"/);
  assert.strictEqual(ledger(grist).length, 1);
});

test('a Meta timeout is UNCERTAIN: sent=false, uncertain=true, never re-sent', () => {
  const grist = fg();
  const meta = fakeMeta(() => { throw new Error('timeout of 15000ms exceeded'); });
  const a = go({}, { meta, grist });
  assert.deepStrictEqual([a.out.sent, a.out.uncertain, a.out.send_status], [false, true, 'uncertain']);
  assert.strictEqual(ledger(grist)[0].Status, 'uncertain');
  const meta2 = fakeMeta();
  const b = go({}, { meta: meta2, grist });
  assert.strictEqual(meta2.calls.length, 0, 'an uncertain message must not be sent again');
  assert.deepStrictEqual([b.out.duplicate, b.out.send_status], [true, 'duplicate']);
});

test('a 2xx answer without a message id is uncertain too', () => {
  const a = go({}, { meta: fakeMeta({ status: 200, body: { messages: [] } }) });
  assert.deepStrictEqual([a.out.sent, a.out.uncertain, a.out.send_status], [false, true, 'uncertain']);
});

test('a Meta rejection is "rejected" in the ledger and may be tried again', () => {
  const grist = fg();
  const a = go({}, { meta: fakeMeta(metaError(400, 132001, 'template not found')), grist });
  assert.deepStrictEqual([a.out.sent, a.out.uncertain, a.out.send_status, a.out.send_error_code], [false, false, 'rejected', 132001]);
  assert.strictEqual(ledger(grist)[0].Status, 'rejected');
  const meta2 = fakeMeta();
  const b = go({}, { meta: meta2, grist });
  assert.strictEqual(meta2.calls.length, 1);
  assert.strictEqual(b.out.sent, true);
  assert.deepStrictEqual(ledger(grist).map((l) => l.Status), ['rejected', 'accepted']);
});

test('two runs racing for the same key: only the lowest ledger row sends', () => {
  const grist = fg();
  const real = grist.handle.bind(grist);
  let injected = false;
  grist.handle = (method, url, query, body) => {
    if (method === 'POST' && /Send_Ledger/.test(url) && !injected) {   // a rival run claims the key between our lookup and our claim
      injected = true;
      real('POST', url, {}, { records: [{ fields: { Idem_Key: 'W5:reminder_24h:uid-1', Status: 'sending', Created_At: 1, Updated_At: 1 } }] });
    }
    return real(method, url, query, body);
  };
  const meta = fakeMeta();
  const a = go({}, { meta, grist });
  assert.strictEqual(meta.calls.length, 0, 'the loser must not call Meta');
  assert.deepStrictEqual([a.out.sent, a.out.duplicate, a.out.send_status], [false, true, 'duplicate']);
  assert.deepStrictEqual(ledger(grist).map((l) => [l.id, l.Status]), [[1, 'sending'], [2, 'duplicate']]);
});

test('ledger unreadable: nothing is sent (fail closed), result "blocked"', () => {
  const grist = fg();
  const real = grist.handle.bind(grist);
  grist.handle = (m, u, q, b) => { if (/Send_Ledger/.test(u)) throw new Error('Grist 503: down'); return real(m, u, q, b); };
  const meta = fakeMeta();
  const a = go({}, { meta, grist });
  assert.strictEqual(meta.calls.length, 0);
  assert.deepStrictEqual([a.out.sent, a.out.send_status], [false, 'blocked']);
  assert.match(a.out.send_error, /could not read the send ledger/);
});

test('ledger claim fails: nothing is sent', () => {
  const grist = fg();
  const real = grist.handle.bind(grist);
  grist.handle = (m, u, q, b) => { if (m === 'POST' && /Send_Ledger/.test(u)) throw new Error('Grist 500: boom'); return real(m, u, q, b); };
  const meta = fakeMeta();
  const a = go({}, { meta, grist });
  assert.strictEqual(meta.calls.length, 0);
  assert.deepStrictEqual([a.out.sent, a.out.send_status], [false, 'blocked']);
  assert.match(a.out.send_error, /could not write to the send ledger/);
});

test('ledger update fails after Meta accepted: the result is still "sent", the row stays "sending" (blocks a second send)', () => {
  const grist = fg();
  const real = grist.handle.bind(grist);
  grist.handle = (m, u, q, b) => { if (m === 'PATCH' && /Send_Ledger/.test(u)) throw new Error('Grist 500: boom'); return real(m, u, q, b); };
  const a = go({}, { grist });
  assert.deepStrictEqual([a.out.sent, a.out.send_status], [true, 'accepted']);
  assert.strictEqual(ledger(grist)[0].Status, 'sending');
  const meta2 = fakeMeta();
  go({}, { meta: meta2, grist: Object.assign(grist, { handle: real }) });
  assert.strictEqual(meta2.calls.length, 0);
});

test('no idempotency key, or no ledger location: not sent', () => {
  const meta = fakeMeta();
  const a = go({ idem_key: '' }, { meta });
  assert.deepStrictEqual([a.out.send_status, meta.calls.length], ['invalid', 0]);
  assert.match(a.out.send_error, /no idempotency key/);
  const b = go({ doc_id: '' }, { meta });
  assert.deepStrictEqual([b.out.send_status, meta.calls.length], ['invalid', 0]);
  assert.match(b.out.send_error, /ledger location/);
});

test('callers that identify the message by their own id get a derived key', () => {
  for (const [over, key] of [
    [{ idem_key: '', source_workflow: 'W7-outcome-nudge', template: 'outcome_check', booking_uid: 'uid-9', template_params: { name: 'A', clinic_name: 'C' } }, 'W7-outcome-nudge:outcome_check:uid-9'],
    [{ idem_key: '', source_workflow: 'W10-staff-reply', message_type: 'text', text_body: 'hello', last_inbound_at: Math.floor(DAY / 1000) - 60, inbox_row_id: 31 }, 'W10-staff-reply:text:31'],
    [{ idem_key: '', source_workflow: 'W9-weekly-report', audience: 'staff', template: 'weekly_owner_report', week: '2026-W41', template_params: { clinic_name: 'C', week: 'w', summary: 's' }, decision: { send: true, to: P.OWNER, reason: 'ok' } }, 'W9-weekly-report:weekly_owner_report:2026-W41'],
  ]) {
    const meta = fakeMeta();
    const a = go(over, { meta });
    assert.strictEqual(a.out.idem_key, key);
    assert.strictEqual(a.out.sent, true, a.out.send_error);
  }
});

test('hello_world is refused unless FLOWHQ_WA_ALLOW_HELLO_WORLD=true', () => {
  const meta = fakeMeta();
  const a = go({ template: 'hello_world', template_params: {}, idem_key: 'smoke-1' }, { meta });
  assert.deepStrictEqual([a.out.sent, a.out.send_status, meta.calls.length], [false, 'invalid', 0]);
  assert.match(a.out.send_error, /hello_world.*not sent to people in production/);
  const b = go({ template: 'hello_world', template_params: {}, idem_key: 'smoke-2' }, { meta, env: { FLOWHQ_WA_ALLOW_HELLO_WORLD: 'true' } });
  assert.strictEqual(b.out.sent, true);
});

test('quiet hours 21:00-08:00 IST block the send (the temporary test switch is OFF)', () => {
  const meta = fakeMeta();
  const a = go({}, { meta, now: NIGHT });
  assert.deepStrictEqual([a.out.sent, a.out.send_status, meta.calls.length], [false, 'blocked', 0]);
  assert.match(a.out.send_error, /quiet hours/);
  assert.strictEqual(ledger(a.grist).length, 0, 'a blocked message leaves no ledger row');
});

test('allowlist mode: a number that is not listed is blocked', () => {
  const meta = fakeMeta();
  const a = go({ decision: { send: true, to: '+919000000077', reason: 'ok' }, lead_phone: '+919000000077' }, { meta });
  assert.deepStrictEqual([a.out.send_status, meta.calls.length], ['blocked', 0]);
  assert.match(a.out.send_error, /not in the W12 allowlist/);
});

test('send_mode off blocks everything; a bad mode fails the config guard', () => {
  const meta = fakeMeta();
  const a = go({}, { meta, env: { FLOWHQ_WA_SEND_MODE: 'off' } });
  assert.deepStrictEqual([a.out.send_status, meta.calls.length], ['blocked', 0]);
  const res = run(wf, START, [sendItem()], { meta, env: { FLOWHQ_WA_SEND_MODE: 'yes' } });
  assert.match(res.r.error.message, /FLOWHQ_WA_SEND_MODE must be allowlist, live or off/);
  assert.strictEqual(meta.calls.length, 0);
});

test('missing environment: the config guard stops W12 before anything is called', () => {
  const meta = fakeMeta();
  const res = run(wf, START, [sendItem()], { meta, env: { FLOWHQ_WA_ALLOWLIST: '' } });
  assert.match(res.r.error.message, /FLOWHQ_WA_ALLOWLIST is not set/);
  assert.strictEqual(meta.calls.length, 0);
});

test('the ledger stores no message text and no phone number', () => {
  const grist = fg();
  go({}, { grist });
  const text = JSON.stringify(grist.docs.DOCA.Send_Ledger);
  assert(!/Asha|reminder is|9000000011/.test(text), text);
});

finish('W12 production');
