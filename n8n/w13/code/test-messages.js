// MANUAL TEST (dry run): the 7 end-to-end scenarios against YOUR clinic's real Settings, Knowledge, Appointments and the REAL
// Claude API, without writing to Grist or sending anything. Click "Execute workflow" on "W13 – Manual Test" after saving.
// Each case runs W13 once (W13 – Run Each Test); W13 – Test Report shows what the AI decided and what it WOULD send.
// SAFE FAKE DATA ONLY: 919000000011 is the W2 test lead (see n8n/w2/README.md); never paste a real patient's number here.
const DEMO_PHONE_NUMBER_ID = '123456789012345';   // WA_Phone_Number_ID of demo-clinic in the Agency Registry
const ONLY = '';                                   // a case name (e.g. 'price') runs just that one; '' runs all of them
const EXISTING = '919000000011';
const NEW_PATIENT = '919000000013';
const cases = [
  ['new-lead', NEW_PATIENT, 'Hi, I want to know about your services.', 'reply listing services from the Knowledge table only'],
  ['existing-lead-availability', EXISTING, 'Can I come tomorrow evening?', 'offer_slots: only real free evening times for tomorrow (or the booking link)'],
  ['price', EXISTING, 'How much does this cost?', 'prices exactly as in Knowledge; a person if Knowledge has none'],
  ['booking', EXISTING, 'Book me for Saturday at 5.', 'book_slot with the booking link for Saturday (link mode), or real alternatives if 17:00 is not free'],
  ['cancellation', EXISTING, 'Cancel my appointment tomorrow.', 'cancel link for the booking, or a person if there is no appointment'],
  ['unknown-question', EXISTING, 'Do you accept the XYZ health insurance card?', 'handoff: a person is alerted, nothing invented'],
  ['returning-lead', EXISTING, 'Hi again, is the knee treatment price still the same?', 'uses the earlier conversation; price from Knowledge'],
];
return cases.filter(([name]) => !ONLY || name === ONLY).map(([name, phone, text, expect]) => ({
  json: { dry_run: true, test_case: name, test_expect: expect, wa_phone_number_id: DEMO_PHONE_NUMBER_ID, patient_phone: phone, sender_name: 'W13 Test', text },
}));
