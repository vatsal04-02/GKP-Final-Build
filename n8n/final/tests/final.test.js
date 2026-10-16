// Checks on the SELECTED workflow files themselves (n8n/final/workflows) and on the tools that produced / audit them. No network, no n8n needed.
// Run: node n8n/final/tests/final.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitize } = require('../tools/sanitize-export');
const { audit } = require('../tools/audit-credentials');
const { propose } = require('../tools/propose-fixes');

const W = path.join(__dirname, '..', 'workflows');
const AUTH = path.join(W, 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
const PROP = path.join(W, 'proposed', 'FlowHQ_final_proposed_safe-ai-gate_w1-race-guard.json');
const read = (f) => fs.readFileSync(f, 'utf8');
const auth = JSON.parse(read(AUTH));
const tests = []; const test = (n, f) => tests.push([n, f]);

test('the authoritative export is valid, inactive, has no instance id and every connection points at a node that exists', () => {
  assert.strictEqual(auth.id, 'sUaNZ0rqAG67HNih');
  assert.strictEqual(auth.name, 'FlowHQ Clinic Automation (production candidate)');
  assert.strictEqual(auth.active, false);
  assert(!(auth.meta && auth.meta.instanceId));
  assert.strictEqual(auth.nodes.length, 418);
  const names = new Set(auth.nodes.map((n) => n.name));
  assert.strictEqual(names.size, auth.nodes.length, 'node names are unique');
  for (const [from, v] of Object.entries(auth.connections)) { assert(names.has(from), from); for (const o of v.main || []) for (const c of o || []) assert(names.has(c.node), `${from} -> ${c.node}`); }
});

test('sanitizing it again changes nothing (idempotent): no private value is waiting to be removed', () => {
  assert.deepStrictEqual(sanitize(read(AUTH)).log, []);
});

test('no secret, token, personal phone number, e-mail address or tailnet host is stored in the selected files', () => {
  for (const f of [AUTH, PROP]) {
    const t = read(f);
    for (const [name, re] of [['bearer token', /Bearer\s+[A-Za-z0-9._-]{16,}/], ['Meta token', /EAA[A-Za-z0-9]{20,}/], ['sk- key', /sk-(or-)?[A-Za-z0-9-]{20,}/], ['Telegram token', /\d{8,10}:[A-Za-z0-9_-]{30,}/], ['long hex', /\b[0-9a-f]{32,}\b/i], ['private key', /BEGIN [A-Z ]*PRIVATE KEY/], ['e-mail', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i], ['tailnet host', /\.ts\.net/]]) assert(!re.test(t), `${path.basename(f)}: ${name}`);
    const digits = (t.match(/(?<![\w.-])\d{10,16}(?![\w.-])/g) || []).filter((d) => !/^(91)?(9000000\d{2,5}|98000\d{5}|9876543210)$/.test(d) && d !== '123456789012345');
    assert.deepStrictEqual(digits, [], `${path.basename(f)}: long digit runs`);
  }
});

test('configuration comes from the environment: no clinic slug and no Grist document id in the workflow; the leads table is LEADS (never "Enquiries" / "Leads")', () => {
  const cfgs = auth.nodes.filter((n) => /– Config$/.test(n.name) && n.parameters && n.parameters.assignments);
  const all = cfgs.flatMap((n) => n.parameters.assignments.assignments);
  const leads = all.filter((a) => a.name === 'leads_table');
  assert(leads.length >= 2 && leads.every((a) => a.value === 'LEADS'), 'leads_table is LEADS wherever it is set');
  const tables = new Set(); for (const m of read(AUTH).matchAll(/\/tables\/([A-Za-z_]+)\/records/g)) tables.add(m[1]);
  assert(tables.has('LEADS'), 'W1/W3/W5/W6 read and write LEADS');
  assert(!tables.has('Enquiries') && !tables.has('Leads'), `unexpected leads table names: ${[...tables].join(', ')}`);
  const reg = all.filter((a) => a.name === 'registry_doc_id');
  assert(reg.length >= 10 && reg.every((a) => /\$env\.FLOWHQ_REGISTRY_DOC_ID/.test(a.value)), 'the registry doc id is an $env expression everywhere');
  assert(!/"clinic_slug":\s*"[a-z0-9-]{3,}"/.test(read(AUTH)), 'no clinic slug literal');
});

test('credential audit: reports what each credential is used for, and the known shared-credential finding (documented in docs/CREDENTIAL_AUDIT.md)', () => {
  const a = audit(auth);
  const shared = a.credentials.filter((c) => c.shared).map((c) => c.credentialName).sort();
  assert.deepStrictEqual(shared, ['Header Auth account 2', 'OpenRouter API']);
  const or = a.credentials.find((c) => c.credentialName === 'OpenRouter API');
  assert.deepStrictEqual(Object.fromEntries(Object.entries(or.roles).map(([k, v]) => [k.split(' ')[0], v.length])), { 'webhook-auth': 1, grist: 9, 'ai-provider': 1 });
  const h2 = a.credentials.find((c) => c.credentialName === 'Header Auth account 2');
  assert.deepStrictEqual(h2.roles['ai-provider'], ['W9 – Ask Model']);
  assert.strictEqual(a.nodes, 120);
});

test('the proposed file is exactly what propose-fixes makes from the authoritative one: only W13 – Config changes, six W1 nodes are added, credentials and ids are identical', () => {
  const { wf } = propose(auth);
  assert.strictEqual(JSON.stringify(JSON.parse(read(PROP))), JSON.stringify(wf), 'the committed proposal is current');
  const before = new Map(auth.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = wf.nodes.filter((n) => before.has(n.name) && before.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
  assert.deepStrictEqual(changed, ['W13 – Config']);
  assert.strictEqual(wf.nodes.length, auth.nodes.length + 6);
  const cfg = wf.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.filter((a) => a.name === 'ai_external_enabled');
  assert.deepStrictEqual(cfg.map((a) => a.value), ["={{ $env.FLOWHQ_AI_EXTERNAL_ENABLED === 'true' }}"]);
  assert.strictEqual(wf.active, false);
  for (const n of auth.nodes) assert.strictEqual(JSON.stringify(wf.nodes.find((x) => x.name === n.name).credentials || null), JSON.stringify(n.credentials || null), n.name);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log(`  ok  ${n}`); } catch (e) { failed++; console.log(`  FAIL ${n}\n       ${String(e.message).split('\n')[0]}`); } }
console.log(`final workflow files: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
