// Checks on the SELECTED workflow files themselves (n8n/final/workflows) and on the tools that produced / audit them. No network, no n8n needed.
// Run: node n8n/final/tests/final.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitize } = require('../tools/sanitize-export');
const { audit } = require('../tools/audit-credentials');
const { propose } = require('../tools/propose-fixes');
const { apply } = require('../tools/apply-openrouter-config');
const cp = require('child_process');

const W = path.join(__dirname, '..', 'workflows');
const AUTH = path.join(W, 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
const SUPPLIED = path.join(W, 'history', 'FlowHQ_Clinic_Automation_production_candidatefinal.as-supplied.sanitized.json');
const PROP = path.join(W, 'proposed', 'FlowHQ_final_proposed_w1-race-guard.json');
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
  for (const f of [AUTH, PROP, SUPPLIED]) {
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

test('credential audit: every credential serves exactly ONE role (website webhook, Grist, OpenRouter, WhatsApp, SMTP, Telegram)', () => {
  const a = audit(auth);
  assert.deepStrictEqual(a.credentials.filter((c) => c.shared), []);
  const by = Object.fromEntries(a.credentials.map((c) => [c.credentialName, Object.fromEntries(Object.entries(c.roles).map(([k, v]) => [k.split(' ')[0], v.length]))]));
  assert.deepStrictEqual(by, {
    'FlowHQ W1 Webhook Auth': { 'webhook-auth': 1 }, 'Header Auth account 2': { grist: 114 }, 'OpenRouter API': { 'ai-provider': 2 },
    'WhatsApp Cloud API': { 'whatsapp-meta': 1 }, 'SMTP account': { smtp: 1 }, 'Telegram account': { telegram: 1 },
  });
  assert.deepStrictEqual(a.credentials.find((c) => c.credentialName === 'OpenRouter API').roles['ai-provider'].sort(), ['W13 – Ask Model', 'W9 – Ask Model']);
  assert.strictEqual(a.nodes, 120);
});

test('the as-supplied copy still has the two shared credentials, and the authoritative file is exactly apply-openrouter-config applied to it', () => {
  const supplied = JSON.parse(read(SUPPLIED));
  assert.deepStrictEqual(audit(supplied).credentials.filter((c) => c.shared).map((c) => c.credentialName).sort(), ['Header Auth account 2', 'OpenRouter API']);
  const { wf, changed } = apply(supplied);
  assert.strictEqual(JSON.stringify(wf), JSON.stringify(auth), 'the committed authoritative file is current');
  assert.strictEqual(changed.length, 16);
  assert.strictEqual(supplied.nodes.length, auth.nodes.length);
  assert.strictEqual(JSON.stringify(supplied.connections), JSON.stringify(auth.connections), 'connections unchanged');
  assert.strictEqual(supplied.id, auth.id);
});

test('the proposed file is exactly the authoritative one plus the six W1 race-guard nodes: nothing else changes, credentials and ids are identical', () => {
  const { wf } = propose(auth);
  assert.strictEqual(JSON.stringify(JSON.parse(read(PROP))), JSON.stringify(wf), 'the committed proposal is current');
  const before = new Map(auth.nodes.map((n) => [n.name, JSON.stringify(n)]));
  const changed = wf.nodes.filter((n) => before.has(n.name) && before.get(n.name) !== JSON.stringify(n)).map((n) => n.name);
  assert.deepStrictEqual(changed, []);
  assert.strictEqual(wf.nodes.length, auth.nodes.length + 6);
  assert.strictEqual(wf.active, false);
  for (const n of auth.nodes) assert.strictEqual(JSON.stringify(wf.nodes.find((x) => x.name === n.name).credentials || null), JSON.stringify(n.credentials || null), n.name);
});

test('create-credentials --only creates just the website webhook credential (what an existing instance needs): needs only its own secret, never prints a value', () => {
  const script = path.join(__dirname, '..', '..', 'production', 'scripts', 'create-credentials.js');
  const secret = 'synthetic-webhook-secret-0123456789';
  const r = cp.spawnSync(process.execPath, [script, '--only', 'FhqCredW1Hook001', '--dry-run'], { env: { PATH: process.env.PATH, FLOWHQ_W1_WEBHOOK_SECRET: secret }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ready\s+FlowHQ W1 Webhook Auth \(httpHeaderAuth, id FhqCredW1Hook001\)/);
  assert(!/Grist|OpenRouter|AI Provider|WhatsApp/.test(r.stdout), 'only the webhook credential is listed');
  assert(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'no value is printed');
  const bad = cp.spawnSync(process.execPath, [script, '--only', 'nope', '--dry-run'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log(`  ok  ${n}`); } catch (e) { failed++; console.log(`  FAIL ${n}\n       ${String(e.message).split('\n')[0]}`); } }
console.log(`final workflow files: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
