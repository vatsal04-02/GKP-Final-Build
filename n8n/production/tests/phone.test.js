// The E.164 normaliser: behaviour (extracted from the shipped snippet AND from every node of the export) and "every copy is identical".
// Run: node n8n/production/tests/phone.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadWf, test, finish } = H;
const wf = loadWf();
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'phone.js'), 'utf8');
const fnText = SRC.slice(SRC.indexOf('// E.164'), SRC.length).trim();
const make = (env) => new Function('$env', `${fnText}\nreturn normalizeIndianPhone;`)(env);
const norm = make({});

test('Indian numbers in every common format', () => {
  for (const [raw, want] of [['98765 43210', '+919876543210'], ['+91 98765 43210', '+919876543210'], ['09876543210', '+919876543210'], ['919876543210', '+919876543210'], ['0091 98765-43210', '+919876543210'], ['+919876543210', '+919876543210'], ['(+91) 98765.43210', '+919876543210']]) assert.deepStrictEqual(norm(raw), { phone: want, valid: true }, raw);
});
test('international numbers are accepted', () => {
  for (const [raw, want] of [['+44 7700 900123', '+447700900123'], ['0044 7700 900123', '+447700900123'], ['+1 (415) 555-0132', '+14155550132'], ['+971 50 123 4567', '+971501234567'], ['+49 151 23456789', '+4915123456789']]) assert.deepStrictEqual(norm(raw), { phone: want, valid: true }, raw);
});
test('garbage is rejected', () => {
  for (const raw of [null, undefined, '', 'abc', '12345', '5876543210', '+91 12345 67890', '+91 98765 4321', '+0 123456789', '+1234567', '+1234567890123456', '9876543210123', '++91', '0']) assert.deepStrictEqual(norm(raw), { phone: null, valid: false }, String(raw));
});
test('another default country: local numbers get that country code', () => {
  const uk = make({ FLOWHQ_DEFAULT_COUNTRY_CODE: '44' });
  assert.deepStrictEqual(uk('07700 900123'), { phone: '+447700900123', valid: true });
  assert.deepStrictEqual(uk('+91 98765 43210'), { phone: '+919876543210', valid: true });
  const bad = make({ FLOWHQ_DEFAULT_COUNTRY_CODE: 'xx' });
  assert.deepStrictEqual(bad('98765 43210'), { phone: '+919876543210', valid: true }, 'an invalid setting falls back to India');
});
test('Code nodes without $env (blocked) still work', () => {
  const f = new Function(`${fnText}\nreturn normalizeIndianPhone;`)();
  assert.strictEqual(f('98765 43210').phone, '+919876543210');
});
test('every copy in the export is the same function and none is the old +91-only one', () => {
  let n = 0;
  for (const node of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    const c = node.parameters.jsCode;
    if (!/function normalizeIndianPhone/.test(c)) continue;
    n++;
    const flat = (s) => s.replace(/^ +/gm, '');
    assert(flat(c).includes(flat(fnText)), `${node.name} does not carry the shipped normaliser`);
    assert(!c.includes('const valid = /^[6-9]\\d{9}$/.test(digits);'), `${node.name} still has the +91-only check`);
  }
  assert.strictEqual(n, 19);   // 18 original copies + the staff-alert node of W1
});
test('W2: Meta sends the number without "+": international senders are stored, junk is not', () => {
  const g = H.freshGrist();
  const runIt = (from) => H.runItem(wf, 'W2 – Webhook Inbound', H.inboundRequest(H.messageBody('hello', { id: `wamid.P.${from}`, from: `+${from}`, name: 'Test' })), { grist: g });
  const res = runIt('447700900123');
  assert.strictEqual(res.r.error, null, res.r.error && res.r.error.message);
  assert.strictEqual(H.rows(g, 'LEADS')[0].Phone, '+447700900123');
  runIt('12345');
  assert.strictEqual(H.rows(g, 'LEADS').length, 1);
});
finish('phone');
