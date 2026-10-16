// The OpenRouter DEMO workflow (W13-AI-Receptionist-Demo-OpenRouter.json):
//   1. it is W13 with ONLY the provider layer swapped (every other node, id, credential, connection and setting identical),
//   2. the OpenRouter request carries exactly W13's instructions, facts, patient message and decision schema (strict), the model
//      comes from W13 – Config > openrouter_model, and a wrong model_provider stops before any call,
//   3. then the WHOLE W13 end-to-end suite (w13.test.js, incl. mutation tests) runs against the demo file.
// Run: node n8n/w13/w13-openrouter.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');
const ai = require('../snippets/ai-receptionist');

const DEMO_FILE = path.join(__dirname, 'W13-AI-Receptionist-Demo-OpenRouter.json');
const W13 = JSON.parse(fs.readFileSync(path.join(__dirname, 'W13-AI-Receptionist.json'), 'utf8'));
const DEMO = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (m) => console.log(`  ok  ${m}`);
console.log('OpenRouter demo: provider layer only');

// ---------------------------------------------------------------- 1. only the provider layer differs
const byName = (w) => Object.fromEntries(w.nodes.map((n) => [n.name, n]));
const a = byName(W13);
const b = byName(DEMO);
const PROVIDER_NODES = ['W13 – Provider Request', 'W13 – Ask Model', 'W13 – Provider Answer'];
assert.deepStrictEqual(Object.keys(a).filter((n) => !b[n]), ['W13 – Ask Claude']);
assert.deepStrictEqual(Object.keys(b).filter((n) => !a[n]).sort(), [...PROVIDER_NODES].sort());
const differ = Object.keys(a).filter((n) => b[n] && JSON.stringify(a[n]) !== JSON.stringify(b[n]));
assert.deepStrictEqual(differ.sort(), ['W13 – Config', 'W13 – Section 00 Read Me', 'W13 – Section D Decide'].sort());
const cfgA = a['W13 – Config'].parameters.assignments.assignments.map((x) => [x.name, x.value]);
const cfgB = b['W13 – Config'].parameters.assignments.assignments.map((x) => [x.name, x.value]);
assert.deepStrictEqual(cfgA.filter(([k]) => k !== 'anthropic_model'), cfgB.filter(([k]) => !['model_provider', 'openrouter_model'].includes(k)));
assert.deepStrictEqual(cfgB.filter(([k]) => ['model_provider', 'openrouter_model'].includes(k)), [['model_provider', 'openrouter'], ['openrouter_model', 'openai/gpt-4o-mini']]);
assert.deepStrictEqual(DEMO.settings, W13.settings);
assert.notStrictEqual(DEMO.name, W13.name);
assert.strictEqual(DEMO.name, 'W13 DEMO - AI receptionist (OpenRouter)');
ok(`every node except the provider layer is identical to W13 (${Object.keys(a).length - 4} nodes incl. all gates, Plan, Plan Ready, Record Sends, W12 call, CRM writes); Config only swaps anthropic_model for model_provider + openrouter_model; different workflow name`);

// connections: identical once the provider layer is collapsed to one hop
const collapse = (w, from, to) => JSON.parse(JSON.stringify(w.connections).split(`"node":"${from}"`).join(`"node":"${to}"`));
const ca = collapse(W13, 'W13 – Ask Claude', 'PROVIDER');
const cb = collapse(DEMO, 'W13 – Provider Request', 'PROVIDER');
delete cb['W13 – Provider Request']; delete cb['W13 – Ask Model'];
cb.PROVIDER = cb['W13 – Provider Answer']; delete cb['W13 – Provider Answer'];
ca.PROVIDER = ca['W13 – Ask Claude']; delete ca['W13 – Ask Claude'];
assert.deepStrictEqual(cb, ca);
assert.deepStrictEqual(DEMO.connections['W13 – Provider Request'].main[0].map((c) => c.node), ['W13 – Ask Model']);
assert.deepStrictEqual(DEMO.connections['W13 – Ask Model'].main[0].map((c) => c.node), ['W13 – Provider Answer']);
assert.deepStrictEqual(DEMO.connections['W13 – Provider Answer'].main[0].map((c) => c.node), ['W13 – Plan']);
ok('connections identical: Claim? / Claim Message -> [Provider Request -> Ask Model -> Provider Answer] -> Plan, where W13 has [Ask Claude]');

const ask = b['W13 – Ask Model'];
const claude = a['W13 – Ask Claude'];
for (const k of ['onError', 'retryOnFail', 'maxTries', 'waitBetweenTries']) assert.strictEqual(ask[k], claude[k], k);
assert.strictEqual(ask.parameters.options.timeout, claude.parameters.options.timeout);
ok('same timeout (45 s), retries (2) and "continue on error" as Ask Claude: a provider failure becomes a hand-off, never a crash');

// ---------------------------------------------------------------- 2. the request that leaves for OpenRouter
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
const crm = () => new FakeGrist({
  REGISTRY_DOC_ID_PLACEHOLDER: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true } }] },
  DOCA: { Settings: F.settingsRows(), Knowledge: clone(F.KNOWLEDGE), LEADS: F.leadRows(), Conversations: F.conversationRows(), Messages: F.messageRows(), Appointments: F.appointmentRows(), Run_Log: [] },
});
const dryRun = (w, only) => {
  const ww = clone(w);
  const t = ww.nodes.find((n) => n.name === 'W13 – Test Messages');
  t.parameters.jsCode = t.parameters.jsCode.replace("const ONLY = '';", `const ONLY = '${only}';`);
  const g = crm();
  const claudeFake = F.fakeClaude();
  const or = F.fakeOpenRouter(claudeFake);
  const r = simulate(ww, { start: 'W13 – Manual Test', items: [{ json: {} }], grist: g, now: F.NOW, workflowId: 'DEMO', workflows: {}, openrouter: or, meta: () => { throw new Error('no Meta in a dry run'); } });
  return { r, g, or, claudeFake, report: (r.runData['W13 – Test Report'] || []).map((i) => i.json) };
};
let x = dryRun(DEMO, 'existing-lead-availability');
assert.strictEqual(x.r.error, null, JSON.stringify(x.r.error));
assert.strictEqual(x.or.calls.length, 1);
const call = x.or.calls[0];
assert.deepStrictEqual([call.method, call.url, call.headers], ['POST', 'https://openrouter.ai/api/v1/chat/completions', { 'X-Title': 'Clinic Autopilot (demo)' }]);
const body = call.body;
assert.deepStrictEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'provider', 'response_format']);
assert.deepStrictEqual([body.model, body.max_tokens, body.provider], ['openai/gpt-4o-mini', 1500, { require_parameters: true }]);
assert.deepStrictEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'clinic_decision', strict: true, schema: ai.AI_DECISION_SCHEMA } });
assert.deepStrictEqual(body.messages.map((m) => m.role), ['system', 'user']);
assert(body.messages[0].content.startsWith(`${ai.AI_RULES}\n\nCLINIC\n- name: Demo Physio`));
for (const s of ['[K1] (services) Knee pain physiotherapy', '- 2026-10-07 = wednesday Wed 07 Oct (tomorrow)', '- [A1] Wed 07 Oct 10:00 AM', '- patient (Thu 01 Oct 11:00): Do you treat knee pain?', '- earlier summary: Asked about knee pain treatment']) assert(body.messages[0].content.includes(s), s);
assert.strictEqual(body.messages[1].content, '<patient_message>\nCan I come tomorrow evening?\n</patient_message>');
assert(!JSON.stringify(body).match(/9000000011|Authorization|Bearer/));
assert.deepStrictEqual([x.report[0].status, x.report[0].route, x.report[0].reply], ['dry_run', 'offer_slots', 'Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free. Which one suits you?']);
assert.deepStrictEqual(x.g.calls.filter((c) => c.method !== 'GET'), []);
ok('request: POST /api/v1/chat/completions; the same rules + clinic facts + slots + appointments + history (one system message), the same patient message, max_tokens 1500, the decision schema as strict json_schema, require_parameters; no phone number, no key in the body or headers (the key is only in the n8n credential)');

const usage = x.r.subRuns[0].runData['W13 – Done'][0].json.usage;
assert.deepStrictEqual(usage, { input_tokens: 1000, output_tokens: 200, provider: 'openrouter', model: 'openai/gpt-4o-mini' });
ok('the model actually used and the token counts reach W13 – Done > usage (visible in the manual test)');

const other = clone(DEMO);
other.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((v) => v.name === 'openrouter_model').value = 'google/gemini-2.5-flash-lite';
x = dryRun(other, 'price');
assert.strictEqual(x.or.calls[0].body.model, 'google/gemini-2.5-flash-lite');
ok('the model is configurable in W13 – Config > openrouter_model (no code change)');

const wrong = clone(DEMO);
wrong.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((v) => v.name === 'model_provider').value = 'anthropic';
x = dryRun(wrong, 'price');
assert.strictEqual(x.or.calls.length, 0, 'nothing is called');
assert(/model_provider is "anthropic": this demo workflow only talks to OpenRouter/.test(x.report[0].ai_error), x.report[0].ai_error);
const badModel = clone(DEMO);
badModel.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((v) => v.name === 'openrouter_model').value = '';
x = dryRun(badModel, 'price');
assert.deepStrictEqual([x.or.calls.length, /is not an OpenRouter model id/.test(x.report[0].ai_error)], [0, true]);
ok('a wrong model_provider or an empty / malformed model id stops the run BEFORE any call, with a clear error (nothing sent, nothing written)');

// ---------------------------------------------------------------- 3. the safety checks on answers that came through OpenRouter
// One custom message per case (dry run: the real decision path up to "what would be sent"; nothing is written or sent).
const custom = (text, ai) => {
  const ww = clone(DEMO);
  const t = ww.nodes.find((n) => n.name === 'W13 – Test Messages');
  t.parameters.jsCode = t.parameters.jsCode.replace("const ONLY = '';", "const ONLY = 'custom';").replace('const cases = [', `const cases = [\n  ['custom', EXISTING, ${JSON.stringify(text)}, 'custom'],`);
  const g = crm();
  const or = F.fakeOpenRouter(F.fakeClaude(ai));
  const r = simulate(ww, { start: 'W13 – Manual Test', items: [{ json: {} }], grist: g, now: F.NOW, workflowId: 'DEMO', workflows: {}, openrouter: or });
  assert.strictEqual(r.error, null, JSON.stringify(r.error));
  assert.deepStrictEqual(g.calls.filter((c) => c.method !== 'GET'), []);
  return r.runData['W13 – Test Report'][0].json;
};
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';
const handedOff = (rep, why, name) => {
  assert.deepStrictEqual([rep.route, rep.needs_human], ['handoff', true], name);
  assert.deepStrictEqual(rep.would_send.map((w) => [w.kind, w.kind === 'patient_reply' ? w.text : '']), [['patient_reply', HOLD], ['staff_alert', '']], name);
  assert(why.test(rep.reason), `${name}: ${rep.reason}`);
};
const answer = (over) => (req) => ({ ...F.fakeDecide(req), ...over });
const checks = [
  ['medical question', 'My knee is swollen, should I take ibuprofen?', answer({ intent: 'medical_question', action: 'reply', needs_human: false, confidence: 0.95, reply: 'Take 400 mg ibuprofen twice a day.' }), /medical question/],
  ['payment issue', 'I paid twice by UPI, please refund', answer({ intent: 'payment_issue', action: 'reply', needs_human: false, confidence: 0.9, reply: 'Your refund is done.' }), /payment issue/],
  ['made-up price', 'How much does this cost?', answer({ reply: 'Special price today: only ₹199!' }), /fact check/],
  ['made-up link', 'How much does this cost?', answer({ reply: 'Please pay here: https://pay.example/now' }), /fact check/],
  ['low confidence', 'How much does this cost?', answer({ confidence: 0.4 }), /low confidence \(0\.4\)/],
  ['malformed model output', 'How much does this cost?', () => 'Sure! {intent: pricing', /not JSON/],
  ['provider timeout', 'How much does this cost?', () => ({ throw: 'timeout of 45000ms exceeded' }), /OpenRouter: timeout/],
  ['unknown question', 'Do you accept the XYZ health insurance card?', undefined, /not covered by the knowledge base/],
];
for (const [name, text, aiFn, why] of checks) {
  const rep = custom(text, aiFn);
  handedOff(rep, why, name);
  assert(!JSON.stringify(rep.would_send).match(/ibuprofen|refund is done|199|pay\.example/), `${name}: the bad text must not be sent`);
}
const stop = custom('STOP', undefined);
assert.deepStrictEqual([stop.route, stop.would_send, stop.status], ['opt_out', [], 'opted_out']);   // reported as opted_out; the dry run still writes nothing (checked in custom())
ok(`through OpenRouter: ${checks.map((c) => c[0]).join(', ')} -> hand-off (holding reply + staff alert, the bad text never sent); STOP -> opt-out, nothing sent`);

console.log('\nthe full W13 end-to-end suite on the OpenRouter demo:');
process.env.W13_FILE = DEMO_FILE;
require('./w13.test.js');
