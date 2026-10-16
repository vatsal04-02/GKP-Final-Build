// SECTIONS W7, W8, W9 and W10 on your workflow (the "ai updated workflow clinic" after apply-handoff-gate.js):
//   node n8n/integrated/apply-w7-w10.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Adds (nothing removed, no existing connection changed):
//   W7 – outcome check-in, W8 – review request, W9 – weekly report, W10 – staff reply from the Grist inbox: each with its own trigger,
//   Config, clinic lookup (Agency Registry), reads, deterministic guard, W12 call, writes and Run_Log (n8n/w7-w10/sections.js).
// Changes in existing nodes (code / text only, each fingerprinted first):
//   - W12 – Prepare request, W12 – Read reply: the pasted wa-send.js block -> the current n8n/snippets/wa-send.js (3 new templates
//     outcome_check / review_request / weekly_owner_report; a W10 row that already exists is not written to the inbox twice).
//   - W13 – Build Context, Plan, Plan Ready, Record Sends: the pasted ai-receptionist.js block -> the current one (outcome answers
//     better / same / worse; the AI stays out of a conversation a staff member wrote in during the last 24 h).
//   - Sticky notes Section W7 / W8 / W9 / W10 (the RESERVED text -> what the section does) and Section 00 (the 4 new triggers).
// Every value the new sections need that already exists in your workflow is copied FROM it: Grist base URL and registry doc id
// (W6 – Config), the Grist credential (W6 – Clinics), the OpenRouter credential (W13 – Ask Model) and model (W13 – Config).
// Anything unexpected (a node edited in n8n, a section already built) = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');
const { buildSections, STICKIES, STICKY_HEIGHT } = require('../w7-w10/sections');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-w7-w10.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fail = (m) => { console.error(`apply-w7-w10: ${m}\nNothing was written.`); process.exit(1); };
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');

const FINGERPRINTS = {   // your workflow after apply-handoff-gate.js (commit 8be1676), code / sticky text
  'W13 – Build Context': '2aeef88590ada56c',
  'W13 – Plan': 'e37398352961807e',
  'W13 – Plan Ready': 'be94a1e0dcdc3c2e',
  'W13 – Record Sends': 'bd781a8125518c60',
  'W12 – Prepare request': '62bc2f1c40a25ad8',
  'W12 – Read reply': '2395037a2489fbd7',
  'Section W7': '91644f8bd86b344e',
  'Section W8': 'ee2b2a0da1b7aef4',
  'Section W9': 'c15cf5f72ac9cca7',
  'Section W10': 'd303f54cd84c26a6',
  'Section 00': '0366a0a6c4656e30',
};
const OLD_WA_BLOCK = '55f9a9d1dc57874f';   // the wa-send.js block pasted in W12 (const WA_TEMPLATES .. end of waInboxRow)
const OLD_AI_BLOCK = '1a2a7ae22d6bbf72';   // the ai-receptionist.js block pasted in W13 (const AI_INTENTS .. before "const h = {")

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const node = (name) => byName[name] || fail(`node "${name}" is missing`);
for (const [name, want] of Object.entries(FINGERPRINTS)) {
  const n = node(name);
  const got = sha(n.type === 'n8n-nodes-base.stickyNote' ? n.parameters.content : n.parameters.jsCode);
  if (got !== want) fail(`"${name}" is not the expected version (fingerprint ${got}, expected ${want}): it was edited in n8n. Re-export and re-check.`);
}
const taken = wf.nodes.filter((n) => /^W(7|8|9|10) – /.test(n.name)).map((n) => n.name);
if (taken.length) fail(`the workflow already has W7-W10 nodes (${taken.join(', ')})`);

// ---------------------------------------------------------------- 1. W12: the wa-send.js block
const WA = snip('wa-send.js');
const waBlock = (code) => { const s = code.indexOf('const WA_TEMPLATES'); const e = code.indexOf('\n}\n', code.indexOf('function waInboxRow', s)) + 3; return [s, e]; };
const [ws, we] = waBlock(WA);
const NEW_WA = WA.slice(ws, we);
for (const name of ['W12 – Prepare request', 'W12 – Read reply']) {
  const n = node(name);
  const [s, e] = waBlock(n.parameters.jsCode);
  if (s < 0 || sha(n.parameters.jsCode.slice(s, e)) !== OLD_WA_BLOCK) fail(`${name}: the pasted wa-send.js block is not the expected version`);
  n.parameters.jsCode = n.parameters.jsCode.slice(0, s) + NEW_WA + n.parameters.jsCode.slice(e);
}

// ---------------------------------------------------------------- 2. W13: the ai-receptionist.js block
const AI = snip('ai-receptionist.js');
const NEW_AI = AI.slice(AI.indexOf('const AI_INTENTS'), AI.indexOf('if (typeof module'));
for (const name of ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends']) {
  const n = node(name);
  const code = n.parameters.jsCode;
  const s = code.indexOf('const AI_INTENTS');
  const e = code.indexOf('\nconst h = { normalizeIndianPhone', s);
  if (s < 0 || e < 0 || code.indexOf('const AI_INTENTS', s + 1) >= 0 || sha(code.slice(s, e)) !== OLD_AI_BLOCK) fail(`${name}: the pasted ai-receptionist.js block is not the expected version`);
  n.parameters.jsCode = code.slice(0, s) + NEW_AI + code.slice(e);
}

// ---------------------------------------------------------------- 3. the new sections, from YOUR values
const assignment = (nodeName, key) => {
  const a = (node(nodeName).parameters.assignments.assignments || []).find((x) => x.name === key);
  if (!a || a.value === undefined || a.value === '') fail(`${nodeName} > ${key} is missing`);
  return a.value;
};
const credentialOf = (nodeName) => {
  const c = node(nodeName).credentials;
  if (!c || !c.httpHeaderAuth || !c.httpHeaderAuth.id) fail(`${nodeName} has no credential`);
  return c;
};
const built = buildSections({
  gristBaseUrl: assignment('W6 – Config', 'grist_base_url'),
  registryDocId: assignment('W6 – Config', 'registry_doc_id'),
  gristCredentials: credentialOf('W6 – Clinics'),
  openrouterCredentials: credentialOf('W13 – Ask Model'),
  model: assignment('W13 – Config', 'openrouter_model'),
});
for (const n of built.nodes) if (byName[n.name]) fail(`name clash: ${n.name}`);
wf.nodes.push(...built.nodes);
for (const [from, c] of Object.entries(built.connections)) {
  if (wf.connections[from]) fail(`connections already exist for ${from}`);
  wf.connections[from] = c;
}

// ---------------------------------------------------------------- 4. sticky notes
for (const sec of ['W7', 'W8', 'W9', 'W10']) {
  const n = node(`Section ${sec}`);
  n.parameters.content = STICKIES[sec];
  n.parameters.height = STICKY_HEIGHT;
  n.parameters.width = built.widths[sec];
}
const s00 = node('Section 00');
const EDITS_00 = [
  ['- **W6 – Daily 10:00** — cron 0 10 * * * -> SECTION W6\n', `- **W6 – Daily 10:00** — cron 0 10 * * * -> SECTION W6
- **W7 – Every hour** — cron 20 * * * * -> SECTION W7 (outcome check-in)
- **W8 – Every hour** — cron 35 * * * * -> SECTION W8 (review request)
- **W9 – Monday 09:00** — cron 0 9 * * 1 -> SECTION W9 (weekly report)
- **W10 – Every minute** — every minute -> SECTION W10 (staff reply from the Grist inbox)
`],
  ['(W3 / W5 / W6 senders)', '(W3 / W5 / W6 / W7 / W8 / W9 / W10 senders)'],
  ['Save this workflow before any test (sends call the SAVED version).', 'Save this workflow before any test (sends call the SAVED version). W7-W10: add the Grist column Appointments.Outcome_Sent (DateTime) and get the templates outcome_check, review_request (and weekly_owner_report) approved first (n8n/whatsapp-templates.md).'],
];
for (const [from, to] of EDITS_00) {
  const count = s00.parameters.content.split(from).length - 1;
  if (count !== 1) fail(`Section 00: the text to change was found ${count} times (expected once): ${from}`);
  s00.parameters.content = s00.parameters.content.replace(from, () => to);
}
s00.parameters.height = 1200;

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${built.nodes.length} added), active = false`);
console.log('  - W12 – Prepare request, W12 – Read reply: wa-send.js block (3 templates, inbox_row_id)');
console.log('  - W13 – Build Context, Plan, Plan Ready, Record Sends: ai-receptionist.js block (outcome answers, staff gate)');
console.log('  - Section W7 / W8 / W9 / W10 / 00: sticky text');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: every value is kept exactly as in your file)' : report.join('; ') || 'none needed'}`);
