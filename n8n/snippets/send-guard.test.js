// Run: node n8n/snippets/send-guard.test.js
const assert = require('assert');
const { decideSend, isTestMode, inQuietHours } = require('./send-guard');

const ist = (hhmm) => Date.parse(`2026-10-05T${hhmm}:00+05:30`);
const base = { kind: 'transactional', flag_value: null, opted_out: false, automation_paused: false,
  patient_phone: '+919876543210', test_mode: 'false', test_phone: '+919000000001', now_ms: ist('10:00') };

const cases = [
  // [description, input overrides, expected send, expected to, expected reason]
  ['normal send to the patient', {}, true, '+919876543210', 'ok'],
  ['sent flag already set', { flag_value: 1759650000 }, false, null, 'already sent'],
  ['empty / zero flag counts as not sent', { flag_value: 0 }, true, '+919876543210', 'ok'],
  ['opted out', { opted_out: true }, false, null, 'opted out'],
  ['paused does not block a reminder', { automation_paused: true }, true, '+919876543210', 'ok'],
  ['paused blocks marketing', { kind: 'marketing', automation_paused: true }, false, null, 'automation paused'],
  ['unknown kind is treated like marketing', { kind: 'other', automation_paused: true }, false, null, 'automation paused'],
  ['opted out wins even in test mode', { opted_out: true, test_mode: 'true' }, false, null, 'opted out'],
  ['already sent wins over everything', { flag_value: 5, opted_out: true }, false, null, 'already sent'],
  ['quiet hours: 21:00 IST', { now_ms: ist('21:00') }, false, null, 'quiet hours'],
  ['quiet hours: 23:59 IST', { now_ms: ist('23:59') }, false, null, 'quiet hours'],
  ['quiet hours: 03:00 IST', { now_ms: ist('03:00') }, false, null, 'quiet hours'],
  ['quiet hours: 07:59 IST', { now_ms: ist('07:59') }, false, null, 'quiet hours'],
  ['08:00 IST is allowed', { now_ms: ist('08:00') }, true, '+919876543210', 'ok'],
  ['20:59 IST is allowed', { now_ms: ist('20:59') }, true, '+919876543210', 'ok'],
  ['no clock means no send', { now_ms: undefined }, false, null, 'quiet hours'],
  ['test mode reroutes to TEST_PHONE', { test_mode: 'true' }, true, '+919000000001', 'test mode: sent to TEST_PHONE'],
  ['missing TEST_MODE row means ON', { test_mode: undefined }, true, '+919000000001', 'test mode: sent to TEST_PHONE'],
  ['empty TEST_MODE means ON', { test_mode: '' }, true, '+919000000001', 'test mode: sent to TEST_PHONE'],
  ['garbage TEST_MODE means ON', { test_mode: 'maybe' }, true, '+919000000001', 'test mode: sent to TEST_PHONE'],
  ['test mode without TEST_PHONE', { test_mode: 'true', test_phone: null }, false, null, 'test mode on but TEST_PHONE is missing or invalid'],
  ['live mode without a valid patient phone', { patient_phone: null }, false, null, 'no valid patient phone'],
  ['live mode ignores TEST_PHONE', { patient_phone: null, test_phone: '+919000000001' }, false, null, 'no valid patient phone'],
];

for (const [desc, over, send, to, reason] of cases) {
  const r = decideSend({ ...base, ...over });
  assert.strictEqual(r.send, send, `${desc}: send`);
  assert.strictEqual(r.to, to, `${desc}: to`);
  assert.strictEqual(r.reason, reason, `${desc}: reason`);
}

for (const v of ['false', 'FALSE', ' 0 ', 'no', 'Off']) assert.strictEqual(isTestMode(v), false, v);
for (const v of ['true', 'TRUE', '1', 'yes', 'on', '', null, undefined, 'x']) assert.strictEqual(isTestMode(v), true, String(v));
assert.strictEqual(decideSend({ ...base, test_mode: 'false' }).test_mode, false);
assert.strictEqual(decideSend({ ...base, test_mode: 'true' }).test_mode, true);
assert.strictEqual(inQuietHours(NaN), true);

console.log(`All ${cases.length} send-guard cases pass`);
