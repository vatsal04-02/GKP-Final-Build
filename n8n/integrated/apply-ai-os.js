// AI OS improvements A1-A6 applied to your live workflow "ai workflow clinic" (export), nothing else:
//   node n8n/integrated/apply-ai-os.js --in <export.json> [--out <file>] [--keep-private]
//
//   A1-A4 + A2  SECTION W13: the code of W13 – Start, Build Context, Plan, Plan Ready and Record Sends is replaced by the rebuilt
//               OpenRouter W13 (n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json, from n8n/snippets/ai-receptionist.js);
//               W13 – Config: min_confidence 0.7 -> 0.65, + confidence_auto 0.8, + confidence_write 0.85.
//   A5          W6 – Plan follow-ups: the day-2 follow-up skips Needs_Human, Lead_Stage cold, Last_Intent not_interested / opt_out,
//               Next_Action_At in the future, a patient message in the last 48 h. No-show rebook and Mark Lost are unchanged.
//   A6          W3: new node W3 – Conversations (Grist read, same credential as W3 – Leads, errors -> nothing skipped) between
//               W3 – Leads and W3 – Find due. Find due: hot -> warm -> cold, skips conversations a person owns (Automation_Paused,
//               Assigned_To); a lead the AI handed off is skipped through Escalated. Build Message: AI_Summary (or Enquiry) in the
//               existing staff message; the template is unchanged.
//
// Every node it edits is fingerprinted first: if your workflow changed since the audit export, it stops and changes nothing.
// The result is saved INACTIVE. Unless --keep-private, the Meta verify token, the Cal.com secret and the allowlisted phone
// number are replaced by placeholders (public copy). Credentials are referenced by id / name only, never copied or changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'ai-workflow-clinic.ai-os.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-ai-os.js --in <export.json> [--out file] [--keep-private]'); process.exit(1); }
const REPO = path.join(__dirname, '..', '..');
const DEMO_FILE = path.join(REPO, 'n8n/w13/W13-AI-Receptionist-Demo-OpenRouter.json');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const uuid = (seed) => {   // deterministic id for the new node
  const h = crypto.createHash('sha256').update(`ai-os:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (m) => { console.error(`apply-ai-os: ${m}\nNothing was written.`); process.exit(1); };

// ---------------------------------------------------------------- what is changed (and the exact state it is changed from)
const W13_CODE = ['W13 – Start', 'W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const FINGERPRINTS = {   // sha256 (first 16 hex) of the audited export ("ai workflow clinic", id EHOflaSmQ73eitjQ)
  'W13 – Start': '1d0fb80159edc94d',
  'W13 – Build Context': '807cfbae9568d1e0',
  'W13 – Plan': 'ac87183bcddcef5d',
  'W13 – Plan Ready': '3d2b7acbf298a772',
  'W13 – Record Sends': '6b91b0f0bbd343c4',
  'W3 – Find due': 'd9c776e589183b88',
  'W3 – Build Message': 'c11a363570d207e8',
  'W6 – Plan follow-ups': '97d1824a01573225',
  'W13 – Config': '827518011e48978d',   // its parameters (fingerprint re-computed after the private ids in this lineage were replaced by placeholders, see docs/SOURCES.md)
  'W3 – Leads': '560520e02034539d',     // its parameters (read only: the new node copies its credential)
};
const NEW_NODE = 'W3 – Conversations';

// Exact-text edits: [old, new]. Each old text must occur exactly once.
const W3_FIND_DUE = [
  [`  const clinics = $('W3 – Add settings').all();
  const out = [];

  $input.all().forEach((item, i) => {
    const base = clinics[i].json;
`, `  const clinics = $('W3 – Add settings').all();
  const leadsPerClinic = $('W3 – Leads').all();         // one LEADS answer per clinic (this node's input is W3 – Conversations)
  const STAGE = { hot: 0, warm: 1, cold: 2 };           // A6: hot leads first, then warm / not yet known, cold last
  const stage = (f) => { const s = STAGE[String(f.Lead_Stage || '')]; return typeof s === 'number' ? s : 1; };
  const out = [];

  $input.all().forEach((convs, i) => {
    const item = leadsPerClinic[i] || { json: {} };
    const base = clinics[i].json;
    // A6: a person already owns the conversation (Automation_Paused or Assigned_To): no escalation. A lead the AI handed off is
    // skipped through Escalated (W13 sets it only when its staff alert was delivered; a failed alert = W3 still escalates).
    // Conversations unreadable -> nothing is skipped, W3 escalates exactly as before.
    const owned = new Set();
    for (const r of (convs.json && convs.json.records) || []) {
      const c = r.fields || {};
      if (c.Lead && (c.Automation_Paused === true || String(c.Assigned_To || '').trim())) owned.add(String(c.Lead));
    }
`],
  [`        if (f.Status !== 'New' || f.Escalated || typeof f.Created_At !== 'number') return false;
`, `        if (f.Status !== 'New' || f.Escalated || typeof f.Created_At !== 'number') return false;
        if (owned.has(String(r.id))) return false;
`],
  [`      .sort((a, b) => a.fields.Created_At - b.fields.Created_At)
`, `      .sort((a, b) => stage(a.fields) - stage(b.fields) || a.fields.Created_At - b.fields.Created_At)
`],
  [`          escalated: !!f.Escalated,
`, `          escalated: !!f.Escalated,
          lead_stage: String(f.Lead_Stage || ''),
          ai_summary: String(f.AI_Summary || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
`],
];
const W3_BUILD_MESSAGE = [
  [`const message_text =
  \`New lead: \${name} (\${phone}) has submitted an enquiry for \${clinic}.\`;
`, `// A6: what the AI learned (AI_Summary) or the enquiry, and the lead stage, in the existing staff message
const about = item.ai_summary || item.enquiry || '';
const stage = item.lead_stage ? \` [\${item.lead_stage}]\` : '';
const message_text =
  \`New lead\${stage}: \${name} (\${phone}) has submitted an enquiry for \${clinic}.\${about ? \` \${about}\` : ''}\`;
`],
  [`    enquiry: item.enquiry || '',
`, `    enquiry: item.ai_summary || item.enquiry || '',
`],
];
const W6_PLAN = [
  [`    for (const r of conv.json.records || []) {
      const f = r.fields || {};
      if (f.Automation_Paused === true && f.Lead) paused.add(String(f.Lead));
    }
`, `    const hold = new Set();                                     // A5: conversations where a day-2 follow-up would be wrong
    for (const r of conv.json.records || []) {
      const f = r.fields || {};
      if (f.Automation_Paused === true && f.Lead) paused.add(String(f.Lead));
      const intent = String(f.Last_Intent || '');
      const recent = typeof f.Last_Inbound_At === 'number' && nowMs - f.Last_Inbound_At * 1000 < 48 * 3600 * 1000;
      if (f.Lead && (f.Needs_Human === true || intent === 'not_interested' || intent === 'opt_out' || recent)) hold.add(String(f.Lead));
    }
`],
  [`    const oldestFirst = (a, b) => a.fields.Created_At - b.fields.Created_At;
    leadRows
      .filter((r) => isOpen(r) && !r.fields.Followup_Sent && age(r) >= followupAfter && age(r) < lostAfter)
`, `    const oldestFirst = (a, b) => a.fields.Created_At - b.fields.Created_At;
    // A5: no day-2 follow-up while a person must answer, the patient wrote in the last 48 h, said not interested / stop, the AI
    // rated the lead cold, or a call-back is planned (Next_Action_At in the future). Without these fields: as before.
    const aiHold = (r) => {
      const f = r.fields || {};
      return hold.has(String(r.id)) || f.Lead_Stage === 'cold' || (typeof f.Next_Action_At === 'number' && f.Next_Action_At * 1000 > nowMs);
    };
    leadRows
      .filter((r) => isOpen(r) && !r.fields.Followup_Sent && age(r) >= followupAfter && age(r) < lostAfter && !aiHold(r))
`],
];
const CONFIG_EDIT = { from: { min_confidence: 0.7 }, to: { min_confidence: 0.65 }, add: [['confidence_auto', 0.8], ['confidence_write', 0.85]] };

// ---------------------------------------------------------------- redaction (public copies only; as build-integrated.js)
const PH_SECRET = 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT';
const PH_PHONE = 'PASTE_YOUR_TEST_NUMBER';
const PH_VERIFY = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
const assignment = (node, key) => (node.parameters.assignments.assignments || []).find((a) => a.name === key);
function redact(wf, report) {
  const nodes = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const secret = nodes['W4 – Config'] && assignment(nodes['W4 – Config'], 'cal_webhook_secret');
  if (secret && secret.value !== PH_SECRET) { secret.value = PH_SECRET; report.push('W4 – Config > cal_webhook_secret'); }
  const verify = nodes['W2 – Verify Config'] && assignment(nodes['W2 – Verify Config'], 'meta_verify_token');
  if (verify && verify.value !== PH_VERIFY) { verify.value = PH_VERIFY; report.push('W2 – Verify Config > meta_verify_token'); }
  const allow = nodes['W12 – Config'] && assignment(nodes['W12 – Config'], 'w12_allowlist');
  const phones = String(allow ? allow.value : '').split(/[,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10);
  let text = JSON.stringify(wf);
  for (const ph of phones) {
    const tail = ph.slice(-10);
    const re = new RegExp(`(\\+?91[\\s-]?)?${tail.slice(0, 5)}[\\s-]?${tail.slice(5)}`, 'g');
    const hits = (text.match(re) || []).length;
    if (hits) { text = text.replace(re, PH_PHONE); report.push(`${hits} occurrence(s) of the allowlisted phone number`); }
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 0. is this the audited workflow?
const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);
if (node(NEW_NODE)) fail(`${NEW_NODE} already exists: this export is already patched`);
for (const [name, want] of Object.entries(FINGERPRINTS)) {
  const n = node(name);
  if (!n) fail(`node "${name}" is missing`);
  const got = n.type === 'n8n-nodes-base.code' ? sha(n.parameters.jsCode) : sha(JSON.stringify(n.parameters));
  if (got !== want) fail(`"${name}" is not the audited version (fingerprint ${got}, expected ${want}): it was edited in n8n after the audit. Re-export and re-check before patching.`);
}
const leadsOut = JSON.stringify((wf.connections['W3 – Leads'] || {}).main);
if (leadsOut !== JSON.stringify([[{ node: 'W3 – Find due', type: 'main', index: 0 }]])) fail('W3 – Leads is not connected only to W3 – Find due');
if (wf.connections[NEW_NODE]) fail(`connections already mention ${NEW_NODE}`);

const demo = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));
const demoNode = (name) => demo.nodes.find((n) => n.name === name);
if (!/openrouter\.ai/.test(JSON.stringify(demo)) || /api\.anthropic\.com/.test(JSON.stringify(demo))) fail('the W13 source is not the OpenRouter build');

const editText = (name, edits) => {
  const n = node(name);
  let code = n.parameters.jsCode;
  for (const [from, to] of edits) {
    const count = code.split(from).length - 1;
    if (count !== 1) fail(`${name}: the text to change was found ${count} times (expected once):\n${from}`);
    code = code.replace(from, () => to);
  }
  n.parameters.jsCode = code;
};
const CHANGES = [];

// ---------------------------------------------------------------- 1. SECTION W13 (A1, A2, A3, A4)
for (const name of W13_CODE) {
  const d = demoNode(name);
  if (!d || typeof d.parameters.jsCode !== 'string') fail(`${name} is missing in ${path.basename(DEMO_FILE)}`);
  node(name).parameters.jsCode = d.parameters.jsCode;
}
CHANGES.push(`${W13_CODE.join(', ')}: code from the rebuilt OpenRouter W13 (shared decision module: no_reply rule, triage + emergency gate, confidence tiers, decision trace)`);
{
  const cfg = node('W13 – Config');
  for (const [k, v] of Object.entries(CONFIG_EDIT.from)) {
    const a = assignment(cfg, k);
    if (!a || a.value !== v) fail(`W13 – Config > ${k} is not ${v}`);
    a.value = CONFIG_EDIT.to[k];
  }
  const list = cfg.parameters.assignments.assignments;
  let at = list.findIndex((a) => a.name === 'min_confidence') + 1;
  for (const [k, v] of CONFIG_EDIT.add) {
    if (assignment(cfg, k)) fail(`W13 – Config > ${k} already exists`);
    list.splice(at++, 0, { id: uuid(`W13 – Config:${k}`), name: k, value: v, type: 'number' });
  }
  CHANGES.push('W13 – Config: min_confidence 0.7 -> 0.65; added confidence_auto = 0.8, confidence_write = 0.85');
}

// ---------------------------------------------------------------- 2. W6 (A5)
editText('W6 – Plan follow-ups', W6_PLAN);
CHANGES.push('W6 – Plan follow-ups: day-2 follow-up skips Needs_Human, cold, not_interested / opt_out, Next_Action_At in the future, a message in the last 48 h');

// ---------------------------------------------------------------- 3. W3 (A6)
{
  const leads = node('W3 – Leads');
  wf.nodes.push({
    parameters: {
      url: "={{ $('W3 – Add settings').item.json.grist_base_url }}/api/docs/{{ $('W3 – Add settings').item.json.doc_id }}/tables/Conversations/records",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {},
    },
    id: uuid(NEW_NODE),
    name: NEW_NODE,
    type: leads.type,
    typeVersion: leads.typeVersion,
    position: [leads.position[0] + 104, leads.position[1] + 192],
    credentials: clone(leads.credentials),
    onError: 'continueRegularOutput',
  });
  wf.connections['W3 – Leads'].main = [[{ node: NEW_NODE, type: 'main', index: 0 }]];
  wf.connections[NEW_NODE] = { main: [[{ node: 'W3 – Find due', type: 'main', index: 0 }]] };
  editText('W3 – Find due', W3_FIND_DUE);
  editText('W3 – Build Message', W3_BUILD_MESSAGE);
  CHANGES.push(`added ${NEW_NODE} (Grist read, credential of W3 – Leads, on error: continue = nothing skipped); W3 – Leads -> ${NEW_NODE} -> W3 – Find due`);
  CHANGES.push('W3 – Find due: hot -> warm -> cold, then oldest first; skips conversations with Automation_Paused / Assigned_To; passes lead_stage, ai_summary');
  CHANGES.push('W3 – Build Message: AI_Summary (else Enquiry) and the lead stage in the staff message; template unchanged');
}

// ---------------------------------------------------------------- 4. out
wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes, active = false`);
for (const c of CHANGES) console.log(`  - ${c}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: your verify token, Cal.com secret and allowlist stay in this file)' : report.join('; ') || 'none needed'}`);
