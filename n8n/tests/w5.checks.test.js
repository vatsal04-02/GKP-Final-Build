// Offline checks for W5-reminders.json. Run: node n8n/tests/w5.checks.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repo = process.argv[2] || path.join(__dirname, '..', '..');
const file = path.join(repo, 'n8n/workflows/W5-reminders.json');
const raw = fs.readFileSync(file, 'utf8');
const wf = JSON.parse(raw);
const schema = fs.readFileSync(path.join(repo, 'grist/schema.md'), 'utf8');
const phoneSrc = fs.readFileSync(path.join(repo, 'n8n/snippets/normalize-phone.js'), 'utf8');
const guardSrc = fs.readFileSync(path.join(repo, 'n8n/snippets/send-guard.js'), 'utf8');

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const node = (name) => wf.nodes.find((x) => x.name === name);

// ------------------------------------------------------------------ structure
console.log('structure');
const names = wf.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(wf.nodes.map((x) => x.id)).size, wf.nodes.length);
for (const [from, v] of Object.entries(wf.connections)) {
  assert(names.includes(from));
  for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), `missing ${t.node}`);
}
const seen = new Set(['Every 15 minutes']); const q = ['Every 15 minutes'];
while (q.length) for (const outs of (wf.connections[q.shift()] || { main: [] }).main) for (const t of outs || []) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
assert.deepStrictEqual(names.filter((x) => !seen.has(x) && x !== 'Notes'), []);
assert.strictEqual(node('Every 15 minutes').type, 'n8n-nodes-base.scheduleTrigger');
assert.deepStrictEqual(node('Every 15 minutes').parameters.rule.interval, [{ field: 'minutes', minutesInterval: 15 }]);
ok(`${names.length} nodes, unique, connected, runs every 15 minutes`);

let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
wf.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);

// the "Sent?" tail is only reachable from a real send; the stub must never feed it
assert.strictEqual(wf.connections['Send reminder (stub)'].main[0][0].node, 'Sent?');
assert.deepStrictEqual(wf.connections['Sent?'].main[0].map((t) => t.node), ['Prepare sent log']);
assert.strictEqual(wf.connections['Sent?'].main[1], undefined);
assert.deepStrictEqual(['Prepare sent log', 'Set sent flag', 'Write Run_Log'], ['Prepare sent log', 'Set sent flag', 'Write Run_Log'].filter((x, i, a) => wf.connections[x] === undefined ? i === a.length - 1 : wf.connections[x].main[0][0].node === a[i + 1]));
ok('flag is set (PATCH) before the Run_Log row, and only after a real send');

// ------------------------------------------------------------------ embedded snippets are verbatim
console.log('embedded snippets');
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const decideSrc = node('Decide send').parameters.jsCode;
const phoneFn = phoneSrc.match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0];
const guardFns = guardSrc.slice(guardSrc.indexOf('function isTestMode'), guardSrc.indexOf('// ---- n8n Code node body'));
assert(strip(decideSrc).includes(strip(phoneFn)), 'normalizeIndianPhone drifted');
assert(strip(decideSrc).includes(strip(guardFns)), 'send-guard drifted');
ok('Decide send contains normalizeIndianPhone and the send guard exactly as in n8n/snippets/');

// ------------------------------------------------------------------ run Code nodes
const runAll = (name, input, store = {}) => {
  const $ = (nm) => { if (!(nm in store)) throw new Error(`Node '${nm}' hasn't been executed`); return { all: () => store[nm], first: () => store[nm][0] }; };
  const $input = { all: () => input, first: () => input[0] };
  return new Function('$', '$input', node(name).parameters.jsCode)($, $input);
};
const runEach = (name, json, store = {}) => {
  const $ = (nm) => ({ first: () => ({ json: store[nm] }) });
  return new Function('$json', '$', node(name).parameters.jsCode)(json, $).json;
};
const items = (...js) => js.map((json) => ({ json }));

const realNow = Date.now;
const NOW = Date.parse('2026-10-05T10:00:00+05:30');   // 10:00 IST, a Monday
Date.now = () => NOW;
const inMin = (m) => Math.round((NOW + m * 60000) / 1000);

const cfg = { grist_base_url: 'http://grist:8484/', registry_doc_id: 'REG', r24_min_hours: 20, r24_max_hours: 24, r2_min_minutes: 45, r2_max_minutes: 120 };
const store0 = { Config: items(cfg) };

console.log('Split clinics');
const registry = { records: [
  { id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: ' DOCA ', Active: true } },
  { id: 2, fields: { Clinic_Slug: 'old', Clinic_Name: 'Old', Grist_Doc_ID: 'DOCB', Active: false } },
  { id: 3, fields: { Clinic_Slug: 'nodoc', Clinic_Name: 'No Doc', Grist_Doc_ID: '', Active: true } },
  { id: 4, fields: { Clinic_Slug: 'city-physio', Clinic_Name: 'City Physio', Grist_Doc_ID: 'DOCC', Active: true } },
] };
let clinics = runAll('Split clinics', items(registry), store0);
assert.deepStrictEqual(clinics.map((c) => c.json.doc_id), ['DOCA', 'DOCC']);
assert.strictEqual(clinics[0].json.grist_base_url, 'http://grist:8484');
assert.deepStrictEqual(runAll('Split clinics', items({ records: [] }), store0), []);
ok('only Active clinics that have a Grist_Doc_ID; trailing slash trimmed; none => no items (workflow just ends)');

console.log('Add settings');
const settingsA = { records: [{ fields: { Key: 'clinic_name', Value: 'Demo Physio Clinic' } }, { fields: { Key: 'TEST_MODE', Value: 'false' } }, { fields: { Key: 'TEST_PHONE', Value: '98000 00001' } }] };
const settingsC = { records: [{ fields: { Key: 'owner_phone', Value: 'x' } }] };   // no clinic_name / TEST_MODE rows
let withSettings = runAll('Add settings', items(settingsA, settingsC), { ...store0, 'Split clinics': clinics });
assert.deepStrictEqual([withSettings[0].json.clinic_name, withSettings[0].json.test_mode, withSettings[0].json.test_phone], ['Demo Physio Clinic', 'false', '98000 00001']);
assert.deepStrictEqual([withSettings[1].json.clinic_name, withSettings[1].json.test_mode], ['City Physio', undefined]);
ok('settings are read per clinic in order; clinic_name falls back to the registry; missing TEST_MODE stays undefined (=> ON)');

console.log('Find due');
const appt = (id, status, minutes, extra = {}) => ({ id, fields: { Booking_UID: `uid${id}`, Lead: 10, Service: 'Assessment', Physio: 'Dr Rao', Start: inMin(minutes), End: inMin(minutes + 45), Status: status, ...extra } });
const appointmentsA = { records: [
  appt(1, 'Booked', 23 * 60),                          // r24 due
  appt(2, 'Booked', 25 * 60),                          // too early
  appt(3, 'Booked', 19 * 60),                          // between the two windows
  appt(4, 'Booked', 90),                               // r2 due
  appt(5, 'Booked', 30),                               // too late
  appt(6, 'Booked', 23 * 60, { R24_Sent: 1759650000 }),// r24 already sent
  appt(7, 'Cancelled', 23 * 60),                       // not Booked
  appt(8, 'Booked', 23 * 60, { Lead: 99 }),            // lead missing
  appt(9, 'Booked', -60),                              // already started
  appt(10, 'Booked', 24 * 60),                         // exactly 24h: included
  appt(11, 'Booked', 20 * 60),                         // exactly 20h: excluded
  appt(12, 'Booked', 120),                             // exactly 120 min: included
  appt(13, 'Booked', 45),                              // exactly 45 min: excluded
  appt(14, 'Booked', 90, { R24_Sent: 1759650000 }),    // R24 sent but R2 not: r2 still due
  appt(15, 'Booked', 90, { R2_Sent: 1759650000 }),     // r2 already sent
  { id: 16, fields: { Booking_UID: 'nostart', Lead: 10, Status: 'Booked' } },   // no Start
] };
const leadsA = { records: [{ id: 10, fields: { Name: 'Asha Rao', Phone: '+919876543210', Opted_Out: false } }, { id: 11, fields: { Name: 'Ravi', Phone: '+919811111111', Opted_Out: true } }] };
const leadsC = { records: [{ id: 10, fields: { Name: 'Different Person', Phone: '+919822222222', Opted_Out: false } }] };   // same row id 10, other clinic
const apptsC = { records: [appt(1, 'Booked', 22 * 60)] };

const withAppts = runAll('Add appointments', items(appointmentsA, apptsC), { ...store0, 'Add settings': withSettings });
let due = runAll('Find due', items(leadsA, leadsC), { ...store0, 'Add appointments': withAppts });
const ids = (clinic) => due.filter((d) => d.json.doc_id === clinic).map((d) => `${d.json.appt_row_id}:${d.json.kind}`);
assert.deepStrictEqual(ids('DOCA'), ['1:r24', '4:r2', '10:r24', '12:r2', '14:r2']);
ok('due: 23h, 24h(edge) => r24; 90min, 120min(edge) => r2; skips too early/late, gap, sent, cancelled, no lead, past, 20h/45min edges, no Start');
assert(!ids('DOCA').includes('15:r2') && !ids('DOCA').includes('6:r24'));

const first = due[0].json;
assert.deepStrictEqual([first.template, first.flag_column, first.flag_value, first.booking_uid, first.patient_name, first.patient_phone, first.opted_out, first.clinic_name], ['reminder_24h', 'R24_Sent', null, 'uid1', 'Asha Rao', '+919876543210', false, 'Demo Physio Clinic']);
assert.strictEqual(due.find((d) => d.json.appt_row_id === 4).json.template, 'reminder_2h');
assert(!('appointments' in first), 'big arrays must not be carried');
ok('each due item carries what the guard and the send need (template, flag column, patient, clinic)');

const c2 = due.filter((d) => d.json.doc_id === 'DOCC');
assert.deepStrictEqual(c2.map((d) => [d.json.patient_name, d.json.clinic_name, d.json.patient_phone]), [['Different Person', 'City Physio', '+919822222222']]);
assert.strictEqual(due.find((d) => d.json.appt_row_id === 1 && d.json.doc_id === 'DOCA').json.patient_name, 'Asha Rao');
ok('two clinics with the SAME lead row id stay separate (no data leaks between clinics)');

// custom windows from Config are honoured
const wide = runAll('Find due', items(leadsA), { Config: items({ ...cfg, r24_min_hours: 0, r24_max_hours: 48, r2_min_minutes: 0, r2_max_minutes: 0 }), 'Add appointments': [withAppts[0]] });
assert(wide.some((d) => d.json.appt_row_id === 2 && d.json.kind === 'r24') && wide.some((d) => d.json.appt_row_id === 3));
ok('window sizes come from the Config node');

console.log('Decide send');
const live = due[0].json;                         // clinic A: TEST_MODE = false
const decide = (over) => runEach('Decide send', { ...live, ...over });

let d = decide({ patient_phone: '98765 43210' });
assert.deepStrictEqual([d.send, d.decision.to, d.decision.reason, d.decision.test_mode], [true, '+919876543210', 'ok', false]);
ok('live mode: goes to the patient (phone normalised)');

d = decide({ test_mode: 'true' });
assert.deepStrictEqual([d.send, d.decision.to], [true, '+919800000001']);
d = decide({ test_mode: undefined });
assert.deepStrictEqual([d.send, d.decision.to], [true, '+919800000001']);
ok('TEST_MODE on, or the row missing: goes to TEST_PHONE, never to the patient');

const cClinic = c2[0].json;                      // clinic C: no TEST_MODE and no TEST_PHONE rows
d = runEach('Decide send', cClinic);
assert.deepStrictEqual([d.send, d.decision.reason], [false, 'test mode on but TEST_PHONE is missing or invalid']);
ok('a clinic with no Settings rows sends nothing (fail safe)');

d = decide({ opted_out: true });
assert.deepStrictEqual([d.send, d.decision.reason], [false, 'opted out']);
d = decide({ flag_value: 1759650000 });
assert.deepStrictEqual([d.send, d.decision.reason], [false, 'already sent']);
ok('opted-out patients and already-sent reminders are skipped');

Date.now = () => Date.parse('2026-10-05T22:00:00+05:30');
d = decide({});
assert.deepStrictEqual([d.send, d.decision.reason], [false, 'quiet hours']);
Date.now = () => Date.parse('2026-10-05T07:59:00+05:30');
assert.strictEqual(decide({}).send, false);
Date.now = () => NOW;
ok('quiet hours 21:00-08:00 IST: skipped (the window is wide enough that the next run still catches it)');

console.log('Stub send + sent log');
const stubFor = (extra) => runEach('Send reminder (stub)', { ...decide({}), ...extra });
let s = stubFor({});
assert.strictEqual(s.message_text, 'Hi Asha Rao, a reminder: your Assessment at Demo Physio Clinic is on 06 Oct at 9:00 AM.');
assert.deepStrictEqual([s.sent, s.stub, s.template], [false, true, 'reminder_24h']);
assert.deepStrictEqual(s.template_params, { name: 'Asha Rao', clinic_name: 'Demo Physio Clinic', date: '06 Oct', time: '9:00 AM', service: 'Assessment', physio: 'Dr Rao' });
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
assert.match(stubFor({ start: at('2026-10-05T15:05:00+05:30') }).message_text, /on 05 Oct at 3:05 PM\.$/);
assert.match(stubFor({ start: at('2026-10-05T12:00:00+05:30') }).message_text, /at 12:00 PM\.$/);
assert.match(stubFor({ start: at('2026-10-06T00:30:00+05:30') }).message_text, /on 06 Oct at 12:30 AM\.$/);
assert.match(stubFor({ patient_name: '', service: '' }).message_text, /^Hi there, a reminder: your appointment at/);
ok('stub builds the message with IST date and 12-hour time; sends nothing (sent=false)');

const log = runEach('Prepare sent log', { ...s, sent: true });
assert.deepStrictEqual(log.patch, { records: [{ id: 1, fields: { R24_Sent: Math.floor(NOW / 1000) } }] });
assert.deepStrictEqual(log.log, { Workflow: 'W5-reminders', Record: 'uid1 (r24)', Outcome: 'ok', Error: '', At: Math.floor(NOW / 1000) });
const log2 = runEach('Prepare sent log', { ...runEach('Send reminder (stub)', runEach('Decide send', due[1].json)), sent: true });
assert.deepStrictEqual(Object.keys(log2.patch.records[0].fields), ['R2_Sent']);
ok('after a real send: patch ticks R24_Sent or R2_Sent on the right row, and the Run_Log row is correct');

// whole pipeline: nothing ever reaches the "sent" tail while the stub is in place
const all = due.map((x) => runEach('Send reminder (stub)', runEach('Decide send', x.json)));
assert(all.every((x) => x.sent === false));
ok(`end to end: ${due.length} due reminders -> ${due.filter((x) => runEach('Decide send', x.json).send).length} would be sent, 0 flags set while stubbed`);

Date.now = realNow;

// ------------------------------------------------------------------ names match schema.md (rule 3)
console.log('schema.md names');
const block = (re) => schema.match(re)[0];
const apptCols = block(/### Appointments[\s\S]*?(?=\n### )/);
const leadsCols = block(/### Leads[\s\S]*?(?=\n### )/);
const settingsBlock = block(/### Settings\n[\s\S]*?(?=\n### )/);
const clinicsCols = block(/### Clinics[\s\S]*?(?=\n## )/);
const runLogLine = schema.match(/### Run_Log\n([^\n]+)/)[1];
const has = (blob, col) => new RegExp(`(^|[|\\s,\`])${col}([|\\s,\`.]|$)`, 'm').test(blob);

for (const col of ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'Status', 'R24_Sent', 'R2_Sent']) assert(has(apptCols, col), `Appointments.${col}`);
assert(apptCols.includes('Booked'));
for (const col of ['Name', 'Phone', 'Opted_Out']) assert(has(leadsCols, col), `Leads.${col}`);
for (const col of ['Key', 'Value', 'clinic_name', 'TEST_MODE', 'TEST_PHONE']) assert(has(settingsBlock, col), `Settings.${col}`);
for (const col of ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'Active']) assert(has(clinicsCols, col), `Clinics.${col}`);
for (const col of ['Workflow', 'Record', 'Outcome', 'Error', 'At']) assert(has(runLogLine, col), `Run_Log.${col}`);
const urls = wf.nodes.filter((x) => x.type.endsWith('httpRequest')).map((x) => x.parameters.url).join('\n');
for (const t of ['Clinics', 'Settings', 'Appointments', 'Leads', 'Run_Log']) assert(urls.includes(`/tables/${t}/`), `no call to ${t}`);
ok('every table, column, Settings key and choice value used exists in schema.md');

assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw) && !/[0-9]{8,}:[A-Za-z0-9_-]{30,}/.test(raw));
assert(!/\+91[0-9]{10}/.test(raw), 'no real-looking phone numbers in the file');
ok('no secrets, tokens, hostnames or phone numbers in the JSON');

console.log(`\nALL ${n} CHECK GROUPS PASSED`);
