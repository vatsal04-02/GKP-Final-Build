// E-mail gateway (W1) of the PRODUCTION export in the simulator. Run: node n8n/production/tests/email.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, fakeMeta, rows, freshGrist, test, finish, NIGHT, P, F } = H;
const wf = loadWf();
const form = (over = {}) => ({ clinic_slug: 'demo-physio', name: 'Priya Nair', phone: '98000 00021', enquiry: 'Knee pain since a month', consent_whatsapp: 'on', ...over });
const EMAIL_ENV = { FLOWHQ_ALERT_EMAIL_TO: 'frontdesk@clinic.example, owner@clinic.example', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example' };
const g0 = (settings = {}) => freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, ...settings }) });
const post = (body, o = {}) => run(wf, 'W1 – Webhook', [{ headers: {}, params: {}, query: {}, body }], { grist: g0(), ...o });
const log = (g) => rows(g, 'Run_Log').filter((l) => l.Workflow === 'W1-website-lead');
const noErr = (r) => assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);

test('no FLOWHQ_ALERT_EMAIL_TO: no e-mail is sent and nothing changes in the log', () => {
  const { r, grist } = post(form(), { meta: fakeMeta() });
  noErr(r);
  assert.strictEqual(r.emails.length, 0);
  assert.strictEqual(log(grist)[0].Error, '');
});

test('the clinic gets one e-mail with the lead details (SMTP credential "FlowHQ SMTP"); the log says so', () => {
  const { r, grist } = post(form(), { meta: fakeMeta(), env: EMAIL_ENV });
  noErr(r);
  assert.strictEqual(r.emails.length, 1);
  const m = r.emails[0];
  assert.deepStrictEqual([m.credential, m.from, m.to, m.format], ['FlowHQ SMTP', 'noreply@clinic.example', 'frontdesk@clinic.example, owner@clinic.example', 'text']);
  assert.match(m.subject, /^New website lead: Priya Nair \(Demo Physio\)$/);
  assert.match(m.text, /Name: Priya Nair/); assert.match(m.text, /Phone: \+919800000021/); assert.match(m.text, /Knee pain since a month/); assert.match(m.text, /WhatsApp alert: sent/);
  assert.deepStrictEqual([log(grist)[0].Outcome, log(grist)[0].Error], ['ok', 'staff e-mail sent']);
});

test('an SMTP failure never loses the lead: the website still gets 200, the log says the e-mail failed (run stays ok because WhatsApp reached the clinic)', () => {
  const { r, grist } = post(form(), { meta: fakeMeta(), env: EMAIL_ENV, email: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1025'); } });
  noErr(r);
  assert.deepStrictEqual(r.responses.map((x) => x.code), [200]);
  assert.strictEqual(rows(grist, 'LEADS').length, 1);
  assert.strictEqual(log(grist)[0].Outcome, 'ok');
  assert.match(log(grist)[0].Error, /staff e-mail failed: .*ECONNREFUSED/);
});

test('no alert reached the clinic at all (WhatsApp held by quiet hours AND e-mail failed): the run is logged failed', () => {
  const { r, grist } = post(form(), { meta: fakeMeta(), env: EMAIL_ENV, now: NIGHT, email: () => { throw new Error('smtp down'); } });
  noErr(r);
  assert.strictEqual(log(grist)[0].Outcome, 'failed');
  const ok = post(form(), { meta: fakeMeta(), env: EMAIL_ENV, now: NIGHT });
  assert.strictEqual(log(ok.grist)[0].Outcome, 'ok', 'quiet hours do not hold the clinic e-mail');
  assert.strictEqual(ok.r.emails.length, 1);
});

test('header injection through the name is neutralised', () => {
  const { r } = post(form({ name: 'Priya\r\nBcc: attacker@evil.example' }), { meta: fakeMeta(), env: EMAIL_ENV });
  noErr(r);
  assert(!/[\r\n]/.test(r.emails[0].subject), 'no line break in the subject');
});

test('bad e-mail settings stop W1 before anything is read', () => {
  const a = post(form(), { env: { FLOWHQ_ALERT_EMAIL_TO: 'frontdesk@clinic.example' } });
  assert.match(a.r.error.message, /FLOWHQ_EMAIL_FROM is not set/);
  const b = post(form(), { env: { ...EMAIL_ENV, FLOWHQ_ALERT_EMAIL_TO: 'not-an-address' } });
  assert.match(b.r.error.message, /invalid address/);
  assert.strictEqual(b.grist.calls.length, 0);
});

const ACK = { ...EMAIL_ENV, FLOWHQ_EMAIL_PATIENT_ACK: 'true' };
test('patient acknowledgement is OFF by default; ON: only a NEW lead with an address AND e-mail consent', () => {
  const off = post(form({ email: 'priya@example.com', consent_email: 'true' }), { meta: fakeMeta(), env: EMAIL_ENV });
  assert.deepStrictEqual(off.r.emails.map((m) => m.to), ['frontdesk@clinic.example, owner@clinic.example']);
  const on = post(form({ email: 'priya@example.com', consent_email: 'true' }), { meta: fakeMeta(), env: ACK });
  noErr(on.r);
  assert.deepStrictEqual(on.r.emails.map((m) => m.to), ['frontdesk@clinic.example, owner@clinic.example', 'priya@example.com']);
  const p = on.r.emails[1];
  assert.match(p.subject, /We received your enquiry - Demo Physio/);
  assert(!/Knee pain/.test(p.text), 'the acknowledgement quotes nothing the person wrote');
  assert.match(on.grist.docs.DOCA.Run_Log[0].fields.Error, /patient e-mail sent/);
  const noConsent = post(form({ email: 'priya@example.com' }), { meta: fakeMeta(), env: ACK });
  assert.deepStrictEqual(noConsent.r.emails.map((m) => m.to.includes('priya')), [false]);
  assert.match(log(noConsent.grist)[0].Error, /no e-mail consent/);
});

test('no patient e-mail in TEST_MODE, in quiet hours, or on a repeated enquiry', () => {
  const t = post(form({ email: 'priya@example.com', consent_email: 'true' }), { meta: fakeMeta(), env: ACK, grist: g0({ TEST_MODE: 'true' }) });
  assert(!t.r.emails.some((m) => m.to === 'priya@example.com'));
  assert.match(log(t.grist)[0].Error, /TEST_MODE/);
  const q = post(form({ email: 'priya@example.com', consent_email: 'true' }), { meta: fakeMeta(), env: ACK, now: NIGHT });
  assert(!q.r.emails.some((m) => m.to === 'priya@example.com'));
  const g = g0();
  post(form({ email: 'priya@example.com', consent_email: 'true' }), { meta: fakeMeta(), env: ACK, grist: g });
  const again = post(form({ email: 'priya@example.com', consent_email: 'true', enquiry: 'And my shoulder' }), { meta: fakeMeta(), env: ACK, grist: g });
  assert(!again.r.emails.some((m) => m.to === 'priya@example.com'), 'acknowledged once, at creation');
  assert.strictEqual(again.r.emails.length, 1, 'the clinic is told about the new enquiry');
});

finish('e-mail');
