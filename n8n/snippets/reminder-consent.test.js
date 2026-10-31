// Run: node n8n/snippets/reminder-consent.test.js
// The message purposes and the reminder-consent rule (n8n/snippets/reminder-consent.js). flowhq/tests/booking-consent.test.ts checks the same rule
// against the TypeScript original (consent.ts), so the two cannot drift apart.
const assert = require('assert');
const { RC_PURPOSE_BY_TEMPLATE, rcPurpose, rcValue, rcOptedOut, rcEffective, rcDecide } = require('./reminder-consent');
const { WA_TEMPLATES } = require('./wa-send');
const { normalizeIndianPhone } = require('./normalize-phone');

let n = 0;
const test = (name, fn) => { fn(); n++; };
const PH = '+919000010001';
const row = (value, phone = PH) => ({ id: 1, fields: { Phone: phone, Reminder_Consent: value } });
const lead = (over = {}) => ({ id: 7, fields: { Phone: PH, Consent_WhatsApp: false, Opted_Out: false, ...over } });
const decide = (purpose, leads, consent) => rcDecide(purpose, PH, leads, consent, normalizeIndianPhone);

test('every W12 template has a purpose, and an unlisted template is engagement', () => {
  for (const t of Object.keys(WA_TEMPLATES)) assert(Object.prototype.hasOwnProperty.call(RC_PURPOSE_BY_TEMPLATE, t), `${t} has no purpose`);
  assert.strictEqual(rcPurpose({ template: 'brand_new_template', message_type: 'template', audience: 'patient' }), 'engagement');
});

test('purposes: replies, booking confirmations, reminders, follow-up reminders, engagement, staff alerts are separate', () => {
  const p = (template, extra = {}) => rcPurpose({ template, message_type: 'template', audience: 'patient', ...extra });
  assert.strictEqual(rcPurpose({ message_type: 'text', audience: 'patient' }), 'reply');
  assert.strictEqual(p('booking_confirmation'), 'booking_transaction');
  assert.strictEqual(p('reminder_24h'), 'appointment_reminder');
  assert.strictEqual(p('reminder_2h'), 'appointment_reminder');
  assert.strictEqual(p('followup_reminder'), 'followup_reminder');
  for (const t of ['followup_day2', 'noshow_rebook', 'outcome_check', 'review_request']) assert.strictEqual(p(t), 'engagement', t);
  assert.strictEqual(rcPurpose({ template: 'new_lead_staff_alert', message_type: 'template', audience: 'staff' }), 'staff_alert');
  assert.strictEqual(rcPurpose({ template: 'reminder_24h', message_type: 'template', audience: 'staff' }), 'staff_alert', 'audience decides for the clinic\'s own phone');
});

test('a caller can raise a message to a reminder purpose (W15 free text) but can never lower one', () => {
  assert.strictEqual(rcPurpose({ message_type: 'text', audience: 'patient', purpose: 'followup_reminder' }), 'followup_reminder');
  assert.strictEqual(rcPurpose({ template: 'reminder_24h', message_type: 'template', audience: 'patient', purpose: 'reply' }), 'appointment_reminder');
  assert.strictEqual(rcPurpose({ template: 'reminder_24h', message_type: 'template', audience: 'patient', purpose: 'staff_alert' }), 'appointment_reminder');
  assert.strictEqual(rcPurpose({ template: 'reminder_24h', message_type: 'text', audience: 'patient', purpose: 'appointment_reminder' }), 'appointment_reminder');
});

test('effective consent: opt-out > No > Yes > Unknown; unreadable never allows', () => {
  assert.deepStrictEqual(rcEffective([row('Yes')], false), { value: 'Yes', allowed: true, reason: 'consent_yes' });
  assert.deepStrictEqual(rcEffective([row('Yes')], true), { value: 'No', allowed: false, reason: 'opted_out' });
  assert.deepStrictEqual(rcEffective([row('No')], false), { value: 'No', allowed: false, reason: 'consent_no' });
  assert.deepStrictEqual(rcEffective([], false), { value: 'Unknown', allowed: false, reason: 'consent_unknown' });
  assert.strictEqual(rcEffective([row('')], false).allowed, false);
  assert.strictEqual(rcEffective([row('yes')], false).allowed, false, 'a typo is Unknown');
  assert.strictEqual(rcEffective([row('Unknown')], false).allowed, false);
  assert.deepStrictEqual(rcEffective(null, false), { value: 'Unknown', allowed: false, reason: 'consent_unreadable' });
  assert.strictEqual(rcEffective(null, true).reason, 'opted_out');
});

test('two rows for one phone (a damaged table): No wins over Yes', () => {
  assert.strictEqual(rcValue([row('Yes'), row('No')], PH), 'No');
  assert.strictEqual(rcValue([row('No'), row('Yes')], PH), 'No');
  assert.strictEqual(rcValue([row('Yes', '+919000010002')], PH), 'Unknown', 'another phone\'s row is not this phone\'s');
});

test('opt-out: any lead with the phone, not just the first', () => {
  assert.strictEqual(rcOptedOut([lead(), lead({ Opted_Out: true })], PH, normalizeIndianPhone), true);
  assert.strictEqual(rcOptedOut([lead({ Phone: '+919000010002', Opted_Out: true })], PH, normalizeIndianPhone), false);
  assert.strictEqual(rcOptedOut([lead({ Phone: '09000010001', Opted_Out: true })], PH, normalizeIndianPhone), true, 'written locally is the same number');
});

test('appointment_reminder / followup_reminder need a recorded Yes; website and inbound consent never count', () => {
  for (const purpose of ['appointment_reminder', 'followup_reminder']) {
    assert.strictEqual(decide(purpose, [lead({ Consent_WhatsApp: true })], []).allowed, false, `${purpose}: legacy lead consent is not reminder consent`);
    assert.strictEqual(decide(purpose, [], []).allowed, false, `${purpose}: no lead, no consent`);
    assert.strictEqual(decide(purpose, [], [row('Yes')]).allowed, true, `${purpose}: a patient with no lead can have a Yes`);
    assert.strictEqual(decide(purpose, [lead()], [row('Yes')]).allowed, true);
    assert.strictEqual(decide(purpose, [lead()], [row('No')]).allowed, false);
    assert.strictEqual(decide(purpose, [lead({ Opted_Out: true })], [row('Yes')]).allowed, false, `${purpose}: opt-out beats Yes`);
    assert.strictEqual(decide(purpose, [lead()], null).allowed, false, `${purpose}: consent table unreadable`);
    assert.strictEqual(decide(purpose, null, [row('Yes')]).allowed, false, `${purpose}: leads unreadable (the opt-out cannot be checked)`);
  }
  assert(/record reminder consent/.test(decide('appointment_reminder', [lead()], []).reason), 'the reason says what to do');
});

test('booking_transaction: not governed by reminder consent, but needs a Meta opt-in and respects opt-out', () => {
  assert.strictEqual(decide('booking_transaction', [lead({ Consent_WhatsApp: true })], []).allowed, true, 'the patient\'s own WhatsApp consent is enough for the confirmation');
  assert.strictEqual(decide('booking_transaction', [lead({ Consent_WhatsApp: true })], [row('No')]).allowed, true, 'declining reminders does not block the confirmation');
  assert.strictEqual(decide('booking_transaction', [], [row('Yes')]).allowed, true, 'a recorded reminder Yes is an opt-in');
  assert.strictEqual(decide('booking_transaction', [lead()], []).allowed, false, 'no opt-in on file');
  assert.strictEqual(decide('booking_transaction', [], []).allowed, false);
  assert.strictEqual(decide('booking_transaction', [lead({ Consent_WhatsApp: true, Opted_Out: true })], [row('Yes')]).allowed, false, 'opt-out always blocks');
  assert.strictEqual(decide('booking_transaction', null, []).allowed, false);
});

test('engagement keeps the existing rule exactly: the first lead, Consent_WhatsApp true, not opted out', () => {
  assert.strictEqual(decide('engagement', [lead({ Consent_WhatsApp: true })], null).allowed, true, 'reminder consent is irrelevant to engagement');
  assert.strictEqual(decide('engagement', [lead()], [row('Yes')]).allowed, false, 'a reminder Yes does not unlock marketing');
  assert.strictEqual(decide('engagement', [], []).allowed, false);
  assert.strictEqual(decide('engagement', [lead({ Consent_WhatsApp: true, Opted_Out: true })], []).allowed, false);
  assert.strictEqual(decide('something_new', [lead()], []).allowed, false, 'an unknown purpose is not waved through');
});

test('reply and staff_alert have no patient consent rule; a missing phone still blocks the others', () => {
  assert.strictEqual(decide('reply', [], null).allowed, true);
  assert.strictEqual(decide('staff_alert', null, null).allowed, true);
  assert.strictEqual(rcDecide('appointment_reminder', '', [], [row('Yes')], normalizeIndianPhone).allowed, false);
});

console.log(`reminder-consent: ${n} tests passed`);
