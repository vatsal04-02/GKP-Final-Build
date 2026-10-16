// Before / after proof for apply-quiet-hours-switch.js:
//   node n8n/integrated/validate-quiet-hours-switch.js [--orig <before.json>] [--patched <after.json>] [--private]
// Defaults: the public ai-updated-workflow-clinic.w7-w10.json (before) and ai-updated-workflow-clinic.quiet-hours-test.json (after).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'ai-updated-workflow-clinic.quiet-hours-test.json'));
const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'quiet-hours-switch.js'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('// ---- TEMPORARY TEST SWITCH'), SRC.indexOf('// ---- end of the test switch ----\n') + '// ---- end of the test switch ----\n'.length);
const TARGETS = ['W12 – Prepare request', 'W13 – Build Context', 'W13 – Plan Ready', 'W7 – Decide send', 'W8 – Decide send', 'W9 – Owner message', 'W10 – Check'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
let value = null;
const group = (t, fn) => { try { const d = fn(); console.log(`PASS  ${t}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${t}\n      ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };

group('1. the patcher reproduces this file', () => {
  const v = /const DISABLE_QUIET_HOURS_FOR_TEST = (true|false);/.exec(B['W12 – Prepare request'].parameters.jsCode);
  must(v, 'no switch in W12 – Prepare request');
  value = v[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-'));
  const out = path.join(dir, 'o.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-quiet-hours-switch.js'), '--in', ORIG, '--out', out, '--value', value, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, `${r.stderr}`);
  return `DISABLE_QUIET_HOURS_FOR_TEST = ${value}`;
});
group('2. nodes: 0 added, 0 removed; exactly the 7 quiet-hours nodes changed, each only by the pasted switch (one value in all 7)', () => {
  must(same(Object.keys(A).sort(), Object.keys(B).sort()), 'node set differs');
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n]));
  must(same(changed.sort(), [...TARGETS].sort()), `changed: ${changed}`);
  const blk = BLOCK.replace(/= (true|false);/, `= ${value};`);
  for (const n of TARGETS) {
    const a = A[n].parameters.jsCode; const b = B[n].parameters.jsCode;
    must(b.split(blk).length === 2 && b.replace(blk, '') === a, `${n}: more than the switch block changed`);
    const x = JSON.parse(JSON.stringify(A[n])); const y = JSON.parse(JSON.stringify(B[n])); delete x.parameters.jsCode; delete y.parameters.jsCode;
    must(same(x, y), `${n}: more than its code changed`);
  }
  return `${Object.keys(A).length - TARGETS.length} of ${Object.keys(A).length} nodes byte-identical`;
});
group('3. the original quiet-hours logic is still in place (not deleted, not edited)', () => {
  for (const n of TARGETS) {
    const c = B[n].parameters.jsCode;
    must(c.includes("function inQuietHours(nowMs) {\n  if (!Number.isFinite(nowMs)) return true;           // no clock, no send\n  const hourIST = new Date(nowMs + 5.5 * 3600 * 1000).getUTCHours();\n  return hourIST >= 21 || hourIST < 8;\n}"), `${n}: inQuietHours() changed`);
    if (/function decideSend/.test(c)) must(c.includes("  if (inQuietHours(i.now_ms)) return skip('quiet hours');"), `${n}: decideSend quiet-hours step changed`);
    must(c.indexOf('// ---- TEMPORARY TEST SWITCH') > c.indexOf('function inQuietHours'), `${n}: the switch is not after the helpers`);
  }
  must(B['W12 – Prepare request'].parameters.jsCode.includes("if (h.inQuietHours(nowMs)) return stop('blocked', 'quiet hours (21:00-08:00 IST)');"), 'W12 quiet-hours step changed');
  must(B['W13 – Build Context'].parameters.jsCode.includes("if (!c.dry_run && c.night) return { route: 'defer', reason: 'quiet hours (21:00-08:00 IST): answered by the 08:05 run' };"), 'W13 night gate changed');
  return 'inQuietHours(), decideSend()\'s quiet-hours step, W12\'s quiet-hours block and W13\'s night gate are byte-identical; the switch only wraps inQuietHours';
});
group('4. connections: 0 added, 0 removed, 0 changed', () => { must(same(orig.connections, patched.connections), 'connections differ'); });
group('5. CREDENTIALS changed = 0', () => { for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), n); });
group('6. WEBHOOKS changed = 0', () => {
  const hooks = orig.nodes.filter((n) => /webhook|Trigger|respondToWebhook/i.test(n.type));
  for (const n of hooks) must(same(n, B[n.name]), n.name);
  return `${hooks.length} webhook / trigger / respond nodes identical`;
});
group('7. SECRETS / Config changed = 0; Meta, OpenRouter, Cal.com, W11 nodes identical', () => {
  let values = 0;
  for (const n of orig.nodes.filter((x) => x.type === 'n8n-nodes-base.set')) { values += n.parameters.assignments.assignments.length; must(same(n, B[n.name]), n.name); }
  for (const n of ['W12 – Meta send', 'W12 – Read reply', 'W12 – Test input', 'W13 – Ask Model', 'W9 – Ask Model', 'W4 – Verify & parse', 'W2 – Check Verify Token', 'W11 – Telegram alert']) must(same(A[n], B[n]), n);
  return `${values} Config values in ${orig.nodes.filter((x) => x.type === 'n8n-nodes-base.set').length} Set nodes identical`;
});
group('8. every other safety gate untouched: W3 / W4 / W5 / W6 nodes identical, W12 still the only sender', () => {
  for (const n of Object.keys(A).filter((x) => /^W[3-6] – /.test(x))) must(same(A[n], B[n]), n);
  const meta = patched.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta, ['W12 – Prepare request', 'W12 – Read reply']), `Meta URL in: ${meta}`);
  const code = B['W13 – Build Context'].parameters.jsCode;
  for (const g of ['if (c.failed)', 'AI_STOP_WORDS.test', 'if (c.opted_out)', 'if (c.paused)', 'if (c.needs_human && !c.after_handoff)', 'if (c.answered_after)', 'if (c.newer_inbound)', 'aiEmergencyIn(c.text)', 'if (c.staff_active)', 'c.ai_replies_last_hour >= c.max_per_hour']) must(code.includes(g), `W13 gate missing: ${g}`);
});
group('9. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'nodeGroups', 'versionId']) must(same(orig[k], patched[k]), k);
  must(patched.active === false, 'active');
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : `\nALL 9 CHECK GROUPS PASSED (${path.basename(PATCHED)}, DISABLE_QUIET_HOURS_FOR_TEST = ${value})`);
process.exit(failed ? 1 : 0);
