// Offline checks for W1-website-lead.json. Run: node n8n/tests/w1.checks.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repo = process.argv[2] || path.join(__dirname, '..', '..');
const wf = JSON.parse(fs.readFileSync(path.join(repo, 'n8n/workflows/W1-website-lead.json'), 'utf8'));
const schema = fs.readFileSync(path.join(repo, 'grist/schema.md'), 'utf8');
const snippet = fs.readFileSync(path.join(repo, 'n8n/snippets/normalize-phone.js'), 'utf8');

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// ------------------------------------------------------------------ structure
console.log('structure');
const names = wf.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length, 'node names must be unique');
assert.strictEqual(new Set(wf.nodes.map((x) => x.id)).size, wf.nodes.length, 'node ids must be unique');
ok(`${names.length} nodes, unique names and ids`);

for (const [from, v] of Object.entries(wf.connections)) {
  assert(names.includes(from), `connection source missing: ${from}`);
  for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), `connection target missing: ${t.node}`);
}
ok('every connection points at an existing node');

const seen = new Set(['Webhook']);
const q = ['Webhook'];
while (q.length) {
  const cur = q.shift();
  for (const outs of (wf.connections[cur] || { main: [] }).main) for (const t of outs || []) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
}
const unreachable = names.filter((x) => !seen.has(x) && !wf.nodes.find((y) => y.name === x).type.endsWith('stickyNote'));
assert.deepStrictEqual(unreachable, [], `unreachable nodes: ${unreachable}`);
ok('every node is reachable from the Webhook');

const hook = wf.nodes.find((x) => x.name === 'Webhook');
assert.strictEqual(hook.parameters.responseMode, 'onReceived');
assert.strictEqual(hook.parameters.authentication, 'headerAuth');
ok('webhook responds immediately (rule 6) and requires the secret header');

// every n8n expression ={{ ... }} must at least compile as JS
let exprCount = 0;
const checkExprs = (val) => {
  if (typeof val === 'string') {
    if (val.startsWith('=')) for (const m of val.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); exprCount++; }
  } else if (val && typeof val === 'object') Object.values(val).forEach(checkExprs);
};
wf.nodes.forEach((x) => checkExprs(x.parameters));
ok(`${exprCount} n8n expressions compile`);

// ------------------------------------------------------------------ embedded phone function == snippet (rule 7)
console.log('phone function');
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const fnRe = /function normalizeIndianPhone[\s\S]*?\n\s*\}\n/;   // closing brace may be indented inside the Code node
const prepSrc = wf.nodes.find((x) => x.name === 'Prepare lead').parameters.jsCode;
assert.strictEqual(strip(prepSrc.match(fnRe)[0]), strip(snippet.match(fnRe)[0]));
ok('Prepare lead embeds the same normalizeIndianPhone as n8n/snippets/normalize-phone.js');

// ------------------------------------------------------------------ run the Code nodes
const run = (nodeName, json, store = {}) => {
  const src = wf.nodes.find((x) => x.name === nodeName).parameters.jsCode;
  const $ = (name) => ({ first: () => { if (!(name in store)) throw new Error(`Node '${name}' hasn't been executed`); return { json: store[name] }; } });
  return new Function('$json', '$', src)(json, $).json;
};
const realNow = Date.now;
const at = (iso) => { Date.now = () => new Date(iso).getTime(); };
const restore = () => { Date.now = realNow; };

const cfg = { grist_base_url: 'http://grist:8484/', registry_doc_id: ' REG123 ' };
const prep = (body) => run('Prepare lead', { ...cfg, body });

console.log('Prepare lead');
let p = prep({ clinic: 'Demo-Physio', name: '  Asha   Rao ', phone: '+91 98765 43210', enquiry: 'Back pain\nsince 2 weeks', page_url: 'https://x.in/a', utm_campaign: 'gads', website: '' });
assert.deepStrictEqual(
  { s: p.clinic_slug, n: p.name, ph: p.phone, ok: p.input_ok, e: p.enquiry, b: p.grist_base_url, r: p.registry_doc_id },
  { s: 'demo-physio', n: 'Asha Rao', ph: '+919876543210', ok: true, e: 'Back pain\nsince 2 weeks', b: 'http://grist:8484', r: 'REG123' });
ok('happy path: slug lowercased, name tidied, phone normalised, newline kept in enquiry, base url trimmed');

for (const [raw, want] of [['9876543210', '+919876543210'], ['09876543210', '+919876543210'], ['0091-98765-43210', '+919876543210']]) {
  assert.strictEqual(prep({ clinic: 'demo-physio', name: 'A', phone: raw }).phone, want);
}
ok('phone formats from the snippet tests');

assert.strictEqual(prep({ clinic: 'demo-physio', name: 'A', phone: '12345' }).skip_reason, 'invalid phone');
assert.strictEqual(prep({ clinic: 'demo-physio', name: ' ', phone: '9876543210' }).skip_reason, 'missing name');
assert.strictEqual(prep({ clinic: 'demo-physio', name: 'A', phone: '9876543210', website: 'http://spam' }).skip_reason, 'honeypot filled');
assert.strictEqual(prep({ clinic: 'demo-physio', name: 'A', phone: '12345' }).input_ok, false);
ok('invalid phone / missing name / honeypot are all skipped');

assert.strictEqual(prep({ clinic: '../etc', name: 'A', phone: '9876543210' }).clinic_slug, '');
assert.strictEqual(prep({ name: 'A', phone: '9876543210' }).clinic_slug, '');
assert.strictEqual(run('Prepare lead', { ...cfg }).skip_reason, 'missing name');
ok('bad / missing clinic slug becomes empty; missing body does not crash');

p = prep({ clinic: 'demo-physio', name: 'A\u0000B\u0007', phone: '9876543210', enquiry: 'x'.repeat(5000), page_url: 'u'.repeat(900) });
assert.strictEqual(p.name, 'AB');
assert.strictEqual(p.enquiry.length, 1000);
assert.strictEqual(p.page_url.length, 500);
ok('control characters stripped, long fields truncated');

console.log('Resolve clinic');
const prepared = { ...prep({ clinic: 'demo-physio', name: 'Asha', phone: '9876543210' }) };
const rc = (records) => run('Resolve clinic', { records }, { 'Prepare lead': prepared });
const good = { id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: ' DOC999 ', WA_Phone_Number_ID: '555', Active: true } };
let r = rc([good]);
assert.deepStrictEqual([r.clinic_found, r.doc_id, r.clinic_name, r.wa_phone_number_id, r.name], [true, 'DOC999', 'Demo Physio', '555', 'Asha']);
ok('active clinic found; context carried through');
assert.strictEqual(rc([]).clinic_found, false);
assert.strictEqual(rc([{ id: 1, fields: { ...good.fields, Active: false } }]).clinic_found, false);
assert.strictEqual(rc([{ id: 1, fields: { ...good.fields, Grist_Doc_ID: '' } }]).clinic_found, false);
assert.strictEqual(rc([{ id: 1, fields: { ...good.fields, Clinic_Slug: 'other' } }]).clinic_found, false);
assert.strictEqual(run('Resolve clinic', { records: [{ id: 2, fields: { Clinic_Slug: '', Active: true, Grist_Doc_ID: 'X' } }] }, { 'Prepare lead': { ...prepared, clinic_slug: '' } }).clinic_found, false);
ok('no match / inactive / no doc id / wrong slug / empty slug all => not found');

console.log('Build update');
const resolved = { ...prepared, clinic_found: true, doc_id: 'DOC999', clinic_name: 'Demo Physio' };
at('2026-10-04T05:00:00Z');
const bu = (rec, ctx = resolved) => run('Build update', { records: [rec] }, { 'Resolve clinic': ctx });
let u = bu({ id: 7, fields: { Lead_ID: 'L-20261001-0003', Enquiry: 'Knee pain' } }, { ...resolved, enquiry: 'Back pain', page_url: 'https://x.in/a', utm_campaign: 'gads' });
assert.strictEqual(u.has_changes, true);
assert.deepStrictEqual(u.patch, { records: [{ id: 7, fields: { Enquiry: 'Knee pain\n---\n2026-10-04: Back pain', Page_URL: 'https://x.in/a', UTM_Campaign: 'gads' } }] });
assert.strictEqual(u.lead_id, 'L-20261001-0003');
ok('existing lead: enquiry appended with IST date, only allowed fields patched (Status untouched)');
assert(!('Status' in u.patch.records[0].fields) && !('Name' in u.patch.records[0].fields));
u = bu({ id: 7, fields: { Lead_ID: 'L-1', Enquiry: 'Back pain' } }, { ...resolved, enquiry: 'Back pain', page_url: '', utm_campaign: '' });
assert.deepStrictEqual([u.has_changes, u.skip_reason], [false, 'duplicate submission']);
ok('identical resubmission => no changes, flagged as duplicate');
u = bu({ id: 7, fields: { Lead_ID: 'L-1', Enquiry: 'Back pain', Page_URL: 'https://x.in/a', UTM_Campaign: 'gads' } }, { ...resolved, enquiry: 'Back pain', page_url: 'https://x.in/a', utm_campaign: 'gads' });
assert.deepStrictEqual([u.has_changes, u.skip_reason], [false, 'duplicate submission']);
u = bu({ id: 7, fields: { Lead_ID: 'L-1', Enquiry: 'Back pain', Page_URL: 'https://x.in/a', UTM_Campaign: 'gads' } }, { ...resolved, enquiry: 'Back pain', page_url: 'https://x.in/b', utm_campaign: 'gads' });
assert.deepStrictEqual([u.has_changes, Object.keys(u.patch.records[0].fields)], [true, ['Page_URL']]);
ok('REGRESSION: a double-submit with the same page URL / campaign is a duplicate; a different page URL is an update');
u = bu({ id: 9, fields: { Lead_ID: '', Enquiry: '' } }, { ...resolved, enquiry: 'Hello', page_url: '', utm_campaign: '' });
assert.deepStrictEqual([u.patch.records[0].fields.Enquiry, u.lead_id], ['Hello', 'row 9']);
ok('lead with empty Enquiry / no Lead_ID (staff-entered) is handled');
restore();

console.log('Build new lead');
const bn = (records, ctx = resolved) => run('Build new lead', { records }, { 'Resolve clinic': ctx });
at('2026-10-04T05:00:00Z');   // 10:30 IST on 4 Oct
let nl = bn([]);
assert.strictEqual(nl.lead_id, 'L-20261004-0001');
nl = bn([{ fields: { Lead_ID: 'L-20261004-0007' } }, { fields: { Lead_ID: 'L-20261004-0002' } }, { fields: { Lead_ID: 'L-20261003-0099' } }, { fields: { Lead_ID: '' } }]);
assert.strictEqual(nl.lead_id, 'L-20261004-0008');
ok('Lead_ID = L-YYYYMMDD-#### : starts at 0001, continues from today\'s max, ignores other days and blanks');
const f = nl.create.records[0].fields;
assert.deepStrictEqual(Object.keys(f), ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Page_URL', 'UTM_Campaign', 'Enquiry', 'Status']);
assert.deepStrictEqual([f.Source, f.Status, f.Phone, f.Created_At], ['Website', 'New', '+919876543210', Math.floor(Date.parse('2026-10-04T05:00:00Z') / 1000)]);
ok('new lead fields: Source=Website, Status=New, Created_At in epoch seconds');
at('2026-10-04T19:00:00Z');   // 00:30 IST on 5 Oct
assert.strictEqual(bn([]).lead_id, 'L-20261005-0001');
ok('IST date rollover (19:00 UTC is already the next day in India)');
restore();

console.log('Staff alert (stub) + Run_Log rows');
const alertFrom = (store) => run('Staff alert (stub)', {}, store);
const created = { ...resolved, action: 'created', lead_id: 'L-20261004-0001', enquiry: 'Back pain' };
const updated = { ...resolved, action: 'updated', lead_id: 'L-20261001-0003', enquiry: '' };
let a = alertFrom({ 'Build new lead': created });
assert.strictEqual(a.staff_alert_sent, false);
assert.match(a.staff_alert_text, /^New website lead \(Demo Physio\): Asha, \+919876543210 - "Back pain"\. L-20261004-0001\.$/);
assert.deepStrictEqual([a.log.Workflow, a.log.Record, a.log.Outcome, a.log.Error], ['W1-website-lead', 'L-20261004-0001 (created)', 'ok', '']);
a = alertFrom({ 'Build update': updated });
assert.match(a.staff_alert_text, /^Existing lead enquired again/);
assert.strictEqual(a.log.Record, 'L-20261001-0003 (updated)');
ok('works from either branch even though the other branch never ran; sends nothing (stub)');
const sk = run('Log skipped', { ...prepared, input_ok: false, skip_reason: 'invalid phone', phone: null, phone_raw: '12345' });
assert.deepStrictEqual([sk.log.Outcome, sk.log.Error, sk.log.Record], ['skipped', 'invalid phone', '12345']);
ok('skipped runs log Outcome=skipped with the reason');

// ------------------------------------------------------------------ names match schema.md (rule 3)
console.log('schema.md names');
const section = (title) => schema.split(/^## /m).find((s) => s.startsWith(title)) || '';
const leadsCols = schema.match(/### Leads[\s\S]*?(?=\n### )/)[0];
const runLogLine = schema.match(/### Run_Log\n([^\n]+)/)[1];
const clinicsCols = schema.match(/### Clinics[\s\S]*?(?=\n## )/)[0];
const inSchema = (blob, col) => new RegExp(`(^|[|\\s,])${col}([|\\s,]|$)`, 'm').test(blob);

for (const col of Object.keys(nl.create.records[0].fields).concat(['Page_URL', 'UTM_Campaign', 'Enquiry'])) assert(inSchema(leadsCols, col), `Leads.${col} not in schema.md`);
for (const col of ['Workflow', 'Record', 'Outcome', 'Error', 'At']) assert(inSchema(runLogLine, col), `Run_Log.${col} not in schema.md`);
for (const col of ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'WA_Phone_Number_ID', 'Active']) assert(inSchema(clinicsCols, col), `Clinics.${col} not in schema.md`);
for (const choice of ['Website', 'New']) assert(leadsCols.includes(choice));
const urls = wf.nodes.filter((x) => x.type.endsWith('httpRequest')).map((x) => x.parameters.url).join('\n');
for (const t of ['Clinics', 'Leads', 'Run_Log']) assert(urls.includes(`/tables/${t}`), `no call to table ${t}`);
ok('every Leads / Run_Log / Clinics column, choice value and table the workflow touches exists in schema.md');

// no secrets or real hostnames baked in (rule 2)
const raw = fs.readFileSync(path.join(repo, 'n8n/workflows/W1-website-lead.json'), 'utf8');
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw));
ok('no secrets, API keys or tailnet hostnames in the JSON');

console.log(`\nALL ${n} CHECK GROUPS PASSED`);
