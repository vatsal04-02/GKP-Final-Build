// TEMPORARY quiet-hours test switch (DISABLE_QUIET_HOURS_FOR_TEST) on your workflow after apply-w7-w10.js, or flip it later:
//   node n8n/integrated/apply-quiet-hours-switch.js --in <workflow.json> [--out <file>] [--value true|false] [--keep-private]
//
// Pastes n8n/snippets/quiet-hours-switch.js (one block, one value) into the 7 Code nodes that apply the 21:00-08:00 IST quiet
// hours in W12, W13, W7, W8, W9 and W10, right after their pasted send-guard helpers. Nothing else changes: no node added or removed,
// no connection, credential, webhook, Config value or other safety gate. The original quiet-hours code stays in every node.
//   --value true  (default): those 7 nodes skip ONLY the quiet-hours check (testing at night).
//   --value false          : the original rule, exactly as before.
// On a file that already has the switch, it only sets the value (all 7 at once). Each node is fingerprinted (with the switch taken
// out, it must be exactly the W7-W10 version); anything unexpected = nothing written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'ai-updated-workflow-clinic.quiet-hours-test.json'));
const VALUE = arg('--value', 'true');
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN || !['true', 'false'].includes(VALUE)) { console.error('usage: node apply-quiet-hours-switch.js --in <workflow.json> [--out file] [--value true|false] [--keep-private]'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fail = (m) => { console.error(`apply-quiet-hours-switch: ${m}\nNothing was written.`); process.exit(1); };

// The block, from the snippet: between its two marker lines (inclusive), with the value set.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'quiet-hours-switch.js'), 'utf8');
const START = '// ---- TEMPORARY TEST SWITCH: quiet hours';
const END = '// ---- end of the test switch ----\n';
const TEMPLATE = SRC.slice(SRC.indexOf(START), SRC.indexOf(END) + END.length);
const LINE = /const DISABLE_QUIET_HOURS_FOR_TEST = (true|false);/;
if (!LINE.test(TEMPLATE)) fail('the snippet has no DISABLE_QUIET_HOURS_FOR_TEST line');
const block = (v) => TEMPLATE.replace(LINE, `const DISABLE_QUIET_HOURS_FOR_TEST = ${v};`);

// The 7 nodes: fingerprint of the W7-W10 version, and the line the switch goes right before (after the pasted helpers).
// The two W13 nodes also accept their W13 prompt v2.1, v2.2 and split-opening-hours versions (apply-w13-prompt.js changes only the pasted ai-receptionist.js block).
const TARGETS = {
  'W12 – Prepare request': ['6ba9ea4adcb8c857', '  const cfg = {\n    send_mode'],
  'W13 – Build Context': [['c99da5e795fe4b67', '90713c448df91172', '236cc177ba9568e6', '6a45579c66705f76'], 'const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };'],
  'W13 – Plan Ready': [['806be7b2ca2ffc44', 'bfc908a99accf824', 'a8d0c7d049075e85', '19d86de6c2ce5ca3'], 'const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };'],
  'W7 – Decide send': ['d821944e8d49fb24', '// ---- this node ----'],
  'W8 – Decide send': ['d821944e8d49fb24', '// ---- this node ----'],
  'W9 – Owner message': ['41509458b5d0a377', '// ---- this node ----'],
  'W10 – Check': ['265136c6c62dfc58', '// ---- this node ----'],
};
// The switch block, whatever its value, if the node already has it.
const EXISTING = new RegExp(`${TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('= true;', '= (?:true|false);')}`, 'g');

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
let mode = null;
for (const [name, [want, anchor]] of Object.entries(TARGETS)) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) fail(`node "${name}" is missing`);
  const code = n.parameters.jsCode;
  const found = code.match(EXISTING) || [];
  if (found.length > 1) fail(`${name}: the switch is in it ${found.length} times`);
  const base = found.length ? code.replace(EXISTING, '') : code;
  const m = found.length ? 'set' : 'insert';
  if (mode && mode !== m) fail(`some of the 7 nodes have the switch and some do not (${name}: ${m})`);
  mode = m;
  if (![].concat(want).includes(sha(base))) fail(`"${name}" is not the expected version (fingerprint ${sha(base)}, expected ${want}): it was edited in n8n. Re-export and re-check.`);
  const at = base.split(anchor).length - 1;
  if (at !== 1) fail(`${name}: the insertion point was found ${at} times (expected once)`);
  n.parameters.jsCode = base.replace(anchor, () => `${block(VALUE)}${anchor}`);
}
const others = wf.nodes.filter((n) => !TARGETS[n.name] && typeof (n.parameters || {}).jsCode === 'string' && n.parameters.jsCode.includes('DISABLE_QUIET_HOURS_FOR_TEST'));
if (others.length) fail(`the switch is also in ${others.map((n) => n.name).join(', ')}`);

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes, active = false`);
console.log(`  DISABLE_QUIET_HOURS_FOR_TEST = ${VALUE} (${mode === 'insert' ? 'switch pasted into' : 'value set in'}: ${Object.keys(TARGETS).join(', ')})`);
console.log(`  ${VALUE === 'true' ? 'quiet hours (21:00-08:00 IST) are NOT applied by those 7 nodes; every other check unchanged' : 'quiet hours applied exactly as before'}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: every value is kept exactly as in your file)' : report.join('; ') || 'none needed'}`);
