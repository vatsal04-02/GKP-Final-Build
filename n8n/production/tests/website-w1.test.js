// Website enquiry -> W1 -> Grist (LEADS) -> downstream consent enforcement. Simulator with FAKE Grist, Meta, OpenRouter and SMTP; synthetic people only.
// Nothing is sent anywhere. Run: node n8n/production/tests/website-w1.test.js
//   PROD_FILE=<another export of the same workflow, e.g. the one imported in n8n> SIM_CRED='{"meta":"WhatsApp Cloud API","openrouter":"__none__"}' node ...
//   SITE_DIR=<the website repo>   builds the payload with the website's own api/enquiry.mjs instead of the fixture below (contract test)
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const H = require('./harness');
const racePatch = require('../tools/patch-w1-race-guard');
const { loadWf, FILE, run, fakeMeta, ledger, rows, freshGrist, test, finish, DAY, P, F, clone } = H;
const wfOriginal = loadWf();
const patched = !!wfOriginal.nodes.find((n) => n.name === racePatch.N.race);
const wfBefore = wfOriginal;                                   // as exported (or, when the file already has the guard, with it)
const wf = patched ? wfOriginal : racePatch.patch(wfOriginal);   // the proposed workflow: the race guard applied in memory
const S = (ms) => Math.floor(ms / 1000);

// What the website function (api/enquiry.mjs) sends to the n8n webhook for: name "Test Patient", phone "+91 98765 43210", Back Pain,
// Home visit, "Mon 6", Morning, WhatsApp box UNTICKED. clinic_slug is the harness's synthetic clinic (the real one is set at deploy time).
const sitePayload = (over = {}) => ({
  clinic_slug: 'demo-physio', name: 'Test Patient', phone: '+919876543210',
  enquiry: 'Concern: Back Pain · Visit: Home visit · Preferred: Mon 6, Morning 9 AM–1 PM',
  page_url: 'https://site.example.test/', utm_campaign: '', consent_whatsapp: false, consent_version: 'DRAFT-2026-10-v1', request_id: 'req-00000001', ...over,
});

const settings = () => F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, booking_link: 'https://cal.example.test/demo' });
const crm = (extra = {}) => freshGrist({ Settings: settings(), ...extra });
const aiCalls = [];
const openrouter = () => { aiCalls.push(1); throw new Error('an AI provider must not be called by the website path'); };
const SAFE = { FLOWHQ_WA_SEND_MODE: 'off', FLOWHQ_AI_EXTERNAL_ENABLED: 'false' };   // the settings required for a controlled live test
const post = (body, o = {}) => run(wf, 'W1 – Webhook', [{ headers: {}, params: {}, query: {}, body }], { grist: o.grist || crm(), meta: o.meta || fakeMeta(), openrouter, ...o, env: { ...SAFE, ...(o.env || {}) } });
const codes = (r) => r.responses.map((x) => [x.code, JSON.parse(x.body)]);
const noErr = (r) => assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);

test('contract: when SITE_DIR is given, the payload built by the website function is exactly the fixture used below', async () => {
  if (!process.env.SITE_DIR) return;
  const { createHandler } = await import(path.join(process.env.SITE_DIR, 'api/enquiry.mjs'));
  let sent;
  const env = { N8N_WEBHOOK_URL: 'https://n8n.example.test/webhook-test/website-lead', N8N_WEBHOOK_SECRET: 'synthetic-secret-123456', CLINIC_SLUG: 'demo-physio', ALLOWED_ORIGINS: 'https://site.example.test' };
  const h = createHandler({ env, fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ status: 'ok' }) }; } });
  const req = { method: 'POST', headers: { origin: 'https://site.example.test', 'content-type': 'application/json' }, body: { name: 'Test Patient', phone: '+91 98765 43210', concern: 'Back Pain', visit: 'Home visit', day: 'Mon 6', slot: 'Morning 9 AM–1 PM', consent_whatsapp: false, request_id: 'req-00000001', page_url: 'https://site.example.test/' } };
  const res = { setHeader() {}, end() {}, statusCode: 0 };
  await h(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(sent, sitePayload());
});

test('1 a website enquiry (WhatsApp box unticked, FLOWHQ_W1_REQUIRE_CONSENT=false) is STORED with the consent flag false; no message of any kind goes out', () => {
  const meta = fakeMeta();
  const { r, grist } = post(sitePayload(), { meta, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  noErr(r);
  assert.deepStrictEqual(codes(r), [[200, { status: 'ok', action: 'created', lead_id: codes(r)[0][1].lead_id }]]);
  const lead = rows(grist, 'LEADS');
  assert.strictEqual(lead.length, 1);
  assert.deepStrictEqual([lead[0].Name, lead[0].Phone, lead[0].Source, lead[0].Status, lead[0].Enquiry, lead[0].Consent_WhatsApp, lead[0].Consent_At],
    ['Test Patient', '+919876543210', 'Website', 'New', sitePayload().enquiry, false, null]);
  assert.match(lead[0].Consent_Source, /no consent given/);
  assert.strictEqual(meta.calls.length, 0, 'WhatsApp mode off: no staff alert and no patient message');
  assert.strictEqual(r.emails.length, 0);
  assert.strictEqual(aiCalls.length, 0);
});

test('1b the same, with the box TICKED: consent recorded with its time, source and the wording version the visitor saw', () => {
  const { r, grist } = post(sitePayload({ consent_whatsapp: true, request_id: 'req-00000002' }));
  noErr(r);
  const l = rows(grist, 'LEADS')[0];
  assert.deepStrictEqual([l.Consent_WhatsApp, l.Consent_Source, l.Consent_Version], [true, 'website-form', 'DRAFT-2026-10-v1']);
  assert.strictEqual(typeof l.Consent_At, 'number');
});

test('2 TODAY\'S setting (FLOWHQ_W1_REQUIRE_CONSENT=true) with the box unticked: 400 "consent required", nothing stored -> why the .env change is proposed', () => {
  const { r, grist } = post(sitePayload());
  noErr(r);
  assert.deepStrictEqual(codes(r), [[400, { status: 'invalid', error: 'consent required' }]]);
  assert.strictEqual(rows(grist, 'LEADS').length, 0);
});

test('3 missing name / invalid phone from a direct caller: 400, nothing stored', () => {
  for (const body of [sitePayload({ name: '' }), sitePayload({ phone: '+9198765' }), sitePayload({ phone: '5876543210' })]) {
    const { r, grist } = post(body, { env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
    noErr(r);
    assert.strictEqual(codes(r)[0][0], 400);
    assert.strictEqual(rows(grist, 'LEADS').length, 0);
  }
});

test('4 optional fields missing (no concern / day / time): stored with an empty Enquiry', () => {
  const { r, grist } = post(sitePayload({ enquiry: '' }), { env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  noErr(r);
  assert.strictEqual(rows(grist, 'LEADS')[0].Enquiry, '');
});

test('5 a repeated submission (retry / double click): one lead only, answered "duplicate"; a second request id does not create a second lead', () => {
  const g = crm();
  const env = { FLOWHQ_W1_REQUIRE_CONSENT: 'false' };
  post(sitePayload(), { grist: g, env });
  const again = post(sitePayload(), { grist: g, env });
  noErr(again.r);
  assert.deepStrictEqual(codes(again.r), [[200, { status: 'duplicate' }]]);
  const other = post(sitePayload({ request_id: 'req-00000099' }), { grist: g, env });
  noErr(other.r);
  assert.strictEqual(codes(other.r)[0][0], 200);
  assert.strictEqual(rows(g, 'LEADS').length, 1);
});

test('7 Grist failing while the enquiry is stored: the website gets NO 200 (it shows an error and offers WhatsApp / phone), and no lead is claimed', () => {
  const g = crm();
  const real = g.handle.bind(g);
  g.handle = (m, u, q, b) => { if (m === 'POST' && /LEADS/.test(u)) throw new Error('Grist 503: down'); return real(m, u, q, b); };
  const { r } = post(sitePayload(), { grist: g, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  assert.deepStrictEqual(r.responses, [], 'no success answer was sent');
  assert.match(r.error.message, /503/);
  assert.strictEqual(rows(g, 'LEADS').length, 0);
});

test('12/13 nothing patient-facing, no e-mail, no AI: with FLOWHQ_WA_SEND_MODE=off the whole run makes zero Meta calls, and no node on the W1 path can call an AI provider', () => {
  const meta = fakeMeta();
  const e = post(sitePayload({ consent_whatsapp: true, request_id: 'req-00000003' }), { meta });
  noErr(e.r);
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(aiCalls.length, 0);
  // everything reachable from the W1 webhook (including what it hands to W12)
  const seen = new Set(); const q = ['W1 – Webhook'];
  while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); for (const o of (wf.connections[n] || { main: [] }).main) for (const c of o || []) q.push(c.node); }
  for (const name of seen) {
    const node = wf.nodes.find((x) => x.name === name);
    assert(!/^W13|^W9/.test(name), `${name}: an AI section is on the W1 path`);
    assert(!/openrouter|anthropic/i.test(JSON.stringify(node.parameters || {})), `${name}: mentions an AI provider`);
  }
});

test('DOWNSTREAM CONSENT: a website lead without WhatsApp consent never gets a patient message from W6 (day-2 follow-up) or W3; only staff are alerted', () => {
  const g = crm();
  post(sitePayload(), { grist: g, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  const lead = g.docs[H.DOC].LEADS[0];
  lead.fields.Created_At = S(DAY) - 3 * 86400;                       // three days old, still open: W6 would follow up
  const meta = fakeMeta();
  const live = { FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: `${P.OWNER},+919876543210` };   // sending IS allowed here: the consent gate alone must stop it
  const w6 = run(wf, 'W6 – Daily 10:00', [{}], { grist: g, meta, env: live, openrouter });
  noErr(w6.r);
  assert(meta.calls.every((c) => c.body.to !== '919876543210'), 'no WhatsApp message to the patient');
  assert(ledger(g).every((l) => l.Audience === 'staff' || l.Status !== 'accepted'), 'nothing accepted for the patient');
  const w3 = run(wf, 'W3 – Every 10 minutes', [{}], { grist: g, meta, env: live, openrouter });
  noErr(w3.r);
  assert(meta.calls.every((c) => c.body.to !== '919876543210'));
  assert(meta.calls.every((c) => c.body.to === P.OWNER.slice(1)), 'W3 only alerts the clinic');
  assert.strictEqual(aiCalls.length, 0);
});

test('DOWNSTREAM CONSENT: with the box ticked the same lead IS eligible (the gate is consent, not the website)', () => {
  const g = crm();
  post(sitePayload({ consent_whatsapp: true }), { grist: g, env: { FLOWHQ_W1_REQUIRE_CONSENT: 'false' } });
  g.docs[H.DOC].LEADS[0].fields.Created_At = S(DAY) - 3 * 86400;
  const meta = fakeMeta();
  const w6 = run(wf, 'W6 – Daily 10:00', [{}], { grist: g, meta, env: { FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: `${P.OWNER},+919876543210` }, openrouter });
  noErr(w6.r);
  assert(meta.calls.some((c) => c.body.to === '919876543210' && c.body.template && c.body.template.name === 'followup_day2'));
});


// ---------------------------------------------------------------- simultaneous submissions (the gap the website path exposed)
// A competing run stores the same phone between this run's "find" and its "create": emulated by inserting that row just before our POST.
const withCompetitor = (g, { failDelete = false, failRecheck = false } = {}) => {
  const real = g.handle.bind(g);
  let injected = false; let created = false;
  g.handle = (m, u, q, b) => {
    if (m === 'POST' && /\/LEADS\/records$/.test(u) && !injected) {
      injected = true;
      real(m, u, q, { records: [{ fields: { Lead_id: 'L-20261014-0001', Created_At: S(DAY), Name: 'Test Patient', Phone: '+919876543210', Source: 'Website', Status: 'New', Consent_WhatsApp: false, Consent_Source: 'website-form (no consent given)' } }] });
      created = true;
    }
    if (failDelete && /data\/delete$/.test(u)) throw new Error('Grist 503: delete failed');
    if (failRecheck && created && m === 'GET' && /\/LEADS\/records$/.test(u) && /\[5\]|"Phone"/.test(q.filter || '') && g.calls.filter((c) => c.method === 'POST' && c.table === 'LEADS').length >= 2) throw new Error('Grist 503: re-read failed');
    return real(m, u, q, b);
  };
  return g;
};
const ALLOW = { FLOWHQ_W1_REQUIRE_CONSENT: 'false', FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: P.OWNER };   // an alert WOULD go to the owner if this run carried on

test('SIMULTANEOUS (before): without the guard the losing run keeps its row and alerts again: two leads for one phone, two alerts', () => {
  const g = withCompetitor(crm()); const meta = fakeMeta();
  const res = run(racePatch.unpatch(wf), 'W1 – Webhook', [{ headers: {}, params: {}, query: {}, body: sitePayload() }], { grist: g, meta, openrouter, env: { ...SAFE, ...ALLOW } });
  noErr(res.r);
  assert.strictEqual(rows(g, 'LEADS').length, 2, 'two rows for one phone');
  assert.strictEqual(meta.calls.length, 1, 'the second run alerted staff');
});

test('SIMULTANEOUS (after): the losing run removes ONLY its own row, answers "duplicate", sends no second alert, and tells staff in Run_Log', () => {
  const g = withCompetitor(crm()); const meta = fakeMeta();
  const { r } = post(sitePayload(), { grist: g, meta, env: ALLOW });
  noErr(r);
  assert.deepStrictEqual(codes(r), [[200, { status: 'duplicate' }]]);
  const leads = rows(g, 'LEADS');
  assert.deepStrictEqual(leads.map((l) => l.id), [1], 'the older row is the one that stays');
  assert.strictEqual(meta.calls.length, 0, 'no staff alert from the loser');
  assert.strictEqual(ledger(g).length, 0);
  const log = rows(g, 'Run_Log').filter((l) => l.Workflow === 'W1-website-lead');
  assert.deepStrictEqual(log.map((l) => l.Outcome), ['skipped']);
  assert.match(log[0].Error, /lead row 1 was created first and is kept; the duplicate row 2 was removed/);
  assert.deepStrictEqual(g.calls.filter((c) => c.delete).map((c) => c.body), [[2]], 'exactly one delete, of the row this run created');
});

test('SIMULTANEOUS: when the duplicate cannot be removed, the visitor still gets "duplicate" and the log names the row to delete', () => {
  const g = withCompetitor(crm(), { failDelete: true });
  const { r } = post(sitePayload(), { grist: g, env: ALLOW });
  noErr(r);
  assert.deepStrictEqual(codes(r), [[200, { status: 'duplicate' }]]);
  assert.strictEqual(rows(g, 'LEADS').length, 2);
  assert.match(rows(g, 'Run_Log').find((l) => l.Workflow === 'W1-website-lead').Error, /could NOT be removed automatically: please delete it in Grist/);
});

test('NO race (the normal case) is unchanged: created, answered 200 after the store, ONE alert, nothing deleted', () => {
  const g = crm(); const meta = fakeMeta();
  const { r } = post(sitePayload(), { grist: g, meta, env: ALLOW });
  noErr(r);
  assert.strictEqual(codes(r)[0][1].action, 'created');
  assert.strictEqual(rows(g, 'LEADS').length, 1);
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(g.calls.filter((c) => c.delete).length, 0);
  assert.strictEqual(r.visited.filter((n) => n === 'W1 – Remove duplicate row').length, 0);
});

test('the re-read after creating fails: the run carries on exactly as before (created, alerted); nothing is deleted', () => {
  const g = crm();
  const real = g.handle.bind(g);
  let creates = 0;
  g.handle = (m, u, q, b) => { if (m === 'POST' && /\/LEADS\/records$/.test(u)) creates++; if (creates === 1 && m === 'GET' && /\/LEADS\/records$/.test(u) && (q.limit === '5')) throw new Error('Grist 503: re-read failed'); return real(m, u, q, b); };
  const meta = fakeMeta();
  const { r } = post(sitePayload(), { grist: g, meta, env: ALLOW });
  noErr(r);
  assert.strictEqual(codes(r)[0][1].action, 'created');
  assert.strictEqual(meta.calls.length, 1);
  assert.strictEqual(g.calls.filter((c) => c.delete).length, 0);
});

test('the patch: refuses to run twice, adds only its 6 nodes, and its HTTP nodes reuse the credential reference of "W1 – Find lead by phone"', () => {
  assert.throws(() => racePatch.patch(wf), /already exists/);
  const find = wf.nodes.find((n) => n.name === 'W1 – Find lead by phone');
  for (const n of [racePatch.N.recheck, racePatch.N.remove]) assert.deepStrictEqual(wf.nodes.find((x) => x.name === n).credentials, find.credentials);
  assert.strictEqual(wf.nodes.length, wfBefore.nodes.length + (patched ? 0 : 6));
});

test('14 workflow and credentials intact: the W1 webhook keeps header authentication and "Respond to Webhook"; this branch changes no workflow file', () => {
  const hook = wf.nodes.find((n) => n.name === 'W1 – Webhook');
  assert.deepStrictEqual([hook.parameters.httpMethod, hook.parameters.path, hook.parameters.authentication, hook.parameters.responseMode], ['POST', 'website-lead', 'headerAuth', 'responseNode']);
  assert(hook.credentials && hook.credentials.httpHeaderAuth, 'its credential reference is still there');
  try {
    const rel = path.relative(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(FILE) }).toString().trim(), FILE);
    if (path.basename(FILE) === 'clinic-autopilot-production.json') assert.strictEqual(execFileSync('git', ['diff', '--stat', 'HEAD', '--', rel], { cwd: path.dirname(FILE) }).toString().trim(), '', 'the workflow export is unchanged');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; /* not a git checkout: nothing to compare */ }
});

finish('website enquiry -> W1');
