// Before / after proof for apply-w7-w10.js:
//   node n8n/integrated/validate-w7-w10.js [--orig <before.json>] [--patched <after.json>] [--private]
// Defaults: the public ai-updated-workflow-clinic.handoff-gate.json (before) and ai-updated-workflow-clinic.w7-w10.json (after).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PRIVATE = args.includes('--private');
const ORIG = arg('--orig', path.join(__dirname, 'ai-updated-workflow-clinic.handoff-gate.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json'));
const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const snip = (f) => fs.readFileSync(path.join(__dirname, '..', 'snippets', f), 'utf8');
const W12_CHANGED = ['W12 – Prepare request', 'W12 – Read reply'];
const W13_CHANGED = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const STICKIES = ['Section W7', 'Section W8', 'Section W9', 'Section W10', 'Section 00'];
const CHANGED = [...W12_CHANGED, ...W13_CHANGED, ...STICKIES];
const NEW = Object.keys(B).filter((n) => !A[n]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); return i >= 0 && j > i ? s.slice(i, j) : null; };
let failed = 0;
const group = (t, fn) => { try { const d = fn(); console.log(`PASS  ${t}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${t}\n      ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };

group('1. the patcher reproduces this file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7w10-'));
  const out = path.join(dir, 'o.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-w7-w10.js'), '--in', ORIG, '--out', out, ...(PRIVATE ? ['--keep-private'] : [])], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, `${r.stderr}`);
});
group('2. nodes: 0 removed; added = the W7 / W8 / W9 / W10 sections only', () => {
  must(Object.keys(A).every((n) => B[n]), `removed: ${Object.keys(A).filter((n) => !B[n])}`);
  must(NEW.every((n) => /^W(7|8|9|10) – /.test(n)), `added outside W7-W10: ${NEW.filter((n) => !/^W(7|8|9|10) – /.test(n))}`);
  const per = (p) => NEW.filter((n) => n.startsWith(p)).length;
  must(new Set(patched.nodes.map((n) => n.id)).size === patched.nodes.length, 'duplicate node id');
  return `${NEW.length} added (W7 ${per('W7 – ')}, W8 ${per('W8 – ')}, W9 ${per('W9 – ')}, W10 ${per('W10 – ')})`;
});
group('3. modified: exactly 2 W12 + 4 W13 Code nodes (the pasted snippet block only) + 5 sticky notes (text / size only)', () => {
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n]));
  must(same(changed.sort(), [...CHANGED].sort()), `changed: ${changed}`);
  const WA = snip('wa-send.js'); const waNew = WA.slice(WA.indexOf('const WA_TEMPLATES'), WA.indexOf('\n}\n', WA.indexOf('function waInboxRow')) + 3);
  for (const n of W12_CHANGED) {
    const a = A[n].parameters.jsCode; const b = B[n].parameters.jsCode;
    const blockA = between(a, 'const WA_TEMPLATES', '\n}\n\n'); must(blockA, n);
    const oldBlock = a.slice(a.indexOf('const WA_TEMPLATES'), a.indexOf('\n}\n', a.indexOf('function waInboxRow')) + 3);
    must(b === a.replace(oldBlock, waNew), `${n}: more than the wa-send.js block changed`);
  }
  const AI = snip('ai-receptionist.js'); const aiNew = AI.slice(AI.indexOf('const AI_INTENTS'), AI.indexOf('if (typeof module'));
  for (const n of W13_CHANGED) {
    const a = A[n].parameters.jsCode; const b = B[n].parameters.jsCode;
    const oldBlock = a.slice(a.indexOf('const AI_INTENTS'), a.indexOf('\nconst h = { normalizeIndianPhone'));
    must(b === a.replace(oldBlock, aiNew), `${n}: more than the ai-receptionist.js block changed`);
  }
  for (const n of [...W12_CHANGED, ...W13_CHANGED]) { const a = JSON.parse(JSON.stringify(A[n])); const b = JSON.parse(JSON.stringify(B[n])); delete a.parameters.jsCode; delete b.parameters.jsCode; must(same(a, b), `${n}: more than its code changed`); }
  for (const n of STICKIES) { const a = JSON.parse(JSON.stringify(A[n])); const b = JSON.parse(JSON.stringify(B[n])); for (const k of ['content', 'height', 'width']) { delete a.parameters[k]; delete b.parameters[k]; } must(same(a, b), `${n}: more than text / size changed`); }
  must(!/RESERVED/.test(STICKIES.slice(0, 4).map((n) => B[n].parameters.content).join('')), 'a section still says RESERVED');
  return `${Object.keys(A).length - CHANGED.length} of ${Object.keys(A).length} existing nodes byte-identical`;
});
group('4. connections: 0 existing changed; new ones only inside the new sections', () => {
  for (const [from, c] of Object.entries(orig.connections)) must(same(c, patched.connections[from]), `changed: ${from}`);
  const added = Object.keys(patched.connections).filter((k) => !orig.connections[k]);
  let links = 0;
  for (const from of added) {
    must(NEW.includes(from), `new connection from an existing node: ${from}`);
    for (const out of patched.connections[from].main) for (const c of out || []) { links++; must(NEW.includes(c.node) && c.node.split(' – ')[0] === from.split(' – ')[0], `${from} -> ${c.node}`); }
  }
  return `${added.length} new source nodes, ${links} new links, none to or from an existing section`;
});
group('5. CREDENTIALS changed = 0; new nodes only reference existing credentials', () => {
  for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), n);
  const known = new Map(orig.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials)).map((c) => [`${c.id}|${c.name}`, c]));
  const used = new Set();
  for (const n of NEW) for (const c of Object.values(B[n].credentials || {})) { must(known.has(`${c.id}|${c.name}`), `${n}: unknown credential ${c.name}`); used.add(c.name); }
  must(same([...used].sort(), ['Header Auth account 2', 'OpenRouter API']), `used: ${[...used]}`);
  must(same(B['W9 – Ask Model'].credentials, A['W13 – Ask Model'].credentials), 'W9 – Ask Model is not on W13\'s OpenRouter credential');
  return `existing references untouched; new nodes use "${[...used].join('", "')}" (the same ids as W6 / W13)`;
});
group('6. WEBHOOKS changed = 0; the new triggers are schedules', () => {
  const hooks = orig.nodes.filter((n) => /webhook|Trigger|respondToWebhook/i.test(n.type));
  for (const n of hooks) must(same(n, B[n.name]), n.name);
  const trig = NEW.filter((n) => /Trigger|webhook/i.test(B[n].type));
  must(trig.every((n) => B[n].type === 'n8n-nodes-base.scheduleTrigger' && !B[n].webhookId), `new triggers: ${trig}`);
  return `${hooks.length} webhook / trigger / respond nodes identical; new: ${trig.map((n) => `${n} (${JSON.stringify(B[n].parameters.rule.interval[0]).replace(/"/g, '')})`).join(', ')}`;
});
group('7. SECRETS changed = 0: every existing Config value, W11, W12 sender, W13 model node identical; new Config values copied from yours', () => {
  let values = 0;
  for (const n of orig.nodes.filter((x) => x.type === 'n8n-nodes-base.set')) { values += n.parameters.assignments.assignments.length; must(same(n, B[n.name]), n.name); }
  for (const n of orig.nodes.filter((x) => (/^W11 – |^W12 – /.test(x.name) && !W12_CHANGED.includes(x.name)) || x.name === 'W13 – Ask Model')) must(same(n, B[n.name]), n.name);
  const val = (node, k) => (B[node].parameters.assignments.assignments.find((a) => a.name === k) || {}).value;
  for (const s of ['W7', 'W8', 'W9', 'W10']) for (const k of ['grist_base_url', 'registry_doc_id']) must(val(`${s} – Config`, k) === val('W6 – Config', k), `${s} – Config > ${k} is not your value`);
  must(val('W9 – Config', 'openrouter_model') === val('W13 – Config', 'openrouter_model'), 'W9 model is not W13\'s');
  const newText = JSON.stringify(NEW.map((n) => B[n]));
  must(!/PASTE_|REPLACE_|YOUR_API_KEY|YOUR_SECRET|YOUR_PHONE|sk-or-|Bearer /.test(newText), 'a placeholder or key in a new node');
  if (PRIVATE) must(!/PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT|PASTE_YOUR_TEST_NUMBER|PASTE_META_WEBHOOK_VERIFY_TOKEN/.test(JSON.stringify(patched.nodes.filter((n) => n.type === 'n8n-nodes-base.set'))), 'a placeholder in your Config values');
  return `${values} existing Config values identical${PRIVATE ? ' (your real values present)' : ''}; new Config: Grist URL / registry id from W6 – Config, model from W13 – Config; no key, token or placeholder in any new node`;
});
group('8. W12 is still the ONLY WhatsApp sender; every new send goes through it', () => {
  const meta = patched.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta, ['W12 – Prepare request', 'W12 – Read reply']), `Meta URL in: ${meta}`);
  const wa = patched.nodes.filter((n) => JSON.stringify(n.credentials || {}).includes('WhatsApp Cloud API')).map((n) => n.name);
  must(same(wa, ['W12 – Meta send']), `WhatsApp credential on: ${wa}`);
  const calls = NEW.filter((n) => B[n].type === 'n8n-nodes-base.executeWorkflow');
  must(calls.length === 4 && calls.every((n) => B[n].parameters.workflowId.value === '={{ $workflow.id }}' && B[n].parameters.mode === 'each' && /Call 'W12 - WhatsApp send'$/.test(n)), `calls: ${calls}`);
  for (const n of NEW.filter((x) => B[x].type === 'n8n-nodes-base.code')) must(!/fetch\(|helpers\.httpRequest|graph\.facebook|require\(/.test(B[n].parameters.jsCode), `${n} reaches the network`);
  const http = NEW.filter((n) => B[n].type === 'n8n-nodes-base.httpRequest');
  must(http.every((n) => /tables\/|openrouter\.ai\/api\/v1\/chat\/completions/.test(B[n].parameters.url)), 'a new HTTP node outside Grist / OpenRouter');
  return `${calls.length} new "Call 'W12 - WhatsApp send'" nodes (this workflow, one run per message); new HTTP nodes: ${http.length - 1} Grist + 1 OpenRouter (W9)`;
});
group('9. pasted helpers identical to n8n/snippets/ (the tested code is the code that runs)', () => {
  const fn = (src, name) => { const s = src.indexOf(`function ${name}`); return src.slice(s, src.indexOf('\n}\n', s) + 3); };
  const CM = snip('clinic-modules.js'); const cmBlock = CM.slice(CM.indexOf('const CM_ROLE'), CM.indexOf('if (typeof module'));
  const guard = [fn(snip('normalize-phone.js'), 'normalizeIndianPhone'), ...['isTestMode', 'inQuietHours', 'decideSend'].map((n) => fn(snip('send-guard.js'), n))];
  let cm = 0; let g = 0;
  for (const n of NEW.filter((x) => B[x].type === 'n8n-nodes-base.code')) {
    const c = B[n].parameters.jsCode;
    if (/Pasted from n8n\/snippets\/clinic-modules\.js/.test(c)) { must(c.includes(cmBlock), `${n}: clinic-modules.js differs`); cm++; }
    if (/Pasted from n8n\/snippets\/normalize-phone\.js and n8n\/snippets\/send-guard\.js/.test(c)) { must(guard.every((x) => c.includes(x)), `${n}: send guard differs`); g++; }
    if (/\bcm[A-Z]\w*\(/.test(c)) must(c.includes(cmBlock), `${n} uses clinic-modules without pasting it`);
    if (/(?<![.\w])(decideSend|normalizeIndianPhone)\(/.test(c.replace(cmBlock, ''))) must(guard.every((x) => c.includes(x)), `${n} uses the send guard without pasting it`);
    new Function('$', '$input', '$json', '$getWorkflowStaticData', c);   // compiles
  }
  for (const n of [...W13_CHANGED]) must(B[n].parameters.jsCode.includes(snip('ai-receptionist.js').slice(snip('ai-receptionist.js').indexOf('const AI_INTENTS'), snip('ai-receptionist.js').indexOf('if (typeof module'))), n);
  return `${cm} nodes with clinic-modules.js, ${g} with the send guard; every new Code node compiles`;
});
group('10. every existing safety gate still there (W13 + the new staff gate; send guard rules)', () => {
  const code = B['W13 – Build Context'].parameters.jsCode;
  for (const gte of ['if (c.failed)', "c.ai_status && !(c.retry && c.ai_status === 'deferred')", 'AI_STOP_WORDS.test', "c.ai_mode === 'off'", 'if (c.opted_out)', 'if (c.paused)', 'if (c.needs_human && !c.after_handoff)', 'if (c.answered_after)', 'if (c.newer_inbound)', 'aiEmergencyIn(c.text)', 'if (c.staff_active)', 'c.night)', "['text', 'button', 'interactive']", 'c.ai_replies_last_hour >= c.max_per_hour']) must(code.includes(gte), `gate missing: ${gte}`);
  must(code.indexOf('aiEmergencyIn(c.text)') < code.indexOf('if (c.staff_active)'), 'the staff gate runs before the emergency check');
  for (const s of ['W7', 'W8']) {
    const c = B[`${s} – Decide send`].parameters.jsCode;
    must(/kind: 'marketing'/.test(c) && /flag_value: \$json\.flag_value/.test(c) && /opted_out: \$json\.opted_out/.test(c) && /automation_paused: \$json\.automation_paused/.test(c), `${s} guard`);
    must(B[`${s} – Send?`] && patched.connections[`${s} – Send?`].main[0][0].node === `${s} – Build Message`, `${s}: no Send? gate before the message`);
  }
  return '14 W13 gates in order (STOP, opted out, paused, Needs_Human, emergency before the staff gate...); W7 / W8: flag, Opted_Out, Automation_Paused, quiet hours, TEST_MODE before any message';
});
group('11. canvas: each section inside its own band, nothing overlaps W11 or the next section', () => {
  const tops = { W7: 15008, W8: 15696, W9: 16368, W10: 17056, W11: 17728 };
  const order = ['W7', 'W8', 'W9', 'W10', 'W11'];
  for (const s of order.slice(0, 4)) {
    const st = B[`Section ${s}`];
    must(st.position[1] === tops[s] && st.position[1] + st.parameters.height < tops[order[order.indexOf(s) + 1]], `Section ${s} overlaps the next band`);
    for (const n of NEW.filter((x) => x.startsWith(`${s} – `))) {
      const [x, y] = B[n].position;
      must(y > st.position[1] + 200 && y + 100 <= st.position[1] + st.parameters.height && x >= st.position[0] && x + 100 <= st.position[0] + st.parameters.width, `${n} outside Section ${s}`);
    }
  }
});
group('12. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'nodeGroups', 'versionId']) must(same(orig[k], patched[k]), k);
  must(patched.active === false, 'active');
  must(!patched.settings || !patched.settings.errorWorkflow, 'errorWorkflow set: W11 (this workflow\'s Error Trigger) would not run');
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : `\nALL 12 CHECK GROUPS PASSED (${path.basename(PATCHED)})`);
process.exit(failed ? 1 : 0);
