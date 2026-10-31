#!/usr/bin/env node
// 4D = 4C + AI retry / backoff (n8n/final/tools/patch-4d-ai-retry.js). Proves: (1) the file is exactly patch(4C), (2) nothing else in 4C changed,
// (3) the retry decision behaves as designed, by running the Code node itself against simulated OpenRouter answers (no network, no secrets).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { patch: retryPatch, N, ADDED, NEW_ID } = require('../tools/patch-4d-ai-retry');
const gatePatch = require('../tools/patch-4d-allowlist-gate');
const { build } = require('../tools/build-4d');

const dir = path.join(__dirname, '..', 'workflows');
const file4c = path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4c.json');
const file4d = process.env.PROD_FILE && /4d/.test(process.env.PROD_FILE) ? process.env.PROD_FILE : path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4d.json');
const c4 = JSON.parse(fs.readFileSync(file4c, 'utf8'));
const d4 = JSON.parse(fs.readFileSync(file4d, 'utf8'));
const node = (wf, n) => wf.nodes.find((x) => x.name === n);

let failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`); } };

t('the committed 4D file is exactly build(4C) = allowlist gate(retry(4C)): reproducible', () => assert.deepStrictEqual(d4, build(c4)));
const s1 = retryPatch(c4);   // stage 1: 4C + the retry nodes only
t('4D is inactive, has its own id and name (never the id of the deployed workflow: an import must not overwrite it)', () => {
  assert.strictEqual(d4.active, false); assert.strictEqual(d4.id, NEW_ID); assert.notStrictEqual(d4.id, c4.id); assert.notStrictEqual(d4.name, c4.name);
});
t('exactly 3 nodes were added, with the intended names', () => {
  const added = d4.nodes.filter((n) => !c4.nodes.some((o) => o.name === n.name)).map((n) => n.name).sort();
  assert.deepStrictEqual(added, [...ADDED].sort()); assert.strictEqual(d4.nodes.length, c4.nodes.length + 3);
  assert.strictEqual(new Set(d4.nodes.map((n) => n.id)).size, d4.nodes.length, 'node ids are unique');
});
t('every other node is identical to 4C, except "W13 - Ask Model" (HTTP options only) and the two nodes the allowlist gate touches (W13 Config, W13 Build Context: see 4d-allowlist-gate.test.js)', () => {
  for (const o of c4.nodes) {
    const n = node(d4, o.name); assert.ok(n, `missing ${o.name}`);
    if (o.name === N.ask) { assert.deepStrictEqual({ ...n, parameters: { ...n.parameters, options: null } }, { ...o, parameters: { ...o.parameters, options: null } }); continue; }
    if ([gatePatch.CONFIG, gatePatch.BUILD].includes(o.name)) { assert.deepStrictEqual(n, node(gatePatch.patch(s1), o.name), `${o.name} differs from stage 1 + the gate`); continue; }
    assert.deepStrictEqual(n, o, `node changed: ${o.name}`);
  }
});
t('"Ask Model" returns the full response and never fails on an HTTP error; its timeout is unchanged', () => {
  assert.deepStrictEqual(node(d4, N.ask).parameters.options, { response: { response: { fullResponse: true, neverError: true } }, timeout: 45000 });
  assert.strictEqual(node(d4, N.ask).onError, 'continueRegularOutput');
});
t('wiring: Ask -> Check -> Retry?; retry -> Backoff -> Ask (loop); no retry -> Provider Answer; nothing else rewired', () => {
  const ref = (a) => JSON.stringify(a);
  assert.strictEqual(ref(d4.connections[N.ask].main), ref([[{ node: N.check, type: 'main', index: 0 }]]));
  assert.strictEqual(ref(d4.connections[N.check].main), ref([[{ node: N.test, type: 'main', index: 0 }]]));
  assert.strictEqual(ref(d4.connections[N.test].main), ref([[{ node: N.wait, type: 'main', index: 0 }], [{ node: N.ans, type: 'main', index: 0 }]]));
  assert.strictEqual(ref(d4.connections[N.wait].main), ref([[{ node: N.ask, type: 'main', index: 0 }]]));
  const others = Object.keys(c4.connections).filter((k) => k !== N.ask);
  for (const k of others) assert.deepStrictEqual(d4.connections[k], c4.connections[k], `connections changed for ${k}`);
  assert.strictEqual(Object.keys(d4.connections).length, Object.keys(c4.connections).length + 3);
});
t('the Provider Answer node is byte-identical (so a give-up { error } still ends in a hand-off to a person)', () => assert.strictEqual(node(d4, N.ans).parameters.jsCode, node(c4, N.ans).parameters.jsCode));
t('no new credential, no secret-looking value, no environment variable that is not optional', () => {
  const added = ADDED.map((n) => JSON.stringify(node(d4, n)));
  for (const s of added) { assert.ok(!/"credentials"/.test(s)); assert.ok(!/(sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{30,})/.test(s)); }
  const code = node(d4, N.check).parameters.jsCode;
  const envs = [...code.matchAll(/\$env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const e of envs) assert.ok(/^FLOWHQ_AI_RETRY_(MAX_ATTEMPTS|BASE_SECONDS|MAX_WAIT_SECONDS)$/.test(e), `unexpected env var ${e}`);
  assert.ok(new RegExp(`\\$\\('${N.req}'\\)`).test(code), 'reads the request from Provider Request');
});

// ---- behaviour: run the Code node itself
const CODE = node(d4, N.check).parameters.jsCode;
const REQ = { body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'synthetic test' }] } };
function run(res, { attempt = 1, env = {}, random = 0.5 } = {}) {
  const fn = new Function('$env', '$runIndex', '$', '$json', 'Math', CODE);
  const M = Object.create(Math); M.random = () => random;
  const out = fn(env, attempt - 1, (name) => { assert.strictEqual(name, N.req); return { first: () => ({ json: REQ }) }; }, res, M);
  assert.ok(Array.isArray(out) && out.length === 1, 'one item out');
  return out[0].json;
}
const http = (statusCode, body, headers = {}) => ({ statusCode, headers, body });
const OK = { id: 'x', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] };

t('success: the OpenRouter body is passed on unchanged (plus the attempt count), never marked as a retry', () => {
  const j = run(http(200, OK)); assert.deepStrictEqual(j.choices, OK.choices); assert.strictEqual(j.__attempts, 1); assert.ok(!j.retry && !j.error);
});
t('429 on the first try -> retry with the SAME request body and a wait of 1-20 s', () => {
  const j = run(http(429, { error: { code: 429, message: 'rate limited' } })); assert.strictEqual(j.retry, true); assert.deepStrictEqual(j.body, REQ.body);
  assert.ok(j.wait_seconds >= 1 && j.wait_seconds <= 20); assert.strictEqual(j.class, 'rate_limited');
});
t('a Retry-After of 3 s is a minimum for the wait', () => { const j = run(http(429, { error: { code: 429, message: 'slow down' } }, { 'Retry-After': '3' })); assert.strictEqual(j.retry, true); assert.ok(j.wait_seconds >= 3); });
t('a Retry-After longer than the cap (20 s) is NOT waited for: it gives up', () => { const j = run(http(429, { error: { code: 429, message: 'slow down' } }, { 'retry-after': '120' })); assert.ok(j.error && j.error.class === 'rate_limited' && !j.retry); });
t('a daily free quota is never retried', () => { const j = run(http(429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } })); assert.ok(j.error && /daily/.test(j.error.message)); });
t('402 / 401 / 403 / 404 / 400 are never retried', () => {
  for (const [s, c] of [[402, 'payment_required'], [401, 'auth_error'], [403, 'auth_error'], [404, 'model_unavailable']]) { const j = run(http(s, { error: { code: s, message: 'x' } })); assert.ok(j.error && j.error.class === c && !j.retry, `${s}`); }
  const j400 = run(http(400, { error: { code: 400, message: 'bad request' } })); assert.ok(j400.error && !j400.retry);
});
t('500-599 are retried, but at most 3 requests in total', () => {
  const r = (a) => run(http(503, { error: { code: 503, message: 'upstream' } }), { attempt: a });
  assert.strictEqual(r(1).retry, true); assert.strictEqual(r(2).retry, true);
  const g = r(3); assert.ok(g.error && g.error.attempts === 3 && /gave up/.test(g.error.message) && !g.retry);
});
t('HTTP 200 carrying an error body (an upstream failure) is treated as a failure, not as an answer', () => { const j = run(http(200, { error: { code: 502, message: 'upstream provider error' } })); assert.strictEqual(j.retry, true); assert.ok(!j.choices); });
t('a timeout (no HTTP answer) is retried once, then stops (it may have been processed upstream)', () => {
  const e = { error: { message: 'timeout of 45000ms exceeded', name: 'AxiosError', code: 'ECONNABORTED' } };
  assert.strictEqual(run(e, { attempt: 1 }).retry, true); const g = run(e, { attempt: 2 }); assert.ok(g.error && !g.retry);
});
t('the attempt limit and the wait are clamped: FLOWHQ_AI_RETRY_MAX_ATTEMPTS=9 still means at most 5, and waits never exceed 20 s by default', () => {
  const e = http(503, { error: { code: 503, message: 'upstream' } });
  assert.strictEqual(run(e, { attempt: 4, env: { FLOWHQ_AI_RETRY_MAX_ATTEMPTS: '9' } }).retry, true); assert.ok(run(e, { attempt: 5, env: { FLOWHQ_AI_RETRY_MAX_ATTEMPTS: '9' } }).error);
  for (let a = 1; a <= 2; a++) assert.ok(run(e, { attempt: a, random: 0.999 }).wait_seconds <= 20);
});
t('a give-up is an { error } item that is NEVER shaped like an answer (no choices), so it cannot be mistaken for a reply', () => {
  const g = run(http(503, { error: { code: 503, message: 'upstream' } }), { attempt: 3 }); assert.ok(g.error && g.choices === undefined && g.retry === undefined);
});

process.exit(failed ? 1 : 0);
