// AI context for W3 / W4 / W5 / W6 on your workflow "ai updated workflow clinic" (export), nothing else:
//   node n8n/integrated/apply-ai-context.js --in <export.json> [--out <file>] [--keep-private]
//
// No new model call. W3, W5 and W6 read what the AI receptionist (W13) and staff already wrote to the CRM through ONE shared
// deterministic module, n8n/snippets/lead-context.js (pasted verbatim), which turns it into a next best action that can only
// hold back or reorder a step the workflow's own rules allow. W12 stays the only WhatsApp sender; W4 stays Cal.com-driven.
//   W3  W3 – Find due: also holds back opted-out / not-interested leads and leads with a planned next contact; staff brief
//       (who, what they want, last contact, how hot, next step). W3 – Build Message: uses that brief (template unchanged).
//   W4  W4 – Plan appointment: after the verified Cal.com cancellation, the lead's Next_Action_At = now (a due rebook signal).
//   W5  new node W5 – Conversations (Grist read, credential of W5 – Leads, errors -> nothing held) between W5 – Leads and
//       W5 – Find due. Find due: the 24 h reminder is held while a WhatsApp cancel / reschedule request waits for staff.
//   W6  W6 – Plan follow-ups: day-2 follow-up and no-show rebook use the same next best action (+ Assigned_To, + "wrote since
//       the missed visit" for rebooks); day-2 hot leads first.
//
// Every node it edits is fingerprinted first: if your workflow changed since this export, it stops and writes nothing.
// Secrets, credentials, webhooks and every other node stay byte-identical. The result is saved INACTIVE. Unless --keep-private,
// the output is the public (redacted) copy for this repository; with --keep-private your values are kept exactly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-ai-context.js --in <export.json> [--out file] [--keep-private]'); process.exit(1); }
const REPO = path.join(__dirname, '..', '..');
const LC_SRC = fs.readFileSync(path.join(REPO, 'n8n/snippets/lead-context.js'), 'utf8');
const LC = `// Pasted from n8n/snippets/lead-context.js - keep identical.\n${LC_SRC.slice(LC_SRC.indexOf('const LC_STAGE_RANK'), LC_SRC.indexOf('if (typeof module'))}`;
const code = (f) => fs.readFileSync(path.join(__dirname, 'ai-context', f), 'utf8');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const uuid = (seed) => {
  const h = crypto.createHash('sha256').update(`ai-context:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (m) => { console.error(`apply-ai-context: ${m}\nNothing was written.`); process.exit(1); };

// ---------------------------------------------------------------- the exact state this is applied to
const FINGERPRINTS = {   // sha256 (first 16 hex) in "ai updated workflow clinic" (A1-A6 applied, re-imported)
  'W3 – Find due': '485e4efb93b76d20',
  'W3 – Build Message': '1de43d4d38578daa',
  'W4 – Plan appointment': '059f085fc4abd94c',
  'W5 – Find due': 'a428e2e068206f5e',
  'W6 – Plan follow-ups': '8c05c7a091475dca',
  'W5 – Leads': 'd5bd698e2098af84',          // parameters; read only (the new node copies its credential)
  'W3 – Conversations': '0bbf637f07533565',   // parameters; read only (the new W5 node mirrors it)
};
const NEW_NODE = 'W5 – Conversations';

const W3_BUILD_MESSAGE = [
  [`// A6: what the AI learned (AI_Summary) or the enquiry, and the lead stage, in the existing staff message
const about = item.ai_summary || item.enquiry || '';
const stage = item.lead_stage ? \` [\${item.lead_stage}]\` : '';
const message_text =
  \`New lead\${stage}: \${name} (\${phone}) has submitted an enquiry for \${clinic}.\${about ? \` \${about}\` : ''}\`;
`, `// Staff brief from W3 – Find due (who, what they want, last contact, how hot, next step); the A6 text if it is missing
const about = item.ai_summary || item.enquiry || '';
const stage = item.lead_stage ? \` [\${item.lead_stage}]\` : '';
const message_text = item.staff_text ||
  \`New lead\${stage}: \${name} (\${phone}) has submitted an enquiry for \${clinic}.\${about ? \` \${about}\` : ''}\`;
`],
  [`    enquiry: item.ai_summary || item.enquiry || '',
`, `    enquiry: item.staff_brief || item.ai_summary || item.enquiry || '',
`],
];
const W4_PLAN_APPOINTMENT = [
  [`  const rows = ($json.records || []).map((r) => ({ id: r.id, uid: (r.fields || {}).Booking_UID, status: (r.fields || {}).Status }));
`, `  const rows = ($json.records || []).map((r) => ({ id: r.id, uid: (r.fields || {}).Booking_UID, status: (r.fields || {}).Status, lead: Number((r.fields || {}).Lead) || 0 }));
`],
  [`        logWrite(\`\${ctx.uid} (cancelled)\`, 'ok'),
      ],
`, `        logWrite(\`\${ctx.uid} (cancelled)\`, 'ok'),
        // Rebook signal, from the verified Cal.com cancellation only: the lead's next action is due now (Grist "Today" list,
        // W3 / W6 see a due, not a planned, next contact). Written last, so the cancellation itself never depends on it.
        ...(byUid.lead > 0 ? [{ method: 'PATCH', table: 'LEADS', body: { records: [{ id: byUid.lead, fields: { Next_Action_At: Math.floor(Date.now() / 1000) } }] } }] : []),
      ],
`],
];
const W6_PLAN = [
  [`    const paused = new Set();
    const hold = new Set();                                     // A5: conversations where a day-2 follow-up would be wrong
    for (const r of conv.json.records || []) {
      const f = r.fields || {};
      if (f.Automation_Paused === true && f.Lead) paused.add(String(f.Lead));
      const intent = String(f.Last_Intent || '');
      const recent = typeof f.Last_Inbound_At === 'number' && nowMs - f.Last_Inbound_At * 1000 < 48 * 3600 * 1000;
      if (f.Lead && (f.Needs_Human === true || intent === 'not_interested' || intent === 'opt_out' || recent)) hold.add(String(f.Lead));
    }
`, `    const paused = new Set();
    for (const r of conv.json.records || []) {
      const f = r.fields || {};
      if (f.Automation_Paused === true && f.Lead) paused.add(String(f.Lead));
    }
    // What W13 and staff wrote to Conversations + LEADS -> the next best action per lead (lead-context.js). It only holds back.
    const conversations = lcConversations(conv.json.records || []);
    const nbaFor = (id, purpose, o) => nextBestAction(leadContext({ id, fields: leads[id] }, conversations[id], nowMs), purpose, o);
`],
  [`      if (!leads[id] || futureBooked.has(id)) continue;          // already rebooked: nothing to chase
`, `      if (!leads[id] || futureBooked.has(id)) continue;          // already rebooked: nothing to chase
      if (!nbaFor(id, 'rebook', { since: a.fields.Start }).allowed) continue;   // a person owns it, a call is planned, or they wrote since
`],
  [`    // A5: no day-2 follow-up while a person must answer, the patient wrote in the last 48 h, said not interested / stop, the AI
    // rated the lead cold, or a call-back is planned (Next_Action_At in the future). Without these fields: as before.
    const aiHold = (r) => {
      const f = r.fields || {};
      return hold.has(String(r.id)) || f.Lead_Stage === 'cold' || (typeof f.Next_Action_At === 'number' && f.Next_Action_At * 1000 > nowMs);
    };
    leadRows
      .filter((r) => isOpen(r) && !r.fields.Followup_Sent && age(r) >= followupAfter && age(r) < lostAfter && !aiHold(r))
      .sort(oldestFirst)
`, `    // No day-2 follow-up while a person must answer or owns the conversation, the patient wrote in the last 48 h, said not
    // interested / stop, the AI rated the lead cold, or a call-back is planned (Next_Action_At in the future). Hot leads first.
    // Without these fields: as before (the same leads, oldest first).
    const rank = (r) => leadContext(r, conversations[String(r.id)], nowMs).rank;
    leadRows
      .filter((r) => isOpen(r) && !r.fields.Followup_Sent && age(r) >= followupAfter && age(r) < lostAfter && nbaFor(String(r.id), 'followup').allowed)
      .sort((a, b) => rank(a) - rank(b) || oldestFirst(a, b))
`],
];

// ---------------------------------------------------------------- 0. is this the expected workflow?
const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);
if (node(NEW_NODE) || wf.connections[NEW_NODE]) fail(`${NEW_NODE} already exists: this export is already patched`);
for (const [name, want] of Object.entries(FINGERPRINTS)) {
  const n = node(name);
  if (!n) fail(`node "${name}" is missing`);
  const got = n.type === 'n8n-nodes-base.code' ? sha(n.parameters.jsCode) : sha(JSON.stringify(n.parameters));
  if (got !== want) fail(`"${name}" is not the expected version (fingerprint ${got}, expected ${want}): it was edited in n8n after this export. Re-export and re-check before patching.`);
}
if (JSON.stringify((wf.connections['W5 – Leads'] || {}).main) !== JSON.stringify([[{ node: 'W5 – Find due', type: 'main', index: 0 }]])) fail('W5 – Leads is not connected only to W5 – Find due');

const editText = (name, edits) => {
  const n = node(name);
  let c = n.parameters.jsCode;
  for (const [from, to] of edits) {
    const count = c.split(from).length - 1;
    if (count !== 1) fail(`${name}: the text to change was found ${count} times (expected once):\n${from}`);
    c = c.replace(from, () => to);
  }
  n.parameters.jsCode = c;
};
const CHANGES = [];

// ---------------------------------------------------------------- W3
node('W3 – Find due').parameters.jsCode = `${LC}${code('w3-find-due.js')}`;
editText('W3 – Build Message', W3_BUILD_MESSAGE);
CHANGES.push('W3 – Find due: lead-context next best action (also holds opted out / not interested / planned next contact); staff brief + next_best_action on each item');
CHANGES.push('W3 – Build Message: message_text = the staff brief, template "enquiry" = the short brief (template and its keys unchanged)');

// ---------------------------------------------------------------- W4
editText('W4 – Plan appointment', W4_PLAN_APPOINTMENT);
CHANGES.push('W4 – Plan appointment: a verified BOOKING_CANCELLED also sets the lead\'s Next_Action_At = now (written after the existing writes)');

// ---------------------------------------------------------------- W5
{
  const leads = node('W5 – Leads');
  wf.nodes.push({
    parameters: {
      url: "={{ $('W5 – Add appointments').item.json.grist_base_url }}/api/docs/{{ $('W5 – Add appointments').item.json.doc_id }}/tables/Conversations/records",
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
  wf.connections['W5 – Leads'].main = [[{ node: NEW_NODE, type: 'main', index: 0 }]];
  wf.connections[NEW_NODE] = { main: [[{ node: 'W5 – Find due', type: 'main', index: 0 }]] };
  node('W5 – Find due').parameters.jsCode = `${LC}${code('w5-find-due.js')}`;
  CHANGES.push(`added ${NEW_NODE} (Grist read, credential of W5 – Leads, on error: continue = nothing held); W5 – Leads -> ${NEW_NODE} -> W5 – Find due`);
  CHANGES.push('W5 – Find due: the 24 h reminder is held while a WhatsApp cancel / reschedule request waits for staff (< 24 h); timing, flags, status unchanged');
}

// ---------------------------------------------------------------- W6
wf.nodes.find((n) => n.name === 'W6 – Plan follow-ups').parameters.jsCode = `${LC}${node('W6 – Plan follow-ups').parameters.jsCode}`;
editText('W6 – Plan follow-ups', W6_PLAN);
CHANGES.push('W6 – Plan follow-ups: day-2 and rebook use the lead-context next best action (+ Assigned_To; rebook: + wrote since the missed visit); day-2 hot first');

// ---------------------------------------------------------------- out
wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes, active = false`);
for (const c of CHANGES) console.log(`  - ${c}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private: every value is kept exactly as in your export)' : report.join('; ') || 'none needed'}`);
