const assert = require('assert');
const { simulate } = require('./n8n-sim');
const { load, withConfig, freshGrist, clinicRow } = require('./helpers');

const wf = withConfig(load('W5-reminders.json'), { registry_doc_id: 'REG' });
const NOW = Date.parse('2026-10-05T10:00:00+05:30');          // 10:00 IST
const inMin = (m) => Math.round((NOW + m * 60000) / 1000);
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const appt = (id, lead, status, minutes, extra = {}) => ({ id, fields: { Booking_UID: `u${id}`, Lead: lead, Service: 'Assessment', Physio: 'Dr Rao', Start: inMin(minutes), End: inMin(minutes + 45), Status: status, ...extra } });
const lead = (id, name, phone, opted = false) => ({ id, fields: { Name: name, Phone: phone, Opted_Out: opted } });

const build = () => {
  const g = freshGrist({
    REG: { Clinics: [clinicRow(1, 'demo-physio', 'DOCA'), clinicRow(2, 'old-clinic', 'DOCB', false), clinicRow(3, 'city-physio', 'DOCC')] },
    DOCC: { Leads: [lead(1, 'Different Person', '+919822222222')], Appointments: [appt(1, 1, 'Booked', 22 * 60)], Run_Log: [], Settings: [{ id: 1, fields: { Key: 'TEST_MODE', Value: 'true' } }, { id: 2, fields: { Key: 'TEST_PHONE', Value: '9000000002' } }] },
  });
  g.docs.DOCA.Leads.push(lead(1, 'Asha Rao', '+919876543210'), lead(2, 'Opted Out', '+919811111111', true));
  g.docs.DOCA.Appointments.push(appt(1, 1, 'Booked', 23 * 60), appt(2, 1, 'Booked', 90), appt(3, 2, 'Booked', 90), appt(4, 1, 'Cancelled', 23 * 60), appt(5, 1, 'Booked', 25 * 60));
  return g;
};
const run = (g, now = NOW, w = wf) => simulate(w, { start: 'Every 15 minutes', items: [{ json: { timestamp: 'x' } }], grist: g, now });

let g = build();
let r = run(g);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const stub = r.runData['Send reminder (stub)'].map((i) => i.json);
const summary = stub.map((s) => `${s.clinic_slug}:${s.booking_uid}:${s.kind}:${s.decision.to}`).sort();
assert.deepStrictEqual(summary, ['city-physio:u1:r24:+919000000002', 'demo-physio:u1:r24:+919876543210', 'demo-physio:u2:r2:+919876543210']);
ok('2 active clinics read from the registry (inactive one ignored); 3 reminders would go out; the opted-out patient and cancelled / too-early bookings are skipped');
assert(summary.some((x) => x.includes('city-physio') && x.endsWith('+919000000002')));
ok('clinic with TEST_MODE=true sends to TEST_PHONE; clinic with TEST_MODE=false sends to the patient');
assert.strictEqual(stub.find((s) => s.clinic_slug === 'city-physio').patient_name, 'Different Person');
assert.strictEqual(stub.find((s) => s.clinic_slug === 'demo-physio' && s.kind === 'r24').patient_name, 'Asha Rao');
ok('same lead row id in two clinics: each reminder uses its own clinic\'s patient');
assert(stub.every((s) => s.sent === false && s.stub === true && /^Hi /.test(s.message_text)));
assert(!r.visited.includes('Prepare sent log') && !r.visited.includes('Set sent flag') && !r.visited.includes('Write Run_Log'));
assert(g.calls.every((c) => c.method === 'GET'));
assert.deepStrictEqual(g.docs.DOCA.Appointments.map((a) => a.fields.R24_Sent || a.fields.R2_Sent || null), [null, null, null, null, null]);
assert.strictEqual(g.docs.DOCA.Run_Log.length + g.docs.DOCC.Run_Log.length, 0);
ok('while stubbed: only READ calls to Grist, no sent flags set, nothing logged');

g = build();
r = run(g, Date.parse('2026-10-05T22:00:00+05:30'));
assert.strictEqual(r.error, null);
assert(!r.visited.includes('Send reminder (stub)'));
ok('22:00 IST (quiet hours): nothing goes out');

g = build();
r = run(g, NOW, withConfig(load('W5-reminders.json'), { registry_doc_id: 'REG', r24_min_hours: 0, r24_max_hours: 48 }));
assert(r.runData['Send reminder (stub)'].map((i) => i.json.booking_uid).includes('u5'));
ok('widening the window in the Config node picks up the 25h booking');

g = build(); g.docs.REG.Clinics.forEach((c) => { c.fields.Active = false; });
r = run(g);
assert.strictEqual(r.error, null);
assert(!r.visited.includes('Settings'));
ok('no active clinics: the run just ends');

// what happens if the real send is wired in later: simulate by replacing the stub with a node that reports sent:true
const live = JSON.parse(JSON.stringify(wf));
const stubNode = live.nodes.find((x) => x.name === 'Send reminder (stub)');
stubNode.parameters.jsCode = stubNode.parameters.jsCode.replace('sent: false,', 'sent: true,').replace('stub: true,', 'stub: false,');
g = build();
r = run(g, NOW, live);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
const a = (c, id) => g.docs[c].Appointments.find((x) => x.id === id).fields;
assert.strictEqual(a('DOCA', 1).R24_Sent, Math.floor(NOW / 1000));
assert.strictEqual(a('DOCA', 2).R2_Sent, Math.floor(NOW / 1000));
assert.strictEqual(a('DOCC', 1).R24_Sent, Math.floor(NOW / 1000));
assert.strictEqual(a('DOCA', 3).R2_Sent, undefined);
assert.deepStrictEqual(g.docs.DOCA.Run_Log.map((l) => l.fields.Record).sort(), ['u1 (r24)', 'u2 (r2)']);
assert.deepStrictEqual(g.docs.DOCC.Run_Log.map((l) => l.fields.Record), ['u1 (r24)']);
ok('with a real send (sent: true): the right row gets R24_Sent / R2_Sent in the right clinic, then one Run_Log row each');
r = run(g, NOW + 15 * 60000, live);
assert.strictEqual(r.error, null);
assert(!r.visited.includes('Send reminder (stub)'));
ok('the next 15-minute run finds nothing due (flags stop double messages)');

console.log(`W5 simulation: ${n} scenarios pass`);
