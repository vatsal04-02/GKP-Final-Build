#!/usr/bin/env node
// Runs the synthetic test suites (simulator with fake Grist / Meta / AI / SMTP: nothing leaves this computer) against one workflow file and sorts every failure into
// "known finding" (documented in docs/KNOWN_FINDINGS.md) or "UNEXPECTED". Exit code 1 only for an unexpected failure.
//
//   node n8n/final/run-tests.js [reference|authoritative|<path to an export>]     (default: both)
//
//   reference      n8n/production/clinic-autopilot-production.json   the earlier hardened build (FlowHQ credential names): everything passes
//   authoritative  n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json   the selected workflow: OpenRouter configured, credentials by role, W1 race guard (+ the openrouter suite)
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', 'production');
const T = (f) => path.join(ROOT, 'tests', `${f}.test.js`);
const SUITES = ['static', 'phone', 'ops', 'templates', 'w1', 'w2', 'w4', 'w12', 'callers', 'senders', 'consent', 'email', 'w14', 'website-w1', 'w13-visible-skip'];

const TARGETS = {
  reference: { file: path.join(ROOT, 'clinic-autopilot-production.json'), env: {}, known: [], extraSuites: ['mutation'] },
  authoritative: {
    file: path.join(__dirname, 'workflows', 'FlowHQ_Clinic_Automation_production_candidatefinal.json'),
    env: { SIM_CRED: JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' }) },
    extraSuites: ['openrouter'],
    known: [
      ['F-ID', /^identity: inactive, own id and name/],
      ['F-CRED-NAMES', /^credentials: only the production credentials/],
      ['F-CRED-NAMES', /SMTP credential "FlowHQ SMTP"/],
    ],
  },
};

function runTarget(name, t) {
  const file = TARGETS[name] ? t.file : path.resolve(name);
  console.log(`\n=== ${name}: ${path.relative(process.cwd(), file)}`);
  let unexpected = 0; let pass = 0; let known = 0;
  for (const s of [...SUITES, ...(t.extraSuites || [])]) {
    const r = cp.spawnSync(process.execPath, [T(s)], { env: { ...process.env, ...t.env, PROD_FILE: file, STOP_ON_FIRST: '0' }, encoding: 'utf8', cwd: ROOT, timeout: 600000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const fails = [...out.matchAll(/^ {2}FAIL (.+)$/gm)].map((m) => m[1]);
    const ok = (out.match(/^ {2}ok /gm) || []).length || (Number((out.match(/(\d+)\/\d+ mutants killed/) || [])[1]) || 0);
    const classified = fails.map((f) => ({ f, id: (t.known.find(([, re]) => re.test(f)) || [])[0] }));
    const bad = classified.filter((c) => !c.id);
    const crashed = r.status !== 0 && !fails.length;
    pass += ok; known += classified.length - bad.length; unexpected += bad.length + (crashed ? 1 : 0);
    console.log(`  ${(bad.length || crashed) ? 'FAIL ' : 'ok   '} ${s.padEnd(18)} ${ok} passed${classified.length ? `, ${classified.length - bad.length} known finding(s) ${[...new Set(classified.filter((c) => c.id).map((c) => c.id))].join(',')}` : ''}${bad.length ? `, ${bad.length} UNEXPECTED` : ''}${crashed ? ', suite crashed' : ''}`);
    for (const b of bad) console.log(`        UNEXPECTED: ${b.f}`);
    if (crashed) console.log(`        ${out.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
  }
  console.log(`  -> ${pass} checks passed, ${known} known finding(s), ${unexpected} unexpected failure(s)`);
  return unexpected;
}

// the selected files themselves (no workflow needed): shape, sanitization, configuration, credential audit, build from the as-supplied copy
{
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'tests', 'final.test.js')], { encoding: 'utf8' });
  process.stdout.write(`\n=== selected workflow files\n${r.stdout.split('\n').filter(Boolean).map((l) => `  ${l.trim()}`).join('\n')}\n`);
  if (r.status !== 0) { console.log('  FAIL'); process.exit(1); }
}
const arg = process.argv[2];
const names = arg ? [arg] : ['reference', 'authoritative'];
let bad = 0;
for (const n of names) bad += runTarget(n, TARGETS[n] || { file: path.resolve(n), env: {}, known: [] });
process.exit(bad ? 1 : 0);
