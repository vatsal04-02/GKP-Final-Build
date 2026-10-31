// node n8n/final/tests/diff-workflows.test.js: the read-only comparison tool (n8n/final/tools/diff-workflows.js).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { compare, load } = require('../tools/diff-workflows');

const dir = path.join(__dirname, '..', 'workflows');
const base = path.join(dir, 'FlowHQ_Clinic_Automation_production_candidatefinal.json');
const c4 = path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4c.json');
const A = load(base); const B = load(c4);
let n = 0; const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const { ADDED, CHANGED } = require('../tools/build-4c');

test('a file compared with itself is identical', () => assert.strictEqual(compare(A, A).identical, true));

test('candidate vs 4C candidate: exactly the 13 added nodes and the 15 changed ones, nothing else (and no credential name other than the booking one is new)', () => {
  const r = compare(A, B);
  assert.deepStrictEqual(r.onlyInDeployed, []);
  assert.deepStrictEqual(r.onlyInCandidate, [...ADDED].sort());
  assert.deepStrictEqual(r.changed.map((c) => c.name).sort(), [...CHANGED].sort());
  assert.deepStrictEqual(r.credentialNames.candidate.filter((x) => !r.credentialNames.deployed.includes(x)), ['FlowHQ Booking API']);
  assert(r.changed.filter((c) => c.name !== 'W13 – Config').every((c) => c.why.length === 1 && c.why[0] === 'code'), 'every changed node differs by code only (W13 – Config by one assignment)');
  assert(r.changed.every((c) => !c.code || (c.code.a === undefined && c.code.b === undefined)), 'code is not printed unless --code');
});

test('it refuses an export that is active or still holds a token-like value', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diffwf-'));
  const bad1 = path.join(tmp, 'a.json'); fs.writeFileSync(bad1, JSON.stringify({ ...A, active: true }));
  assert.throws(() => load(bad1), /active is true/);
  const bad2 = path.join(tmp, 'b.json'); fs.writeFileSync(bad2, JSON.stringify({ ...A, notes: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }));
  assert.throws(() => load(bad2), /looks like a secret/);
  const bad3 = path.join(tmp, 'c.json'); fs.writeFileSync(bad3, JSON.stringify({ hello: 1 }));
  assert.throws(() => load(bad3), /not an n8n workflow/);
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'diff-workflows.js'), bad1, base], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the tool reads only: the two files are unchanged afterwards', () => {
  const before = [fs.readFileSync(base), fs.readFileSync(c4)];
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'diff-workflows.js'), base, c4], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /DIFFERENT/);
  assert.deepStrictEqual([fs.readFileSync(base), fs.readFileSync(c4)].map((b, i) => b.equals(before[i])), [true, true]);
});

console.log(`diff-workflows: ${n} tests passed`);
