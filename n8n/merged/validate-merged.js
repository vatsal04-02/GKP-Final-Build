// The 15 merge checks for clinic-autopilot-single-workflow.json. Exits 1 on the first failed check group.
//   node n8n/merged/validate-merged.js [--file <merged.json>] [--in <folder with the original exports>]
// With --in it also proves that, apart from the listed merge changes, every node and connection is exactly as exported.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = arg('--file', path.join(__dirname, 'clinic-autopilot-single-workflow.json'));
const IN = arg('--in');
const SEP = ' – ';
const T = {
  webhook: 'n8n-nodes-base.webhook', schedule: 'n8n-nodes-base.scheduleTrigger', error: 'n8n-nodes-base.errorTrigger',
  called: 'n8n-nodes-base.executeWorkflowTrigger', manual: 'n8n-nodes-base.manualTrigger', exec: 'n8n-nodes-base.executeWorkflow',
  sticky: 'n8n-nodes-base.stickyNote', http: 'n8n-nodes-base.httpRequest', code: 'n8n-nodes-base.code', if: 'n8n-nodes-base.if',
};
const TRIGGERS = [T.webhook, T.schedule, T.error, T.called, T.manual];
const lines = [];
const warnings = [];
let group = 0;
const check = (title, fn) => {
  group++;
  try { const detail = fn(); lines.push(`PASS ${String(group).padStart(2)}. ${title}${detail ? ` — ${detail}` : ''}`); } catch (e) {
    lines.push(`FAIL ${String(group).padStart(2)}. ${title} — ${e.message}`);
    console.log(lines.join('\n'));
    process.exit(1);
  }
};
const warn = (m) => warnings.push(m);

// 1 ---------------------------------------------------------------
let raw, wf;
check('JSON syntax is valid and has the n8n workflow shape', () => {
  raw = fs.readFileSync(FILE, 'utf8');
  wf = JSON.parse(raw);
  assert(Array.isArray(wf.nodes) && wf.connections && typeof wf.connections === 'object' && wf.settings, 'nodes / connections / settings missing');
  for (const n of wf.nodes) {
    assert(n.id && n.name && n.type && Number.isFinite(n.typeVersion) && Array.isArray(n.position) && n.position.length === 2, `bad node ${JSON.stringify(n.name)}`);
    assert(n.parameters && typeof n.parameters === 'object', `node ${n.name} has no parameters`);
  }
  return `${wf.nodes.length} nodes, ${wf.nodes.filter((n) => n.type !== T.sticky).length} functional, ${raw.length} bytes`;
});
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const moduleOf = (name) => (name.match(/^(W\d+) – /) || [])[1];
const functional = wf.nodes.filter((n) => n.type !== T.sticky);
const outputsOf = (n) => (n.type === T.if ? 2 : n.type === T.sticky ? 0 : 1);
const edges = [];
for (const [src, byType] of Object.entries(wf.connections)) for (const [t, outs] of Object.entries(byType)) outs.forEach((arr, oi) => (arr || []).forEach((c) => edges.push({ src, t, oi, dst: c.node, di: c.index, dt: c.type })));

// 2 ---------------------------------------------------------------
check('every connection references an existing node', () => {
  for (const e of edges) { assert(byName[e.src], `unknown source "${e.src}"`); assert(byName[e.dst], `unknown target "${e.dst}" (from ${e.src})`); }
  return `${edges.length} connections`;
});

// 3 ---------------------------------------------------------------
check('no duplicate node ids or names; every functional node is in a module (W<n> – …)', () => {
  const ids = wf.nodes.map((n) => n.id);
  const dupId = ids.find((x, i) => ids.indexOf(x) !== i);
  assert(!dupId, `duplicate id ${dupId}`);
  const names = wf.nodes.map((n) => n.name);
  const dupName = names.find((x, i) => names.indexOf(x) !== i);
  assert(!dupName, `duplicate name ${dupName}`);
  for (const n of functional) assert(moduleOf(n.name), `node "${n.name}" has no module prefix`);
  const hooks = wf.nodes.filter((n) => n.webhookId).map((n) => n.webhookId);
  assert.strictEqual(new Set(hooks).size, hooks.length, 'duplicate webhookId');
  return `${ids.length} unique ids, ${names.length} unique names`;
});

// 4 ---------------------------------------------------------------
check('no broken connections (valid output/input index, main type, no sticky ends, no cross-module wires)', () => {
  for (const e of edges) {
    const s = byName[e.src]; const d = byName[e.dst];
    assert(e.t === 'main' && e.dt === 'main', `${e.src} -> ${e.dst}: type ${e.t}/${e.dt}`);
    assert(e.oi < outputsOf(s), `${e.src} has no output ${e.oi}`);
    assert(e.di === 0, `${e.dst} input ${e.di}`);
    assert(s.type !== T.sticky && d.type !== T.sticky, 'sticky note in a connection');
    assert(!TRIGGERS.includes(d.type), `${e.src} -> trigger ${e.dst}`);
    assert.strictEqual(moduleOf(e.src), moduleOf(e.dst), `cross-module connection ${e.src} -> ${e.dst}`);
  }
  const incoming = new Set(edges.map((e) => e.dst));
  const orphans = functional.filter((n) => !TRIGGERS.includes(n.type) && !incoming.has(n.name));
  assert(!orphans.length, `nodes without input: ${orphans.map((n) => n.name).join(', ')}`);
  const idleTriggers = functional.filter((n) => TRIGGERS.includes(n.type) && !wf.connections[n.name]);
  idleTriggers.forEach((n) => warn(`trigger "${n.name}" is not connected (as in the export)`));
  const deadEnds = functional.filter((n) => n.type === T.if && (((wf.connections[n.name] || {}).main || []).length < 2 || wf.connections[n.name].main.some((a) => !a || !a.length)));
  deadEnds.forEach((n) => warn(`IF "${n.name}" has an output that goes nowhere (as in the export)`));
  return 'every edge is main -> main, inside one module';
});

// 5 ---------------------------------------------------------------
const hooks = functional.filter((n) => n.type === T.webhook);
check('webhook paths preserved and unique', () => {
  const keys = hooks.map((n) => `${n.parameters.httpMethod || 'GET'} ${n.parameters.path}`);
  assert.strictEqual(new Set(keys).size, keys.length, `duplicate webhook ${keys}`);
  const want = { 'W1 – Webhook': 'POST website-lead', 'W4 – Webhook1': 'POST cal', 'W4 – Webhook': 'POST cal-w4-test' };
  for (const [name, k] of Object.entries(want)) assert.strictEqual(`${byName[name].parameters.httpMethod} ${byName[name].parameters.path}`, k, name);
  assert.strictEqual(byName['W1 – Webhook'].parameters.authentication, 'headerAuth', 'W1 webhook lost its header auth');
  for (const n of hooks) assert(!(n.parameters.options || {}).responseMode || n.parameters.options.responseMode === 'onReceived', `${n.name} no longer answers immediately`);
  return keys.join(', ');
});

// 6 ---------------------------------------------------------------
const trig = (type) => functional.filter((n) => n.type === type);
check('trigger nodes valid (1 Error Trigger, 1 Execute Workflow Trigger, <=1 Manual Trigger, schedules + webhooks in their modules)', () => {
  assert.strictEqual(trig(T.error).length, 1, 'Error Trigger count');
  assert.strictEqual(moduleOf(trig(T.error)[0].name), 'W11');
  assert.strictEqual(trig(T.called).length, 1, 'Execute Workflow Trigger count');
  assert.strictEqual(moduleOf(trig(T.called)[0].name), 'W12');
  assert.strictEqual(trig(T.called)[0].parameters.inputSource, 'passthrough', 'W12 trigger must accept the whole caller item');
  assert(trig(T.manual).length <= 1, 'more than one Manual Trigger');
  const sched = trig(T.schedule).map((n) => moduleOf(n.name)).sort().join(',');
  assert.strictEqual(sched, 'W3,W5,W6', `schedules in ${sched}`);
  return functional.filter((n) => TRIGGERS.includes(n.type)).map((n) => n.name).join(' | ');
});

// 7 ---------------------------------------------------------------
const OLD_IDS = ['Ota9hfoDSNc0gKla', 'WMrHLwPI0HIHCHTy', 'gekhZgOUG3Ja2610', 'qK8PJnJXJq8nfvYh', 'CKLSYcYcauxPWKvg', 'bzsRGJqIW1xcM9eQ', 'wJyVEscB9qqKOOx3'];
const execs = functional.filter((n) => n.type === T.exec);
check('Execute Workflow nodes call THIS workflow (no old workflow ids left in any functional node or setting)', () => {
  assert.strictEqual(execs.length, 3, `expected 3 sender calls, found ${execs.length}`);
  for (const n of execs) {
    assert.deepStrictEqual(n.parameters.workflowId, { __rl: true, value: '={{ $workflow.id }}', mode: 'id' }, n.name);
    assert.strictEqual(n.parameters.mode, 'each', `${n.name} must call once per item (W12 reads .first())`);
    assert(!n.parameters.source || n.parameters.source === 'database', n.name);
  }
  const text = JSON.stringify({ nodes: functional, settings: wf.settings });
  for (const id of OLD_IDS) assert(!text.includes(id), `old workflow id ${id} still referenced`);
  return execs.map((n) => n.name).join(', ');
});

// reachability over connections only (an Execute Workflow call is a separate run, not an edge)
const reach = (start) => {
  const seen = new Set([start]); const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const e of edges.filter((x) => x.src === cur)) if (!seen.has(e.dst)) { seen.add(e.dst); q.push(e.dst); }
  }
  return seen;
};

// 8 ---------------------------------------------------------------
check('W12 cannot call itself (no Execute Workflow node is reachable from the W12 triggers)', () => {
  for (const t of [...trig(T.called), ...trig(T.manual)]) {
    const r = [...reach(t.name)];
    const bad = r.filter((x) => byName[x].type === T.exec);
    assert(!bad.length, `${t.name} reaches ${bad}`);
    assert(r.every((x) => moduleOf(x) === 'W12'), `${t.name} leaves W12`);
  }
  assert(functional.filter((n) => moduleOf(n.name) === 'W12').every((n) => n.type !== T.exec), 'W12 contains an Execute Workflow node');
  return `W12 path: ${[...reach(trig(T.called)[0].name)].length} nodes, ends at "W12 – Return result"`;
});

// 9 ---------------------------------------------------------------
check('W11 cannot trigger itself (no errorWorkflow setting, no Stop and Error / Execute Workflow on the error path)', () => {
  assert(!('errorWorkflow' in wf.settings), 'settings.errorWorkflow must stay empty (this workflow is its own error workflow)');
  const r = [...reach(trig(T.error)[0].name)];
  assert(r.every((x) => moduleOf(x) === 'W11'), 'error path leaves W11');
  assert(r.every((x) => ![T.exec, 'n8n-nodes-base.stopAndError'].includes(byName[x].type)), 'error path can raise or call');
  const tg = byName['W11 – Telegram alert'];
  assert(tg && tg.retryOnFail === true && !tg.onError, 'Telegram node settings changed');
  warn('a failure of the Telegram alert itself fails the error run; n8n then stops (mode "error" never starts another error run)');
  return `error path: ${r.join(' -> ')}`;
});

// 10, 11 ----------------------------------------------------------
const reachSets = functional.filter((n) => TRIGGERS.includes(n.type)).map((n) => ({ t: n.name, set: reach(n.name) }));
const disjoint = (a, b) => [...a.set].filter((x) => b.set.has(x));
check('independent schedules stay independent (own rule, disjoint node sets)', () => {
  const s = reachSets.filter((x) => byName[x.t].type === T.schedule);
  const rules = Object.fromEntries(s.map((x) => [x.t, JSON.stringify(byName[x.t].parameters.rule)]));
  assert.strictEqual(rules['W3 – Every 10 minutes'], JSON.stringify({ interval: [{ field: 'minutes', minutesInterval: 10 }] }));
  assert.strictEqual(rules['W5 – Every 15 minutes'], JSON.stringify({ interval: [{ field: 'minutes', minutesInterval: 15 }] }));
  assert.strictEqual(rules['W6 – Daily 10:00'], JSON.stringify({ interval: [{ field: 'cronExpression', expression: '0 10 * * *' }] }));
  for (const a of s) for (const b of s) if (a !== b) assert(!disjoint(a, b).length, `${a.t} and ${b.t} share ${disjoint(a, b)}`);
  return s.map((x) => `${x.t} (${x.set.size} nodes)`).join(', ');
});
check('webhook branches stay independent (no node shared with any other trigger)', () => {
  const allowedPair = (a, b) => [a, b].every((t) => ['W12 – When called by another workflow', 'W12 – Manual test'].includes(t));
  for (const a of reachSets) for (const b of reachSets) {
    if (a === b || allowedPair(a.t, b.t)) continue;
    assert(!disjoint(a, b).length, `${a.t} and ${b.t} share ${disjoint(a, b)}`);
  }
  return `${reachSets.length} triggers; only the two W12 entry points share the W12 engine (by design)`;
});

// 12 --------------------------------------------------------------
const NEEDED = ['decision', 'template', 'template_params', 'wa_phone_number_id', 'audience', 'source_workflow', 'message_text'];
check('W12 receives the fields it reads from every caller (the node feeding each call sets them)', () => {
  const out = [];
  for (const n of execs) {
    const feeders = edges.filter((e) => e.dst === n.name).map((e) => byName[e.src]);
    assert.strictEqual(feeders.length, 1, `${n.name} has ${feeders.length} inputs`);
    const code = feeders[0].parameters.jsCode || '';
    for (const k of NEEDED) assert(new RegExp(`\\b${k}\\s*[:,]`).test(code), `${feeders[0].name} does not set ${k}`);
    assert(/\.\.\.item/.test(code), `${feeders[0].name} does not pass the caller item through (grist_base_url, doc_id, flags)`);
    out.push(feeders[0].name);
  }
  const prep = byName['W12 – Prepare request'].parameters.jsCode;
  for (const k of ['decision', 'template', 'template_params', 'wa_phone_number_id']) assert(prep.includes(`input.${k}`), `W12 no longer reads ${k}`);
  return `feeders: ${out.join(', ')}`;
});

// 13 --------------------------------------------------------------
check('W12 returns its result to the calling branch (same-module next node, caller item + result fields)', () => {
  const ret = byName['W12 – Return result'].parameters.jsCode;
  assert(/\.\.\.p\.input/.test(ret), 'Return result no longer spreads the caller item');
  for (const k of ['sent', 'send_status', 'wa_message_id', 'send_error']) assert(ret.includes(`${k}:`), `Return result lacks ${k}`);
  assert(!wf.connections['W12 – Return result'], 'Return result must be the last node (its output is what the caller gets)');
  const routes = [];
  for (const n of execs) {
    const next = edges.filter((e) => e.src === n.name).map((e) => e.dst);
    assert.strictEqual(next.length, 1, `${n.name} -> ${next}`);
    assert.strictEqual(moduleOf(next[0]), moduleOf(n.name), `${n.name} returns into another module`);
    assert(/\$json\.sent\b/.test(JSON.stringify(byName[next[0]].parameters)), `${next[0]} does not test $json.sent`);
    routes.push(`${n.name} -> ${next[0]}`);
  }
  return routes.join('; ');
});

// 14 --------------------------------------------------------------
check('credentials referenced correctly (by id + name, none invented)', () => {
  const KNOWN = {
    '9J6XxrIQoFDcQZ0Y': 'Header Auth account 2', dP1cyJMLSBR822tU: 'Header Auth account', k01hgCFOtdH5hdiq: 'WhatsApp Cloud API', NzFVBwmYZTH1K6L8: 'Telegram account',
  };
  const used = {};
  for (const n of functional) {
    for (const [type, c] of Object.entries(n.credentials || {})) {
      assert(KNOWN[c.id] && KNOWN[c.id] === c.name, `${n.name}: unknown credential ${type} ${c.id}/${c.name}`);
      used[c.name] = (used[c.name] || 0) + 1;
    }
    if (n.type === T.http) {
      assert(n.credentials && n.credentials.httpHeaderAuth, `${n.name} has no credential`);
      const url = String(n.parameters.url);
      const cred = n.credentials.httpHeaderAuth.name;
      if (url.includes('graph.facebook.com') || url.includes('meta_url')) assert.strictEqual(cred, 'WhatsApp Cloud API', n.name);
      else if (url.includes('/api/docs/')) assert.strictEqual(cred, 'Header Auth account 2', `${n.name} calls Grist with the "${cred}" credential`);
      else assert.notStrictEqual(cred, 'WhatsApp Cloud API', `${n.name} uses the WhatsApp credential for a non-Meta call`);
    }
  }
  const meta = functional.filter((n) => (n.credentials || {}).httpHeaderAuth && n.credentials.httpHeaderAuth.name === 'WhatsApp Cloud API').map((n) => n.name);
  assert.deepStrictEqual(meta, ['W12 – Meta send'], `the WhatsApp credential must be used by W12 – Meta send only, found: ${meta}`);
  assert(functional.filter((n) => n.type === T.http && String(n.parameters.url).includes('graph.facebook.com') || (n.parameters.url === '={{ $json.prep.meta_url }}')).length === 1, 'more than one Meta HTTP node');
  assert.strictEqual(byName['W1 – Webhook'].credentials.httpHeaderAuth.name, 'Header Auth account');
  assert.strictEqual(byName['W11 – Telegram alert'].credentials.telegramApi.name, 'Telegram account');
  return Object.entries(used).map(([k, v]) => `${k} x${v}`).join(', ');
});

// 15 --------------------------------------------------------------
check('no secret or token values in the file (placeholders only)', () => {
  const sec = byName['W4 – Config'].parameters.assignments.assignments.find((a) => a.name === 'cal_webhook_secret');
  assert(sec && sec.value === 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT', 'cal_webhook_secret is not the placeholder');
  const text = JSON.stringify({ nodes: wf.nodes, settings: wf.settings });
  const PATTERNS = [
    [/EAA[A-Za-z0-9]{20,}/, 'Meta access token'], [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token'],
    [/Bearer\s+[A-Za-z0-9._-]{16,}/, 'Bearer token'], [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  ];
  for (const [re, what] of PATTERNS) assert(!re.test(text), `${what} found`);
  for (const n of wf.nodes) for (const a of ((n.parameters.assignments || {}).assignments || [])) {
    if (/secret|token|password|api[_-]?key/i.test(a.name)) assert(/^PASTE_|^$/.test(String(a.value)), `${n.name} > ${a.name} holds a value`);
  }
  const phones = [...text.matchAll(/(?<![\dA-Za-z])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g)].map((m) => m[0]);
  const sample = phones.filter((p) => !/^(\+?91[\s-]?)?(98765[\s-]?43210|90000[\s-]?00001)$/.test(p));
  assert(!sample.length, `phone-like values left: ${sample.length}`);
  return 'cal_webhook_secret + allowlisted numbers are placeholders; no token patterns';
});

// 16 --------------------------------------------------------------
check('the safety guards are intact (real clock everywhere, decision never rebuilt, TEST_MODE / allowlist settings unchanged)', () => {
  for (const n of functional.filter((x) => x.type === T.code)) {
    const code = n.parameters.jsCode || '';
    assert(!/new Date\(\s*['"`]20\d\d-/.test(code), `${n.name} uses a fixed test date instead of the real clock`);
  }
  for (const m of ['W3', 'W5', 'W6']) assert(/now_ms:\s*Date\.now\(\)/.test(byName[`${m} – Decide send`].parameters.jsCode), `${m} – Decide send must use now_ms: Date.now()`);
  assert(/waPrepare\(\s*input,\s*cfg,\s*Date\.now\(\),/.test(byName['W12 – Prepare request'].parameters.jsCode), 'W12 – Prepare request must call waPrepare with Date.now()');
  for (const n of ['W12 – Prepare request', 'W5 – Decide send', 'W6 – Decide send', 'W3 – Decide send']) assert(/function inQuietHours[\s\S]*hourIST >= 21 \|\| hourIST < 8/.test(byName[n].parameters.jsCode), `${n}: the 21:00-08:00 IST rule changed`);
  assert(!byName['W5 – Decide send'].executeOnce, 'W5 – Decide send is still Execute Once');
  const w5 = byName['W5 – Code in JavaScript'];
  assert.strictEqual(w5.parameters.mode, 'runOnceForEachItem');
  assert(/decision\s*=\s*item\.decision\s*\|\|/.test(w5.parameters.jsCode) && /^\s*decision,\s*$/m.test(w5.parameters.jsCode), 'W5 – Code in JavaScript must pass the Decide send decision through');
  assert(!/test_mode:\s*Boolean/.test(w5.parameters.jsCode) && !/decision\s*:\s*\{/.test(w5.parameters.jsCode), 'W5 – Code in JavaScript rebuilds the decision again');
  const cfg = Object.fromEntries(byName['W12 – Config'].parameters.assignments.assignments.map((a) => [a.name, a.value]));
  assert.strictEqual(cfg.w12_send_mode, 'allowlist', 'w12_send_mode must stay allowlist');
  assert.strictEqual(cfg.w12_uncertain_counts_as_sent, true);
  const prep = byName['W12 – Prepare request'].parameters.jsCode;
  assert(/if \(mode === 'allowlist'\)[\s\S]*is not in the W12 allowlist/.test(prep) && /inQuietHours\(nowMs\)\) return stop\('blocked', 'quiet hours/.test(prep), 'W12 allowlist / quiet-hours guard changed');
  return 'W3 / W5 / W6 / W12 use Date.now(); W5 passes the guard decision through; send_mode = allowlist';
});

// with --in: everything else is byte-for-byte what was exported -------------------------------
if (IN) {
  check('nothing else changed: every exported node and connection is present and identical apart from the merge changes, the 5 requested fixes and A-01', () => {
    const SKIP = new Set(['W4 – Config.cal_webhook_secret']);
    const files = fs.readdirSync(IN).filter((x) => x.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8')));
    // the private numbers come from the export itself (W12 Config allowlist), never from this file
    const w12 = files.find((x) => /^W12\b/.test(String(x.name)));
    const allow = ((w12.nodes.find((n) => n.name === 'Config').parameters.assignments || {}).assignments || []).find((x) => x.name === 'w12_allowlist');
    const phoneRes = String(allow ? allow.value : '').split(/[,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10)
      .map((d) => { const t = d.slice(-10); return new RegExp(`(\\+?91[\\s-]?)?${t.slice(0, 5)}[\\s-]?${t.slice(5)}`, 'g'); });
    // The only nodes allowed to differ from the exports (the five fixes, README section 3) and exactly how.
    const CLOCK = "new Date('2026-10-05T10:00:00+05:30').getTime()";
    const W5_NEW1 = "// The recipient and the send / no-send answer come ONLY from \"Decide send\" (Opted_Out, sent flag, quiet hours,\n// TEST_MODE -> TEST_PHONE). Never rebuild them here; W12 checks them again before calling Meta.\nconst decision = item.decision || { send: false, to: null, reason: 'W5: no decision from Decide send', test_mode: true };";
    const W5_OLD1 = "const to = String(phone).replace(/\\D/g, '');\n\nconst send = Boolean(item.send !== false);";
    const W5_OLD2 = "    decision: {\n      send,\n      to,\n      reason: 'W5 reminder',\n      test_mode: Boolean(item.test_mode),\n    },";
    // A-01: W12's pasted wa-send.js block must be EXACTLY n8n/snippets/wa-send.js; in the export it is the older version. Both sides
    // get the block replaced by a marker, so the rest of the two nodes must still be identical to the export.
    const WA = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'wa-send.js'), 'utf8');
    const WA_BLOCK = WA.slice(WA.indexOf('const WA_TEMPLATES'), WA.indexOf('if (typeof module'));
    const waSendBack = (code) => { assert.strictEqual(code.split(WA_BLOCK).length, 2, 'W12 code does not embed n8n/snippets/wa-send.js exactly once'); return code.replace(WA_BLOCK, '<<wa-send.js>>'); };
    const waSendMark = (o) => {
      const c = o.jsCode; const start = c.indexOf('const WA_TEMPLATES'); const end = c.indexOf('\n}\n\n', c.indexOf('function waInboxRow', start)) + 4;
      assert(start >= 0 && end > start, 'export: wa-send.js block not found');
      o.jsCode = `${c.slice(0, start)}<<wa-send.js>>${c.slice(end)}`;
    };
    const UNDO = {
      'W5 – Decide send': { props: { executeOnce: true } },
      'W5 – Code in JavaScript': { params: (p) => { assert.strictEqual(p.mode, 'runOnceForEachItem'); delete p.mode; p.jsCode = p.jsCode.replace(W5_NEW1, W5_OLD1).replace('    decision,', W5_OLD2); } },
      'W6 – Decide send': { params: (p) => { p.jsCode = p.jsCode.replace('now_ms: Date.now(),', `now_ms: ${CLOCK},`); } },
      'W12 – Prepare request': { params: (p) => { p.jsCode = waSendBack(p.jsCode).replace('  Date.now(),\n', `  ${CLOCK},\n`); }, orig: waSendMark },
      'W12 – Read reply': { params: (p) => { p.jsCode = waSendBack(p.jsCode); }, orig: waSendMark },
      'W12 – Find conversation': { grist: true }, 'W12 – Create conversation': { grist: true }, 'W12 – Add message': { grist: true },
    };
    const seenFix = new Set();
    let count = 0;
    for (const src of files) {
      const m = (String(src.name).match(/^(W\d+)\b/) || [])[1];
      if (!m) continue;
      const map = Object.fromEntries(src.nodes.map((n) => [n.name, `${m}${SEP}${n.name}`]));
      for (const n of src.nodes) {
        const got = byName[map[n.name]];
        assert(got, `${map[n.name]} missing`);
        assert.strictEqual(got.id, n.id, `${got.name} id changed`);
        const u = UNDO[got.name];
        const view = { ...got, ...((u && u.props) || {}) };
        if (u && u.grist) {
          assert.deepStrictEqual(got.credentials, { httpHeaderAuth: byName['W5 – Clinics'].credentials.httpHeaderAuth }, `${got.name} must use the Grist credential`);
          assert.notDeepStrictEqual(got.credentials, n.credentials, `${got.name}: expected the fix to differ from the export`);
          view.credentials = n.credentials;
        }
        for (const k of ['type', 'typeVersion', 'credentials', 'webhookId', 'disabled', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'onError', 'notes']) {
          assert.deepStrictEqual(view[k], n[k], `${got.name}.${k} changed`);
        }
        // parameters: equal once the renamed references are mapped back and the merge-only edits are undone
        const back = JSON.parse(JSON.stringify(got.parameters));
        let s = JSON.stringify(back);
        for (const [o, nn] of Object.entries(map).sort((x, y) => y[1].length - x[1].length)) s = s.split(nn.replace(/"/g, '\\"')).join(o.replace(/"/g, '\\"'));
        const p = JSON.parse(s);
        const orig = JSON.parse(JSON.stringify(n.parameters));
        if (u) {
          seenFix.add(got.name);
          if (u.params) { const before = JSON.stringify(p); u.params(p); assert.notStrictEqual(JSON.stringify(p), before, `${got.name}: the fix was not found`); }
          if (u.orig) u.orig(orig);
        }
        if (n.type === T.exec) { delete p.workflowId; delete orig.workflowId; }
        if (p.assignments) for (const a of p.assignments.assignments) if (SKIP.has(`${got.name}.${a.name}`)) { a.value = null; const o = orig.assignments.assignments.find((x) => x.name === a.name); o.value = null; }
        const ps = JSON.stringify(p).replace(/PASTE_YOUR_TEST_NUMBER/g, 'PHONE');
        const os = phoneRes.reduce((acc, re) => acc.replace(re, 'PHONE'), JSON.stringify(orig));
        assert.strictEqual(ps, os, `${got.name} parameters differ beyond the merge changes`);
        count++;
      }
      for (const [srcName, byType] of Object.entries(src.connections || {})) {
        const mine = wf.connections[map[srcName]];
        assert(mine, `connections of ${map[srcName]} missing`);
        const expect = Object.fromEntries(Object.entries(byType).map(([t, outs]) => [t, outs.map((a) => (a || []).map((x) => ({ ...x, node: map[x.node] })))]));
        assert.deepStrictEqual(mine, expect, `connections of ${map[srcName]} changed`);
      }
    }
    assert.deepStrictEqual([...seenFix].sort(), Object.keys(UNDO).sort(), 'a fixed node was not found in the exports');
    return `${count - seenFix.size} exported nodes identical; ${seenFix.size} differ ONLY by the 5 fixes + A-01 (${[...seenFix].join(', ')}); all ids, connections and credentials of the rest identical`;
  });
}

console.log(lines.join('\n'));
if (warnings.length) console.log(`\nWarnings (kept as exported, listed in ISSUES FOUND BEFORE MERGE):\n${[...new Set(warnings)].map((w) => `  - ${w}`).join('\n')}`);
console.log(`\nALL ${group} CHECK GROUPS PASSED`);
