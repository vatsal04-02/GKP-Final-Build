// Structure + end-to-end checks for W3-speed-to-lead.json (runs the shipped JSON). Run: node n8n/tests/w3.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate } = require('./n8n-sim');
const { load, withConfig, freshGrist, clinicRow, REPO } = require('./helpers');

const raw = fs.readFileSync(path.join(REPO, 'n8n/workflows/W3-speed-to-lead.json'), 'utf8');
const w3raw = JSON.parse(raw);
const wf = withConfig(w3raw, { registry_doc_id: 'REG' });
const MON_10AM = Date.parse('2026-10-05T10:00:00+05:30');      // a Monday
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const secs = (ms) => Math.floor(ms / 1000);

// ---------------------------------------------------------------- fixtures
const lead = (id, minutesAgo, over = {}, now = MON_10AM) => ({
  id, fields: { Lead_ID: `L-20261005-${String(id).padStart(4, '0')}`, Name: `Lead ${id}`, Phone: `+9198000000${String(id).padStart(2, '0')}`, Source: 'Website', Status: 'New', Escalated: false, Enquiry: 'Back pain', Created_At: secs(now - minutesAgo * 60000), ...over },
});
const setSettings = (g, doc, map) => { g.docs[doc].Settings = Object.entries(map).map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } })); };
const OPEN = { clinic_name: 'Demo Physio', open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat', owner_phone: '98100 00001', TEST_MODE: 'false', TEST_PHONE: '9000000001' };
const build = (settings = OPEN, leads = []) => { const g = freshGrist(); setSettings(g, 'DOCA', settings); g.docs.DOCA.Leads.push(...leads); return g; };
const run = (g, now = MON_10AM, w = wf) => simulate(w, { start: 'Every 10 minutes', items: [{ json: { timestamp: 'x' } }], grist: g, now });
const alerts = (r) => (r.runData['Send escalation (stub)'] || []).map((i) => i.json);
const ids = (r) => alerts(r).map((a) => String(a.lead_row_id).padStart(4, '0'));

// ================================================================ structure
console.log('structure');
const names = w3raw.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(w3raw.nodes.map((x) => x.id)).size, names.length);
for (const [from, v] of Object.entries(w3raw.connections)) { assert(names.includes(from)); for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), t.node); }
const seen = new Set(['Every 10 minutes']); const q = ['Every 10 minutes'];
while (q.length) for (const outs of (w3raw.connections[q.shift()] || { main: [] }).main) for (const t of outs || []) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
assert.deepStrictEqual(names.filter((x) => !seen.has(x) && x !== 'Notes'), []);
assert.deepStrictEqual(w3raw.nodes.find((x) => x.name === 'Every 10 minutes').parameters.rule.interval, [{ field: 'minutes', minutesInterval: 10 }]);
ok(`${names.length} nodes, connected, runs every 10 minutes`);
let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
w3raw.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const snip = (f) => fs.readFileSync(path.join(REPO, 'n8n/snippets', f), 'utf8');
const phoneFn = snip('normalize-phone.js').match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0];
const gd = snip('send-guard.js'); const gdFns = gd.slice(gd.indexOf('function isTestMode'), gd.indexOf('// ---- n8n Code node body'));
const hs = snip('clinic-hours.js'); const hsFns = hs.slice(hs.indexOf('const DAY_INDEX'), hs.indexOf('// ---- n8n Code node body'));
const code = (name) => w3raw.nodes.find((x) => x.name === name).parameters.jsCode;
assert(strip(code('Decide send')).includes(strip(phoneFn)) && strip(code('Decide send')).includes(strip(gdFns)));
assert(strip(code('Add settings')).includes(strip(hsFns)));
ok('Decide send and Add settings embed the phone, send-guard and clinic-hours functions exactly as in n8n/snippets/');
assert.strictEqual(w3raw.connections['Send escalation (stub)'].main[0][0].node, 'Sent?');
assert.deepStrictEqual(w3raw.connections['Sent?'].main[0].map((t) => t.node), ['Prepare sent log']);
assert.strictEqual(w3raw.connections['Sent?'].main[1], undefined);
assert.strictEqual(w3raw.connections['Prepare sent log'].main[0][0].node, 'Set Escalated');
assert.strictEqual(w3raw.connections['Set Escalated'].main[0][0].node, 'Write Run_Log');
ok('Escalated is set (PATCH) before the Run_Log row, and only after a real send');

// ================================================================ which leads
console.log('which leads are escalated');
let g = build(OPEN, [
  lead(1, 31), lead(2, 10), lead(3, 49 * 60), lead(4, 40, { Escalated: true }), lead(5, 40, { Status: 'Contacted' }),
  lead(6, 40, { Created_At: undefined }), lead(7, 30), lead(8, 29.98), lead(9, 47 * 60), lead(10, 40, { Lead_ID: '' }),
]);
let r = run(g);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.deepStrictEqual(ids(r), ['0009', '0010', '0001', '0007']);   // 47h, 40m, 31m, 30m
ok('waiting 30+ min and New and not Escalated: oldest first. Skipped: 10 min, 29m59s, over 48h, already Escalated, Contacted, no Created_At');
const a1 = alerts(r).find((a) => a.lead_id.endsWith('0001'));
assert.deepStrictEqual([a1.waiting_minutes, a1.lead_name, a1.lead_phone, a1.decision.to, a1.decision.send], [31, 'Lead 1', '+919800000001', '+919810000001', true]);
assert.strictEqual(a1.message_text, 'Lead waiting 31 min with no response (Demo Physio): Lead 1, +919800000001 - "Back pain". L-20261005-0001.');
assert.strictEqual(alerts(r).find((a) => a.lead_row_id === 10).lead_id, 'row 10');
ok('alert goes to the OWNER (normalised owner_phone), text names the lead, wait time and enquiry; a lead with no Lead_ID shows as "row N"');
// two independent layers keep an already-Escalated lead from being alerted again (rule 4): test each one on its own
assert(!r.runData['Find due'].some((i) => i.json.lead_row_id === 4), 'layer 1: Find due must not even pick an Escalated lead');
const decideOn = (json) => new Function('$json', '$', code('Decide send'))(json, () => ({ first: () => ({ json: {} }) })).json;
const forced = decideOn({ ...r.runData['Find due'][0].json, escalated: true });
assert.deepStrictEqual([forced.send, forced.decision.reason], [false, 'already sent']);
ok('already-Escalated leads are stopped twice: Find due never picks them, and the send guard would refuse them anyway');
assert(g.calls.every((c) => c.method === 'GET'));
assert(g.docs.DOCA.Leads.every((l) => !l.fields.Escalated || l.id === 4));
assert.strictEqual(g.docs.DOCA.Run_Log.length, 0);
ok('while stubbed: only READ calls, Escalated never set, nothing logged');

g = build(OPEN, [lead(1, 31)]);
assert.deepStrictEqual(ids(run(g, new Date(MON_10AM).getTime())), ['0001']);
r = run(build({ ...OPEN }, [lead(1, 31)]), MON_10AM, withConfig(w3raw, { registry_doc_id: 'REG', new_for_minutes: 60 }));
assert.deepStrictEqual(ids(r), []);
r = run(build({ ...OPEN }, [lead(1, 49 * 60)]), MON_10AM, withConfig(w3raw, { registry_doc_id: 'REG', max_age_hours: 72 }));
assert.deepStrictEqual(ids(r), ['0001']);
ok('the 30-minute wait and the 48-hour backlog limit come from the Config node');

g = build(OPEN, Array.from({ length: 13 }, (_, i) => lead(i + 1, 31 + i)));
r = run(g);
assert.deepStrictEqual(ids(r), ['0013', '0012', '0011', '0010', '0009', '0008', '0007', '0006', '0005', '0004']);
ok('13 leads due at once: at most 10 alerts per clinic per run, oldest first (the rest wait for the next run)');

// ================================================================ clinic hours
console.log('clinic hours');
const at = (iso) => Date.parse(`${iso}+05:30`);
const dueAt = (iso, settings = OPEN) => { const now = at(iso); return run(build(settings, [lead(1, 45, {}, now)]), now); };
assert.deepStrictEqual(ids(dueAt('2026-10-05T09:00:00')), ['0001']);
assert.deepStrictEqual(ids(dueAt('2026-10-05T18:59:00')), ['0001']);
for (const iso of ['2026-10-05T08:59:00', '2026-10-05T19:00:00', '2026-10-05T23:00:00', '2026-10-04T11:00:00']) {
  const rr = dueAt(iso);
  assert.strictEqual(rr.error, null); assert.deepStrictEqual(ids(rr), [], iso);
}
ok('open 09:00-19:00 Mon-Sat: alerts at 09:00 and 18:59; nothing at 08:59, 19:00, 23:00 or on Sunday');
assert.deepStrictEqual(ids(dueAt('2026-10-04T11:00:00', { ...OPEN, working_days: 'daily' })), ['0001']);
assert.deepStrictEqual(ids(dueAt('2026-10-05T10:00:00', { ...OPEN, working_days: 'Tue,Wed' })), []);
ok('working_days is read as typed: "daily" opens Sunday, "Tue,Wed" keeps Monday closed');

const noHours = { clinic_name: 'Demo Physio', owner_phone: '98100 00001', TEST_MODE: 'false' };
assert.deepStrictEqual(ids(dueAt('2026-10-04T10:00:00', noHours)), ['0001']);
assert.deepStrictEqual(ids(dueAt('2026-10-04T07:00:00', noHours)), []);
assert.deepStrictEqual(ids(dueAt('2026-10-04T10:00:00', { ...noHours, open_time: 'whenever', working_days: 'weekdays' })), ['0001']);
ok('no / unreadable hours settings: falls back to 08:00-21:00 every day (never to "always")');
const rr = dueAt('2026-10-05T10:00:00', noHours);
assert.strictEqual(rr.runData['Add settings'][0].json.hours_source, 'default');
assert.strictEqual(dueAt('2026-10-05T10:00:00').runData['Add settings'][0].json.hours_source, 'settings');

const lateClose = { ...OPEN, close_time: '22:00' };
const now2130 = at('2026-10-05T21:30:00');
r = run(build(lateClose, [lead(1, 45, {}, now2130)]), now2130);
assert.strictEqual(r.runData['Add settings'][0].json.open_now, true);
assert.deepStrictEqual([alerts(r).length, alerts(r)[0] && alerts(r)[0].decision.send], [0, undefined]);
assert(r.runData['Decide send'] && r.runData['Decide send'][0].json.decision.reason === 'quiet hours');
ok('clinic open until 22:00 but it is 21:30: the send guard still enforces quiet hours (21:00-08:00), nothing goes out');

// ================================================================ recipient / test mode
console.log('recipient and TEST_MODE');
r = run(build({ ...OPEN, TEST_MODE: 'true' }, [lead(1, 45)]));
assert.strictEqual(alerts(r)[0].decision.to, '+919000000001');
r = run(build({ clinic_name: 'D', open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat', owner_phone: '98100 00001', TEST_PHONE: '9000000001' }, [lead(1, 45)]));
assert.strictEqual(alerts(r)[0].decision.to, '+919000000001');
ok('TEST_MODE on, or the TEST_MODE row missing: the alert goes to TEST_PHONE, never the real owner');
for (const owner of [undefined, '', '12345']) {
  const s = { ...OPEN }; if (owner === undefined) delete s.owner_phone; else s.owner_phone = owner;
  r = run(build(s, [lead(1, 45)]));
  assert.strictEqual(r.error, null);
  assert.strictEqual(alerts(r).length, 0, String(owner));
  assert.strictEqual(r.runData['Decide send'][0].json.decision.send, false);
}
ok('no / invalid owner_phone (live mode): nothing sent, no error, the reason is visible in the "Decide send" output');
assert.strictEqual(run(build({ ...OPEN, TEST_MODE: 'true', TEST_PHONE: '' }, [lead(1, 45)])).runData['Decide send'][0].json.decision.reason, 'test mode on but TEST_PHONE is missing or invalid');
ok('TEST_MODE on with no TEST_PHONE: nothing sent (fail safe)');

// ================================================================ several clinics
console.log('several clinics');
const multi = () => {
  const gg = freshGrist({
    REG: { Clinics: [clinicRow(1, 'demo-physio', 'DOCA'), clinicRow(2, 'old-clinic', 'DOCB', false), clinicRow(3, 'city-physio', 'DOCC'), clinicRow(4, 'sunday-only', 'DOCD')] },
    DOCC: { Leads: [lead(1, 50, { Name: 'City Lead', Phone: '+919822222222' })], Appointments: [], Run_Log: [], Settings: [] },
    DOCD: { Leads: [lead(1, 50, { Name: 'Sunday Lead' })], Appointments: [], Run_Log: [], Settings: [] },
  });
  setSettings(gg, 'DOCA', OPEN); gg.docs.DOCA.Leads.push(lead(1, 31, { Name: 'Asha' }), lead(2, 90, { Name: 'Ravi' }));
  setSettings(gg, 'DOCC', { clinic_name: 'City Physio', owner_phone: '9811111111', TEST_MODE: 'false' });
  setSettings(gg, 'DOCD', { clinic_name: 'Sunday Only', open_time: '09:00', close_time: '19:00', working_days: 'Sun', owner_phone: '9822222222', TEST_MODE: 'false' });
  return gg;
};
g = multi(); r = run(g);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const summary = alerts(r).map((a) => `${a.clinic_slug}:${a.lead_name}:${a.decision.to}`).sort();
assert.deepStrictEqual(summary, ['city-physio:City Lead:+919811111111', 'demo-physio:Asha:+919810000001', 'demo-physio:Ravi:+919810000001']);
ok('3 active clinics: each alert uses ITS clinic\'s lead and ITS owner; the inactive clinic is ignored; the clinic closed today (Sunday-only) is skipped');
assert(!summary.some((s) => s.includes('sunday-only')));

// ================================================================ a real send (simulated)
console.log('with a real WhatsApp send wired in');
const live = JSON.parse(JSON.stringify(wf));
const stubNode = live.nodes.find((x) => x.name === 'Send escalation (stub)');
stubNode.parameters.jsCode = stubNode.parameters.jsCode.replace('sent: false,', 'sent: true,').replace('stub: true,', 'stub: false,');
g = multi(); r = run(g, MON_10AM, live);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const flag = (doc, id) => g.docs[doc].Leads.find((l) => l.id === id).fields.Escalated;
assert.deepStrictEqual([flag('DOCA', 1), flag('DOCA', 2), flag('DOCC', 1), flag('DOCD', 1)], [true, true, true, false]);
assert.deepStrictEqual(g.docs.DOCA.Run_Log.map((l) => [l.fields.Workflow, l.fields.Record, l.fields.Outcome]).sort(), [['W3-speed-to-lead', 'L-20261005-0001 (escalated)', 'ok'], ['W3-speed-to-lead', 'L-20261005-0002 (escalated)', 'ok']]);
assert.deepStrictEqual(g.docs.DOCC.Run_Log.map((l) => l.fields.Record), ['L-20261005-0001 (escalated)']);
assert.strictEqual(g.docs.DOCD.Run_Log.length, 0);
ok('after a real send: Escalated = true on exactly the alerted leads in the right clinics, one Run_Log row each');
r = run(g, MON_10AM + 10 * 60000, live);
assert.strictEqual(r.error, null); assert(!r.visited.includes('Send escalation (stub)'));
ok('the next run (10 minutes later) finds nothing to escalate: the flag stops repeat alerts');

// ================================================================ names and secrets
console.log('schema.md and secrets');
const schema = fs.readFileSync(path.join(REPO, 'grist/schema.md'), 'utf8');
const block = (re) => schema.match(re)[0];
const has = (blob, col) => new RegExp(`(^|[|\\s,\`])${col}([|\\s,\`.]|$)`, 'm').test(blob);
const leadsCols = block(/### Leads[\s\S]*?(?=\n### )/), settings = block(/### Settings\n[\s\S]*?(?=\n### )/), clinics = block(/### Clinics[\s\S]*?(?=\n## )/), runLog = schema.match(/### Run_Log\n([^\n]+)/)[1];
for (const c of ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Enquiry', 'Status', 'Escalated']) assert(has(leadsCols, c), c);
for (const c of ['Key', 'Value', 'clinic_name', 'open_time', 'close_time', 'working_days', 'owner_phone', 'TEST_MODE', 'TEST_PHONE']) assert(has(settings, c), c);
for (const c of ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'Active']) assert(has(clinics, c), c);
for (const c of ['Workflow', 'Record', 'Outcome', 'Error', 'At']) assert(has(runLog, c), c);
assert(leadsCols.includes('New'));
ok('every table, column, Settings key and choice value W3 uses exists in schema.md');
assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw));
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw) && !/[0-9]{8,}:[A-Za-z0-9_-]{30,}/.test(raw) && !/\+91[0-9]{10}/.test(raw));
ok('no email addresses, secrets, hostnames or phone numbers in the JSON');

console.log(`\nW3: ${n} check groups pass`);
