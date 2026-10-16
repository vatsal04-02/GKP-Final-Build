// Offline checks for W11-error-alert.json. Run: node n8n/tests/w11.checks.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const file = path.join(process.argv[2] || path.join(__dirname, '..', '..'), 'n8n/workflows/W11-error-alert.json');
const raw = fs.readFileSync(file, 'utf8');
const wf = JSON.parse(raw);
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

console.log('structure');
const names = wf.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(wf.nodes.map((x) => x.id)).size, wf.nodes.length);
for (const [from, v] of Object.entries(wf.connections)) {
  assert(names.includes(from));
  for (const outs of v.main) for (const t of outs) assert(names.includes(t.node), `missing ${t.node}`);
}
const seen = new Set(['Error Trigger']); const q = ['Error Trigger'];
while (q.length) for (const outs of (wf.connections[q.shift()] || { main: [] }).main) for (const t of outs) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
assert.deepStrictEqual(names.filter((x) => !seen.has(x) && x !== 'Notes'), []);
assert(wf.nodes.find((x) => x.name === 'Error Trigger').type === 'n8n-nodes-base.errorTrigger');
ok(`${names.length} nodes, unique, connected, starts at an Error Trigger`);

const tg = wf.nodes.find((x) => x.name === 'Telegram alert');
assert.strictEqual(tg.parameters.additionalFields.parse_mode, 'HTML');
assert.strictEqual(tg.parameters.additionalFields.appendAttribution, false);
assert.strictEqual(tg.retryOnFail, true);
assert(!/[0-9]{8,}:[A-Za-z0-9_-]{20,}/.test(raw), 'looks like a Telegram bot token');
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw));
ok('Telegram node: HTML mode, no n8n attribution, retries 3x; no token / secret / hostname in the file');

let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
wf.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);

// ------------------------------------------------------------------ Code node behaviour
const src = wf.nodes.find((x) => x.name === 'Format alert').parameters.jsCode;
let staticData = {};
const realNow = Date.now;
let clock = Date.parse('2026-10-04T09:02:00Z');   // 14:32 IST
Date.now = () => clock;
const alertFor = (json) => new Function('$json', '$getWorkflowStaticData', src)({ telegram_chat_id: '-1001', throttle_minutes: 10, ...json }, () => staticData).json;
const failure = (over = {}) => ({
  workflow: { id: '5', name: 'W1 - Website lead intake' },
  execution: { id: '77', url: 'https://host.example/workflow/5/executions/77', lastNodeExecuted: 'Create lead', error: { message: 'Request failed with status code 500' } },
  ...over,
});

console.log('Format alert');
let a = alertFor(failure());
assert.strictEqual(a.send, true);
assert.strictEqual(a.telegram_chat_id, '-1001');
assert.strictEqual(a.alert_text, [
  '<b>n8n workflow failed</b>',
  'Workflow: W1 - Website lead intake',
  'Step: Create lead',
  'Error: Request failed with status code 500',
  'Time: 2026-10-04 14:32 IST',
  'Execution: https://host.example/workflow/5/executions/77',
].join('\n'));
ok('message has workflow, step, error, IST time and execution link');

staticData = {};
a = alertFor(failure({ execution: { ...failure().execution, error: { message: 'Bad <b>data</b> & more; Phone +91 98765 43210 failed; Authorization: Bearer abc123XYZ' } } }));
assert(!a.alert_text.includes('98765') && !a.alert_text.includes('abc123XYZ'), a.alert_text);
assert(a.alert_text.includes('[number]') && a.alert_text.includes('[hidden]'));
assert(a.alert_text.includes('Bad &lt;b&gt;data&lt;/b&gt; &amp; more'));
for (const leaky of ['Authorization: Bearer abc123XYZ', 'api_key=sk-live-999', 'token: 123456:ABCdef', 'password=hunter2', 'Bearer abc123XYZ']) {
  const t = alertFor(failure({ execution: { ...failure().execution, error: { message: `call failed ${leaky} end` } } })).alert_text;
  assert(!/abc123XYZ|sk-live-999|ABCdef|hunter2/.test(t), `leaked: ${leaky} -> ${t}`);
}
ok('phone numbers and tokens (Bearer / api_key / token / password) are masked; <, >, & are escaped for Telegram HTML mode');

staticData = {};
a = alertFor(failure({ execution: { ...failure().execution, error: { message: 'x'.repeat(5000) } } }));
assert(a.alert_text.length < 1000);
ok('very long error is trimmed (Telegram limit is 4096)');

staticData = {};
for (const odd of [{}, { execution: {} }, { workflow: {}, execution: { error: {} } }, { workflow: { name: 'W2' }, execution: { error: { node: { name: 'Webhook' }, message: 'x' } } }]) {
  assert.doesNotThrow(() => alertFor(odd));
}
assert.match(alertFor({}).alert_text, /Workflow: unknown workflow\nStep: unknown step\nError: no message/);
assert.match(alertFor({ workflow: { name: 'W2' }, execution: { error: { node: { name: 'Webhook' }, message: 'x' } } }).alert_text, /Step: Webhook/);
ok('missing fields never crash; falls back to error.node.name or "unknown"');

console.log('throttle');
staticData = {}; clock = Date.parse('2026-10-04T09:02:00Z');
assert.strictEqual(alertFor(failure()).send, true);
clock += 60e3;
assert.strictEqual(alertFor(failure()).send, false);
clock += 60e3;
assert.strictEqual(alertFor(failure()).send, false);
ok('same failure within 10 minutes is held back');
const other = failure({ execution: { ...failure().execution, lastNodeExecuted: 'Write Run_Log' } });
assert.strictEqual(alertFor(other).send, true);
assert.strictEqual(alertFor(failure({ workflow: { name: 'W4 - Booking sync' } })).send, true);
ok('a different step, or a different workflow, still alerts straight away');
clock += 11 * 60e3;
a = alertFor(failure());
assert.strictEqual(a.send, true);
assert(a.alert_text.includes('(2 similar alerts held back since the last one)'), a.alert_text);
assert.strictEqual(alertFor(failure()).send, false);
ok('after the window it alerts again and says how many were held back (2); then throttles again');

staticData = {}; clock = Date.parse('2026-10-04T09:02:00Z');
for (let i = 0; i < 80; i++) { alertFor(failure({ workflow: { name: `W${i}` } })); clock += 1000; }
assert(Object.keys(staticData.recent).length <= 50);
clock += 25 * 3600e3;
alertFor(failure());
assert.strictEqual(Object.keys(staticData.recent).length, 1);
ok('memory stays small: max 50 entries, entries older than 24h are dropped');

Date.now = realNow;
console.log(`\nALL ${n} CHECK GROUPS PASSED`);
