// Mutation check of the production tests: break the production export on purpose in ~25 ways (each one a bug these tests are meant to catch) and require that
// at least one test file FAILS for every mutant. A surviving mutant = a test that proves nothing. The unmodified export is run first as the control.
// Run: node n8n/production/tests/mutation.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhq-mut-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'clinic-autopilot-production.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const node = (wf, name) => { const n = wf.nodes.find((x) => x.name === name); if (!n) throw new Error(`no node ${name}`); return n; };
const code = (wf, name, find, replace, times = 1) => { const n = node(wf, name); const c = n.parameters.jsCode; const k = c.split(find).length - 1; if (k < 1 || (times && k !== times)) throw new Error(`mutant anchor not found ${k}x in ${name}: ${find.slice(0, 60)}`); n.parameters.jsCode = c.split(find).join(replace); };
const cond = (wf, name, expr) => { node(wf, name).parameters.conditions.conditions[0].leftValue = expr; };
const set = (wf, name, key, value) => { node(wf, name).parameters.assignments.assignments.find((a) => a.name === key).value = value; };

const T = (...f) => f.map((x) => `${x}.test.js`);
const MUTANTS = [
  ['uncertain counts as sent (W12 Read reply)', (w) => code(w, 'W12 – Read reply', "    sent: send_status === 'accepted',   // PRODUCTION: only a message id from Meta counts as sent", "    sent: send_status === 'accepted' || send_status === 'uncertain',"), T('w12', 'callers', 'w1')],
  ['send ledger never reports a duplicate', (w) => cond(w, 'W12 – Stopped by ledger?', '={{ false }}'), T('w12', 'callers')],
  ['ledger claim lost: loser still sends', (w) => cond(w, 'W12 – Won claim?', '={{ true }}'), T('w12')],
  ['no callback data sent to Meta', (w) => code(w, 'W12 – Prepare request', 'else prep.meta_request.biz_opaque_callback_data =', 'else void 0 &&', 1), T('w12')],
  ['no idempotency key required', (w) => code(w, 'W12 – Prepare request', "if (!idem_key) { prep.call_meta = false;", "if (false) { prep.call_meta = false;"), T('w12')],
  ['consent gate bypassed', (w) => cond(w, 'W12 – Consent needed?', '={{ false }}'), T('consent', 'senders')],
  ['consent decide accepts anything', (w) => code(w, 'W12 – Consent decide', "if (lead.fields.Consent_WhatsApp !== true) return stop(", "if (false) return stop("), T('consent')],
  ['hello_world allowed', (w) => code(w, 'W12 – Prepare request', "cfg.allow_hello_world !== true", "false"), T('w12', 'callers')],
  ['quiet-hours test switch ON in W12', (w) => code(w, 'W12 – Prepare request', 'DISABLE_QUIET_HOURS_FOR_TEST = false;', 'DISABLE_QUIET_HOURS_FOR_TEST = true;'), T('w12', 'static')],
  ['external AI gate removed (W13)', (w) => code(w, 'W13 – Build Context', "$('W13 – Config').first().json.ai_external_enabled !== true", 'false'), T('w2')],
  ['patient identifiers not masked', (w) => code(w, 'W13 – Provider Request', 'fhqRedactRequest(bc.request,', '((r) => r)(bc.request,'), T('w2')],
  ['W9 sends metrics to the provider regardless of the gate', (w) => cond(w, 'W9 – External AI?', '={{ true }}'), T('senders')],
  ['W2 signature check lets everything through', (w) => cond(w, 'W2 – Signature OK?', '={{ true }}'), T('w2')],
  ['W2 delivery receipts may move a status backwards', (w) => code(w, 'W2 – Status Plan', "(mrank[ev.status] || 0) > (mrank[cur] === undefined ? -1 : mrank[cur])", 'true'), T('w2')],
  ['W4 verifies a re-serialised copy instead of the raw bytes', (w) => code(w, 'W4 – Verify & parse', 'hmacSha256HexBytes(secret, bytes)', 'hmacSha256Hex(secret, JSON.stringify($json.body))'), T('w4')],
  ['W4 replay window removed', (w) => code(w, 'W4 – Verify & parse', "if (Math.abs(Date.now() - createdMs) > maxAgeH * 3600 * 1000) return", "if (false) return"), T('w4')],
  ['W4 answers before the writes (onReceived)', (w) => { node(w, 'W4 – Webhook1').parameters.responseMode = 'onReceived'; }, T('static', 'w4')],
  ['W4 confirmation never sent', (w) => cond(w, 'W4 – Confirm?', '={{ false }}'), T('w4')],
  ['W1 answers before storing (onReceived)', (w) => { node(w, 'W1 – Webhook').parameters.responseMode = 'onReceived'; }, T('static', 'w1')],
  ['W1 consent not required', (w) => code(w, 'W1 – Prepare lead', "else if ($json.require_consent !== false && !consent_whatsapp) skip_reason = 'consent required';", ''), T('w1')],
  // W1's own guard and W12's refusal of decision.send=false are two layers: removing ONE is invisible by design (defence in depth), removing BOTH must be caught
  ['W1 staff alert: neither W1 nor W12 honours the send guard', (w) => { cond(w, 'W1 – Alert send?', '={{ true }}'); code(w, 'W12 – Prepare request', "if (!d || d.send !== true) return stop('not_requested'", "if (false) return stop('not_requested'"); }, T('w1')],
  ['W5 patient reminder: neither the caller nor W12 honours the send guard', (w) => { cond(w, 'W5 – Send?', '={{ true }}'); code(w, 'W5 – Decide send', 'return { json: { ...$json, decision, send: decision.send } };', "return { json: { ...$json, decision: { ...decision, send: true, to: $json.patient_phone || decision.to }, send: true } };"); }, T('callers')],
  ['W5 flag only set on "sent" (an uncertain send is retried)', (w) => cond(w, 'W5 – Sent?', '={{ $json.sent === true }}'), T('callers')],
  ['phone numbers forced back to +91', (w) => { for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code' && /function normalizeIndianPhone/.test(x.parameters.jsCode))) n.parameters.jsCode = n.parameters.jsCode.replace('let valid = /^[1-9]\\d{7,14}$/.test(digits);', 'let valid = /^91[6-9]\\d{9}$/.test(digits);'); }, T('phone', 'w1')],
  ['W12 config guard never stops the run', (w) => code(w, 'W12 – Config Guard', 'if (problems.length) throw new Error(', 'if (false) throw new Error('), T('static', 'w12')],
  ['a literal secret in a Config node', (w) => set(w, 'W4 – Config', 'cal_webhook_secret', 'a-real-looking-secret-0123456789abcdef'), T('static')],
  ['TLS verification switched off', (w) => { node(w, 'W13 – Ask Model').parameters.options.allowUnauthorizedCerts = true; }, T('static')],
  ['workflow exported ACTIVE', (w) => { w.active = true; }, T('static')],
  ['W14 reconcile marks nothing', (w) => code(w, 'W14 – Plan', "f.Status === 'sending' && age >= staleSec", 'false'), T('w14')],
  ['e-mail sent to patients without consent', (w) => code(w, 'W1 – Email plan', "if (j.consent_email !== true) patient_note = 'no e-mail consent';", "if (false) patient_note = 'no e-mail consent';"), T('email')],
];

const runTests = (file, env) => cp.spawnSync(process.execPath, [path.join(__dirname, file)], { env: { ...process.env, ...env, STOP_ON_FIRST: '1' }, encoding: 'utf8', timeout: 240000 });
console.log('control run (unmodified export):');
const files = [...new Set(MUTANTS.flatMap((m) => m[2]))];
let controlFailed = 0;
for (const f of files) { const r = runTests(f, {}); if (r.status !== 0) { controlFailed++; console.log(`  control FAIL ${f}\n${(r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join('\n')}`); } }
if (controlFailed) { console.log('the control run must pass first'); process.exit(1); }
console.log(`  ${files.length} test files pass on the unmodified export\n`);
let survived = 0;
MUTANTS.forEach(([name, mutate, tests], i) => {
  const wf = clone(base);
  mutate(wf);
  const file = path.join(TMP, `mutant-${i}.json`);
  fs.writeFileSync(file, JSON.stringify(wf));
  let killedBy = '';
  for (const t of tests) { const r = runTests(t, { PROD_FILE: file }); if (r.status !== 0) { killedBy = t; break; } }
  if (killedBy) console.log(`  KILLED   ${name}   (${killedBy})`); else { survived++; console.log(`  SURVIVED ${name}   (tests run: ${tests.join(', ')})`); }
});
console.log(`\nmutation check: ${MUTANTS.length - survived}/${MUTANTS.length} mutants killed${survived ? `, ${survived} SURVIVED` : ''}`);
process.exit(survived ? 1 : 0);
