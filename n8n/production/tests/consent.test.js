// Consent gate (W12) and consent capture (W1 / W2 / W4) in the PRODUCTION export. Run: node n8n/production/tests/consent.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, runItem, inboundRequest, messageBody, sendItem, fakeMeta, ledger, rows, freshGrist, test, finish, P, DAY, F } = H;
const wf = loadWf();
const START = 'W12 – When called by another workflow';
const go = (over, o = {}) => { const res = run(wf, START, [sendItem(over)], o); assert.strictEqual(res.r.error, null, res.r.error && res.r.error.message); return { ...res, out: res.r.runData['W12 – Return result'][0].json }; };
const gristWithLead = (fields = {}, noLead = false) => freshGrist({ LEADS: noLead ? [] : [H.ashaLead(fields)] });

test('a template to a patient WITH consent is sent', () => {
  const meta = fakeMeta();
  assert.strictEqual(go({}, { meta, grist: gristWithLead() }).out.sent, true);
  assert.strictEqual(meta.calls.length, 1);
});

test('no consent on file (empty, false, or unknown lead): not sent, nothing claimed in the ledger', () => {
  for (const [name, grist, why] of [
    ['empty', gristWithLead({ Consent_WhatsApp: undefined }), /no WhatsApp consent on file/],
    ['false', gristWithLead({ Consent_WhatsApp: false }), /no WhatsApp consent on file/],
    ['no lead', gristWithLead({}, true), /no lead with this phone number/],
  ]) {
    const meta = fakeMeta();
    const { out, grist: g } = go({}, { meta, grist });
    assert.deepStrictEqual([out.sent, out.send_status, meta.calls.length, ledger(g).length], [false, 'blocked', 0, 0], name);
    assert.match(out.send_error, why, name);
  }
});

test('an opted-out lead is blocked even with consent', () => {
  const meta = fakeMeta();
  const { out } = go({}, { meta, grist: gristWithLead({ Opted_Out: true }) });
  assert.deepStrictEqual([out.send_status, meta.calls.length], ['blocked', 0]);
  assert.match(out.send_error, /opted out/);
});

test('the lead cannot be read (Grist down): fail closed', () => {
  const g = gristWithLead();
  const real = g.handle.bind(g);
  g.handle = (m, u, q, b) => { if (/LEADS/.test(u)) throw new Error('Grist 503'); return real(m, u, q, b); };
  const meta = fakeMeta();
  const { out } = go({}, { meta, grist: g });
  assert.deepStrictEqual([out.send_status, meta.calls.length], ['blocked', 0]);
  assert.match(out.send_error, /could not read the lead/);
});

test('exempt: TEST_MODE sends (to the clinic\'s own phone), free-text replies inside the 24 h window, and staff alerts', () => {
  const meta = fakeMeta();
  const noConsent = () => gristWithLead({ Consent_WhatsApp: false });
  assert.strictEqual(go({ decision: { send: true, to: P.TEST, reason: 'test mode', test_mode: true } }, { meta, grist: noConsent() }).out.sent, true);
  const text = go({ message_type: 'text', text_body: 'Sure, 9 AM works.', template: '', idem_key: 'W13:patient_reply:5', last_inbound_at: Math.floor(DAY / 1000) - 120 }, { meta, grist: gristWithLead({}, true) });
  assert.strictEqual(text.out.sent, true, text.out.send_error);
  const staff = go({ audience: 'staff', template: 'new_lead_staff_alert', template_params: { clinic_name: 'C', lead_name: 'N', lead_phone: P.ASHA, enquiry: 'x' }, decision: { send: true, to: P.OWNER, reason: 'ok' }, idem_key: 'W3:alert:1' }, { meta, grist: gristWithLead({}, true) });
  assert.strictEqual(staff.out.sent, true, staff.out.send_error);
  assert.strictEqual(meta.calls.length, 3);
});

test('the lead is found by phone however the caller spells its phone field', () => {
  const meta = fakeMeta();
  const { out } = go({ lead_phone: '98000 00011'.replace('98000 00011', '+91 90000 00011') }, { meta, grist: gristWithLead() });
  assert.strictEqual(out.sent, true);
});

// ---------------------------------------------------------------- capture
const post = (body, o = {}) => runItem(wf, 'W2 – Webhook Inbound', inboundRequest(body), { ...o, grist: o.grist || freshGrist() });

test('W2: a patient who starts the chat is recorded with consent (whatsapp-inbound); FLOWHQ_W2_IMPLIED_CONSENT=false turns that off', () => {
  const a = post(messageBody('hello', { id: 'wamid.C1', from: P.BOB, name: 'Bob' }));
  assert.strictEqual(a.r.error, null);
  const l = rows(a.grist, 'LEADS')[0];
  assert.deepStrictEqual([l.Consent_WhatsApp, l.Consent_Source, typeof l.Consent_At], [true, 'whatsapp-inbound', 'number']);
  const b = post(messageBody('hello', { id: 'wamid.C2', from: P.BOB, name: 'Bob' }), { env: { FLOWHQ_W2_IMPLIED_CONSENT: 'false' } });
  const l2 = rows(b.grist, 'LEADS')[0];
  assert.deepStrictEqual([l2.Consent_WhatsApp, l2.Consent_Source, l2.Consent_At], [false, '', null]);
});

finish('consent');
