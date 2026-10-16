// Builds ONE n8n workflow (Clinic Autopilot) from the live exports of W1, W3, W4, W5, W6, W11 and W12.
//
//   node n8n/merged/build-merged.js --in <folder with the exported W*.json files> [--out <file>] [--keep-private]
//
// What it changes, and only this (see n8n/merged/README.md, "5. Merge changes"):
//   1. Node names get a module prefix ("Config" -> "W3 – Config") because one workflow cannot have two nodes with the
//      same name. Every reference to a renamed node inside expressions and Code nodes is renamed with it:
//      $('Name') and the from('Name') helper. Table names such as 'Appointments' are NOT touched.
//   2. Positions are shifted so each module sits in its own labelled section (sticky notes).
//   3. The "Call 'W12 - WhatsApp send'" nodes in W3 / W5 / W6 now call THIS workflow ({{ $workflow.id }}), which
//      enters the W12 section at "W12 – When called by another workflow". Same mode ("each"), same inputs.
//   4. settings.errorWorkflow is left out: a workflow that contains an Error Trigger is its own error workflow in n8n,
//      and n8n does not run it again when the error run itself fails (no loop).
//   5. FIXES (on by default, `--no-fixes` builds the as-exported merge): the five defects reported in README.md section 3
//      that you asked to have fixed before the first import (I-01 .. I-05), plus A-01 (W12 sends W13's free-text replies,
//      README section 5c). Each edit asserts the exact old text is in the export, so a different export fails loudly
//      instead of being patched blindly. See FIXES below.
//   6. Unless --keep-private: the Cal.com webhook secret and the phone numbers in the W12 allowlist are replaced by
//      placeholders, so the file can live in a public repo. Paste them back after import.
// Node ids, webhook ids, paths, schedules, credentials, Grist tables / columns and all code are kept as exported.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-single-workflow.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
const NO_FIXES = args.includes('--no-fixes');
if (!IN) { console.error('usage: node build-merged.js --in <exports folder> [--out file] [--keep-private] [--no-fixes]'); process.exit(1); }

const SEP = ' – ';
const MODULE_ORDER = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
const EXPECTED = ['W1', 'W3', 'W4', 'W5', 'W6', 'W11', 'W12'];
const PLACEHOLDER_SECRET = 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT';
const PLACEHOLDER_PHONE = 'PASTE_YOUR_TEST_NUMBER';

// ---------------------------------------------------------------- load the exports
const exportsByModule = {};
for (const f of fs.readdirSync(IN).filter((x) => x.endsWith('.json'))) {
  const w = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8'));
  const m = String(w.name || '').match(/^(W\d+)\b/);
  if (!m || !Array.isArray(w.nodes)) continue;
  if (exportsByModule[m[1]]) throw new Error(`two exports for ${m[1]}: ${exportsByModule[m[1]].file} and ${f}`);
  exportsByModule[m[1]] = { file: f, wf: w };
}
for (const m of EXPECTED) if (!exportsByModule[m]) throw new Error(`missing export for ${m}`);

// ---------------------------------------------------------------- helpers
const uuid = (seed) => {   // deterministic id for the NEW sticky notes only (rebuilds give the same ids)
  const h = crypto.createHash('sha256').update(`clinic-autopilot-merged:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const walk = (v, fn) => {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, fn)]));
  return v;
};
// $('Name') / $("Name") / $(`Name`) and the from('Name') helper used in W1, W4 and W12 (it wraps $(name)).
const renameRefs = (str, map) => {
  let s = str;
  for (const [oldName, newName] of Object.entries(map)) {
    for (const q of ["'", '"', '`']) {
      const nq = q === "'" ? newName.replace(/'/g, "\\'") : q === '"' ? newName.replace(/"/g, '\\"') : newName;
      const oq = q === "'" ? oldName.replace(/'/g, "\\'") : q === '"' ? oldName.replace(/"/g, '\\"') : oldName;
      s = s.replace(new RegExp(`(\\$\\(\\s*|\\bfrom\\(\\s*)${esc(q + oq + q)}`, 'g'), `$1${q}${nq}${q}`);
    }
  }
  return s;
};
const SIZE = (n) => (n.type === 'n8n-nodes-base.stickyNote'
  ? { w: n.parameters.width || 240, h: n.parameters.height || 160 }
  : { w: 120, h: 120 });
const bbox = (nodes) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const { w, h } = SIZE(n);
    x0 = Math.min(x0, n.position[0]); y0 = Math.min(y0, n.position[1]);
    x1 = Math.max(x1, n.position[0] + w); y1 = Math.max(y1, n.position[1] + h);
  }
  return { x0, y0, x1, y1 };
};

// ---------------------------------------------------------------- section texts
const TRIGGER_TEXT = {
  W1: 'POST /webhook/website-lead (Header Auth)',
  W3: 'Schedule: every 10 minutes',
  W4: 'POST /webhook/cal?clinic=<slug> (Cal.com, HMAC-signed)',
  W5: 'Schedule: every 15 minutes',
  W6: 'Schedule: cron 0 10 * * * (n8n timezone, Asia/Kolkata in docker-compose)',
  W11: 'Error Trigger: any failed production run of THIS workflow',
  W12: 'Execute Workflow Trigger (called by W3 / W5 / W6, one item per call) + Manual test',
};
const TITLE = {
  W1: 'WEBSITE LEADS', W2: 'WHATSAPP INBOUND', W3: 'SPEED TO LEAD', W4: 'BOOKING', W5: 'REMINDERS', W6: 'FOLLOW UPS',
  W7: 'OUTCOME NUDGE', W8: 'REVIEWS', W9: 'REPORTING', W10: 'STAFF REPLY', W11: 'ERROR HANDLER', W12: 'WHATSAPP SEND ENGINE',
};
const SECTION_BODY = {
  W1: 'Website form -> clinic lookup (Agency Registry) -> find / create / update the LEADS row -> Run_Log.\nStaff alert is still a STUB (sends nothing, does not call W12).',
  W3: 'New leads waiting 30 min - 48 h -> guard (TEST_MODE / quiet hours) -> **W3 – Call \'W12 - WhatsApp send\'** -> if sent: Escalated + Run_Log.',
  W4: 'Verify the Cal.com signature -> clinic lookup -> create / reschedule / cancel the Appointments row (+ LEADS) -> Run_Log.\nBooking confirmation is still a STUB (does not call W12). "W4 – Webhook" (path cal-w4-test) is the old unconnected test webhook, kept as exported.',
  W5: 'Booked appointments due for the 24 h / 2 h reminder -> guard -> **W5 – Call \'W12 - WhatsApp send\'** -> if sent: R24_Sent / R2_Sent + Run_Log.',
  W6: 'No-show rebook, day-2 follow-up, mark Lost (mark_lost is OFF in Config) -> guard -> **W6 – Call \'W12 - WhatsApp send\'** -> if sent: Rebook_Sent / Followup_Sent + Run_Log.',
  W11: 'Runs only when another run of this workflow FAILS (production runs, not editor test runs). Telegram alert with workflow, step (node name = module), trimmed error. Same failure at most once per 10 min.\nNo loop: n8n never starts the error run again when the error run itself fails.',
  W12: 'The ONE place that talks to Meta. Entered at "W12 – When called by another workflow" through an Execute Workflow node that calls THIS workflow, one item per call, so every caller gets its own result back.\nSafety kept: decision from the caller, send_mode allowlist, quiet hours, template check, Meta call, classification, Grist inbox log.',
};
const RESERVED = {
  W2: 'WhatsApp inbound webhook (Meta -> Conversations / Messages).',
  W7: 'Outcome nudge after an appointment.',
  W8: 'Review request after a Completed appointment (Appointments.Review_Sent).',
  W9: 'Weekly report (numbers computed in n8n, text by AI).',
  W10: 'Staff reply from the Grist inbox (Messages rows with Send ticked).',
};
const HOW_TO_SEND =
  'To send WhatsApp from a new section: copy one of the "Call \'W12 - WhatsApp send\'" nodes (it calls this workflow, mode: each) and give it items that carry ' +
  '`decision {send,to,reason,test_mode}`, `template`, `template_params`, `wa_phone_number_id`, `audience`, `source_workflow`, `message_text` ' +
  '(+ `grist_base_url`, `doc_id`, `lead_phone`, `lead_row_id` for patient messages). The item comes back with `sent`, `send_status`, `wa_message_id`, `send_error`.';

// ---------------------------------------------------------------- build
const nodes = [];
const connections = {};
const report = { renamed: {}, executeWorkflowRewired: [], redactions: [] };
const SECTION_X = 0;
const GAP = 260;
const HEADER = 300;
const PAD = 120;
const MIN_WIDTH = 2200;
let cursorY = 0;

const sticky = (key, content, x, y, w, h, color) => {
  nodes.push({
    parameters: { content, height: Math.round(h), width: Math.round(w), color },
    id: uuid(`sticky:${key}`),
    name: `Section ${key}`,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [Math.round(x), Math.round(y)],
  });
};

// SECTION 00 (written after the loop, when the entry points are known): reserve its space now.
const SECTION00_HEIGHT = 1060;
cursorY += SECTION00_HEIGHT + GAP;
const entryPoints = [];

const COLORS = { W1: 4, W3: 4, W4: 4, W5: 4, W6: 4, W11: 3, W12: 6 };
for (const m of MODULE_ORDER) {
  const ex = exportsByModule[m];
  if (!ex) {
    sticky(m, `## SECTION ${m} — ${TITLE[m]}\n**RESERVED — not built yet. There are no ${m} nodes in this workflow.**\n\nPlanned: ${RESERVED[m]}\n\n${HOW_TO_SEND}\n\nName new nodes "${m} – <name>". Do not connect this section to other sections; give it its own trigger.`,
      SECTION_X, cursorY, MIN_WIDTH, 420, 7);
    cursorY += 420 + GAP;
    continue;
  }
  const wf = ex.wf;
  const map = Object.fromEntries(wf.nodes.map((n) => [n.name, `${m}${SEP}${n.name}`]));
  report.renamed[m] = map;
  const box = bbox(wf.nodes);
  const dx = SECTION_X + PAD - box.x0;
  const dy = cursorY + HEADER - box.y0;
  const width = Math.max(MIN_WIDTH, box.x1 - box.x0 + 2 * PAD);
  const height = box.y1 - box.y0 + HEADER + PAD;
  sticky(m, `## SECTION ${m} — ${TITLE[m]}\n**Source:** "${wf.name}" (old id ${wf.id}). **Starts from:** ${TRIGGER_TEXT[m]}\n\n${SECTION_BODY[m]}`,
    SECTION_X, cursorY, width, height, COLORS[m]);

  for (const n of wf.nodes) {
    const c = JSON.parse(JSON.stringify(n));
    c.name = map[n.name];
    c.position = [n.position[0] + dx, n.position[1] + dy];
    if (c.parameters) c.parameters = walk(c.parameters, (s) => renameRefs(s, map));
    if (c.type === 'n8n-nodes-base.executeWorkflow') {
      const before = JSON.stringify(c.parameters.workflowId);
      c.parameters.workflowId = { __rl: true, value: '={{ $workflow.id }}', mode: 'id' };
      report.executeWorkflowRewired.push({ node: c.name, before: JSON.parse(before), after: c.parameters.workflowId });
    }
    if (['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.manualTrigger'].includes(c.type)) {
      entryPoints.push({ module: m, node: c.name, type: c.type, parameters: c.parameters, connected: !!(wf.connections[n.name]) });
    }
    nodes.push(c);
  }
  for (const [src, byType] of Object.entries(wf.connections || {})) {
    connections[map[src]] = Object.fromEntries(Object.entries(byType).map(([t, outs]) => [t, outs.map((arr) => (arr || []).map((x) => ({ ...x, node: map[x.node] })))]));
  }
  cursorY += height + GAP;
}
sticky('FUTURE', `## SECTION FUTURE — RESERVED FOR NEW MODULES\nW13, W14, W15, AI receptionist, AI lead qualification, payments, review automation, analytics, staff notifications, new clinic modules.\n\nRules for a new module:\n1. Its own trigger (webhook path or schedule) and its own section sticky; never chain sections together.\n2. Name nodes "W<n> – <name>"; Code-node references must use those names.\n3. Start with a Config node and read the Agency Registry (never hard-code a clinic).\n4. WhatsApp only through the W12 engine (see SECTION 00). Guards, TEST_MODE and sent flags as in CLAUDE.md.\n5. Errors reach W11 automatically (same workflow).`,
  SECTION_X, cursorY, MIN_WIDTH, 520, 7);

// SECTION 00 — MASTER / ENTRY POINTS
const describe = (e) => {
  const p = e.parameters || {};
  if (e.type === 'n8n-nodes-base.webhook') return `${p.httpMethod || 'GET'} /webhook/${p.path}${e.connected ? '' : ' — NOT CONNECTED (does nothing)'}`;
  if (e.type === 'n8n-nodes-base.scheduleTrigger') {
    const r = ((p.rule || {}).interval || [])[0] || {};
    return r.field === 'cronExpression' ? `cron ${r.expression}` : `every ${r[`${r.field}Interval`]} ${r.field}`;
  }
  if (e.type === 'n8n-nodes-base.errorTrigger') return 'a production run of this workflow failed';
  if (e.type === 'n8n-nodes-base.executeWorkflowTrigger') return 'Execute Workflow node calling this workflow (W3 / W5 / W6 senders)';
  if (e.type === 'n8n-nodes-base.manualTrigger') return '"Execute workflow" button in the editor (W12 test)';
  return e.type;
};
const s00 = [
  '## SECTION 00 — MASTER / ENTRY POINTS',
  '**Clinic Autopilot runs as ONE workflow.** Every trigger below starts only its own section. Sections are not chained (no W1 -> W3 -> ...).',
  '',
  ...entryPoints.map((e) => `- **${e.node}** — ${describe(e)} -> SECTION ${e.module}`),
  '',
  '**WhatsApp:** only SECTION W12 calls Meta. ' + HOW_TO_SEND,
  '**Errors:** SECTION W11 (Error Trigger). Settings > Error workflow stays EMPTY: this workflow is its own error workflow.',
  '',
  '**Before activating:** deactivate the old W1, W3, W4, W5, W6 and W12 workflows (same webhook paths, double sends). Save this workflow before any test (sends call the SAVED version).',
  KEEP_PRIVATE ? '' : `**Fill after import (kept out of the repo):** W4 – Config > cal_webhook_secret; W12 – Config > w12_allowlist; W12 – Test input > decision.to; W3 – Config > test_phone (unused).`,
].join('\n');
sticky('00', s00, SECTION_X, 0, MIN_WIDTH, SECTION00_HEIGHT, 5);


// ---------------------------------------------------------------- FIXES (I-01 .. I-05)
// Only these 7 nodes differ from the exports. Everything is matched on exact text and asserted.
const FIXED_NODES = [];
const fixNode = (name, why, fn) => {
  const n = nodes.find((x) => x.name === name);
  if (!n) throw new Error(`fix: node "${name}" not found`);
  fn(n);
  FIXED_NODES.push({ name, id: n.id, why });
};
// The pasted wa-send.js helpers: from "const WA_TEMPLATES" to the blank line after waInboxRow (same cut as the W12 drift test).
const WA_SEND_SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'wa-send.js'), 'utf8');
const WA_SEND_BLOCK = WA_SEND_SRC.slice(WA_SEND_SRC.indexOf('const WA_TEMPLATES'), WA_SEND_SRC.indexOf('if (typeof module'));
const waSendSpan = (code) => {
  const start = code.indexOf('const WA_TEMPLATES');
  const fn = code.indexOf('function waInboxRow', start);
  const close = code.indexOf('\n}\n\n', fn);
  if (start < 0 || fn < 0 || close < 0 || code.indexOf('const WA_TEMPLATES', start + 1) >= 0) return null;
  return { start, end: close + 4, text: code.slice(start, close + 4) };
};
const replaceOnce = (node, key, from, to) => {
  const src = node.parameters[key];
  const parts = src.split(from);
  if (parts.length !== 2) throw new Error(`fix: expected exactly one occurrence in ${node.name}.${key} of: ${from.slice(0, 70)}`);
  node.parameters[key] = parts.join(to);
};
if (!NO_FIXES) {
  // I-01  W5 "Code in JavaScript" rebuilt the decision from the patient's number and Boolean(test_mode): TEST_MODE was bypassed.
  //       Now the decision is the one "Decide send" made (Opted_Out, sent flag, quiet hours, TEST_MODE -> TEST_PHONE), and a missing
  //       decision means "do not send". The node must also run once per item (it was "all items" + $json = first item only).
  fixNode('W5 – Code in JavaScript', 'I-01: keep the guard decision (TEST_MODE / TEST_PHONE); run once per item', (n) => {
    replaceOnce(n, 'jsCode', "const to = String(phone).replace(/\\D/g, '');\n\nconst send = Boolean(item.send !== false);",
      "// The recipient and the send / no-send answer come ONLY from \"Decide send\" (Opted_Out, sent flag, quiet hours,\n" +
      "// TEST_MODE -> TEST_PHONE). Never rebuild them here; W12 checks them again before calling Meta.\n" +
      "const decision = item.decision || { send: false, to: null, reason: 'W5: no decision from Decide send', test_mode: true };");
    replaceOnce(n, 'jsCode', "    decision: {\n      send,\n      to,\n      reason: 'W5 reminder',\n      test_mode: Boolean(item.test_mode),\n    },",
      '    decision,');
    n.parameters.mode = 'runOnceForEachItem';
  });
  // I-02  W5 "Decide send": Execute Once handled only the first due reminder per run.
  fixNode('W5 – Decide send', 'I-02: Execute Once off (every due reminder is processed)', (n) => {
    if (n.executeOnce !== true) throw new Error('fix: W5 – Decide send is not "Execute Once" in this export');
    delete n.executeOnce;
  });
  // I-05 / I-03  fixed test clock -> real clock (quiet hours 21:00-08:00 IST work again)
  const FIXED_CLOCK = "new Date('2026-10-05T10:00:00+05:30').getTime()";
  fixNode('W6 – Decide send', 'I-05: real clock (Date.now()) for quiet hours', (n) => replaceOnce(n, 'jsCode', `now_ms: ${FIXED_CLOCK},`, 'now_ms: Date.now(),'));
  fixNode('W12 – Prepare request', 'I-03: real clock (Date.now()) for quiet hours', (n) => replaceOnce(n, 'jsCode', `  ${FIXED_CLOCK},\n`, '  Date.now(),\n'));
  // I-04  W12 inbox nodes call Grist: use the Grist credential (copied from a Grist node in this file), not the Meta one.
  const grist = nodes.find((x) => x.name === `W5${SEP}Clinics`).credentials.httpHeaderAuth;
  if (grist.id !== '9J6XxrIQoFDcQZ0Y' || grist.name !== 'Header Auth account 2') throw new Error('fix: unexpected Grist credential in W5 – Clinics');
  for (const name of ['Find conversation', 'Create conversation', 'Add message']) {
    fixNode(`W12${SEP}${name}`, 'I-04: Grist credential instead of the WhatsApp Cloud API one', (n) => {
      if (n.credentials.httpHeaderAuth.name !== 'WhatsApp Cloud API') throw new Error(`fix: ${n.name} does not use the WhatsApp credential in this export`);
      n.credentials = { httpHeaderAuth: { id: grist.id, name: grist.name } };
    });
  }
  // A-01  W13 (AI receptionist) replies with free text inside WhatsApp's 24-hour window and alerts staff with human_handoff_alert.
  //       Only the pasted wa-send.js block in W12's two Code nodes changes (templates work exactly as before).
  for (const name of ['Prepare request', 'Read reply']) {
    fixNode(`W12${SEP}${name}`, 'A-01: wa-send.js with free-text replies (24-hour window) + human_handoff_alert, for W13', (n) => {
      const span = waSendSpan(n.parameters.jsCode);
      if (!span || span.text.includes('WA_TEXT_WINDOW_MS')) throw new Error(`fix: ${n.name} has no old wa-send.js block (already patched?)`);
      n.parameters.jsCode = n.parameters.jsCode.slice(0, span.start) + WA_SEND_BLOCK + n.parameters.jsCode.slice(span.end);
    });
  }
}

// ---------------------------------------------------------------- privacy (public repo)
const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
const assignment = (node, key) => (byName[node].parameters.assignments.assignments || []).find((a) => a.name === key);
const secretA = assignment(`W4${SEP}Config`, 'cal_webhook_secret');
const secretValue = secretA ? String(secretA.value) : '';
const allowA = assignment(`W12${SEP}Config`, 'w12_allowlist');
const privatePhones = String(allowA ? allowA.value : '').split(/[,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10);
let out = { name: 'Clinic Autopilot — single workflow (W1–W12)', nodes, pinData: {}, connections, active: false,
  settings: { executionOrder: 'v1', binaryMode: 'separate', timeSavedMode: 'fixed', callerPolicy: 'workflowsFromSameOwner', availableInMCP: false },
  meta: exportsByModule.W12.wf.meta || {}, tags: [] };
if (!KEEP_PRIVATE) {
  if (secretA && secretValue && secretValue !== PLACEHOLDER_SECRET) { secretA.value = PLACEHOLDER_SECRET; report.redactions.push('W4 – Config > cal_webhook_secret'); }
  let text = JSON.stringify(out);
  for (const ph of privatePhones) {
    const tail = ph.slice(-10);   // the same number written with or without 91 / +91
    const re = new RegExp(`(\\+?91[\\s-]?)?${tail.slice(0, 5)}[\\s-]?${tail.slice(5)}`, 'g');
    const hits = (text.match(re) || []).length;
    if (hits) { text = text.replace(re, PLACEHOLDER_PHONE); report.redactions.push(`${hits} occurrence(s) of an allowlisted phone number`); }
  }
  out = JSON.parse(text);
  if (secretValue && JSON.stringify(out).includes(secretValue)) throw new Error('the Cal.com secret is still in the output');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${out.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length} functional), ${Object.keys(out.connections).length} connection sources`);
console.log(`modules: ${EXPECTED.map((m) => `${m}<-${exportsByModule[m].file}`).join(', ')}`);
console.log(`execute-workflow nodes rewired to this workflow: ${report.executeWorkflowRewired.map((r) => r.node).join(', ')}`);
console.log(`fixed nodes (${new Set(FIXED_NODES.map((f) => f.name)).size}): ${FIXED_NODES.map((f) => `${f.name} [${f.why.split(':')[0]}]`).join(', ') || 'none (--no-fixes)'}`);
console.log(`redactions: ${report.redactions.length ? report.redactions.join('; ') : 'none (--keep-private)'}`);
