// Structure + end-to-end checks for W6-followups.json (runs the shipped JSON). Run: node n8n/tests/w6.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate } = require('./n8n-sim');
const { withConfig, freshGrist, clinicRow, REPO } = require('./helpers');

const raw = fs.readFileSync(path.join(REPO, 'n8n/workflows/W6-followups.json'), 'utf8');
const w6raw = JSON.parse(raw);
const wf = withConfig(w6raw, { registry_doc_id: 'REG' });
const DAY = 86400000;
const NOW = Date.parse('2026-10-06T10:00:00+05:30');            // Tuesday 10:00 India time
const DAY0 = Date.parse('2026-10-06T00:00:00+05:30');
const at = (daysAgo, hhmm = '15:00', base = DAY0) => { const [h, m] = hhmm.split(':').map(Number); return Math.floor((base - daysAgo * DAY + (h * 60 + m) * 60000) / 1000); };
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ---------------------------------------------------------------- fixtures
const pad = (x) => String(x).padStart(2, '0');
const L = (id, name, status, daysAgo, over = {}, hhmm = '15:00') => ({
  id, fields: { Lead_ID: `L-TEST-${pad(id)}`, Name: name, Phone: `+9198000000${pad(id)}`, Source: 'Website', Status: status, Created_At: at(daysAgo, hhmm), Opted_Out: false, Followup_Sent: false, ...over },
});
const A = (id, lead, status, start, over = {}) => ({ id, fields: { Booking_UID: `A${id}`, Lead: lead, Service: 'Assessment', Physio: 'Dr Rao', Start: start, End: start + 2700, Status: status, ...over } });
const SETTINGS = { clinic_name: 'Demo Physio', booking_link: 'https://cal.com/demo-physio/assessment', TEST_MODE: 'false', TEST_PHONE: '9000000001' };
const setSettings = (g, doc, map) => { g.docs[doc].Settings = Object.entries(map).map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } })); };

const build = (settings = SETTINGS) => {
  const g = freshGrist();
  setSettings(g, 'DOCA', settings);
  g.docs.DOCA.Leads.push(
    L(1, 'Asha', 'New', 2),                       // follow-up
    L(2, 'Ravi', 'Contacted', 6),                 // follow-up (oldest)
    L(3, 'Meera', 'New', 1),                      // too young
    L(4, 'OldNew', 'New', 7),                     // Lost
    L(5, 'OldContacted', 'Contacted', 10),        // Lost (oldest)
    L(6, 'Followed', 'New', 3, { Followup_Sent: true }),
    L(7, 'Opted', 'New', 3, { Opted_Out: true }, '11:00'),   // picked, but the guard refuses
    L(8, 'Paused', 'New', 3, {}, '12:00'),                  // picked, but the conversation is paused
    L(9, 'HasBooking', 'New', 4),                 // has a future booking: left alone
    L(10, 'Callback', 'Contacted', 9, { Next_Action_At: at(-1, '10:00') }),          // call-back planned tomorrow: not Lost
    L(11, 'OverdueCallback', 'Contacted', 9, { Next_Action_At: at(1, '10:00') }),    // call-back was yesterday: Lost
    L(12, 'Converted', 'Converted', 20), L(13, 'AlreadyLost', 'Lost', 20), L(14, 'BookedLead', 'Booked', 3),
    L(15, 'NoShowPatient', 'Booked', 30), L(16, 'Rebooked', 'Booked', 30), L(17, 'TwoNoShows', 'Booked', 30),
    L(18, 'OldNoShow', 'Booked', 30), L(19, 'TodayNoShow', 'Booked', 30), L(20, 'RebookSent', 'Booked', 30), L(21, 'DayBefore', 'Booked', 30),
  );
  g.docs.DOCA.Appointments.push(
    A(1, 15, 'No-show', at(1, '11:00')),                        // yesterday: rebook
    A(2, 16, 'No-show', at(1, '11:00')), A(3, 16, 'Booked', at(-2, '11:00')),   // already rebooked: nothing
    A(4, 17, 'No-show', at(1, '16:00')), A(5, 17, 'No-show', at(2, '11:00')),   // two no-shows: ONE message (the newest)
    A(6, 18, 'No-show', at(3, '11:00')),                        // 3 days ago: outside the 2-day lookback
    A(7, 19, 'No-show', at(0, '09:00')),                        // today: not yet
    A(8, 20, 'No-show', at(1, '11:00'), { Rebook_Sent: at(1, '12:00') }),       // already sent
    A(9, 9, 'Booked', at(-2, '10:00')),                         // lead 9's future booking
    A(10, 1, 'Completed', at(1, '10:00')),
    A(11, 21, 'No-show', at(2, '10:00')),                       // day before yesterday: still within lookback
  );
  g.docs.DOCA.Conversations = [{ id: 1, fields: { Lead: 8, Phone: '+919800000008', Automation_Paused: true } }, { id: 2, fields: { Lead: 1, Phone: '+919800000001', Automation_Paused: false } }];
  return g;
};
const run = (g, now = NOW, w = wf) => simulate(w, { start: 'Daily 10:00', items: [{ json: { timestamp: 'x' } }], grist: g, now });
const planned = (r, kind) => (r.runData['Plan follow-ups'] || []).map((i) => i.json).filter((j) => j.kind === kind).map((j) => j.lead_row_id);
const sentIds = (r) => (r.runData['Send message (stub)'] || []).map((i) => `${i.json.kind}:${i.json.lead_row_id}`).sort();
const lead = (g, id, doc = 'DOCA') => g.docs[doc].Leads.find((l) => l.id === id).fields;
const writes = (g) => g.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.doc}.${c.table}`);

// ================================================================ structure
console.log('structure');
const names = w6raw.nodes.map((x) => x.name);
assert.strictEqual(new Set(names).size, names.length);
assert.strictEqual(new Set(w6raw.nodes.map((x) => x.id)).size, names.length);
for (const [from, v] of Object.entries(w6raw.connections)) { assert(names.includes(from)); for (const outs of v.main) for (const t of outs || []) assert(names.includes(t.node), t.node); }
const seen = new Set(['Daily 10:00']); const q = ['Daily 10:00'];
while (q.length) for (const outs of (w6raw.connections[q.shift()] || { main: [] }).main) for (const t of outs || []) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); }
assert.deepStrictEqual(names.filter((x) => !seen.has(x) && x !== 'Notes'), []);
assert.deepStrictEqual(w6raw.nodes.find((x) => x.name === 'Daily 10:00').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 10 * * *' }]);
assert.strictEqual(w6raw.settings.timezone, 'Asia/Kolkata');
ok(`${names.length} nodes, connected; runs daily at 10:00 with the workflow timezone pinned to Asia/Kolkata`);
let ex = 0;
const chk = (v) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { new Function('$json', '$', `return (${m[1]});`); ex++; } else if (v && typeof v === 'object') Object.values(v).forEach(chk); };
w6raw.nodes.forEach((x) => chk(x.parameters));
ok(`${ex} n8n expressions compile`);
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
const snip = (f) => fs.readFileSync(path.join(REPO, 'n8n/snippets', f), 'utf8');
const phoneFn = snip('normalize-phone.js').match(/function normalizeIndianPhone[\s\S]*?\n\}\n/)[0];
const gd = snip('send-guard.js'); const gdFns = gd.slice(gd.indexOf('function isTestMode'), gd.indexOf('// ---- n8n Code node body'));
const code = (name) => w6raw.nodes.find((x) => x.name === name).parameters.jsCode;
assert(strip(code('Decide send')).includes(strip(phoneFn)) && strip(code('Decide send')).includes(strip(gdFns)));
ok('Decide send embeds the phone and send-guard functions exactly as in n8n/snippets/');
assert.deepStrictEqual(w6raw.connections['Needs send?'].main.map((o) => o.map((t) => t.node)), [['Decide send'], ['Prepare writes']]);
assert.deepStrictEqual(w6raw.connections['Sent?'].main.map((o) => (o || []).map((t) => t.node)), [['Prepare writes']]);
ok('Lost items go straight to the writes; messages reach the writes only through "Sent?" (a real send)');

// ================================================================ what gets planned
console.log('what is planned (Tuesday 10:00)');
let g = build();
let r = run(g);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.deepStrictEqual(planned(r, 'rebook').sort((a, b) => a - b), [15, 17, 21]);
ok('rebook: no-shows from yesterday and the day before; NOT today\'s, NOT 3 days ago, NOT already sent, NOT a patient who already rebooked');
const reb17 = r.runData['Plan follow-ups'].map((i) => i.json).find((j) => j.kind === 'rebook' && j.lead_row_id === 17);
assert.deepStrictEqual([reb17.flag_row_id, reb17.booking_uid], [4, 'A4']);
ok('a patient with two recent no-shows gets ONE message, about the newest one');
assert.deepStrictEqual(planned(r, 'followup'), [2, 7, 8, 1]);
ok('follow-up: New/Contacted leads 2-6 days old, oldest first; skips 1 day old, Followup_Sent, a lead with a future booking, Booked/Converted/Lost leads');
assert.deepStrictEqual(planned(r, 'lost'), [5, 11, 4]);
ok('Lost: New/Contacted leads 7+ days old, oldest first; skips the one with a call-back planned tomorrow (but not one whose call-back date has passed)');

console.log('messages (stubbed)');
assert.deepStrictEqual(sentIds(r), ['followup:1', 'followup:2', 'rebook:15', 'rebook:17', 'rebook:21']);
const dec = (id) => r.runData['Decide send'].map((i) => i.json).find((j) => j.lead_row_id === id).decision;
assert.deepStrictEqual([dec(7).send, dec(7).reason], [false, 'opted out']);
assert.deepStrictEqual([dec(8).send, dec(8).reason], [false, 'automation paused']);
assert.strictEqual(dec(1).to, '+919800000001');
ok('5 messages would go out; the opted-out lead and the lead whose conversation is paused are refused by the send guard');
// two independent layers stop a repeat message (rule 4): the plan never picks a flagged row, and the guard refuses one anyway
const decideOn = (json) => new Function('$json', '$', code('Decide send'))(json, () => ({ first: () => ({ json: {} }) })).json;
const fuItem = r.runData['Plan follow-ups'].map((i) => i.json).find((j) => j.kind === 'followup' && j.lead_row_id === 1);
const rbItem = r.runData['Plan follow-ups'].map((i) => i.json).find((j) => j.kind === 'rebook' && j.lead_row_id === 15);
assert.deepStrictEqual([decideOn({ ...fuItem, flag_value: 1 }).decision.reason, decideOn({ ...rbItem, flag_value: at(1, '12:00') }).decision.reason], ['already sent', 'already sent']);
ok('even if a flagged row slipped into the plan, the send guard refuses it ("already sent")');
const msg = (id) => r.runData['Send message (stub)'].map((i) => i.json).find((j) => j.lead_row_id === id);
assert.strictEqual(msg(15).message_text, 'Hi NoShowPatient, we missed you at your Assessment at Demo Physio on 05 Oct. Book a time here: https://cal.com/demo-physio/assessment');
assert.strictEqual(msg(15).template, 'noshow_rebook');
assert.strictEqual(msg(1).message_text, 'Hi Asha, thanks for contacting Demo Physio. Would you like to book your visit? Book a time here: https://cal.com/demo-physio/assessment');
assert.strictEqual(msg(1).template, 'followup_day2');
assert.deepStrictEqual(msg(15).template_params, { name: 'NoShowPatient', clinic_name: 'Demo Physio', service: 'Assessment', date: '05 Oct', booking_link: 'https://cal.com/demo-physio/assessment' });
assert(r.runData['Send message (stub)'].every((i) => i.json.sent === false && i.json.stub === true));
ok('message texts use the India date of the missed visit and the clinic\'s booking_link; templates noshow_rebook / followup_day2; nothing sent');

console.log('Grist changes');
assert.deepStrictEqual([5, 11, 4].map((id) => [lead(g, id).Status, lead(g, id).Lost_Reason]), [['Lost', 'No response'], ['Lost', 'No response'], ['Lost', 'No response']]);
assert.strictEqual(lead(g, 10).Status, 'Contacted');
// n8n runs every item through one node before the next: all 3 patches, then all 3 log rows
assert.deepStrictEqual(writes(g), ['PATCH DOCA.Leads', 'PATCH DOCA.Leads', 'PATCH DOCA.Leads', 'POST DOCA.Run_Log', 'POST DOCA.Run_Log', 'POST DOCA.Run_Log']);
assert.deepStrictEqual(g.docs.DOCA.Run_Log.map((l) => [l.fields.Workflow, l.fields.Record, l.fields.Outcome]), [['W6-followups', 'L-TEST-05 (lost: no response)', 'ok'], ['W6-followups', 'L-TEST-11 (lost: no response)', 'ok'], ['W6-followups', 'L-TEST-04 (lost: no response)', 'ok']]);
assert(g.docs.DOCA.Appointments.every((a) => a.id === 8 || !a.fields.Rebook_Sent));
assert(g.docs.DOCA.Leads.every((l) => l.id === 6 || !l.fields.Followup_Sent));
ok('the ONLY writes are the 3 Lost leads (Status + Lost_Reason, then one Run_Log row each); no message flag is set while stubbed');

r = run(g);
assert.strictEqual(r.error, null);
assert.deepStrictEqual(planned(r, 'lost'), []);
assert.strictEqual(writes(g).length, 6);
ok('running again the same day changes nothing more (Lost leads are no longer open)');

// ================================================================ switches and limits
console.log('Config switches and limits');
g = build(); r = run(g, NOW, withConfig(w6raw, { registry_doc_id: 'REG', mark_lost: false }));
assert.deepStrictEqual([planned(r, 'lost'), writes(g)], [[], []]);
assert.strictEqual(sentIds(r).length, 5);
ok('mark_lost = false: no lead is marked Lost (messages still planned)');

g = freshGrist(); setSettings(g, 'DOCA', SETTINGS);
for (let i = 1; i <= 35; i++) g.docs.DOCA.Leads.push(L(i, `F${i}`, 'New', 3, {}, `${pad(8 + Math.floor(i / 6))}:${pad((i * 7) % 60)}`));
for (let i = 101; i <= 160; i++) g.docs.DOCA.Leads.push(L(i, `X${i}`, 'New', 8 + (i % 5), {}, `${pad(9 + (i % 10))}:00`));
r = run(g);
assert.strictEqual(planned(r, 'followup').length, 30);
assert.strictEqual(planned(r, 'lost').length, 50);
const createdOf = (id) => lead(g, id).Created_At;
const fu = planned(r, 'followup'); assert(fu.every((id, k) => k === 0 || createdOf(fu[k - 1]) <= createdOf(id)));
ok('at most 30 follow-ups and 50 Lost per clinic per run, oldest first (the rest wait for tomorrow)');

g = build(); r = run(g, NOW, withConfig(w6raw, { registry_doc_id: 'REG', followup_after_days: 3, lost_after_days: 10, noshow_lookback_days: 1 }));
// follow-up window becomes 3-9 days: 10 and 11 (9 days, same moment, original order), 4 (7), 2 (6), 7 and 8 (3)
assert.deepStrictEqual([planned(r, 'followup'), planned(r, 'lost'), planned(r, 'rebook').sort((a, b) => a - b)], [[10, 11, 4, 2, 7, 8], [5], [15, 17]]);
ok('follow-up day, Lost day and no-show lookback all come from the Config node');

// ================================================================ India calendar days
console.log('India calendar days');
const one = (fields) => { const gg = freshGrist(); setSettings(gg, 'DOCA', SETTINGS); gg.docs.DOCA.Leads.push({ id: 1, fields: { Lead_ID: 'L-1', Name: 'X', Phone: '+919800000001', Status: 'New', Opted_Out: false, Followup_Sent: false, ...fields } }); const rr = run(gg); return ['followup', 'lost'].filter((k) => planned(rr, k).length); };
assert.deepStrictEqual(one({ Created_At: at(2, '23:59') }), ['followup']);
assert.deepStrictEqual(one({ Created_At: at(1, '00:01') }), []);
assert.deepStrictEqual(one({ Created_At: at(7, '23:59') }), ['lost']);
assert.deepStrictEqual(one({ Created_At: at(6, '00:00') }), ['followup']);
assert.deepStrictEqual(one({ Created_At: Math.floor(Date.parse('2026-09-30T03:00:00+05:30') / 1000) }), ['followup']);
ok('ages are India calendar days: 30 Sep 03:00 IST (still 29 Sep in UTC) is 6 days old -> follow-up, not Lost');

// ================================================================ quiet hours / test mode / no link
console.log('send guard, TEST_MODE, booking link');
g = build(); r = run(g, Date.parse('2026-10-06T22:00:00+05:30'));
assert.deepStrictEqual(sentIds(r), []);
assert.strictEqual(planned(r, 'lost').length, 3);
ok('a run at 22:00 (manual): no message (quiet hours), Lost marking still happens (it is not a message)');
g = build({ ...SETTINGS, TEST_MODE: 'true' }); r = run(g);
assert(r.runData['Decide send'].filter((i) => i.json.send).every((i) => i.json.decision.to === '+919000000001'));
g = build({ clinic_name: 'Demo Physio', booking_link: 'https://cal.com/x' }); r = run(g);
assert.deepStrictEqual([sentIds(r).length, r.runData['Decide send'][0].json.decision.reason], [0, 'test mode on but TEST_PHONE is missing or invalid']);
ok('TEST_MODE on: every message goes to TEST_PHONE; no TEST_MODE / TEST_PHONE rows at all: nothing is sent (fail safe)');
g = build({ ...SETTINGS, booking_link: '' }); r = run(g);
assert.strictEqual(r.runData['Send message (stub)'].map((i) => i.json).find((j) => j.lead_row_id === 1).message_text, 'Hi Asha, thanks for contacting Demo Physio. Would you like to book your visit?');
ok('no booking_link in Settings: the message simply has no link sentence');
g = build(); g.docs.DOCA.Conversations.push({ id: 3, fields: { Lead: 15, Automation_Paused: true } }); r = run(g);
assert(!sentIds(r).includes('rebook:15'));
ok('a no-show rebook is also stopped when that patient\'s conversation is paused (it is a follow-up, not a reminder)');

// ================================================================ several clinics
console.log('several clinics');
const multi = () => {
  const gg = build();
  gg.docs.REG.Clinics.push(clinicRow(3, 'city-physio', 'DOCC'));
  gg.docs.DOCC = { Leads: [L(1, 'CityLead', 'New', 2), L(4, 'CityOld', 'New', 8)], Appointments: [], Run_Log: [], Settings: [], Conversations: [{ id: 1, fields: { Lead: 1, Automation_Paused: true } }] };
  setSettings(gg, 'DOCC', { ...SETTINGS, clinic_name: 'City Physio' });
  return gg;
};
g = multi(); r = run(g);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const byClinic = r.runData['Send message (stub)'].map((i) => `${i.json.clinic_slug}:${i.json.kind}:${i.json.lead_name}`).sort();
assert(byClinic.includes('demo-physio:followup:Asha') && !byClinic.some((x) => x.startsWith('city-physio')));
assert.deepStrictEqual([lead(g, 4, 'DOCC').Status, lead(g, 4).Status, lead(g, 1, 'DOCC').Status], ['Lost', 'Lost', 'New']);
assert.deepStrictEqual(g.docs.DOCC.Run_Log.map((l) => l.fields.Record), ['L-TEST-04 (lost: no response)']);
ok('two clinics with the same lead row ids: each clinic\'s pause / Lost / Run_Log stays in its own doc');

// ================================================================ a real send (simulated)
console.log('with a real WhatsApp send wired in');
const live = JSON.parse(JSON.stringify(wf));
const stubNode = live.nodes.find((x) => x.name === 'Send message (stub)');
stubNode.parameters.jsCode = stubNode.parameters.jsCode.replace('sent: false,', 'sent: true,').replace('stub: true,', 'stub: false,');
g = build(); r = run(g, NOW, live);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const appt = (id) => g.docs.DOCA.Appointments.find((a) => a.id === id).fields;
const nowSec = Math.floor(NOW / 1000);
assert.deepStrictEqual([appt(1).Rebook_Sent, appt(4).Rebook_Sent, appt(11).Rebook_Sent, appt(5).Rebook_Sent], [nowSec, nowSec, nowSec, undefined]);
assert.deepStrictEqual([1, 2, 7, 8].map((id) => lead(g, id).Followup_Sent), [true, true, false, false]);
const recs = g.docs.DOCA.Run_Log.map((l) => l.fields.Record).sort();
assert.deepStrictEqual(recs, ['A1 (rebook) L-TEST-15', 'A11 (rebook) L-TEST-21', 'A4 (rebook) L-TEST-17', 'L-TEST-01 (followup)', 'L-TEST-02 (followup)', 'L-TEST-04 (lost: no response)', 'L-TEST-05 (lost: no response)', 'L-TEST-11 (lost: no response)']);
ok('after real sends: Rebook_Sent (time) on exactly the 3 no-show rows, Followup_Sent on exactly the 2 leads messaged, one Run_Log row per action');
r = run(g, NOW + DAY, live);
assert.strictEqual(r.error, null);
// Wednesday: nobody messaged on Tuesday is messaged again; only the newly due ones appear -
// lead 3 is now 2 days old, and Tuesday morning's no-show (lead 19) is now "yesterday's"
assert.deepStrictEqual(sentIds(r), ['followup:3', 'rebook:19']);
assert.deepStrictEqual(planned(r, 'lost'), [10, 2]);   // lead 10's call-back time (Wed 10:00) has come; lead 2 is now 7 days old
ok('the next day: no repeat message to anyone already messaged (flags); only newly due people (lead 3 turned 2 days old, Tuesday\'s no-show)');

// ================================================================ names and secrets
console.log('schema.md and secrets');
const schema = fs.readFileSync(path.join(REPO, 'grist/schema.md'), 'utf8');
const block = (re) => schema.match(re)[0];
const has = (blob, col) => new RegExp(`(^|[|\\s,\`])${col}([|\\s,\`.(]|$)`, 'm').test(blob);
const leadsCols = block(/### Leads[\s\S]*?(?=\n### )/), apptCols = block(/### Appointments[\s\S]*?(?=\n### )/), convCols = block(/### Conversations\n[^\n]+/), settings = block(/### Settings\n[\s\S]*?(?=\n### )/), clinics = block(/### Clinics[\s\S]*?(?=\n## )/), runLog = schema.match(/### Run_Log\n([^\n]+)/)[1];
for (const c of ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Status', 'Opted_Out', 'Followup_Sent', 'Lost_Reason', 'Next_Action_At']) assert(has(leadsCols, c), c);
for (const c of ['Booking_UID', 'Lead', 'Service', 'Start', 'Status', 'Rebook_Sent']) assert(has(apptCols, c), c);
for (const c of ['Lead', 'Automation_Paused']) assert(has(convCols, c), c);
for (const c of ['Key', 'Value', 'clinic_name', 'booking_link', 'TEST_MODE', 'TEST_PHONE']) assert(has(settings, c), c);
for (const c of ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'Active']) assert(has(clinics, c), c);
for (const c of ['Workflow', 'Record', 'Outcome', 'Error', 'At']) assert(has(runLog, c), c);
for (const v of ['New', 'Contacted', 'Lost', 'No response']) assert(leadsCols.includes(v), v);
for (const v of ['No-show', 'Booked']) assert(apptCols.includes(v), v);
ok('every table, column, Settings key and choice value W6 uses exists in schema.md (the fake Grist also rejected anything else during the runs)');
assert(!/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(raw));
assert(!/Bearer\s+[A-Za-z0-9]/.test(raw) && !/ts\.net/.test(raw) && !/sk-ant/.test(raw) && !/[0-9]{8,}:[A-Za-z0-9_-]{30,}/.test(raw) && !/\+91[0-9]{10}/.test(raw));
ok('no email addresses, secrets, hostnames or phone numbers in the JSON');

console.log(`\nW6: ${n} check groups pass`);
