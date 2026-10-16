// The TEMPORARY quiet-hours test switch (DISABLE_QUIET_HOURS_FOR_TEST, n8n/snippets/quiet-hours-switch.js) end to end:
//   ON  = the switch on (your test file), OFF = the same file with the switch set to false (made here with the patcher),
//   BEFORE = the workflow without the switch (ai-updated-workflow-clinic.w7-w10.json).
// ON must skip ONLY the 21:00-08:00 IST quiet-hours check in W12, W13 and W7-W10; OFF must behave exactly like BEFORE.
// Run: node n8n/integrated/quiet-hours-switch.test.js      (QH_FILE / QH_ORIG = other files, e.g. your private pair)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const { inQuietHours } = require('../snippets/send-guard');
const { redact } = require('./redact');
const F = require('../tests/ai-fixtures');

const ON_FILE = process.env.QH_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.quiet-hours-test.json');
const BEFORE_FILE = process.env.QH_ORIG || path.join(__dirname, 'ai-updated-workflow-clinic.w7-w10.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-'));
const OFF_FILE = path.join(TMP, 'off.json');
const mk = spawnSync(process.execPath, [path.join(__dirname, 'apply-quiet-hours-switch.js'), '--in', ON_FILE, '--out', OFF_FILE, '--value', 'false', '--keep-private'], { encoding: 'utf8' });
if (mk.status !== 0) { console.log(`could not make the OFF file: ${mk.stderr}`); process.exit(1); }
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- live CRM naming, as in the other suites
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const prepare = (file) => {   // test values, in memory only
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const setv = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  setv('W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000014,${OWNER},${TESTP}`);
  setv('W2 – Verify Config', 'meta_verify_token', 'test-verify-token-123');
  setv('W4 – Config', 'cal_webhook_secret', 'test-cal-secret-456');
  const ti = w.nodes.find((n) => n.name === 'W12 – Test input');
  ti.parameters.jsCode = ti.parameters.jsCode.replace(/to: '[^']*'/, `to: '${TESTP}'`).replace(/wa_phone_number_id: '[^']*'/, `wa_phone_number_id: '${PNID}'`);
  return w;
};
const WF = { ON: prepare(ON_FILE), OFF: prepare(OFF_FILE), BEFORE: prepare(BEFORE_FILE) };

const T = F.sec(F.NOW);
const HOUR = 3600, DAY = 86400;
const at = (s) => Date.parse(`${s}+05:30`);
const NIGHT = at('2026-10-06T22:00:00');
const crm = ({ settings = {}, msgs, convs, leads, appts } = {}) => new FakeGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', outcome_checkin: 'on', review_requests: 'on', review_link: 'https://g.page/r/demo-physio-test/review', weekly_report_whatsapp: 'on', ...settings }),
    Knowledge: clone(F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()), Conversations: clone(convs || F.conversationRows()),
    Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || []), Run_Log: [],
  },
});
const fakeMeta = (answer) => { const calls = []; const fn = (m, url, body) => { calls.push({ url, body }); return (answer && answer(body)) || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; }; fn.calls = calls; return fn; };
const reportAi = () => { const calls = []; const fn = (m, u, h, body) => { calls.push(body); return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ summary: 'A quiet week.', observations: [], recommendations: [] }) } }] } }; }; fn.calls = calls; return fn; };
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const run = (which, start, items, o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = F.fakeClaude(o.ai);
  const r = simulate(WF[which], { start, items, grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: o.openrouter || F.fakeOpenRouter(claude) });
  const runs = allRuns(r);
  const w12 = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
  const metaRuns = runs.filter((x) => x.visited.includes('W12 – Meta send'));
  return { r, g, meta, claude, runs, w12, metaRuns, errors: runs.filter((x) => x.error).map((x) => x.error) };
};
const tick = (which, start, o = {}) => run(which, start, [{ json: {} }], o);
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const metaBody = (text, ts, id) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
  contacts: [{ profile: { name: 'Asha Patel' }, wa_id: P_ASHA }], messages: [{ from: P_ASHA, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });
let seq = 0;
const post = (which, text, o = {}) => {
  const now = o.now || NIGHT;
  const x = run(which, 'W2 – Webhook Inbound', [{ json: { headers: {}, params: {}, query: {}, body: metaBody(text, F.sec(now) - 5, o.id || `wamid.QH.${++seq}`) } }], { ...o, now });
  x.last = rows(x.g, 'Messages').filter((m) => m.Direction === 'In').pop();
  x.conv = rows(x.g, 'Conversations')[0];
  return x;
};
const manual = (which, now) => { const x = tick(which, 'W12 – Manual test', { now }); x.out = x.r.runData['W12 – Return result'][0].json; return x; };
// Everything observable: the CRM afterwards, what went to Meta, how often the AI was asked, errors.
const snap = (x) => JSON.stringify({ docs: x.g.docs, meta: x.meta.calls, ai: x.claude.calls.length, errors: x.errors });
const sameAsBefore = (fn) => { const a = fn('OFF'); const b = fn('BEFORE'); assert.strictEqual(snap(a), snap(b), 'OFF differs from BEFORE'); return [a, b]; };
const onlyW12 = (x) => assert.strictEqual(x.meta.calls.length, x.metaRuns.length, 'a Meta call that did not come from W12');

const W7_APPTS = () => [{ id: 11, fields: { Booking_UID: 'cal-qh-asha', Lead: 1, Service: 'Knee pain physiotherapy', Start: T - 23 * HOUR, End: T - 22 * HOUR, Status: 'Completed' } }];
const STAFF = () => ({ id: 50, fields: { Conversation: 1, Direction: 'Out', Body: 'Hi Asha, Dr Mehta can see you tomorrow at 10.', Sent_By: 'Ravi', Send: true, Created_At: F.sec(NIGHT) - 60 } });
const W10_CONV = () => [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: F.sec(NIGHT) - HOUR, Unread: 1, Automation_Paused: false } }];

const results = [];
const check = (id, title, fn) => { try { const why = fn(); results.push({ id, title, ok: true, why: why || '' }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n').slice(0, 3).join(' ') }); } };

// ================================================================ the switch itself
check('U.1', 'one switch, one value in all 7 nodes; the original rule kept', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'quiet-hours-switch.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf('// ---- TEMPORARY TEST SWITCH'), SRC.indexOf('// ---- end of the test switch ----\n') + '// ---- end of the test switch ----\n'.length);
  const wrapped = (v) => new Function('inQuietHours', `${block.replace(/= (true|false);/, `= ${v};`)}\nreturn inQuietHours;`)(inQuietHours);
  const off = wrapped(false); const on = wrapped(true);
  let n = 0;
  for (let t = at('2026-10-06T00:00:00'); t < at('2026-10-08T00:00:00'); t += 60000) { assert.strictEqual(off(t), inQuietHours(t), new Date(t).toISOString()); assert.strictEqual(on(t), false); n++; }
  assert.deepStrictEqual([off(NaN), on(NaN)], [true, false]);
  const TARGETS = ['W12 – Prepare request', 'W13 – Build Context', 'W13 – Plan Ready', 'W7 – Decide send', 'W8 – Decide send', 'W9 – Owner message', 'W10 – Check'];
  for (const [name, v] of [['ON', 'true'], ['OFF', 'false']]) {
    const has = WF[name].nodes.filter((x) => String((x.parameters || {}).jsCode || '').includes('DISABLE_QUIET_HOURS_FOR_TEST')).map((x) => x.name);
    assert.deepStrictEqual(has.sort(), [...TARGETS].sort(), `${name}: switch in ${has}`);
    for (const t of TARGETS) {
      const c = WF[name].nodes.find((x) => x.name === t).parameters.jsCode;
      assert(c.includes(block.replace(/= (true|false);/, `= ${v};`)) && c.includes('function inQuietHours(nowMs) {') && c.includes('return hourIST >= 21 || hourIST < 8;'), t);
    }
  }
  return `false: identical to the original inQuietHours() for all ${n} minutes of 2 days; true: never quiet; the switch is in exactly the 7 nodes, with one value; the original function is still in each`;
});

// ================================================================ the 4 requested cases
check('A', 'W13 during 21:00-08:00, switch TRUE -> NOT deferred', () => {
  for (const t of ['2026-10-06T22:00:00', '2026-10-07T03:00:00', '2026-10-07T07:59:00']) {
    const x = post('ON', 'How much does this cost?', { now: at(t) });
    onlyW12(x);
    assert.deepStrictEqual([x.errors, x.claude.calls.length, x.last.AI_Status, x.meta.calls.length, x.meta.calls[0].body.type], [[], 1, 'replied', 1, 'text'], t);
    const b = post('BEFORE', 'How much does this cost?', { now: at(t) });
    assert.deepStrictEqual([b.claude.calls.length, b.last.AI_Status, b.meta.calls.length], [0, 'deferred', 0], t);
  }
  return '22:00, 03:00, 07:59: the AI answers at once and the reply goes out through W12 (the workflow without the switch defers all three)';
});
check('B', 'W12 manual send during quiet hours, switch TRUE -> send allowed', () => {
  const x = manual('ON', NIGHT);
  assert.deepStrictEqual([x.out.sent, x.out.send_status, x.meta.calls.length, x.meta.calls[0].body.to, x.meta.calls[0].body.template.name], [true, 'accepted', 1, TESTP.slice(1), 'hello_world']);
  const y = tick('ON', 'W7 – Every hour', { crm: { appts: W7_APPTS() }, now: at('2026-10-06T23:20:00') });
  onlyW12(y);
  assert.deepStrictEqual([y.meta.calls.length, y.w12[0].runData['W12 – Return result'][0].json.sent], [1, true]);
  return '22:00: the W12 manual test sends hello_world (Meta called once); a patient message W7 hands to W12 at 23:20 is sent too';
});
check('C', 'W13 during quiet hours, switch FALSE -> deferred exactly as before', () => {
  for (const t of ['2026-10-06T21:00:00', '2026-10-06T22:00:00', '2026-10-07T03:00:00', '2026-10-07T07:59:00']) {
    const [a] = sameAsBefore((w) => post(w, 'How much does this cost?', { now: at(t), id: `wamid.C.${t}` }));
    assert.deepStrictEqual([a.claude.calls.length, a.last.AI_Status, a.meta.calls.length], [0, 'deferred', 0], t);
  }
  const g = post('OFF', 'How much does this cost?', { now: NIGHT, id: 'wamid.C.retry' }).g;
  const morning = tick('OFF', 'W13 – Every Morning', { g, now: at('2026-10-07T08:05:00') });
  assert.deepStrictEqual([morning.meta.calls.length, rows(g, 'Messages').find((m) => m.WA_Message_ID === 'wamid.C.retry').AI_Status], [1, 'replied']);
  return '21:00, 22:00, 03:00, 07:59: no AI call, nothing sent, AI_Status deferred: CRM, sends and AI calls byte-identical to the workflow without the switch; the 08:05 run answers it';
});
check('D', 'W12 with switch FALSE -> quiet-hours blocking exactly as before', () => {
  for (const [t, sent] of [['2026-10-06T20:59:00', true], ['2026-10-06T21:00:00', false], ['2026-10-07T03:00:00', false], ['2026-10-07T07:59:00', false], ['2026-10-07T08:00:00', true]]) {
    const [a] = sameAsBefore((w) => manual(w, at(t)));
    assert.deepStrictEqual([a.out.sent, a.meta.calls.length, a.out.send_error], [sent, sent ? 1 : 0, sent ? '' : 'quiet hours (21:00-08:00 IST)'], t);
  }
  const [y] = sameAsBefore((w) => tick(w, 'W7 – Every hour', { crm: { appts: W7_APPTS() }, now: at('2026-10-06T23:20:00') }));
  assert.strictEqual(y.meta.calls.length, 0);
  return '20:59 sends, 21:00 / 03:00 / 07:59 blocked "quiet hours (21:00-08:00 IST)", 08:00 sends: identical to the workflow without the switch';
});

// ================================================================ every other safety gate, at night with the switch ON
check('E.1', 'STOP / opt-out still works', () => {
  const x = post('ON', 'STOP');
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, x.last.AI_Status, rows(x.g, 'LEADS').find((l) => l.id === 1).Opted_Out], [0, 0, 'opted_out', true]);
  const leads = F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l));
  const w7 = tick('ON', 'W7 – Every hour', { crm: { appts: W7_APPTS(), leads }, now: at('2026-10-06T23:20:00') });
  const w10 = tick('ON', 'W10 – Every minute', { crm: { leads, convs: W10_CONV(), msgs: [...F.messageRows(), STAFF()] }, now: NIGHT });
  assert.deepStrictEqual([w7.meta.calls.length, w10.meta.calls.length, rows(w10.g, 'Messages').find((m) => m.id === 50).Status], [0, 0, 'failed']);
  return 'STOP at 22:00: opted out, nothing sent, no AI; an opted-out patient gets no W7 check-in and no W10 staff reply at night';
});
check('E.2', 'Needs_Human still works', () => {
  const convs = [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 5 * DAY, Unread: 0, Needs_Human: true } }];
  const x = post('ON', 'How much does this cost?', { crm: { convs } });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length, x.last.AI_Status], [0, 0, 'skipped']);
  return 'Needs_Human ticked (by hand): the AI stays silent at night too';
});
check('E.3', 'emergency hand-off still works', () => {
  const x = post('ON', 'I have severe chest pain');
  onlyW12(x);
  assert.deepStrictEqual([x.claude.calls.length, x.last.AI_Status, x.conv.Needs_Human, /^URGENT/.test(x.conv.Handoff_Reason), x.meta.calls.length], [0, 'handed_off', true, true, 2]);
  return 'URGENT hand-off before any AI call; with quiet hours off the holding reply and the staff alert go out at once (instead of 08:05)';
});
check('E.4', 'duplicate protection still works', () => {
  const x = post('ON', 'How much does this cost?', { id: 'wamid.DUP.QH' });
  const y = post('ON', 'How much does this cost?', { id: 'wamid.DUP.QH', g: x.g });
  assert.deepStrictEqual([rows(x.g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.DUP.QH').length, x.claude.calls.length + y.claude.calls.length, x.meta.calls.length + y.meta.calls.length], [1, 1, 1]);
  const g = crm({ appts: W7_APPTS() });
  const a = tick('ON', 'W7 – Every hour', { g, now: at('2026-10-06T23:20:00') });
  const b = tick('ON', 'W7 – Every hour', { g, now: at('2026-10-07T00:20:00') });
  const s = crm({ convs: W10_CONV(), msgs: [...F.messageRows(), STAFF()] });
  const c = tick('ON', 'W10 – Every minute', { g: s, now: NIGHT });
  const d = tick('ON', 'W10 – Every minute', { g: s, now: NIGHT + 60000 });
  assert.deepStrictEqual([a.meta.calls.length, b.meta.calls.length, c.meta.calls.length, d.meta.calls.length], [1, 0, 1, 0]);
  return 'the same WhatsApp message twice: stored once, one AI call, one reply; W7 (Outcome_Sent) and W10 (claimed row) never send twice at night';
});
check('E.5', 'TEST_MODE still works', () => {
  const w7 = tick('ON', 'W7 – Every hour', { crm: { appts: W7_APPTS(), settings: { TEST_MODE: 'true' } }, now: at('2026-10-06T23:20:00') });
  const w13 = post('ON', 'How much does this cost?', { crm: { settings: { TEST_MODE: 'true' } } });
  const w10 = tick('ON', 'W10 – Every minute', { crm: { convs: W10_CONV(), msgs: [...F.messageRows(), STAFF()], settings: { TEST_MODE: 'true' } }, now: NIGHT });
  assert.deepStrictEqual([w7.meta.calls.map((c) => c.body.to), w13.meta.calls.map((c) => c.body.to), w10.meta.calls.map((c) => c.body.to)], [[TESTP.slice(1)], [TESTP.slice(1)], [TESTP.slice(1)]]);
  return 'TEST_MODE on: W7, W13 and W10 send to TEST_PHONE only, at night as by day';
});
check('E.6', 'W12 allowlist and 24 h window still work', () => {
  const item = (o) => ({ json: { source_workflow: 'QH-test', audience: 'staff', template: 'hello_world', template_params: {}, wa_phone_number_id: PNID, decision: { send: true, to: '+919111111111', reason: 't', test_mode: false }, ...o } });
  const a = run('ON', 'W12 – When called by another workflow', [item()], { now: NIGHT });
  const b = run('ON', 'W12 – When called by another workflow', [item({ message_type: 'text', text_body: 'hi', decision: { send: true, to: TESTP, reason: 't', test_mode: false }, last_inbound_at: F.sec(NIGHT) - 30 * HOUR })], { now: NIGHT });
  const ra = a.r.runData['W12 – Return result'][0].json; const rb = b.r.runData['W12 – Return result'][0].json;
  assert.deepStrictEqual([ra.sent, /allowlist/.test(ra.send_error), rb.sent, /24-hour/.test(rb.send_error), a.meta.calls.length + b.meta.calls.length], [false, true, false, true, 0]);
  return 'at 22:00: a number not on the allowlist is still blocked, free text outside the 24 h window still refused; Meta never called';
});
check('E.7', 'Automation_Paused, sent flags and opted-out reviews still apply in W7 / W8', () => {
  const paused = [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - 5 * DAY, Automation_Paused: true } }];
  const a = tick('ON', 'W7 – Every hour', { crm: { appts: W7_APPTS(), convs: paused }, now: at('2026-10-06T23:20:00') });
  const sent = [{ id: 21, fields: { Booking_UID: 'cal-qh-rev', Lead: 1, Start: T - 5 * HOUR, End: T - 4 * HOUR, Status: 'Completed', Review_Sent: T - HOUR } }];
  const b = tick('ON', 'W8 – Every hour', { crm: { appts: sent }, now: at('2026-10-06T23:35:00') });
  assert.deepStrictEqual([a.meta.calls.length, b.meta.calls.length], [0, 0]);
  return 'Automation_Paused: no check-in; Review_Sent already set: no second review request (at night, switch on)';
});

// ================================================================ W7-W10 at night: ON sends, OFF = before
check('F', 'W7 / W8 / W9 / W10 at night: switch TRUE sends, FALSE exactly as before', () => {
  const W8 = () => [{ id: 21, fields: { Booking_UID: 'cal-qh-rev', Lead: 1, Start: T - 5 * HOUR, End: T - 4 * HOUR, Status: 'Completed' } }];
  const cases = {
    W7: (w) => tick(w, 'W7 – Every hour', { crm: { appts: W7_APPTS() }, now: at('2026-10-06T23:20:00') }),
    W8: (w) => tick(w, 'W8 – Every hour', { crm: { appts: W8() }, now: at('2026-10-06T23:35:00') }),
    W9: (w) => tick(w, 'W9 – Monday 09:00', { crm: { settings: { owner_phone: OWNER } }, now: at('2026-10-12T22:00:00'), openrouter: reportAi() }),
    W10: (w) => tick(w, 'W10 – Every minute', { crm: { convs: W10_CONV(), msgs: [...F.messageRows(), STAFF()] }, now: NIGHT }),
  };
  const out = [];
  for (const [s, fn] of Object.entries(cases)) {
    const on = fn('ON');
    onlyW12(on);
    assert.deepStrictEqual([on.errors, on.meta.calls.length], [[], 1], `${s} ON`);
    const [off] = sameAsBefore(fn);
    assert.strictEqual(off.meta.calls.length, 0, `${s} OFF`);
    out.push(s);
  }
  return `${out.join(', ')}: one message each through W12 with the switch on; with it off nothing at night (W10: the row waits, W9: no owner copy), CRM byte-identical to the workflow without the switch`;
});
check('G', 'daytime: ON, OFF and the workflow without the switch behave identically', () => {
  const day = (w) => [post(w, 'How much does this cost?', { now: F.NOW, id: 'wamid.DAY' }), tick(w, 'W7 – Every hour', { crm: { appts: W7_APPTS() } }), manual(w, F.NOW),
    tick(w, 'W10 – Every minute', { crm: { convs: [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: T - HOUR, Unread: 1 } }], msgs: [...F.messageRows(), STAFF()] } })].map(snap).join('|');
  assert.strictEqual(day('ON'), day('BEFORE'));
  assert.strictEqual(day('OFF'), day('BEFORE'));
  return 'W13 reply, W7 check-in, W12 manual test, W10 staff reply at 11:00: CRM, sends and AI calls identical in all three';
});
check('H', 'scope: W3 / W4 / W5 / W6 keep their quiet hours (nodes untouched)', () => {
  const ids = ['W3 – Decide send', 'W4 – Plan writes', 'W5 – Decide send', 'W6 – Decide send'];
  for (const n of ids) assert.strictEqual(JSON.stringify(WF.ON.nodes.find((x) => x.name === n)), JSON.stringify(WF.BEFORE.nodes.find((x) => x.name === n)), n);
  const leads = [{ id: 1, fields: { Lead_id: 'L-1', Name: 'Asha', Phone: F.ASHA, Status: 'Booked', Created_At: T - 9 * DAY } }];
  const r24 = (now) => tick('ON', 'W5 – Every 15 minutes', { crm: { leads, appts: [{ id: 1, fields: { Booking_UID: 'u1', Lead: 1, Start: F.sec(now) + 22 * HOUR, Status: 'Booked' } }], convs: [], settings: { TEST_MODE: 'true' } }, now });
  assert.deepStrictEqual([r24(NIGHT).meta.calls.length, r24(at('2026-10-06T20:00:00')).meta.calls.length], [0, 1]);   // 20:00 = the control: it is due
  return 'their nodes are byte-identical to before; a W5 reminder at 22:00 is still held with the switch on (W5 was not in the request)';
});

// ================================================================ the existing suites
const sh = (file, env) => spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: { ...process.env, ...env } });
const fails = (r) => (r.stdout.match(/^(?:FAIL|\s+FAIL)\s+(.+)$/gm) || []).map((l) => l.replace(/^\s*FAIL\s+/, '').trim().split(/\s{2,}/)[0]);
const asCommitted = (file, name) => {   // existing-modules checks the placeholders of the committed file; your own file gets its redacted form
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(redact(JSON.parse(fs.readFileSync(file, 'utf8')))));
  return p;
};
const SRC = path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json');
const PRE_A1 = path.join(__dirname, 'source', 'ai-workflow-clinic.export.redacted.json');
const suites = (file, tag) => ({
  system: sh('system.test.js', { AI_CTX_FILE: file, AI_CTX_ORIG: SRC }),
  w7w10: sh('w7-w10.test.js', { W7W10_FILE: file }),
  integrated: sh('integrated.test.js', { INTEGRATED_FILE: file, INTEGRATED_NO_MUTATIONS: '1' }),
  modules: sh('existing-modules.test.js', { INTEGRATED_FILE: asCommitted(file, `${tag}-redacted.json`) }),
  handoff: sh('handoff-gate.test.js', { HANDOFF_FILE: file }),
  aios: sh('ai-os.test.js', { AI_OS_FILE: file, AI_OS_ORIG: PRE_A1, AI_OS_NO_MUTATIONS: '1' }),
});
const KNOWN = ['A5 W6 day-2 follow-up', 'A6 W3 message'];   // the 2 intended earlier A1-A6 differences (AI-CONTEXT-REPORT.md)
check('R.1', 'switch FALSE: every existing suite passes, as on the workflow without the switch', () => {
  const s = suites(OFF_FILE, 'off');
  for (const k of ['system', 'w7w10', 'integrated', 'modules', 'handoff']) assert.strictEqual(s[k].status, 0, `${k}: ${fails(s[k]).join(' | ')}`);
  const a = fails(s.aios).filter((f) => !KNOWN.some((k) => f.startsWith(k)));
  assert.deepStrictEqual(a, []);
  return 'system test 83, W7-W10 34, W2->W13->W12 18, 25 W1-W12 scenarios, Needs_Human 9, A1-A6 (2 known): all as before';
});
check('R.2', 'switch TRUE: the ONLY existing checks that change are the quiet-hours ones', () => {
  const s = suites(ON_FILE, 'on');
  const got = {
    system: fails(s.system).filter((f) => !/^X\.4/.test(f)),
    w7w10: fails(s.w7w10).filter((f) => !/^X\.4/.test(f)),
    integrated: fails(s.integrated),
    aios: fails(s.aios).filter((f) => !KNOWN.some((k) => f.startsWith(k))),
  };
  assert.deepStrictEqual(got, {
    system: ['W12.4 quiet hours'],
    w7w10: ['W7.4 quiet hours -> blocked', 'W8.5 quiet hours -> blocked', 'W10.9 quiet hours and TEST_MODE'],
    integrated: ['night: deferred at 22:00 without asking the AI; W13 – Every Morning (08:05) answers it through W12 the next day'],
    aios: ['A3 emergency at 22:00: nothing sent at night (W12 quiet hours unchanged), deferred; the 08:05 run sends the URGENT alert'],
  });
  assert(s.modules.status !== 0 && /W12 at 07:59/.test(s.modules.stderr) && !/W12 at 0?8:00|20:59/.test(s.modules.stderr), 'existing-modules: not (only) the W12 quiet-hours scenario');
  assert.strictEqual(s.handoff.status, 0);
  return 'exactly 7 checks, all about quiet hours (W12 at night, W13 night deferral, W7 / W8 / W10 at night, the night emergency alert, W12 at 07:59); everything else passes';
});
check('X.1', 'real connections', () => { throw new Error('NOT RUN: this sandbox cannot reach your n8n, Grist or Meta; test at night in your n8n with TEST_MODE on'); });

fs.rmSync(TMP, { recursive: true, force: true });
const width = Math.max(...results.map((r) => `${r.id} ${r.title}`.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${`${r.id} ${r.title}`.padEnd(width)}  ${r.why}`);
const bad = results.filter((r) => !r.ok && r.id !== 'X.1');
console.log(`\n${results.length - bad.length - 1} PASS, 1 known FAIL (needs your n8n), ${bad.length} unexpected FAIL`);
if (bad.length) process.exit(1);
console.log(`QUIET-HOURS SWITCH: ${results.length} checks run on ${path.basename(ON_FILE)}`);
