// W1 (website enquiry) of the PRODUCTION export in the simulator: respond-after-store, validation, consent, dedupe, real staff alert.
// Run: node n8n/production/tests/w1.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, fakeMeta, ledger, rows, freshGrist, test, finish, DAY, NIGHT, P, DOC, F } = H;
const wf = loadWf();
const form = (over = {}) => ({ clinic_slug: 'demo-physio', name: 'Priya Nair', phone: '98000 00021', enquiry: 'Knee pain since a month', page_url: 'https://clinic.example/contact', utm_campaign: 'autumn', consent_whatsapp: 'on', consent_version: 'v1-2026-10', website: '', ...over });
const post = (body, o = {}) => run(wf, 'W1 – Webhook', [{ headers: {}, params: {}, query: {}, body }], { ...o, grist: o.grist || freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST }) }) });
const codes = (r) => r.responses.map((x) => [x.code, JSON.parse(x.body)]);
const order = (r, a, b) => r.visited.indexOf(a) >= 0 && r.visited.indexOf(a) < r.visited.indexOf(b);
const noErr = (r) => assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
const log = (g) => rows(g, 'Run_Log').filter((l) => l.Workflow === 'W1-website-lead');

test('a valid enquiry: stored with consent, answered 200 AFTER the store, staff alerted through W12, one honest Run_Log row', () => {
  const meta = fakeMeta();
  const { r, grist } = post(form(), { meta });
  noErr(r);
  assert.deepStrictEqual(codes(r).map((c) => c[0]), [200]);
  assert.strictEqual(codes(r)[0][1].status, 'ok');
  assert.strictEqual(codes(r)[0][1].action, 'created');
  assert(order(r, 'W1 – Create lead', 'W1 – Respond Created'), 'the answer comes after the lead is stored');
  assert(order(r, 'W1 – Respond Created', 'W1 – Staff alert plan'));
  const lead = rows(grist, 'LEADS');
  assert.strictEqual(lead.length, 1);
  assert.deepStrictEqual([lead[0].Name, lead[0].Phone, lead[0].Source, lead[0].Status, lead[0].Consent_WhatsApp, lead[0].Consent_Email, lead[0].Consent_Source, lead[0].Consent_Version], ['Priya Nair', '+919800000021', 'Website', 'New', true, false, 'website-form', 'v1-2026-10']);
  assert.strictEqual(typeof lead[0].Consent_At, 'number');
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(meta.calls[0].body.template.name, 'new_lead_staff_alert');
  assert.strictEqual(meta.calls[0].body.to, P.OWNER.slice(1));
  assert(JSON.stringify(meta.calls[0].body).includes('Priya Nair'));
  assert.match(ledger(grist)[0].Idem_Key, /^W1:created:L-\d{8}-0001:/);
  assert.deepStrictEqual(log(grist).map((l) => [l.Outcome, l.Error]), [['ok', '']]);
});

test('the same enquiry again: 200 "duplicate", nothing new is stored, nobody is alerted twice', () => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER }) });
  const meta = fakeMeta();
  post(form(), { grist: g, meta });
  const { r } = post(form(), { grist: g, meta });
  noErr(r);
  assert.deepStrictEqual(codes(r), [[200, { status: 'duplicate' }]]);
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert.strictEqual(meta.calls.length, 1);
  assert.deepStrictEqual(log(g).map((l) => l.Outcome), ['ok', 'skipped']);
});

test('a NEW enquiry from the same phone updates the lead and alerts again (different content, different key)', () => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER }) });
  const meta = fakeMeta();
  post(form(), { grist: g, meta });
  const { r } = post(form({ enquiry: 'Also shoulder pain' }), { grist: g, meta });
  noErr(r);
  assert.strictEqual(codes(r)[0][1].action, 'updated');
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert.match(rows(g, 'LEADS')[0].Enquiry, /shoulder/);
  assert.strictEqual(meta.calls.length, 2);
  assert.match(JSON.stringify(meta.calls[1].body), /\(again\)/);
});

test('invalid input is answered 400 with the reason, logged "skipped", and NOTHING is stored or sent', () => {
  for (const [over, why] of [[{ name: '' }, 'missing name'], [{ phone: '12345' }, 'invalid phone'], [{ email: 'not-an-email' }, 'invalid email'], [{ consent_whatsapp: '' }, 'consent required'], [{ consent_whatsapp: 'no' }, 'consent required']]) {
    const meta = fakeMeta();
    const { r, grist } = post(form(over), { meta });
    noErr(r);
    assert.deepStrictEqual(codes(r), [[400, { status: 'invalid', error: why }]], why);
    assert.strictEqual(rows(grist, 'LEADS').length, 0, why);
    assert.strictEqual(meta.calls.length, 0, why);
    assert.deepStrictEqual(log(grist).map((l) => [l.Outcome, l.Error]), [['skipped', why]], why);
  }
});

test('the honeypot is answered 200 (bots learn nothing) and never stored', () => {
  const { r, grist } = post(form({ website: 'http://spam.example' }));
  noErr(r);
  assert.deepStrictEqual(codes(r), [[200, { status: 'ok' }]]);
  assert.strictEqual(rows(grist, 'LEADS').length, 0);
  assert.deepStrictEqual(log(grist).map((l) => [l.Outcome, l.Error]), [['skipped', 'honeypot filled']]);
});

test('international numbers and an e-mail address are accepted and stored', () => {
  const { r, grist } = post(form({ phone: '+44 7700 900123', email: 'Priya.Nair@Example.com', consent_email: 'true' }));
  noErr(r);
  const l = rows(grist, 'LEADS')[0];
  assert.deepStrictEqual([l.Phone, l.Email, l.Consent_Email], ['+447700900123', 'priya.nair@example.com', true]);
});

test('FLOWHQ_W1_REQUIRE_CONSENT=false (old forms): stored, but recorded as "no consent given"', () => {
  const { r, grist } = post(form({ consent_whatsapp: undefined }), { env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  noErr(r);
  const l = rows(grist, 'LEADS')[0];
  assert.deepStrictEqual([l.Consent_WhatsApp, l.Consent_Source, l.Consent_At], [false, 'website-form (no consent given)', null]);
});

test('consent given later on an existing lead is recorded; consent already on file is never removed', () => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER }) });
  post(form({ consent_whatsapp: undefined }), { grist: g, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  assert.strictEqual(rows(g, 'LEADS')[0].Consent_WhatsApp, false);
  post(form(), { grist: g });
  assert.deepStrictEqual([rows(g, 'LEADS')[0].Consent_WhatsApp, rows(g, 'LEADS')[0].Consent_Source], [true, 'website-form']);
  post(form({ consent_whatsapp: undefined }), { grist: g, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  assert.strictEqual(rows(g, 'LEADS')[0].Consent_WhatsApp, true);
});

test('unknown clinic: 404 first, then the run fails (W11 alerts), nothing stored', () => {
  const { r, grist } = post(form({ clinic_slug: 'no-such-clinic' }));
  assert.deepStrictEqual(codes(r), [[404, { status: 'unknown_clinic' }]]);
  assert.match(r.error.message, /unknown or inactive clinic slug/);
  assert.strictEqual(rows(grist, 'LEADS').length, 0);
});

test('a Grist failure while storing: NO 200 is sent (the website sees an error and can retry)', () => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER }) });
  const real = g.handle.bind(g);
  g.handle = (m, u, q, b) => { if (m === 'POST' && /LEADS/.test(u)) throw new Error('Grist 503: down'); return real(m, u, q, b); };
  const { r } = post(form(), { grist: g });
  assert.deepStrictEqual(r.responses, [], 'no answer was sent before the failure');
  assert.match(r.error.message, /503/);
});

test('quiet hours: the lead is stored and answered, the alert is held and the log says why', () => {
  const meta = fakeMeta();
  const { r, grist } = post(form(), { meta, now: NIGHT });
  noErr(r);
  assert.deepStrictEqual(codes(r).map((c) => c[0]), [200]);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(rows(grist, 'LEADS').length, 1);
  assert.match(log(grist)[0].Error, /quiet hours/);
});

test('TEST_MODE on: the alert goes to TEST_PHONE; TEST_MODE row missing counts as ON; no owner number: nothing is sent', () => {
  const m1 = fakeMeta();
  post(form(), { meta: m1, grist: freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'true', owner_phone: P.OWNER, TEST_PHONE: P.TEST }) }) });
  assert.strictEqual(m1.calls[0].body.to, P.TEST.slice(1));
  const m2 = fakeMeta();
  const rowsNoMode = F.settingsRows({ owner_phone: P.OWNER, TEST_PHONE: P.TEST }).filter((x) => x.fields.Key !== 'TEST_MODE');
  post(form(), { meta: m2, grist: freshGrist({ Settings: rowsNoMode }) });
  assert.strictEqual(m2.calls[0].body.to, P.TEST.slice(1));
  const m3 = fakeMeta();
  const { grist } = post(form(), { meta: m3, grist: freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: undefined }) }) });
  assert.strictEqual(m3.calls.length, 0);
  assert.strictEqual(rows(grist, 'LEADS').length, 1);
  assert.match(log(grist)[0].Error, /no valid patient phone/);
});

test('an uncertain alert (Meta timeout): the lead is stored and answered, the log says failed/uncertain, the alert is not repeated by a retry', () => {
  const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER }) });
  const meta = fakeMeta(() => { throw new Error('timeout of 15000ms exceeded'); });
  const { r } = post(form(), { grist: g, meta });
  noErr(r);
  assert.deepStrictEqual([log(g)[0].Outcome, /uncertain/.test(log(g)[0].Error)], ['failed', true]);
  const meta2 = fakeMeta();
  post(form(), { grist: g, meta: meta2 });
  assert.strictEqual(meta2.calls.length, 0);
});

test('missing configuration: the guard stops W1 before anything is read', () => {
  const { r, grist } = post(form(), { unset: ['FLOWHQ_REGISTRY_DOC_ID'] });
  assert.match(r.error.message, /FLOWHQ_REGISTRY_DOC_ID is not set/);
  assert.strictEqual(grist.calls.length, 0);
  assert.deepStrictEqual(r.responses, []);
});

test('the webhook keeps its n8n header authentication and answers through "Respond to Webhook"', () => {
  const hook = wf.nodes.find((n) => n.name === 'W1 – Webhook');
  assert.deepStrictEqual([hook.parameters.authentication, hook.parameters.responseMode, hook.parameters.httpMethod, hook.parameters.path], ['headerAuth', 'responseNode', 'POST', 'website-lead']);
  assert.strictEqual(hook.credentials.httpHeaderAuth.name, 'FlowHQ W1 Webhook Auth');
});

finish('W1 production');
