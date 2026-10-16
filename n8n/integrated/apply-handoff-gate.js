// W13 Needs_Human gate fix on your workflow (the "ai updated workflow clinic" after apply-ai-context.js), nothing else:
//   node n8n/integrated/apply-handoff-gate.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Before: a ticked Conversations.Needs_Human skipped EVERY later patient message until staff unticked it.
// After:  it keeps the AI away from the message W13 handed off (and anything older); a patient message written AFTER that
//         hand-off is processed again, through every other gate, and can be handed off again (Needs_Human set again, new reason).
//         Needs_Human ticked by hand (no hand-off message from W13) still keeps the AI silent. Needs_Human is never cleared by W13.
//
// The shared decision module (n8n/snippets/ai-receptionist.js) is pasted in 4 W13 Code nodes; the same 4 text edits are applied to
// each (only W13 – Build Context runs the changed functions), then the result is checked against the W13 build of commit 8be1676
// (pinned fingerprints: later W13 builds move on, this one-time patch does not). Every node is fingerprinted first; anything
// unexpected = nothing written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'ai-updated-workflow-clinic.handoff-gate.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-handoff-gate.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fail = (m) => { console.error(`apply-handoff-gate: ${m}\nNothing was written.`); process.exit(1); };

const FINGERPRINTS = {   // the W13 code in your workflow (= the W13 build of commit 1eb6b84)
  'W13 – Build Context': '32b4afc964b8b4ae',
  'W13 – Plan': '3033bba4e84d4294',
  'W13 – Plan Ready': '088f7b7c7e53cdc1',
  'W13 – Record Sends': '50f500992df6b6c8',
};
const RESULTS = {   // the same 4 nodes after the edits (= the W13 build of commit 8be1676)
  'W13 – Build Context': '2aeef88590ada56c',
  'W13 – Plan': 'e37398352961807e',
  'W13 – Plan Ready': 'be94a1e0dcdc3c2e',
  'W13 – Record Sends': 'bd781a8125518c60',
};
const EDITS = [
  [`  const aiRepliesLastHour = others.filter((r) => r.fields.Direction === 'Out' && /^W13/.test(String(r.fields.Sent_By || '')) && (Number(r.fields.Created_At) || 0) >= nowSec - 3600).length;
`, `  const aiRepliesLastHour = others.filter((r) => r.fields.Direction === 'Out' && /^W13/.test(String(r.fields.Sent_By || '')) && (Number(r.fields.Created_At) || 0) >= nowSec - 3600).length;
  // The hand-off a ticked Conversations.Needs_Human waits on = the newest patient message W13 itself marked Needs_Human (handed
  // off or failed). It keeps the AI away from that message and anything older; a patient message written AFTER it is answered
  // again (and can be handed off again). No such message (ticked by hand, or older than the last 40) = the AI stays silent.
  const at = (r) => Number(r.fields.Created_At) || 0;
  const handoffMsg = others.filter((r) => r.fields.Direction !== 'Out' && r.fields.Needs_Human === true).sort((a, b) => at(b) - at(a) || b.id - a.id)[0] || null;
  const afterHandoff = !dry && !!msg && !!handoffMsg && !later(handoffMsg);
`],
  [`    needs_human: cf.Needs_Human === true,
    answered_after: answeredAfter,`, `    needs_human: cf.Needs_Human === true,
    after_handoff: afterHandoff,
    answered_after: answeredAfter,`],
  [`  if (c.needs_human) return { route: 'skip', reason: 'this conversation is waiting for a person (untick Conversations > Needs_Human to let the AI answer again)' };`,
    `  if (c.needs_human && !c.after_handoff) return { route: 'skip', reason: 'this conversation is waiting for a person and the patient has not written since (untick Conversations > Needs_Human to let the AI answer again)' };`],
  [`    max_per_hour: Number(cfg.max_ai_replies_per_hour) || 6,
  });
  return { x, gate };`, `    max_per_hour: Number(cfg.max_ai_replies_per_hour) || 6,
  });
  if (gate.route === 'ai' && cf.Needs_Human === true && afterHandoff) notes.push('new patient message after a hand-off: handled by the AI; Conversations > Needs_Human stays ticked until staff untick it');
  return { x, gate };`],
];

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
for (const [name, want] of Object.entries(FINGERPRINTS)) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) fail(`node "${name}" is missing`);
  const got = sha(n.parameters.jsCode);
  if (got !== want) fail(`"${name}" is not the expected version (fingerprint ${got}, expected ${want}): it was edited in n8n. Re-export and re-check.`);
  let code = n.parameters.jsCode;
  for (const [from, to] of EDITS) {
    const count = code.split(from).length - 1;
    if (count !== 1) fail(`${name}: the text to change was found ${count} times (expected once):\n${from}`);
    code = code.replace(from, () => to);
  }
  if (sha(code) !== RESULTS[name]) fail(`${name}: the result is not the W13 build of commit 8be1676 (fingerprint ${sha(code)})`);
  n.parameters.jsCode = code;
}
wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes, active = false`);
console.log(`  - ${Object.keys(FINGERPRINTS).join(', ')}: Needs_Human gate (4 text edits each, identical to the W13 build of commit 8be1676)`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: every value is kept exactly as in your file)' : report.join('; ') || 'none needed'}`);
