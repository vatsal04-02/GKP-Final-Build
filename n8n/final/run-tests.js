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
    finalSuites: ['w12-pause', 'w15-followup'],   // n8n/final/tests: only the authoritative file carries the W12 pause check and W15
    known: [
      ['F-ID', /^identity: inactive, own id and name/],
      ['F-CRED-NAMES', /^credentials: only the production credentials/],
      ['F-CRED-NAMES', /SMTP credential "FlowHQ SMTP"/],
    ],
  },
  // Slice 4C: the authoritative candidate + reminder consent / message purposes (n8n/final/tools/patch-4c-consent.js). The harness gives every made-up phone a recorded
  // reminder-consent Yes (FOURC_CONSENT_YES) so the older suites still walk the reminder paths. What is expected to differ is listed here with its reason; the new
  // behaviour is proved by n8n/final/tests/4c-consent.test.js.
  fourc: {
    file: path.join(__dirname, 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4c.json'),
    env: { SIM_CRED: JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' }), FOURC_CONSENT_YES: '1' },
    extraSuites: ['openrouter'],
    // w12-pause is NOT run here: its first lines rebuild the pause patch from the file (patch(unpatch(file))), which 4C's change to "W12 – Prepare request" breaks by design;
    // its behaviour (a paused conversation blocks a W13 reply, after the consent step) is re-proved in 4c-consent.test.js.
    finalSuites: ['w15-followup', '4c-consent', '4c-w13-booking', 'diff-workflows'],
    known: [
      ['F-ID', /^identity: inactive, own id and name/],
      ['F-CRED-NAMES', /^credentials: only the production credentials/],
      ['F-CRED-NAMES', /SMTP credential "FlowHQ SMTP"/],
      // intended 4C behaviour: reminders are decided by reminder consent, not by the lead's Consent_WhatsApp
      ['F-4C-INTENT', /^no consent on file \(empty, false, or unknown lead\)/],
      ['F-4C-INTENT', /^consent: without consent W13 sends the patient only a free-text reply/],
      ['F-4C-INTENT', /^multi-clinic isolation in W12/],
      ['F-4C-INTENT', /^held, not claimed, ONE summary line: no consent, no lead, opted out, no booking link/],        // a patient with no lead and a reminder Yes IS reminded now
      ['F-4C-INTENT', /^the summary is written once a day \(send_hour run\), and a held patient is reminded as soon as consent is recorded/],   // consent is now Reminder_Consent
      // the w15-followup fixtures use https://cal.com/... as Settings > booking_link, which 4C refuses on purpose (a Cal.com link is "no link"); the same flows pass with a clinic-owned link in 4c-consent.test.js
      ['F-4C-CAL', /^(the day before: ONE followup_reminder template|a second run the same day sends nothing|inside the 24 h window the same words|TEST_MODE: the reminder goes to TEST_PHONE|a send W12 refuses is logged failed|Automation_Paused \(rule 5\)|several patients: each gets their own reminder)/],
      // the lineage-identity tests of the earlier patches assert patch(unpatch(file)) === file; 4C changes nodes those patches added or changed
      ['F-4C-LAYER', /patch\(unpatch\(file\)\)|committed workflow carries|exactly the 2 changed|only the two W12 template lists/],
    ],
  },
};

// Slice 4D: 4C + the AI retry / backoff that the workflow deployed on the production n8n (V4) already has (n8n/final/tools/patch-4d-ai-retry.js).
// Everything 4C expects still applies; 4d-ai-retry.test.js proves the delta (and runs the retry Code node itself).
TARGETS.fourd = { ...TARGETS.fourc, file: path.join(__dirname, 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4d.json'), finalSuites: [...TARGETS.fourc.finalSuites, '4d-ai-retry', '4d-integrity', '4d-allowlist-gate'] };

// Slice 4E: 4D + no quiet hours for staff alerts, hand-off alerts, booking confirmations and replies to a patient who wrote to us (n8n/final/tools/patch-4e-no-quiet-hours.js).
// Everything 4D expects still applies except the few quiet-hours expectations listed below; 4e-no-quiet-hours.test.js proves the delta.
TARGETS.foure = { ...TARGETS.fourd, file: path.join(__dirname, 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4e.json'), finalSuites: [...TARGETS.fourd.finalSuites, '4e-no-quiet-hours'], known: [
  ...TARGETS.fourd.known,
  // intended 4E behaviour: a staff alert / booking confirmation is no longer held at 22:30 (the earlier suites asserted the hold); proved the other way round in 4e-no-quiet-hours.test.js
  ['F-4E-INTENT', /^quiet hours: the lead is stored and answered, the alert is held and the log says why/],
  ['F-4E-INTENT', /^quiet hours: the booking is stored and answered, the confirmation is NOT sent and the log says why/],
  ['F-4E-INTENT', /^no alert reached the clinic at all \(WhatsApp held by quiet hours AND e-mail failed\)/],
  // the 4C build-identity test asserts the 4C candidate is exactly build(candidate); 4E (like 4D before it) changes nodes that patch touches
  ['F-4E-LAYER', /^build: 13 nodes added \(6 consent \+ 7 W13 booking\)/],
] };

function runTarget(name, t) {
  const file = TARGETS[name] ? t.file : path.resolve(name);
  console.log(`\n=== ${name}: ${path.relative(process.cwd(), file)}`);
  let unexpected = 0; let pass = 0; let known = 0;
  for (const s of [...SUITES, ...(t.extraSuites || []), ...(t.finalSuites || [])]) {
    const r = cp.spawnSync(process.execPath, [(t.finalSuites || []).includes(s) ? path.join(__dirname, 'tests', `${s}.test.js`) : T(s)], { env: { ...process.env, ...t.env, PROD_FILE: file, PAUSE_FILE: file, W15_FILE: file, FOURC_FILE: file, STOP_ON_FIRST: '0' }, encoding: 'utf8', cwd: ROOT, timeout: 600000 });
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
const names = arg ? [arg] : ['reference', 'authoritative', 'fourc', 'fourd', 'foure'];
let bad = 0;
for (const n of names) bad += runTarget(n, TARGETS[n] || { file: path.resolve(n), env: {}, known: [] });
process.exit(bad ? 1 : 0);
