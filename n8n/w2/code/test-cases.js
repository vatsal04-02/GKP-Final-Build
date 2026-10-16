// Manual test data for W2. Click "Execute workflow" on "W2 – Manual Test": every case below goes through the normal path
// (Config -> Parse -> clinic -> duplicate check -> lead -> conversation -> message -> Run_Log) WITHOUT Meta and without answering a webhook.
// SAFE FAKE DATA ONLY: the 91900000001x numbers and the display number 15550000000 are made up. Never paste a real patient's number here.
//
// Before the first run create ONE test lead in the demo-clinic CRM:  Phone +919000000011,  Name "W2 Test Existing".
// Afterwards delete the rows the tests created (leads, conversations, messages, Run_Log) by hand in Grist: W2 never deletes anything.
const DEMO_PHONE_NUMBER_ID = '123456789012345';   // WA_Phone_Number_ID of demo-clinic in the Agency Registry
const ONLY = '';              // a case name (e.g. 'new-patient') runs just that one; '' runs all of them
const PASTED_PAYLOAD = null;  // or paste ONE Meta POST body here (a JSON object) to run only that payload
const stamp = Date.now();     // makes the message ids unique for every run of this node (the duplicate case reuses one id on purpose)
const EXISTING = '919000000011';
const NEW_PATIENT = '919000000012';

const meta = (pid, name, from, message) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550000000', phone_number_id: pid },
    contacts: name === null ? [] : [{ profile: { name }, wa_id: from }],
    messages: [message],
  } }] }],
});
const ts = String(Math.floor(stamp / 1000));
const text = (from, id, body) => ({ from, id, timestamp: ts, type: 'text', text: { body } });

const cases = [
  { name: 'existing-patient', expect: 'existing lead: NO new lead; 1 new message; conversation updated (Unread +1); Run_Log ok',
    body: meta(DEMO_PHONE_NUMBER_ID, 'W2 Test Existing', EXISTING, text(EXISTING, `wamid.W2TEST.${stamp}.existing`, 'Hello, I would like to ask about my knee.')) },
  { name: 'new-patient', expect: 'NEW lead (Source WhatsApp, Status New, Lead_id L-YYYYMMDD-NNNN) + conversation + message; Run_Log ok; staff alert prepared (not sent)',
    body: meta(DEMO_PHONE_NUMBER_ID, 'W2 Test New', NEW_PATIENT, text(NEW_PATIENT, `wamid.W2TEST.${stamp}.new`, 'Hi, do you treat back pain?')) },
  { name: 'duplicate-message-first', expect: 'stored once',
    body: meta(DEMO_PHONE_NUMBER_ID, 'W2 Test Existing', EXISTING, text(EXISTING, `wamid.W2TEST.${stamp}.dup`, 'Duplicate delivery test')) },
  { name: 'duplicate-message-second', expect: 'SAME message id again: nothing created, Unread not increased, Run_Log skipped (duplicate WA_Message_ID)',
    body: meta(DEMO_PHONE_NUMBER_ID, 'W2 Test Existing', EXISTING, text(EXISTING, `wamid.W2TEST.${stamp}.dup`, 'Duplicate delivery test')) },
  { name: 'unknown-phone-number-id', expect: 'stops at "W2 – Clinic Rejected" (unknown phone_number_id); nothing written',
    body: meta('000000000000000', 'W2 Test Existing', EXISTING, text(EXISTING, `wamid.W2TEST.${stamp}.unknown`, 'Unknown clinic test')) },
  { name: 'invalid-payload', expect: 'Parse says kind = invalid; nothing else runs',
    body: { hello: 'this is not a Meta webhook body' } },
  { name: 'non-text-image', expect: 'no crash; Body = "[WhatsApp image received]: photo of my knee"; Enquiry untouched',
    body: meta(DEMO_PHONE_NUMBER_ID, 'W2 Test Existing', EXISTING, { from: EXISTING, id: `wamid.W2TEST.${stamp}.image`, timestamp: ts, type: 'image', image: { id: 'TEST_MEDIA_ID', mime_type: 'image/jpeg', sha256: 'test', caption: 'photo of my knee' } }) },
  { name: 'status-event', expect: 'a delivery receipt, not a patient message: ignored, nothing written',
    body: { object: 'whatsapp_business_account', entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: DEMO_PHONE_NUMBER_ID }, statuses: [{ id: `wamid.W2TEST.${stamp}.status`, status: 'delivered', timestamp: ts, recipient_id: EXISTING }] } }] }] } },
];

const wrap = (name, expect, body) => ({ json: { __w2_source: 'manual', test_case: name, test_expect: expect, headers: {}, params: {}, query: {}, body } });
if (PASTED_PAYLOAD !== null) return [wrap('pasted-payload', 'whatever your payload should do', PASTED_PAYLOAD)];
return cases.filter((c) => !ONLY || c.name === ONLY).map((c) => wrap(c.name, c.expect, c.body));
