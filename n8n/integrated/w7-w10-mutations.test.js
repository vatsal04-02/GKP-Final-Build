// Mutation tests for W7-W10: each safety rule is broken once in a copy of the workflow, and the W7-W10 end-to-end test
// (w7-w10.test.js) must then FAIL. A mutation it does not notice would mean that rule is not really tested.
// Run: node n8n/integrated/w7-w10-mutations.test.js       (W7W10_FILE = another file)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const FILE = process.env.W7W10_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json');
const BASE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const node = (w, n) => w.nodes.find((x) => x.name === n);
const code = (w, n, from, to) => { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
const skip = (w, from, to) => { w.connections[from].main[0] = [{ node: to, type: 'main', index: 0 }]; };   // bypass the node(s) in between
const W13_LIB = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const mutations = {
  'W7: no claim before the send (Outcome_Sent never set)': (w) => skip(w, 'W7 – Build Message', 'W7 – Restore'),
  'W7: Opted_Out ignored': (w) => code(w, 'W7 – Decide send', 'opted_out: $json.opted_out,', 'opted_out: false,'),
  'W7: Automation_Paused ignored (sent as transactional)': (w) => code(w, 'W7 – Decide send', "kind: 'marketing',", "kind: 'transactional',"),
  'W7: quiet hours ignored by the section': (w) => code(w, 'W7 – Decide send', "if (inQuietHours(i.now_ms)) return skip('quiet hours');", ''),
  'W7: TEST_MODE ignored': (w) => code(w, 'W7 – Decide send', 'test_mode: $json.test_mode,', "test_mode: 'false',"),
  'W7: a patient without a valid phone messaged in TEST_MODE': (w) => code(w, 'W7 – Decide send', 'const decision = patient_phone', 'const decision = true'),
  'W7: 7-day gap between check-ins ignored': (w) => code(w, 'W7 – Plan', 'now - x.fields.Outcome_Sent < gap', 'false'),
  'W7: per-clinic switch ignored': (w) => code(w, 'W7 – Plan', 'if (!cmOn(c.settings.outcome_checkin)) return;', ''),
  'W8: no claim before the send (Review_Sent never set)': (w) => skip(w, 'W8 – Build Message', 'W8 – Restore'),
  'W8: a review link is made up when Settings has none': (w) => code(w, 'W8 – Plan', 'c.settings.review_link)', "c.settings.review_link || 'https://g.page/r/made-up/review')"),
  'W8: 90-day limit per patient ignored': (w) => code(w, 'W8 – Plan', 'now - x.fields.Review_Sent < gap', 'false'),
  'W8: review gating (unhappy / hand-off patients not asked)': (w) => code(w, 'W8 – Plan', 'if (!/^[1-9]\\d*$/.test(lead) || !leads[lead]) continue;', 'if (!/^[1-9]\\d*$/.test(lead) || !leads[lead] || (convs[lead] && convs[lead].needs_human)) continue;'),
  'W8: Opted_Out ignored': (w) => code(w, 'W8 – Decide send', 'opted_out: $json.opted_out,', 'opted_out: false,'),
  'W9: AI lines not checked against the numbers': (w) => code(w, 'W9 – Report', 'cmCheckAiReport($json, cmAllowedNumbers(x.metrics))', 'cmCheckAiReport($json, { has: () => true })'),
  'W9: completed visits counted outside the week': (w) => code(w, 'W9 – Metrics', "completed: count(week, (a) => a.Status === 'Completed')", "completed: count(appts, (a) => a.Status === 'Completed')"),
  'W9: new leads counted outside the week': (w) => code(w, 'W9 – Metrics', 'new: newLeads.length,', 'new: leads.length,'),
  'W9: owner copy sent again on a re-run': (w) => code(w, 'W9 – Owner message', 'flag_value: r.owner_sent ? 1 : null', 'flag_value: null'),
  'W10: no claim before the send (row stays ticked)': (w) => skip(w, 'W10 – Send?', 'W10 – Restore'),
  'W10: Opted_Out ignored': (w) => code(w, 'W10 – Check', 'if (lf.Opted_Out === true)', 'if (false)'),
  'W10: Needs_Human / Assigned_To cleared after a staff reply': (w) => code(w, 'W10 – Record', 'conversation_patch: ok ? { Unread: 0 } : null', "conversation_patch: ok ? { Unread: 0, Needs_Human: false, Assigned_To: '' } : null"),
  'W10: sends without W12 (calls another workflow)': (w) => { node(w, "W10 – Call 'W12 - WhatsApp send'").parameters.workflowId.value = 'SOMEOTHERID00001'; },
  'W13: staff gate off (AI answers over a staff member)': (w) => code(w, 'W13 – Build Context', 'if (c.staff_active) return', 'if (false) return'),
  // "worse" has two independent safety layers (forced medical flag + human-only intent); removing one alone changes nothing
  'W13: "worse after the visit" left to the AI (both layers removed)': (w) => { for (const n of W13_LIB) { code(w, n, "'medical_question', 'outcome_same', 'outcome_worse'];", "'medical_question', 'outcome_same'];"); code(w, n, "if (d.intent === 'outcome_worse') {", 'if (false) {'); } },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7w10-mut-'));
let missed = 0;
for (const [name, mutate] of Object.entries(mutations)) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'w7-w10.test.js')], { encoding: 'utf8', env: { ...process.env, W7W10_FILE: f } });
  const first = (r.stdout.split('\n').find((l) => l.startsWith('FAIL') && !/X\.4 /.test(l)) || '').replace(/\s{2,}/g, '  ').slice(0, 110);
  if (r.status !== 0) console.log(`  caught  ${name}   <- ${first}`); else { console.log(`  MISSED  ${name}`); missed++; }
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nW7-W10: all ${Object.keys(mutations).length} mutations caught by the W7-W10 test`);
