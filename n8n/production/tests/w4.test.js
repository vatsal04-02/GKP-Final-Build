// W4 (Cal.com bookings) of the PRODUCTION export in the simulator: HMAC over the raw bytes, replay window, respond after the outcome, real confirmation.
// Run: node n8n/production/tests/w4.test.js
const assert = require('assert');
const crypto = require('crypto');
const H = require('./harness');
const { loadWf, runItem, fakeMeta, ledger, rows, freshGrist, test, finish, DAY, NIGHT, P, ENV, F } = H;
const wf = loadWf();
const SECRET = ENV.FLOWHQ_CAL_WEBHOOK_SECRET;
const hmac = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const START = DAY + 26 * 3600 * 1000;
const bookingBody = (over = {}, payload = {}, event = 'BOOKING_CREATED') => ({
  triggerEvent: event, createdAt: iso(DAY - 60000),
  payload: { uid: 'cal-uid-1', title: 'Physio assessment', eventTypeTitle: 'Assessment', startTime: iso(START), endTime: iso(START + 2700000), status: 'ACCEPTED', additionalNotes: 'knee', organizer: { name: 'Dr Rao', email: 'dr@example.test' },
    attendees: [{ name: 'Meera Joshi', email: 'meera@example.test', phoneNumber: '+91 98000 00031', timeZone: 'Asia/Kolkata' }], responses: { name: { value: 'Meera Joshi' } }, ...payload },
  ...over,
});
// the request as n8n delivers it with "Raw Body": parsed json + the exact bytes in binary.data
const request = (body, o = {}) => {
  const raw = o.raw !== undefined ? o.raw : JSON.stringify(body);
  const headers = o.headers !== undefined ? o.headers : { 'content-type': 'application/json', 'x-cal-signature-256': o.signature || hmac(raw, o.secret) };
  const item = { json: { headers, params: {}, query: o.query !== undefined ? o.query : { clinic: 'demo-physio' }, body: o.parsed !== undefined ? o.parsed : JSON.parse(raw) } };
  if (o.binary !== false) item.binary = { data: { data: Buffer.from(o.binaryRaw !== undefined ? o.binaryRaw : raw).toString('base64'), mimeType: 'application/json' } };
  return item;
};
const gristFor = (settings = {}) => freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...settings }) });
const post = (body, o = {}) => runItem(wf, 'W4 – Webhook1', request(body, o.req || {}), { ...o, grist: o.grist || gristFor() });
const codes = (r) => r.responses.map((x) => x.code);
const noErr = (r) => assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
const writes = (g) => g.calls.filter((c) => c.method !== 'GET' && c.doc === H.DOC);
const log = (g) => rows(g, 'Run_Log').filter((l) => l.Workflow === 'W4-booking-sync');
const ALLOW = `${P.ASHA},${P.BOB},${P.OWNER},${P.TEST},+919800000031`;

test('a booking: lead + appointment stored, answered 200 AFTER the writes, confirmation sent through W12, Confirm_Sent set, honest logs', () => {
  const meta = fakeMeta();
  const { r, grist } = post(bookingBody(), { meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r);
  assert.deepStrictEqual(codes(r), [200]);
  assert.deepStrictEqual(JSON.parse(r.responses[0].body), { status: 'ok', action: 'create' });
  assert(r.visited.indexOf('W4 – Grist write') < r.visited.indexOf('W4 – Respond OK'), 'answer after the writes');
  assert(r.visited.indexOf('W4 – Respond OK') < r.visited.indexOf('W4 – Call W12'));
  const lead = rows(grist, 'LEADS');
  assert.deepStrictEqual([lead.length, lead[0].Phone, lead[0].Status, lead[0].Consent_WhatsApp, lead[0].Consent_Source], [1, '+919800000031', 'Booked', true, 'cal.com-booking']);
  const a = rows(grist, 'Appointments');
  assert.deepStrictEqual([a.length, a[0].Booking_UID, a[0].Status, a[0].Start], [1, 'cal-uid-1', 'Booked', Math.floor(START / 1000)]);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'booking_confirmation');
  assert.strictEqual(meta.calls[0].body.to, '919800000031');
  assert.match(JSON.stringify(meta.calls[0].body), /Meera Joshi/);
  assert.strictEqual(ledger(grist)[0].Idem_Key, `W4:booking_confirmation:cal-uid-1:${Math.floor(START / 1000)}`);
  assert.strictEqual(typeof a[0].Confirm_Sent, 'number');
  assert.deepStrictEqual(log(grist).map((l) => [l.Record.includes('confirmation') ? 'confirmation' : 'sync', l.Outcome]), [['sync', 'ok'], ['confirmation', 'ok']]);
});

test('the same booking event twice (Cal.com retry): one appointment, one confirmation', () => {
  const g = gristFor(); const meta = fakeMeta();
  post(bookingBody(), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  const { r } = post(bookingBody(), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r);
  assert.deepStrictEqual(codes(r), [200]);
  assert.strictEqual(rows(g, 'Appointments').length, 1);
  assert.strictEqual(meta.calls.length, 1);
});

test('the signature is checked over the RAW bytes: differently formatted JSON with a valid signature passes, a signature over the re-serialised copy does not', () => {
  const body = bookingBody();
  const pretty = JSON.stringify(body, null, 2).replace('"Meera Joshi"', '"Meera\\u0020Joshi"');   // same data, other bytes
  const ok = post(body, { req: { raw: pretty }, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(ok.r); assert.deepStrictEqual(codes(ok.r), [200]);
  const reserialised = post(body, { req: { raw: pretty, signature: hmac(JSON.stringify(JSON.parse(pretty))) } });
  assert.deepStrictEqual(codes(reserialised.r), [401], 'a signature over JSON.stringify(parsed) is not the signature of the bytes that were sent');
  assert.strictEqual(writes(reserialised.grist).length, 0);
});

test('forged / unsigned / tampered requests: 401, no alert (no error), nothing read or written, nothing sent', () => {
  const body = bookingBody();
  const raw = JSON.stringify(body);
  for (const [name, req] of Object.entries({
    'wrong secret': { secret: 'another-secret-0123456789abcdef' },
    'no header': { headers: {} },
    'no-secret-provided': { headers: { 'x-cal-signature-256': 'no-secret-provided' } },
    'malformed': { headers: { 'x-cal-signature-256': 'abc' } },
    'tampered bytes': { signature: hmac(raw), binaryRaw: raw.replace('knee', 'hip!') },
    'no raw body': { binary: false },
  })) {
    const meta = fakeMeta();
    const res = post(body, { req, meta });
    assert.deepStrictEqual(codes(res.r), [401], name);
    assert.strictEqual(res.r.error, null, `${name}: a signature problem must not raise an alert`);
    assert.strictEqual(res.grist.calls.length, 0, name);
    assert.strictEqual(meta.calls.length, 0, name);
  }
});

test('replay window: an old (even correctly signed) event is refused; so is a body without createdAt', () => {
  const old = post(bookingBody({ createdAt: iso(DAY - 3 * 86400000) }));
  assert.deepStrictEqual(codes(old.r), [401]);
  assert.strictEqual(writes(old.grist).length, 0);
  const future = post(bookingBody({ createdAt: iso(DAY + 3 * 86400000) }));
  assert.deepStrictEqual(codes(future.r), [401]);
  const none = post(bookingBody({ createdAt: undefined }));
  assert.deepStrictEqual(codes(none.r), [422]);
  const wide = post(bookingBody({ createdAt: iso(DAY - 3 * 86400000) }), { env: { FLOWHQ_CAL_MAX_AGE_HOURS: '100' }, meta: fakeMeta() });
  assert.deepStrictEqual(codes(wide.r), [200], 'the window is configurable');
});

test('a booking without a valid phone: 422 and the run fails (alert); nothing stored', () => {
  const body = bookingBody({}, { attendees: [{ name: 'No Phone', email: 'x@example.test' }] });
  const { r, grist } = post(body);
  assert.deepStrictEqual(codes(r), [422]);
  assert.match(r.error.message, /no valid phone number/);
  assert.strictEqual(writes(grist).length, 0);
});

test('unknown clinic in the URL: 404 then the run fails (alert); nothing stored', () => {
  const { r, grist } = post(bookingBody(), { req: { query: { clinic: 'nobody' } } });
  assert.deepStrictEqual(codes(r), [404]);
  assert.match(r.error.message, /unknown or inactive clinic slug/);
  assert.strictEqual(writes(grist).length, 0);
});

test('other Cal.com events are answered 200 "ignored" and change nothing', () => {
  const { r, grist } = post({ triggerEvent: 'PING', createdAt: iso(DAY), payload: {} });
  noErr(r);
  assert.deepStrictEqual([codes(r), JSON.parse(r.responses[0].body).status], [[200], 'ignored']);
  assert.strictEqual(grist.calls.length, 0);
});

test('a cancellation cancels the appointment, makes the lead due for follow-up, and sends NO message', () => {
  const g = gristFor(); const meta = fakeMeta();
  post(bookingBody(), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  const before = meta.calls.length;
  const { r } = post(bookingBody({}, {}, 'BOOKING_CANCELLED'), { grist: g, meta });
  noErr(r);
  assert.deepStrictEqual(codes(r), [200]);
  assert.strictEqual(rows(g, 'Appointments')[0].Status, 'Cancelled');
  assert.strictEqual(typeof rows(g, 'LEADS')[0].Next_Action_At, 'number');
  assert.strictEqual(meta.calls.length, before);
});

test('a reschedule (new uid, old uid named): the new booking is confirmed, the old one is marked Rescheduled', () => {
  const g = gristFor(); const meta = fakeMeta();
  post(bookingBody(), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  const r2 = post(bookingBody({}, { uid: 'cal-uid-2', rescheduledFromUid: 'cal-uid-1', startTime: iso(START + 86400000), endTime: iso(START + 86400000 + 2700000) }, 'BOOKING_RESCHEDULED'), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r2.r);
  assert.deepStrictEqual(rows(g, 'Appointments').map((a) => [a.Booking_UID, a.Status]), [['cal-uid-1', 'Rescheduled'], ['cal-uid-2', 'Booked']]);
  assert.strictEqual(meta.calls.length, 2);
  assert.strictEqual(ledger(g).length, 2);
});

test('quiet hours: the booking is stored and answered, the confirmation is NOT sent and the log says why', () => {
  const meta = fakeMeta();
  const nightBody = bookingBody({ createdAt: iso(NIGHT - 1000) });
  const { r, grist } = post(nightBody, { meta, now: NIGHT, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r);
  assert.deepStrictEqual(codes(r), [200]);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(grist, 'Appointments').length, 1);
  assert.match(log(grist)[0].Error, /quiet hours/);
});

test('TEST_MODE on: the confirmation goes to TEST_PHONE, never to the patient', () => {
  const meta = fakeMeta();
  post(bookingBody(), { meta, grist: gristFor({ TEST_MODE: 'true' }) });
  assert.strictEqual(meta.calls[0].body.to, P.TEST.slice(1));
});

test('an opted-out patient gets no confirmation (the booking itself is still stored)', () => {
  const g = gristFor();
  g.docs[H.DOC].LEADS.push({ id: 1, fields: { Lead_id: 'L-1', Name: 'Meera', Phone: '+919800000031', Status: 'New', Opted_Out: true, Created_At: 1 } });
  const meta = fakeMeta();
  const { r } = post(bookingBody(), { grist: g, meta, env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(g, 'Appointments').length, 1);
});

test('a Grist write failure: NO 200 is sent (the sender sees an error and can retry)', () => {
  const g = gristFor();
  const real = g.handle.bind(g);
  g.handle = (m, u, q, b) => { if (m === 'POST' && /Appointments/.test(u)) throw new Error('Grist 503: down'); return real(m, u, q, b); };
  const { r } = post(bookingBody(), { grist: g });
  assert.deepStrictEqual(r.responses, []);
  assert.match(r.error.message, /503/);
});

test('the confirmation is uncertain (Meta timeout): the booking is stored, Confirm_Sent set, log failed/uncertain, never sent twice', () => {
  const g = gristFor();
  const { r } = post(bookingBody(), { grist: g, meta: fakeMeta(() => { throw new Error('socket hang up'); }), env: { FLOWHQ_WA_ALLOWLIST: ALLOW } });
  noErr(r);
  assert.strictEqual(typeof rows(g, 'Appointments')[0].Confirm_Sent, 'number');
  const l = log(g).find((x) => x.Record.includes('confirmation'));
  assert.deepStrictEqual([l.Outcome, /^uncertain/.test(l.Error)], ['failed', true]);
});

test('webhook inventory: exactly /website-lead, /whatsapp-inbound (GET + POST) and /cal; the obsolete /cal-w4-test is gone', () => {
  const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => `${n.parameters.httpMethod || 'GET'} ${n.parameters.path}`).sort();
  assert.deepStrictEqual(hooks, ['GET whatsapp-inbound', 'POST cal', 'POST website-lead', 'POST whatsapp-inbound']);
  const cal = wf.nodes.find((n) => n.name === 'W4 – Webhook1');
  assert.deepStrictEqual([cal.parameters.responseMode, cal.parameters.options.rawBody], ['responseNode', true]);
});

finish('W4 production');
