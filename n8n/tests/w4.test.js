// End-to-end + structural checks for W4-booking-sync.json (runs the shipped JSON). Run: node n8n/tests/w4.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { simulate } = require('./n8n-sim');
const { load, withConfig, freshGrist, REPO } = require('./helpers');

const real = require('./fixtures/cal-booking-created.sample.json');   // real Cal.com structure, fake identities
const raw = fs.readFileSync(path.join(REPO, 'n8n/workflows/W4-booking-sync.json'), 'utf8');
const w4raw = JSON.parse(raw);
const SECRET = 'testsecret-123';
const w4 = withConfig(w4raw, { registry_doc_id: 'REG', cal_webhook_secret: SECRET });
const w4open = withConfig(w4raw, { registry_doc_id: 'REG', require_signature: false });
const NOW = Date.parse('2026-10-05T10:00:00+05:30');          // 10:00 IST
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------- fixtures
// A synthetic booking with the exact structure of the real payload, fake people.
const mk = (event, over = {}) => {
  const b = clone(real.body);
  b.triggerEvent = event;
  const p = b.payload;
  Object.assign(p, {
    title: '45 min Assessment between Dr Rao and Asha Rao', eventTitle: 'Assessment', eventTypeTitle: 'Assessment',
    uid: 'UID1', startTime: '2026-10-06T03:30:00.000Z', endTime: '2026-10-06T04:15:00.000Z', status: 'ACCEPTED',
  });
  p.organizer = { ...p.organizer, name: 'Dr Rao', email: 'drrao@example.com' };
  p.attendees = [{ ...p.attendees[0], name: 'Asha Rao', email: 'asha@example.com', phoneNumber: '+919876543210' }];
  p.responses.name.value = 'Asha Rao';
  p.responses.email.value = 'asha@example.com';
  p.responses.attendeePhoneNumber = { label: 'phone_number', value: '+919876543210', isHidden: false };
  if (event === 'BOOKING_CANCELLED') Object.assign(p, { status: 'CANCELLED', cancellationReason: 'Cannot make it' });
  if (event === 'BOOKING_RESCHEDULED') Object.assign(p, { uid: 'UID2', rescheduleUid: 'UID1', startTime: '2026-10-07T05:00:00.000Z', endTime: '2026-10-07T05:45:00.000Z' });
  Object.assign(p, over);
  return b;
};
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
const hook = (body, { secret = SECRET, query = { clinic: 'demo-physio' }, headers } = {}) => [{
  json: { headers: headers || { 'content-type': 'application/json', 'x-cal-signature-256': secret === null ? 'no-secret-provided' : sign(body, secret) }, params: {}, query, body },
}];
const run = (g, body, o = {}) => simulate(o.wf || w4, { start: 'Webhook', items: hook(body, o), grist: g, now: o.now || NOW });
const A = (g) => g.docs.DOCA.Appointments;
const L = (g) => g.docs.DOCA.Leads;
const LOG = (g) => g.docs.DOCA.Run_Log.map((r) => r.fields);
const lead = (id, over = {}) => ({ id, fields: { Lead_ID: `L-20261001-000${id}`, Name: 'Asha R', Phone: '+919876543210', Source: 'Website', Status: 'New', Opted_Out: false, ...over } });
const writesOf = (g) => g.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.table}`);

// ================================================================ structure
console.log('structure');
const names = w4raw.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(w4raw.nodes.map((x) => x.id)).size, names.length);
for (const [from, v] of Object.entries(w4raw.connections)) { assert(names.includes(from)); for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), t.node); }
const seen = new Set(['Webhook']); const q = ['Webhook'];
while (q.length) for (const outs of (w4raw.connections[q.shift()] || { main: [] }).main) for (const t of outs || []) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
assert.deepStrictEqual(names.filter((x) => !seen.has(x) && x !== 'Notes'), []);
const hookNode = w4raw.nodes.find((x) => x.name === 'Webhook');
assert.deepStrictEqual([hookNode.parameters.httpMethod, hookNode.parameters.path, hookNode.parameters.responseMode], ['POST', 'cal', 'onReceived']);
ok(`${names.length} nodes, connected; POST /webhook/cal answers 200 immediately (rule 6)`);
let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
w4raw.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const snip = (f) => fs.readFileSync(path.join(REPO, 'n8n/snippets', f), 'utf8');
const vp = w4raw.nodes.find((x) => x.name === 'Verify & parse').parameters.jsCode;
const pw = w4raw.nodes.find((x) => x.name === 'Plan writes').parameters.jsCode;
const phoneFn = snip('normalize-phone.js').match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0];
const hm = snip('hmac-sha256.js'); const hmFns = hm.slice(hm.indexOf('function utf8Bytes'), hm.indexOf('if (typeof module'));
const gd = snip('send-guard.js'); const gdFns = gd.slice(gd.indexOf('function isTestMode'), gd.indexOf('// ---- n8n Code node body'));
assert(strip(vp).includes(strip(phoneFn)) && strip(vp).includes(strip(hmFns)));
assert(strip(pw).includes(strip(phoneFn)) && strip(pw).includes(strip(gdFns)));
ok('Verify & parse and Plan writes embed the phone, HMAC and send-guard functions exactly as in n8n/snippets/');

// ================================================================ your real payload
console.log('real Cal.com payload structure');
let g = freshGrist();
let r = simulate(w4open, { start: 'Webhook', items: [{ json: { headers: real.headers, params: {}, query: { clinic: 'demo-physio' }, body: real.body } }], grist: g, now: NOW });
assert.deepStrictEqual([r.error.node, r.error.stopAndError], ['Reject', true]);
assert.match(r.error.message, /^W4: booking sampleUid0000000000000A has no valid phone number: add a required phone question/);
assert.strictEqual(g.calls.length, 0);
ok('a real-shaped booking whose phone question is HIDDEN (no value): W4 refuses it loudly, touching nothing in Grist');

r = simulate(w4, { start: 'Webhook', items: [{ json: { headers: real.headers, params: {}, query: { clinic: 'demo-physio' }, body: real.body } }], grist: g, now: NOW });
assert.match(r.error.message, /unsigned request/);
ok('no signature ("no-secret-provided", what Cal.com sends without a secret): rejected while a secret is required');

const withPhone = clone(real.body);
withPhone.payload.responses.attendeePhoneNumber = { label: 'phone_number', value: '+91 98765 43210', isHidden: false };
g = freshGrist();
r = run(g, withPhone);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.deepStrictEqual(A(g).map((a) => a.fields), [{ Booking_UID: 'sampleUid0000000000000A', Lead: 1, Service: '30 min meeting', Physio: 'Dr Rao', Start: epoch('2026-10-06T03:30:00.000Z'), End: epoch('2026-10-06T04:00:00.000Z'), Status: 'Booked' }]);
assert.deepStrictEqual(L(g).map((l) => [l.fields.Lead_ID, l.fields.Name, l.fields.Phone, l.fields.Source, l.fields.Status]), [['L-20261005-0001', 'Asha Rao', '+919876543210', 'Website', 'Booked']]);
assert.deepStrictEqual(LOG(g).map((l) => [l.Workflow, l.Record, l.Outcome, l.Error]), [['W4-booking-sync', 'sampleUid0000000000000A (created) L-20261005-0001', 'ok', '']]);
assert.deepStrictEqual(writesOf(g), ['POST Leads', 'POST Appointments', 'POST Run_Log']);
ok('same booking with a phone answered (signed, +91 98765 43210): lead created, Appointment saved with the right uid / service / physio / UTC->epoch times, Run_Log last');

// ================================================================ signature
console.log('signature');
g = freshGrist();
assert.strictEqual(run(g, mk('BOOKING_CREATED')).error, null);
ok('a correctly signed booking is accepted');
for (const [label, o, re] of [
  ['wrong secret', { secret: 'other-secret' }, /bad signature/],
  ['no secret sent', { secret: null }, /unsigned request/],
  ['missing header', { headers: {} }, /unsigned request/],
]) {
  g = freshGrist(); r = run(g, mk('BOOKING_CREATED'), o);
  assert.strictEqual(r.error.node, 'Reject', label); assert.match(r.error.message, re, label); assert.strictEqual(g.calls.length, 0, label);
}
g = freshGrist();
const tampered = mk('BOOKING_CREATED'); const hdr = hook(tampered)[0].json.headers; tampered.payload.startTime = '2026-10-06T08:00:00.000Z';
r = simulate(w4, { start: 'Webhook', items: [{ json: { headers: hdr, params: {}, query: { clinic: 'demo-physio' }, body: tampered } }], grist: g, now: NOW });
assert.match(r.error.message, /bad signature/); assert.strictEqual(g.calls.length, 0);
r = simulate(withConfig(w4raw, { registry_doc_id: 'REG' }), { start: 'Webhook', items: hook(mk('BOOKING_CREATED')), grist: g, now: NOW });
assert.match(r.error.message, /secret is not set in the Config node/);
ok('wrong secret / unsigned / no header / body changed after signing / secret left as placeholder: all refused, nothing written');
g = freshGrist();
const up = hook(mk('BOOKING_CREATED')); up[0].json.headers['x-cal-signature-256'] = up[0].json.headers['x-cal-signature-256'].toUpperCase();
assert.strictEqual(simulate(w4, { start: 'Webhook', items: up, grist: g, now: NOW }).error, null);
ok('upper-case hex signature is accepted');

// ================================================================ phone extraction
console.log('phone');
const phoneCase = (mut) => { const b = mk('BOOKING_CREATED'); mut(b.payload); g = freshGrist(); return run(g, b); };
r = phoneCase((p) => { p.attendees[0].phoneNumber = null; });
assert.strictEqual(r.error, null); assert.strictEqual(L(g)[0].fields.Phone, '+919876543210');
r = phoneCase((p) => { p.responses.attendeePhoneNumber = { label: 'phone_number', isHidden: true }; p.attendees[0].phoneNumber = '098765 43210'; });
assert.strictEqual(r.error, null); assert.strictEqual(L(g)[0].fields.Phone, '+919876543210');
r = phoneCase((p) => { delete p.responses.attendeePhoneNumber; p.attendees[0].phoneNumber = null; p.responses.mobile_phone = { label: 'Mobile', value: '98765 43210' }; });
assert.strictEqual(r.error, null); assert.strictEqual(L(g)[0].fields.Phone, '+919876543210');
r = phoneCase((p) => { p.responses.attendeePhoneNumber.value = '12345'; p.attendees[0].phoneNumber = '12345'; });
assert.strictEqual(r.error.node, 'Reject'); assert.match(r.error.message, /no valid phone/);
ok('phone found in attendee.phoneNumber, responses.attendeePhoneNumber.value or any *phone* response; invalid / absent => refused');

// ================================================================ create
console.log('BOOKING_CREATED');
g = freshGrist(); g.docs.DOCA.Leads.push(lead(1, { Status: 'New' }));
r = run(g, mk('BOOKING_CREATED'));
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.strictEqual(L(g).length, 1);
assert.strictEqual(L(g)[0].fields.Status, 'Booked');
assert.strictEqual(A(g)[0].fields.Lead, 1);
assert.deepStrictEqual(writesOf(g), ['POST Appointments', 'PATCH Leads', 'POST Run_Log']);
assert.strictEqual(LOG(g)[0].Record, 'UID1 (created) L-20261001-0001');
ok('existing lead found by phone (even with spaces/+91): Appointment linked to it, lead moves New -> Booked, no new lead');

for (const [from, expect] of [['Contacted', 'Booked'], ['Lost', 'Booked'], ['Converted', 'Converted'], ['Booked', 'Booked']]) {
  g = freshGrist(); g.docs.DOCA.Leads.push(lead(1, { Status: from })); run(g, mk('BOOKING_CREATED'));
  assert.strictEqual(L(g)[0].fields.Status, expect, from);
  assert.strictEqual(writesOf(g).includes('PATCH Leads'), from !== expect, from);
}
ok('lead status: Contacted/Lost -> Booked; Converted and Booked are never touched');

g = freshGrist(); g.docs.DOCA.Leads.push(lead(1, { Opted_Out: true })); r = run(g, mk('BOOKING_CREATED'));
assert.strictEqual(r.error, null); assert.strictEqual(A(g).length, 1);
assert.strictEqual(LOG(g)[0].Error, 'confirmation not sent: opted out');
assert.strictEqual(r.runData['Plan writes'][0].json.confirmation.decision.send, false);
ok('opted-out patient: booking still saved, confirmation skipped and the reason is in Run_Log');

g = freshGrist(); r = run(g, mk('BOOKING_CREATED'), { now: Date.parse('2026-10-05T23:00:00+05:30') });
assert.strictEqual(A(g).length, 1); assert.strictEqual(LOG(g)[0].Error, 'confirmation not sent: quiet hours');
ok('booking made at 23:00 IST: saved, confirmation held back for quiet hours (reason logged)');

g = freshGrist(); g.docs.DOCA.Settings.find((s) => s.fields.Key === 'TEST_MODE').fields.Value = 'true'; r = run(g, mk('BOOKING_CREATED'));
const conf = r.runData['Plan writes'][0].json.confirmation;
assert.deepStrictEqual([conf.decision.send, conf.decision.to, conf.sent, conf.stub, conf.template], [true, '+919000000001', false, true, 'booking_confirmation']);
assert.strictEqual(conf.message_text, 'Hi Asha Rao, your Assessment at Demo Physio is booked for 06 Oct at 9:00 AM.');
assert.strictEqual(LOG(g)[0].Error, '');
ok('TEST_MODE on: the confirmation is addressed to TEST_PHONE, never the patient; message built; nothing sent (stub)');

g = freshGrist(); run(g, mk('BOOKING_CREATED'));
r = run(g, mk('BOOKING_CREATED'));
assert.strictEqual(r.error, null); assert.strictEqual(A(g).length, 1); assert.strictEqual(L(g).length, 1);
assert.deepStrictEqual([LOG(g)[1].Outcome, LOG(g)[1].Error], ['skipped', 'duplicate booking event']);
assert(!r.visited.includes('Plan writes'));
ok('Cal.com retries the same booking: skipped as duplicate - no second appointment, lead or confirmation');

g = freshGrist(); r = run(g, mk('BOOKING_CREATED', { status: 'PENDING' }));
assert.strictEqual(A(g).length, 0); assert.match(LOG(g)[0].Error, /status is PENDING/);
ok('a booking awaiting host approval (not ACCEPTED) is skipped and logged');

g = freshGrist(); run(g, mk('BOOKING_CREATED', { uid: 'UIDX' })); run(g, mk('BOOKING_CREATED', { uid: 'UIDY', attendees: [{ name: 'Ravi', phoneNumber: '+919811111111' }], responses: { attendeePhoneNumber: { value: '+919811111111' }, name: { value: 'Ravi' } } }));
assert.deepStrictEqual(L(g).map((l) => l.fields.Lead_ID), ['L-20261005-0001', 'L-20261005-0002']);
assert.deepStrictEqual(A(g).map((a) => a.fields.Lead), [1, 2]);
ok('two different patients: two leads (Lead_ID continues 0001, 0002), each appointment linked to its own');

// ================================================================ cancel
console.log('BOOKING_CANCELLED');
g = freshGrist(); run(g, mk('BOOKING_CREATED'));
const before = clone(L(g));
r = run(g, mk('BOOKING_CANCELLED'));
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.strictEqual(A(g)[0].fields.Status, 'Cancelled');
assert.deepStrictEqual(L(g), before);
assert.strictEqual(LOG(g).at(-1).Record, 'UID1 (cancelled)');
assert(!r.visited.includes('Find lead by phone'));
ok('cancel: the Appointment becomes Cancelled (so W5 stops reminding); lead untouched; no phone needed');
const noPhoneCancel = mk('BOOKING_CANCELLED'); delete noPhoneCancel.payload.attendees[0].phoneNumber; noPhoneCancel.payload.responses.attendeePhoneNumber = { isHidden: true };
g = freshGrist(); run(g, mk('BOOKING_CREATED')); assert.strictEqual(run(g, noPhoneCancel).error, null);
assert.strictEqual(A(g)[0].fields.Status, 'Cancelled');

g = freshGrist(); r = run(g, mk('BOOKING_CANCELLED'));
assert.strictEqual(r.error, null); assert.match(LOG(g)[0].Error, /not found/); assert.strictEqual(LOG(g)[0].Outcome, 'skipped');
g = freshGrist(); run(g, mk('BOOKING_CREATED')); A(g)[0].fields.Status = 'Completed'; run(g, mk('BOOKING_CANCELLED'));
assert.strictEqual(A(g)[0].fields.Status, 'Completed'); assert.match(LOG(g).at(-1).Error, /already Completed/);
g = freshGrist(); run(g, mk('BOOKING_CREATED')); run(g, mk('BOOKING_CANCELLED')); r = run(g, mk('BOOKING_CANCELLED'));
assert.match(LOG(g).at(-1).Error, /already Cancelled/);
ok('cancel of an unknown booking / an already Completed / an already Cancelled one: skipped and logged, nothing overwritten');

// ================================================================ reschedule
console.log('BOOKING_RESCHEDULED');
g = freshGrist(); run(g, mk('BOOKING_CREATED'));
r = run(g, mk('BOOKING_RESCHEDULED'));
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.deepStrictEqual(A(g).map((a) => [a.fields.Booking_UID, a.fields.Status]), [['UID1', 'Rescheduled'], ['UID2', 'Booked']]);
assert.strictEqual(A(g)[1].fields.Start, epoch('2026-10-07T05:00:00.000Z'));
assert.strictEqual(L(g).length, 1);
assert.strictEqual(LOG(g).at(-1).Record, 'UID2 (rescheduled) L-20261005-0001');
assert.strictEqual(r.runData['Plan writes'][0].json.confirmation.message_text, 'Hi Asha Rao, your Assessment at Demo Physio is booked for 07 Oct at 10:30 AM.');
ok('reschedule with a new uid: new row Booked at the new time, old row marked Rescheduled (W5 uses only Booked), one lead, new confirmation text');

g = freshGrist(); run(g, mk('BOOKING_CREATED'));
r = run(g, mk('BOOKING_RESCHEDULED', { uid: 'UID1', rescheduleUid: undefined, startTime: '2026-10-08T05:00:00.000Z', endTime: '2026-10-08T05:45:00.000Z' }));
assert.strictEqual(r.error, null); assert.strictEqual(A(g).length, 1);
assert.deepStrictEqual([A(g)[0].fields.Status, A(g)[0].fields.Start], ['Booked', epoch('2026-10-08T05:00:00.000Z')]);
ok('reschedule that keeps the same uid: the row is updated in place');

g = freshGrist(); run(g, mk('BOOKING_CREATED')); A(g)[0].fields.Status = 'Completed';
run(g, mk('BOOKING_RESCHEDULED'));
assert.deepStrictEqual(A(g).map((a) => a.fields.Status), ['Completed', 'Booked']);
g = freshGrist(); r = run(g, mk('BOOKING_RESCHEDULED'));
assert.strictEqual(r.error, null); assert.deepStrictEqual(A(g).map((a) => a.fields.Booking_UID), ['UID2']);
ok('reschedule never rewrites a Completed old row; reschedule of a booking we never saw simply creates it');

// ================================================================ clinic / events
console.log('clinic and event handling');
g = freshGrist(); r = run(g, mk('BOOKING_CREATED'), { query: { clinic: 'no-such' } });
assert.deepStrictEqual([r.error.node, r.error.stopAndError], ['Unknown clinic', true]);
r = run(g, mk('BOOKING_CREATED'), { query: { clinic: 'old-clinic' } }); assert.strictEqual(r.error.node, 'Unknown clinic');
r = run(g, mk('BOOKING_CREATED'), { query: {} }); assert.deepStrictEqual([r.error.node, r.error.message], ['Reject', 'W4: missing or invalid ?clinic= in the webhook URL']);
r = run(g, mk('BOOKING_CREATED'), { query: { clinic: '../x' } }); assert.strictEqual(r.error.node, 'Reject');
assert.strictEqual(writesOf(g).length, 0);
ok('unknown / inactive / missing / malformed clinic in the URL: the run fails on purpose (so W11 alerts) and writes nothing');

for (const ev of ['PING', 'MEETING_ENDED', 'BOOKING_REQUESTED', 'BOOKING_PAID']) {
  g = freshGrist(); r = run(g, { ...mk('BOOKING_CREATED'), triggerEvent: ev });
  assert.strictEqual(r.error, null, ev); assert.strictEqual(g.calls.length, 0, ev);
}
ok('other Cal.com events (ping, meeting ended, requested, paid) are ignored quietly');

// ================================================================ failure hand-off
console.log('alerts');
g = freshGrist(); r = run(g, mk('BOOKING_CREATED'), { secret: 'wrong' });
const t = simulate(withConfig(load('W11-error-alert.json'), { telegram_chat_id: '-1001' }), { start: 'Error Trigger', grist: g, now: NOW, staticData: {}, items: [{ json: { workflow: { id: '4', name: 'W4 - Booking sync' }, execution: { id: '5', url: 'https://h/workflow/4/executions/5', lastNodeExecuted: r.error.node, error: { message: r.error.message } } } }] });
assert.strictEqual(t.error, null); assert.strictEqual(t.telegram.length, 1);
assert(t.telegram[0].text.includes('Workflow: W4 - Booking sync\nStep: Reject\nError: W4: bad signature'), t.telegram[0].text);
const noPhone = simulate(w4open, { start: 'Webhook', items: [{ json: { headers: {}, params: {}, query: { clinic: 'demo-physio' }, body: real.body } }], grist: freshGrist(), now: NOW });
assert(!/@/.test(noPhone.error.message) && !/Asha|Rao/.test(noPhone.error.message));
ok('a bad signature raises ONE clean Telegram alert (workflow, step, reason); alert texts carry no names or emails');

// ================================================================ names and secrets
console.log('schema.md and secrets');
const schema = fs.readFileSync(path.join(REPO, 'grist/schema.md'), 'utf8');
const block = (re) => schema.match(re)[0];
const has = (blob, col) => new RegExp(`(^|[|\\s,\`])${col}([|\\s,\`.]|$)`, 'm').test(blob);
const apptCols = block(/### Appointments[\s\S]*?(?=\n### )/), leadsCols = block(/### Leads[\s\S]*?(?=\n### )/), settings = block(/### Settings\n[\s\S]*?(?=\n### )/), clinics = block(/### Clinics[\s\S]*?(?=\n## )/), runLog = schema.match(/### Run_Log\n([^\n]+)/)[1];
for (const c of ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status']) assert(has(apptCols, c), c);
for (const c of ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Enquiry', 'Status', 'Opted_Out']) assert(has(leadsCols, c), c);
for (const c of ['Key', 'Value', 'clinic_name', 'TEST_MODE', 'TEST_PHONE']) assert(has(settings, c), c);
for (const c of ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'Active']) assert(has(clinics, c), c);
for (const c of ['Workflow', 'Record', 'Outcome', 'Error', 'At']) assert(has(runLog, c), c);
for (const choice of ['Booked', 'Rescheduled', 'Cancelled', 'Completed']) assert(apptCols.includes(choice), choice);
ok('every table, column and choice value W4 writes exists in schema.md (the fake Grist also rejected any unknown column / choice during the runs above)');
assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw), 'an email address is in the workflow file');
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw) && !/[0-9]{8,}:[A-Za-z0-9_-]{30,}/.test(raw) && !/\+91[0-9]{10}/.test(raw));
assert(raw.includes('REPLACE_WITH_CAL_WEBHOOK_SECRET') && !raw.includes(SECRET));
ok('no email addresses, secrets, hostnames or phone numbers in the file; the Cal.com secret is a placeholder');

console.log(`\nW4: ${n} check groups pass`);
