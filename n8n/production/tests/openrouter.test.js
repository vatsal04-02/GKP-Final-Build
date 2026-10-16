// OpenRouter as the one external AI provider: configuration, the single enable/disable switch (W13 and W9), invalid or missing configuration, and the
// separation of credentials by ROLE (OpenRouter / website webhook / Grist). The provider is a MOCK: no real OpenRouter call is ever made.
// Run: node n8n/production/tests/openrouter.test.js   (target: the selected workflow; run-tests.js passes PROD_FILE and the credential names)
'use strict';
const assert = require('assert');
const H = require('./harness');
const { audit } = require('../../final/tools/audit-credentials');
const { loadWf, run, runItem, inboundRequest, messageBody, fakeMeta, ledger, rows, freshGrist, test, finish, clone, P, F, ENV } = H;

const wf = loadWf();
const node = (w, n) => w.nodes.find((x) => x.name === n);
const T = F.sec(F.NOW);
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const all = (r) => [r, ...(r.subRuns || []).flatMap(all)];
const errors = (res) => all(res.r).filter((x) => x.error).map((x) => `${x.error.node}: ${x.error.message}`);

// ---------------------------------------------------------------- W13 helpers (a patient message through W2, then W13)
const crm = (settings = {}) => freshGrist({
  Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER, ...settings }),
  LEADS: F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } })), Conversations: [], Messages: [],
});
const inbound = (text, env = {}, g = crm()) => {
  const cl = F.fakeClaude(); const or = F.fakeOpenRouter(cl); const meta = fakeMeta();
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody(text, { id: `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, from: P.ASHA, name: 'Asha Patel', ts: T })), {
    grist: g, now: F.NOW, openrouter: or, meta, env: { ...ENV, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}`, ...env },
  });
  return { res, g, or, meta };
};
const inMsg = (g) => rows(g, 'Messages').find((m) => m.Direction === 'In');

// ---------------------------------------------------------------- configuration
test('config: W13 and W9 each have ONE ai_external_enabled assignment, the same expression; no literal override exists anywhere in the workflow', () => {
  const exprs = [];
  for (const n of wf.nodes) {
    const list = ((n.parameters || {}).assignments || {}).assignments || [];
    for (const a of list) if (a.name === 'ai_external_enabled') exprs.push([n.name, a.value]);
  }
  assert.deepStrictEqual(exprs.map((e) => e[0]).sort(), ['W13 – Config', 'W9 – Config']);
  assert(exprs.every(([, v]) => v === "={{ String($env.FLOWHQ_AI_EXTERNAL_ENABLED || '').trim().toLowerCase() === 'true' }}"), JSON.stringify(exprs));
  assert(!/ai_external_enabled\s*[:=]\s*true/.test(JSON.stringify(wf.nodes.map((n) => (n.parameters || {}).jsCode || ''))), 'no code node forces the switch on');
});

test('config: the gate in W13 – Build Context reads only W13 – Config (no second, different check of the environment)', () => {
  const code = node(wf, 'W13 – Build Context').parameters.jsCode;
  const gate = code.split('\n').filter((l) => /ai_external_enabled/.test(l));
  assert.strictEqual(gate.length, 1, gate.join(' | '));
  assert(!/\$env/.test(gate[0]), 'the gate line does not read $env itself');
  assert.match(gate[0], /ai_external_enabled !== true/);
  assert.match(gate[0], /quiet: false/, 'a closed gate is a visible skip');
});

test('config: OpenRouter is the provider in both sections: model from FLOWHQ_AI_MODEL (default openai/gpt-4o-mini), endpoint https://openrouter.ai/api/v1 by default', () => {
  for (const nm of ['W13 – Config', 'W9 – Config']) {
    const a = Object.fromEntries(node(wf, nm).parameters.assignments.assignments.map((x) => [x.name, x.value]));
    assert.strictEqual(a.openrouter_model, "={{ $env.FLOWHQ_AI_MODEL || 'openai/gpt-4o-mini' }}", nm);
    assert.strictEqual(a.ai_base_url, "={{ $env.FLOWHQ_AI_BASE_URL || 'https://openrouter.ai/api/v1' }}", nm);
  }
  assert.strictEqual(node(wf, 'W13 – Config').parameters.assignments.assignments.find((x) => x.name === 'model_provider').value, 'openrouter');
  for (const nm of ['W13 – Ask Model', 'W9 – Ask Model']) {
    const p = node(wf, nm).parameters;
    assert.match(p.url, /ai_base_url.*\/chat\/completions$/, nm);
    assert.deepStrictEqual([p.authentication, p.genericAuthType], ['genericCredentialType', 'httpHeaderAuth'], nm);
  }
});

// ---------------------------------------------------------------- the switch (W13)
test('W13 switch: unset, empty or any value other than "true" = OFF (visible skip, no provider call, nothing sent)', () => {
  for (const v of [undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'enabled', 'tru e', 'truee']) {
    const x = inbound('How much is a physio session?', { FLOWHQ_AI_EXTERNAL_ENABLED: v });
    assert.deepStrictEqual(errors(x.res), [], `value ${JSON.stringify(v)}`);
    assert.strictEqual(x.or.calls.length, 0, `value ${JSON.stringify(v)}: provider called`);
    const m = inMsg(x.g);
    assert.deepStrictEqual([m.AI_Status, m.AI_Action], ['skipped', 'skip'], `value ${JSON.stringify(v)}`);
    assert.match(m.AI_Reason, /FLOWHQ_AI_EXTERNAL_ENABLED/);
    assert.strictEqual(x.meta.calls.length, 0);
    assert.strictEqual(ledger(x.g).length, 0);
  }
});

test('W13 switch: "true" in any case, with spaces = ON: exactly one call to OpenRouter with the configured model, and a valid reply', () => {
  for (const v of ['true', 'TRUE', 'True', ' true ']) {
    const x = inbound('How much is a physio session?', { FLOWHQ_AI_EXTERNAL_ENABLED: v });
    assert.deepStrictEqual(errors(x.res), [], `value ${JSON.stringify(v)}`);
    assert.strictEqual(x.or.calls.length, 1, `value ${JSON.stringify(v)}`);
    assert.strictEqual(x.or.calls[0].url, OPENROUTER_URL);
    assert.strictEqual(x.or.calls[0].body.model, 'openai/gpt-4o-mini');
    const m = inMsg(x.g);
    assert.deepStrictEqual([m.Intent, m.AI_Action, m.AI_Status], ['pricing', 'reply', 'replied']);
  }
});

test('W13 model: FLOWHQ_AI_MODEL is what is sent to OpenRouter', () => {
  const x = inbound('How much is a physio session?', { FLOWHQ_AI_EXTERNAL_ENABLED: 'true', FLOWHQ_AI_MODEL: 'anthropic/claude-3.5-haiku' });
  assert.deepStrictEqual(errors(x.res), []);
  assert.strictEqual(x.or.calls[0].body.model, 'anthropic/claude-3.5-haiku');
});

test('W13 switch OFF does not weaken the safeguards: an emergency still alerts staff; STOP still opts out', () => {
  const e = inbound('I have severe chest pain and cannot breathe', { FLOWHQ_AI_EXTERNAL_ENABLED: 'false' });
  assert.strictEqual(e.or.calls.length, 0);
  assert(e.meta.calls.some((c) => c.body.template && c.body.template.name === 'human_handoff_alert'));
  const s = inbound('STOP', { FLOWHQ_AI_EXTERNAL_ENABLED: undefined });
  assert.strictEqual(s.or.calls.length, 0);
  assert.strictEqual(rows(s.g, 'LEADS').find((l) => l.Phone === P.ASHA).Opted_Out, true);
});

// ---------------------------------------------------------------- invalid configuration (switch ON): stops before anything is sent anywhere
test('invalid configuration with the switch ON stops W13 with a message naming the variable: bad model, foreign endpoint, metadata address, look-alike host; nothing is sent', () => {
  const cases = [
    [{ FLOWHQ_AI_MODEL: 'bad model' }, /FLOWHQ_AI_MODEL must look like vendor\/model/],
    [{ FLOWHQ_AI_MODEL: 'gpt-4o-mini' }, /FLOWHQ_AI_MODEL must look like vendor\/model/],
    [{ FLOWHQ_AI_BASE_URL: 'https://evil.example/v1' }, /FLOWHQ_AI_BASE_URL must be https:\/\/openrouter\.ai/],
    [{ FLOWHQ_AI_BASE_URL: 'https://openrouter.ai.evil.example/api/v1' }, /FLOWHQ_AI_BASE_URL must be https:\/\/openrouter\.ai/],
    [{ FLOWHQ_AI_BASE_URL: 'http://169.254.169.254/latest' }, /FLOWHQ_AI_BASE_URL must be https:\/\/openrouter\.ai/],
    [{ FLOWHQ_AI_BASE_URL: 'ftp://openrouter.ai/x' }, /FLOWHQ_AI_BASE_URL must be https:\/\/openrouter\.ai/],
  ];
  for (const [env, re] of cases) {
    const x = inbound('How much is a physio session?', { FLOWHQ_AI_EXTERNAL_ENABLED: 'true', ...env });
    const errs = errors(x.res);
    assert(errs.some((e) => re.test(e)), `${JSON.stringify(env)} -> ${errs.join(' | ') || 'no error'}`);
    assert.strictEqual(x.or.calls.length, 0, `${JSON.stringify(env)}: provider called`);
    assert.strictEqual(x.meta.calls.length, 0, `${JSON.stringify(env)}: something was sent`);
    assert.strictEqual(ledger(x.g).length, 0);
  }
});

test('valid OpenRouter endpoints are accepted: the default, the bare host, and a local mock on 127.0.0.1', () => {
  for (const base of [undefined, 'https://openrouter.ai/api/v1', 'https://openrouter.ai', 'http://127.0.0.1:9']) {
    const x = inbound('How much is a physio session?', { FLOWHQ_AI_EXTERNAL_ENABLED: 'true', FLOWHQ_AI_BASE_URL: base });
    assert(!errors(x.res).some((e) => /FLOWHQ_AI_BASE_URL/.test(e)), `${base}: ${errors(x.res).join(' | ')}`);
  }
});

test('with the switch OFF the AI settings are not validated: a bad model or endpoint cannot stop W13 (emergency alerts keep working)', () => {
  const x = inbound('I have severe chest pain and cannot breathe', { FLOWHQ_AI_EXTERNAL_ENABLED: 'false', FLOWHQ_AI_MODEL: 'bad model', FLOWHQ_AI_BASE_URL: 'https://evil.example/v1' });
  assert.deepStrictEqual(errors(x.res), []);
  assert.strictEqual(x.or.calls.length, 0);
  assert(x.meta.calls.some((c) => c.body.template && c.body.template.name === 'human_handoff_alert'));
});

test('the OpenRouter API key is never an environment value of the workflow: no $env name suggests a key, and every Config node is free of secrets', () => {
  const names = new Set(); for (const m of JSON.stringify(wf).matchAll(/\$env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  assert([...names].every((n) => /^FLOWHQ_/.test(n)), [...names].join(','));
  assert(![...names].some((n) => /KEY|TOKEN|SECRET_KEY|PASSWORD/.test(n) && !/^FLOWHQ_(META_VERIFY_TOKEN|META_APP_SECRET|CAL_WEBHOOK_SECRET)$/.test(n)), [...names].join(','));
});

// ---------------------------------------------------------------- the switch (W9, weekly report)
const MON = Date.parse('2026-10-12T09:00:00+05:30');
const w9 = (env) => {
  const g = freshGrist({
    Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: undefined, weekly_report_whatsapp: 'on', owner_phone: P.OWNER, TEST_PHONE: P.TEST }),
    LEADS: F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } })), Conversations: [], Messages: [],
    Appointments: [{ id: 201, fields: { Booking_UID: 'u201', Lead: 1, Service: 'Physio', Start: F.sec(MON) - 3 * 86400, End: F.sec(MON) - 3 * 86400 + 2700, Status: 'Completed' } }],
  });
  const calls = [];
  const openrouter = (method, url, headers, body) => { calls.push({ url, body }); return { status: 200, body: { id: 'g', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'A quiet week.', observations: [], recommendations: [] }) } }] } }; };
  const x = run(wf, 'W9 – Monday 09:00', [{}], { grist: g, now: MON, meta: fakeMeta(), openrouter, env: { ...ENV, FLOWHQ_WA_ALLOWLIST: P.OWNER, ...env } });
  return { x, calls, g };
};

test('W9 switch: the SAME rule as W13: anything but "true" = OFF (no provider call, the report is still written from the numbers)', () => {
  for (const v of [undefined, '', 'false', '1', 'yes', 'on']) {
    const { x, calls, g } = w9({ FLOWHQ_AI_EXTERNAL_ENABLED: v });
    assert.strictEqual(x.r.error, null, `value ${JSON.stringify(v)}: ${x.r.error && x.r.error.message}`);
    assert.strictEqual(calls.length, 0, `value ${JSON.stringify(v)}`);
    assert(rows(g, 'Run_Log').some((l) => /^WEEKLY REPORT/.test(l.Record)), 'the report is saved');
  }
});

test('W9 switch: "true"/"TRUE" = ON: one call to OpenRouter with the configured model and only computed numbers (no names, no phone numbers)', () => {
  for (const v of ['true', 'TRUE', ' True ']) {
    const { x, calls } = w9({ FLOWHQ_AI_EXTERNAL_ENABLED: v, FLOWHQ_AI_MODEL: 'openai/gpt-4o-mini' });
    assert.strictEqual(x.r.error, null, `value ${JSON.stringify(v)}: ${x.r.error && x.r.error.message}`);
    assert.strictEqual(calls.length, 1, `value ${JSON.stringify(v)}`);
    assert.strictEqual(calls[0].url, OPENROUTER_URL);
    assert.strictEqual(calls[0].body.model, 'openai/gpt-4o-mini');
    assert(!/Asha|Patel|\+91\d{10}|9000000011/.test(JSON.stringify(calls[0].body)), 'no patient identifiers');
  }
});

test('W9 invalid configuration with the switch ON stops before anything is called (bad model, foreign endpoint)', () => {
  for (const env of [{ FLOWHQ_AI_MODEL: 'bad model' }, { FLOWHQ_AI_BASE_URL: 'https://evil.example/v1' }]) {
    const { x, calls } = w9({ FLOWHQ_AI_EXTERNAL_ENABLED: 'true', ...env });
    assert(x.r.error && /FLOWHQ_AI_(MODEL|BASE_URL)/.test(x.r.error.message), JSON.stringify(env));
    assert.strictEqual(calls.length, 0);
  }
});

// ---------------------------------------------------------------- credential roles
test('credential roles: OpenRouter authenticates ONLY the AI calls; the website webhook has its own credential; Grist has its own; no credential serves two roles', () => {
  const a = audit(wf);
  assert.deepStrictEqual(a.credentials.filter((c) => c.shared).map((c) => c.credentialName), []);
  const roleOfCred = (name) => Object.keys(a.credentials.find((c) => c.credentialName === name).roles).map((r) => r.split(' ')[0]);
  assert.deepStrictEqual(roleOfCred('OpenRouter API'), ['ai-provider']);
  assert.deepStrictEqual(roleOfCred('FlowHQ W1 Webhook Auth'), ['webhook-auth']);
  assert.deepStrictEqual(roleOfCred('Header Auth account 2'), ['grist']);
  const ids = a.credentials.map((c) => c.credentialId);
  assert.strictEqual(new Set(ids).size, ids.length, 'every credential has its own id');
  // the AI nodes are exactly the ones that carry the OpenRouter credential
  const aiNodes = wf.nodes.filter((n) => n.credentials && n.credentials.httpHeaderAuth && n.credentials.httpHeaderAuth.name === 'OpenRouter API').map((n) => n.name).sort();
  assert.deepStrictEqual(aiNodes, ['W13 – Ask Model', 'W9 – Ask Model']);
  const hook = node(wf, 'W1 – Webhook');
  assert.deepStrictEqual([hook.parameters.authentication, hook.credentials.httpHeaderAuth.name], ['headerAuth', 'FlowHQ W1 Webhook Auth']);
  assert.notStrictEqual(hook.credentials.httpHeaderAuth.id, node(wf, 'W13 – Ask Model').credentials.httpHeaderAuth.id);
  assert.notStrictEqual(hook.credentials.httpHeaderAuth.id, node(wf, 'W1 – Create lead').credentials.httpHeaderAuth.id);
});

test('credential roles are ENFORCED by the simulator: an AI node with the Grist credential, or a Grist node with the OpenRouter credential, fails the run', () => {
  const swap = (w, name, cred) => { const c = clone(w); node(c, name).credentials = { httpHeaderAuth: cred }; return c; };
  const grist = node(wf, 'W1 – Create lead').credentials.httpHeaderAuth;
  const ai = node(wf, 'W13 – Ask Model').credentials.httpHeaderAuth;
  const wrongAi = swap(wf, 'W13 – Ask Model', grist);
  const cl = F.fakeClaude(); const or = F.fakeOpenRouter(cl);
  const gw = crm();
  const res = runItem(wrongAi, 'W2 – Webhook Inbound', inboundRequest(messageBody('How much is a physio session?', { id: 'wamid.IN.sw1', from: P.ASHA, name: 'Asha Patel', ts: T })), { grist: gw, now: F.NOW, openrouter: or, meta: fakeMeta(), env: { ...ENV, FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}`, FLOWHQ_AI_EXTERNAL_ENABLED: 'true' } });
  assert.strictEqual(cl.calls.length, 0, 'an AI call with the Grist credential must not succeed');
  assert.match(inMsg(gw).AI_Reason, /OpenRouter called with credential "Header Auth account 2"/, 'the failure is recorded on the message and staff take over');
  assert.strictEqual(inMsg(gw).AI_Action, 'handoff');
  const wrongGrist = swap(wf, 'W1 – Clinic lookup', ai);
  const r2 = run(wrongGrist, 'W1 – Webhook', [{ headers: {}, params: {}, query: {}, body: { clinic_slug: 'demo-physio', name: 'Test Patient', phone: '+919876543210', consent_whatsapp: true } }], { grist: crm(), meta: fakeMeta(), env: { ...ENV, FLOWHQ_WA_SEND_MODE: 'off' } });
  assert(r2.r.error && /OpenRouter credential used for/.test(r2.r.error.message), r2.r.error && r2.r.error.message);
});

finish('OpenRouter configuration');
