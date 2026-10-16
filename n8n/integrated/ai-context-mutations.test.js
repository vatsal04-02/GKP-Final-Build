// Mutation tests for apply-ai-context.js: each new rule is broken once in a copy of the patched workflow, and the full system
// test (system.test.js) must then FAIL. A mutation it does not notice would mean that rule is not really tested.
// Run: node n8n/integrated/ai-context-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const FILE = process.env.AI_CTX_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json');
const BASE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const node = (w, n) => w.nodes.find((x) => x.name === n);
const code = (w, n, from, to) => { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
const mutations = {
  'W3: next best action ignored (nothing held)': (w) => code(w, 'W3 – Find due', '.filter((d) => d.nba.allowed)', '.filter(() => true)'),
  'W3: hot / warm / cold order ignored': (w) => code(w, 'W3 – Find due', 'a.x.rank - b.x.rank || ', ''),
  'W3: failed AI hand-off no longer escalated (safety net broken)': (w) => code(w, 'W3 – Find due', "if (x.needs_human) return act('human_handoff', true", "if (x.needs_human) return act('human_handoff', false"),
  'W3: staff brief not used in the message': (w) => code(w, 'W3 – Build Message', 'const message_text = item.staff_text ||', 'const message_text ='),
  'W3: template enquiry back to the bare summary': (w) => code(w, 'W3 – Build Message', 'enquiry: item.staff_brief || ', 'enquiry: '),
  'W4: no rebook signal on cancellation': (w) => code(w, 'W4 – Plan appointment', 'byUid.lead > 0 ?', 'false ?'),
  'W5: pending-request hold off': (w) => code(w, 'W5 – Find due', 'if (!nba.allowed) continue;', ''),
  'W5: the 2 h reminder held too': (w) => code(w, 'W5 – Find due', "if (o.kind === 'r24' && x.needs_human", 'if (x.needs_human'),
  'W5: Conversations error stops W5': (w) => { delete node(w, 'W5 – Conversations').onError; },
  'W6: rebook ignores the next best action': (w) => code(w, 'W6 – Plan follow-ups', "if (!nbaFor(id, 'rebook', { since: a.fields.Start }).allowed) continue;", ''),
  'W6: day-2 ignores the next best action': (w) => code(w, 'W6 – Plan follow-ups', " && nbaFor(String(r.id), 'followup').allowed", ''),
  'W6: hot-first order ignored': (w) => code(w, 'W6 – Plan follow-ups', 'rank(a) - rank(b) || ', ''),
  'module: Assigned_To no longer means "staff own it"': (w) => { for (const n of ['W3 – Find due', 'W6 – Plan follow-ups']) code(w, n, 'c.assigned_to = lcText(f.Assigned_To, 60)', "c.assigned_to = ''"); },
  'module: a broken Next_Action_At is trusted': (w) => { for (const n of ['W3 – Find due', 'W5 – Find due', 'W6 – Plan follow-ups']) code(w, n, "const n = typeof v === 'number' ? v : NaN;", 'const n = Number(v) || Date.now() / 1000 + 86400;'); },
  'a W5 reminder bypasses W12 (calls another workflow)': (w) => { node(w, "W5 – Call 'W12 - WhatsApp send'").parameters.workflowId.value = 'SOMEOTHERID00001'; },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-mut-'));
let missed = 0;
for (const [name, mutate] of Object.entries(mutations)) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'system.test.js')], { encoding: 'utf8', env: { ...process.env, AI_CTX_FILE: f } });
  const first = (r.stdout.split('\n').find((l) => l.startsWith('FAIL') && !/X\.4 /.test(l)) || '').replace(/\s{2,}/g, '  ').slice(0, 110);
  if (r.status !== 0) console.log(`  caught  ${name}   <- ${first}`); else { console.log(`  MISSED  ${name}`); missed++; }
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nAI context: all ${Object.keys(mutations).length} mutations caught by the system test`);
