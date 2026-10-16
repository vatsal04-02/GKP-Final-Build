// FULL SYSTEM TEST of your workflow after apply-ai-context.js: every section W1, W2, W3, W4, W5, W6, W11, W12, W13 run end to end in
// the simulator (fake Grist, fake Meta, fake OpenRouter that reads the real prompt), next to the ORIGINAL export wherever the
// behaviour is meant to change. One line per check: PASS / FAIL and why. Made-up numbers only; secrets are test values in memory.
// Run: node n8n/integrated/system.test.js       (AI_CTX_FILE / AI_CTX_ORIG = other files, e.g. your private pair)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.AI_CTX_FILE || path.join(__dirname, 'ai-updated-workflow-clinic.ai-context.json');
const ORIG_FILE = process.env.AI_CTX_ORIG || path.join(__dirname, 'source', 'ai-updated-workflow-clinic.export.redacted.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- live CRM naming (LEADS / Lead_id), W2's "Received"
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
class TestGrist extends FakeGrist {
  constructor(docs) { super(docs); this.count = {}; this.fail = []; }
  failAt(method, table, nth = 1) { this.fail.push({ key: `${method} ${table}`, nth }); return this; }
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    if (this.fail.some((x) => x.key === key && x.nth === this.count[key])) throw new Error('Grist 500: injected failure');
    return super.handle(method, url, query, body);
  }
}

// ---------------------------------------------------------------- the workflows, filled in as after import (test values, in memory)
const PNID = '123456789012345';
const REG = 'REGISTRY_DOC_ID_PLACEHOLDER';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const VERIFY = 'test-verify-token-123', CAL_SECRET = 'test-cal-secret-456';
const phone = (n) => `+9190000${String(n).padStart(5, '0')}`;   // fake: +919000000NNN
const prepare = (file) => {
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  set('W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,${OWNER},${TESTP}`);
  set('W2 – Verify Config', 'meta_verify_token', VERIFY);
  set('W4 – Config', 'cal_webhook_secret', CAL_SECRET);
  return w;
};
const NEW = prepare(FILE);
const OLD = prepare(ORIG_FILE);
const crm = ({ settings = {}, msgs, convs, leads, appts } = {}) => new TestGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', ...settings }), Knowledge: clone(F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const run = (w, start, items, o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const r = simulate(w, { start, items, grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude) });
  const runs = allRuns(r);
  const w12 = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W12 – Config'));
  return { r, g, meta, claude, runs, w12, errors: runs.filter((x) => x.error).map((x) => x.error) };
};
const tick = (w, start, g, o = {}) => run(w, start, [{ json: {} }], { ...o, g });
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const logs = (g, wf) => rows(g, 'Run_Log').filter((l) => l.Workflow === wf);
const sec = F.sec;
const MIN = 60000, HOUR = 3600000, DAYMS = 86400000;
const HOLD = 'Thank you for your message. A member of our team will reply to you shortly.';
const onlyW12 = (x) => assert.strictEqual(x.meta.calls.length, x.w12.length, 'a Meta call that did not come from W12');

// ---------------------------------------------------------------- check registry
const results = [];
const check = (id, title, fn) => {
  try { const why = fn(); results.push({ id, title, ok: true, why: why || '' }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n').slice(0, 4).join(' ') }); }
};

// ================================================================ W1 website leads
const w1 = (body, g) => run(NEW, 'W1 – Webhook', [{ json: { headers: {}, params: {}, query: {}, body: { clinic_slug: 'demo-clinic', name: 'Asha Rao', phone: '+91 9000000021', enquiry: 'knee pain', page_url: 'https://site/x', utm_campaign: 'oct', website: '', ...body } } }], { g });
check('W1.1', 'website lead', () => {
  const x = w1({}, crm({ leads: [], convs: [], msgs: [], appts: [] }));
  assert.deepStrictEqual(x.errors, []);
  const l = rows(x.g, 'LEADS')[0];
  assert.deepStrictEqual([l.Phone, l.Status, logs(x.g, 'W1-website-lead')[0].Outcome, x.meta.calls.length], ['+919000000021', 'New', 'ok', 0]);
  return 'LEADS row (New, +91 phone) + Run_Log ok; no WhatsApp send (W1 staff alert is a stub)';
});
check('W1.2', 'duplicate lead', () => {
  const g = crm({ leads: [], convs: [], msgs: [], appts: [] });
  w1({}, g); const x = w1({}, g);
  assert.deepStrictEqual([rows(g, 'LEADS').length, logs(g, 'W1-website-lead').map((l) => l.Outcome)], [1, ['ok', 'skipped']]);
  return 'same form twice: one lead, second logged "skipped"';
});
check('W1.3', 'invalid lead (bot / honeypot)', () => {
  const x = w1({ website: 'http://spam' }, crm({ leads: [], convs: [], msgs: [], appts: [] }));
  assert.deepStrictEqual([rows(x.g, 'LEADS').length, logs(x.g, 'W1-website-lead')[0].Error], [0, 'honeypot filled']);
  return 'honeypot filled: no lead, Run_Log skipped';
});
check('W1.4', 'invalid lead (bad phone number)', () => {
  const x = w1({ phone: '12345' }, crm({ leads: [], convs: [], msgs: [], appts: [] }));
  assert.deepStrictEqual([rows(x.g, 'LEADS').length, logs(x.g, 'W1-website-lead')[0].Outcome, logs(x.g, 'W1-website-lead')[0].Error], [0, 'skipped', 'invalid phone']);
  return 'no lead; Run_Log skipped "invalid phone" (checked in W1 – Resolve clinic)';
});
check('W1.5', 'unknown clinic', () => {
  const x = w1({ clinic_slug: 'nope' }, crm());
  assert.strictEqual(x.r.error && x.r.error.node, 'W1 – Unknown clinic');
  return 'stops at W1 – Unknown clinic (a production run then triggers W11, this workflow\'s own Error Trigger)';
});

// ================================================================ W2 inbound WhatsApp + W13 AI receptionist (one path)
const metaBody = (from, id, text, { ts = sec(F.NOW) - 5, type = 'text', pnid = PNID } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
    contacts: [{ profile: { name: 'Asha Patel' }, wa_id: from }],
    messages: [type === 'text' ? { from, id, timestamp: String(ts), type: 'text', text: { body: text } } : { from, id, timestamp: String(ts), type, [type]: { id: 'MEDIA', caption: text } }],
  } }] }],
});
let seq = 0;
const post = (text, o = {}) => {
  const x = run(o.w || NEW, 'W2 – Webhook Inbound', [{ json: { headers: {}, params: {}, query: {}, body: o.body || metaBody(o.from || P_ASHA, o.id || `wamid.IN.S${++seq}`, text, o) } }], o);
  x.aiJobs = x.runs.filter((y) => y.visited[0] === 'W12 – When called by another workflow' && y.visited.includes('W13 – Config'));
  x.last = rows(x.g, 'Messages').filter((m) => m.Direction === 'In').pop();
  x.texts = x.meta.calls.map((c) => (c.body.type === 'text' ? c.body.text.body : `[${c.body.template.name}]`));
  return x;
};
check('W2.1', 'Meta verification', () => {
  const v = (t) => simulate(NEW, { start: 'W2 – Webhook Verify', items: [{ json: { headers: {}, params: {}, body: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': t, 'hub.challenge': '12345' } } }], grist: crm(), now: F.NOW, workflowId: 'MASTER' });
  assert.deepStrictEqual([v(VERIFY).responses.map((r) => [r.code, r.body]), v('wrong').responses.map((r) => r.code)], [[[200, '12345']], [403]]);
  return 'right token -> 200 + challenge; wrong -> 403';
});
check('W2.2', 'inbound WhatsApp text message', () => {
  const x = post('How much does this cost?');
  assert.deepStrictEqual([x.errors, x.r.responses.map((r) => r.code), x.last.Status, x.aiJobs.length, x.aiJobs[0].waited], [[], [200], 'Received', 1, false]);
  return 'Meta answered 200 first; message stored; ONE AI job, not awaited';
});
check('W2.3', 'duplicate inbound message', () => {
  const x = post('How much does this cost?', { id: 'wamid.DUP' });
  const y = post('How much does this cost?', { id: 'wamid.DUP', g: x.g, meta: x.meta, claude: x.claude });
  assert.deepStrictEqual([rows(x.g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.DUP').length, y.aiJobs.length, x.meta.calls.length], [1, 0, 1]);
  return 'stored once, one AI job, one reply';
});
check('W2.4', 'STOP / opt-out', () => {
  const x = post('STOP');
  assert.deepStrictEqual([x.meta.calls.length, rows(x.g, 'LEADS').find((l) => l.Phone === F.ASHA).Opted_Out, x.last.AI_Status], [0, true, 'opted_out']);
  return 'lead Opted_Out, nothing sent';
});
check('W2.5', 'media message', () => {
  const x = post('my x-ray', { type: 'image' });
  assert.deepStrictEqual([x.claude.calls.length, x.last.AI_Status, x.texts], [0, 'handed_off', [HOLD, '[human_handoff_alert]']]);
  return 'no AI call; holding reply + staff alert via W12';
});
check('W2.6', 'unknown clinic (phone_number_id)', () => {
  const x = post('How much does this cost?', { pnid: '999999999999999' });
  assert.deepStrictEqual([x.aiJobs.length, x.meta.calls.length], [0, 0]);
  return 'no AI job, nothing sent';
});
check('W2.7', 'AI hand-off', () => {
  const x = post('Do you accept the XYZ health insurance card?');
  onlyW12(x);
  assert.deepStrictEqual([x.texts, x.last.AI_Status, rows(x.g, 'Conversations')[0].Needs_Human], [[HOLD, '[human_handoff_alert]'], 'handed_off', true]);
  return 'holding reply + human_handoff_alert, both through W12; Needs_Human';
});
check('W2.8', 'AI response', () => {
  const x = post('How much does this cost?');
  assert.deepStrictEqual([x.texts, x.meta.calls[0].body.type], [['The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.'], 'text']);
  return 'knowledge-base prices as free text in the 24 h window';
});
check('W2.9', 'W12 send (only sender)', () => {
  const x = post('Do you accept the XYZ health insurance card?');
  onlyW12(x);
  assert(x.meta.calls.every((c) => c.url === `https://graph.facebook.com/v23.0/${PNID}/messages`));
  return `${x.meta.calls.length} Meta calls, each from its own W12 run`;
});

// ================================================================ W3 speed to lead (staff escalation)
const W3_LEADS = () => [
  [31, 40, {}], [32, 35, { Lead_Stage: 'hot', AI_Summary: 'Wants a knee assessment tomorrow evening.', Likely_Service: 'Knee pain physiotherapy' }],
  [33, 45, { Lead_Stage: 'warm', AI_Summary: 'Asked about prices.' }], [34, 50, { Lead_Stage: 'cold' }], [35, 38, {}], [36, 42, {}],
  [37, 44, { Next_Action_At: sec(F.NOW + DAYMS) }], [38, 46, { Opted_Out: true }], [39, 47, {}], [40, 41, {}],
].map(([id, min, f]) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: sec(F.NOW - min * MIN), Name: `Lead ${id}`, Phone: phone(id), Source: 'WhatsApp', Status: 'New', Enquiry: 'back pain', ...f } }));
const W3_CONVS = () => [
  [35, { Last_Intent: 'availability_check', Last_Inbound_At: sec(F.NOW - 10 * MIN) }], [36, { Assigned_To: 'Dr. Mehta' }], [39, { Last_Intent: 'not_interested', Last_Inbound_At: sec(F.NOW - 47 * MIN) }],
  [40, { Needs_Human: true, Last_Intent: 'complaint', Last_Inbound_At: sec(F.NOW - 41 * MIN), Handoff_Reason: 'HIGH · Unhappy with the last session, wants a call.' }],
].map(([lead, f], i) => ({ id: i + 1, fields: { Lead: lead, Phone: phone(lead), Automation_Paused: false, ...f } }));
const w3 = (w, g = crm({ settings: { TEST_MODE: 'true' }, leads: W3_LEADS(), convs: W3_CONVS(), msgs: [], appts: [] }), o) => {
  const x = tick(w, 'W3 – Every 10 minutes', g, o);
  const built = Object.fromEntries((x.r.runData['W3 – Build Message'] || []).map((b) => [b.json.lead_row_id, b.json]));
  return { ...x, order: (x.r.runData["W3 – Call 'W12 - WhatsApp send'"] || []).map((b) => b.json.lead_row_id), built };
};
const N3 = w3(NEW); const O3 = w3(OLD);
check('W3.1', 'new lead (no AI data)', () => {
  assert.strictEqual(N3.built[31].message_text, 'New lead Lead 31 (+919000000031) for Demo Physio, waiting 40 min. back pain. Next: call or message today.');
  assert(N3.order.includes(31) && O3.order.includes(31));
  return 'escalated as before; staff message = enquiry + next step';
});
check('W3.2', 'hot lead', () => {
  assert.strictEqual(N3.order[0], 32);
  assert.strictEqual(N3.built[32].template_params.enquiry, '[HOT] Wants a knee assessment tomorrow evening (Knee pain physiotherapy). Next: call now, ready to book.');
  return 'first in the run; brief says HOT, what they want, "call now"';
});
check('W3.3', 'warm lead', () => { assert.strictEqual(N3.order[1], 33); return 'right after hot (warm / unknown, oldest first)'; });
check('W3.4', 'cold lead', () => { assert.strictEqual(N3.order[N3.order.length - 1], 34); return 'still escalated, last'; });
check('W3.5', 'recent patient reply', () => {
  assert(N3.built[35].template_params.enquiry.endsWith('Last: availability check, wrote 10 min ago. Next: reply on WhatsApp now, the patient is active.'));
  return 'escalated with "reply on WhatsApp now"';
});
check('W3.6', 'human-owned conversation', () => {
  assert(!N3.order.includes(36) && !O3.order.includes(36));
  return 'Assigned_To: not escalated (before and after)';
});
check('W3.7', 'future Next_Action_At', () => {
  assert(!N3.order.includes(37) && O3.order.includes(37));
  return 'next contact already planned: held (the original escalated it)';
});
check('W3.8', 'AI_Summary present', () => {
  assert(N3.built[33].message_text.includes('Asked about prices') && N3.built[33].template_params.enquiry.startsWith('[WARM] Asked about prices.'));
  return 'summary + stage in the staff message and the template\'s enquiry value';
});
check('W3.9', 'AI_Summary absent', () => {
  assert(N3.built[31].template_params.enquiry.startsWith('back pain.'));
  return 'falls back to Enquiry';
});
check('W3.10', 'follow-up (staff alert) sent', () => {
  onlyW12(N3);
  assert.deepStrictEqual(N3.order, [32, 33, 40, 31, 35, 34]);
  assert.deepStrictEqual(rows(N3.g, 'LEADS').filter((l) => l.Escalated).map((l) => l.id).sort(), [31, 32, 33, 34, 35, 40]);
  assert(N3.meta.calls.every((c) => c.body.template.name === 'hello_world' && c.body.to === TESTP.slice(1)));
  return '6 alerts through W12 (TEST_MODE -> TEST_PHONE, template unchanged); Escalated + Run_Log';
});
check('W3.11', 'follow-up skipped (opted out, not interested)', () => {
  assert(!N3.order.includes(38) && !N3.order.includes(39) && O3.order.includes(38) && O3.order.includes(39));
  return 'held now; the original alerted staff about both';
});
check('W3.12', 'AI hand-off whose alert failed (safety net)', () => {
  assert.strictEqual(N3.built[40].template_params.enquiry, 'back pain. Last: complaint, wrote 41 min ago. Next: AI hand-off: HIGH · Unhappy with the last session, wants a call.');
  assert(N3.order.includes(40));
  return 'still escalated, with the AI\'s staff note';
});
check('W3.13', 'Conversations unreadable', () => {
  const g = crm({ settings: { TEST_MODE: 'true' }, leads: W3_LEADS(), convs: W3_CONVS(), msgs: [], appts: [] }).failAt('GET', 'Conversations', 1);
  const x = w3(NEW, g);
  assert.deepStrictEqual([x.errors, x.order], [[], [32, 39, 33, 36, 40, 31, 35, 34]]);
  return 'no error; only the LEADS-based holds apply (opted out, planned next action); conversation-based holds lifted, as before';
});

// ================================================================ W4 Cal.com booking sync
const CAL = require('../tests/fixtures/cal-booking-created.sample.json');
const calBody = (event, o = {}) => {
  const b = clone(CAL.body);
  b.triggerEvent = event;
  Object.assign(b.payload, { uid: o.uid || 'UID-1', startTime: o.start || '2026-10-08T05:30:00.000Z', endTime: o.end || '2026-10-08T06:15:00.000Z', status: 'ACCEPTED', eventTitle: 'Assessment', rescheduleUid: o.from || undefined });
  b.payload.attendees = [{ ...b.payload.attendees[0], name: 'Asha Patel', phoneNumber: o.phone || F.ASHA }];
  b.payload.responses.attendeePhoneNumber = { label: 'phone_number', value: o.phone || F.ASHA, isHidden: false };
  return b;
};
const cal = (w, body, o = {}) => {
  const sig = o.sig || crypto.createHmac('sha256', CAL_SECRET).update(JSON.stringify(body)).digest('hex');
  return run(w, 'W4 – Webhook1', [{ json: { headers: { 'content-type': 'application/json', 'x-cal-signature-256': sig }, params: {}, query: { clinic: o.clinic || 'demo-clinic' }, body } }], o);
};
const apptRows = (g) => rows(g, 'Appointments').filter((a) => /^UID-/.test(a.Booking_UID));
check('W4.1', 'valid Cal.com webhook (new patient)', () => {
  const x = cal(NEW, calBody('BOOKING_CREATED', { phone: '+919000000077' }), { crm: { leads: [], convs: [], msgs: [], appts: [] } });
  assert.deepStrictEqual([x.errors, apptRows(x.g).map((a) => [a.Status, a.Start]), rows(x.g, 'LEADS')[0].Status, x.meta.calls.length, x.claude.calls.length], [[], [['Booked', sec(Date.parse('2026-10-08T05:30:00.000Z'))]], 'Booked', 0, 0]);
  return 'signature verified; Appointments row with Cal.com\'s own time; new lead Booked; no send, no AI call';
});
check('W4.2', 'invalid signature', () => {
  const x = cal(NEW, calBody('BOOKING_CREATED'), { sig: 'deadbeef' });
  assert.deepStrictEqual([x.r.error && x.r.error.node, x.g.calls.filter((c) => c.method !== 'GET').length], ['W4 – Reject', 0]);
  return 'rejected at W4 – Reject, nothing written';
});
check('W4.3', 'booking for an existing lead', () => {
  const x = cal(NEW, calBody('BOOKING_CREATED'));
  const asha = rows(x.g, 'LEADS').find((l) => l.Phone === F.ASHA);
  assert.deepStrictEqual([apptRows(x.g).map((a) => [a.Lead, a.Status]), asha.Status, asha.Next_Action_At, logs(x.g, 'W4-booking-sync')[0].Record], [[[1, 'Booked']], 'Booked', undefined, 'UID-1 (created) L-20261001-0001']);
  return 'linked to the lead, lead Booked, Run_Log; the AI fields are not touched';
});
const cancelCase = (w) => { const g = crm(); cal(w, calBody('BOOKING_CREATED'), { g }); const x = cal(w, calBody('BOOKING_CANCELLED'), { g, now: F.NOW + 5 * MIN }); return x; };
check('W4.4', 'cancellation', () => {
  const x = cancelCase(NEW); const y = cancelCase(OLD);
  const asha = (g) => rows(g, 'LEADS').find((l) => l.Phone === F.ASHA);
  assert.deepStrictEqual([apptRows(x.g)[0].Status, logs(x.g, 'W4-booking-sync').map((l) => l.Record)[1], asha(x.g).Next_Action_At, asha(y.g).Next_Action_At], ['Cancelled', 'UID-1 (cancelled)', sec(F.NOW + 5 * MIN), undefined]);
  return 'Cancelled + Run_Log as before; NEW: lead Next_Action_At = now (rebook signal), never a time from AI';
});
check('W4.5', 'reschedule', () => {
  const g = crm(); cal(NEW, calBody('BOOKING_CREATED'), { g });
  const x = cal(NEW, calBody('BOOKING_RESCHEDULED', { uid: 'UID-2', from: 'UID-1', start: '2026-10-09T05:30:00.000Z', end: '2026-10-09T06:15:00.000Z' }), { g });
  assert.deepStrictEqual([x.errors, apptRows(g).map((a) => [a.Booking_UID, a.Status])], [[], [['UID-1', 'Rescheduled'], ['UID-2', 'Booked']]]);
  return 'old row Rescheduled, new row Booked at Cal.com\'s time';
});
check('W4.6', 'duplicate event', () => {
  const g = crm(); cal(NEW, calBody('BOOKING_CREATED'), { g }); const x = cal(NEW, calBody('BOOKING_CREATED'), { g });
  assert.deepStrictEqual([apptRows(g).length, logs(g, 'W4-booking-sync')[1].Error], [1, 'duplicate booking event']);
  return 'one row; second logged as skipped';
});
check('W4.7', 'unknown clinic', () => {
  const x = cal(NEW, calBody('BOOKING_CREATED'), { clinic: 'nope' });
  assert.strictEqual(x.r.error && x.r.error.node, 'W4 – Unknown clinic');
  return 'stops at W4 – Unknown clinic';
});
check('W4.8', 'cancellation of a booking with no lead', () => {
  const g = crm({ appts: [{ id: 9, fields: { Booking_UID: 'UID-1', Lead: 0, Start: sec(F.NOW + DAYMS), Status: 'Booked' } }] });
  const x = cal(NEW, calBody('BOOKING_CANCELLED'), { g });
  assert.deepStrictEqual([x.errors, apptRows(g)[0].Status, logs(g, 'W4-booking-sync').length], [[], 'Cancelled', 1]);
  return 'no lead write, no error';
});

// ================================================================ W5 reminders
const W5_LEADS = () => [51, 52, 53, 54, 55, 56, 57, 58].map((id) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: sec(F.NOW - 5 * DAYMS), Name: `Patient ${id}`, Phone: phone(id), Status: 'Booked', ...(id === 58 ? { Lead_Stage: 'hot', AI_Summary: 'Knee rehab, 3rd session.' } : {}) } }));
const W5_APPTS = () => [
  [51, 22 * 60, {}], [52, 30 * 60, {}], [53, 22 * 60, { Status: 'Cancelled' }], [54, 22 * 60, { R24_Sent: sec(F.NOW - HOUR) }], [55, 22 * 60, {}], [56, 90, {}], [57, 22 * 60, {}], [58, 22 * 60, {}],
].map(([lead, min, f]) => ({ id: lead, fields: { Booking_UID: `uid-${lead}`, Lead: lead, Service: 'Assessment', Physio: 'Dr Rao', Start: sec(F.NOW + min * MIN), End: sec(F.NOW + (min + 45) * MIN), Status: 'Booked', ...f } }));
const pendingCancel = { Needs_Human: true, Last_Intent: 'cancel_appointment', Last_Inbound_At: sec(F.NOW - 2 * HOUR) };
const W5_CONVS = () => [[55, pendingCancel], [56, pendingCancel], [57, { Needs_Human: true, Last_Intent: 'complaint', Last_Inbound_At: sec(F.NOW - HOUR) }], [58, { Last_Intent: 'pricing', Last_Inbound_At: sec(F.NOW - 3 * DAYMS) }]]
  .map(([lead, f], i) => ({ id: i + 1, fields: { Lead: lead, Phone: phone(lead), Automation_Paused: false, ...f } }));
const w5 = (w, o = {}) => {
  const g = o.g || crm({ settings: { TEST_MODE: 'true' }, leads: W5_LEADS(), convs: o.convs || W5_CONVS(), msgs: [], appts: W5_APPTS() });
  if (o.failConv) g.failAt('GET', 'Conversations', 1);
  const x = tick(w, 'W5 – Every 15 minutes', g, o);
  return { ...x, sent: rows(g, 'Appointments').filter((a) => a.R24_Sent || a.R2_Sent).map((a) => `${a.Lead}:${a.R2_Sent ? 'r2' : 'r24'}`).filter((s) => s !== '54:r24').sort() };
};
const N5 = w5(NEW); const O5 = w5(OLD);
check('W5.1', 'due reminder', () => { onlyW12(N5); assert(N5.sent.includes('51:r24') && logs(N5.g, 'W5-reminders').some((l) => l.Record === 'uid-51 (r24)')); return '24 h reminder through W12, R24_Sent + Run_Log'; });
check('W5.2', 'not-due reminder', () => { assert(!N5.sent.some((s) => s.startsWith('52:'))); return '30 h ahead: nothing'; });
check('W5.3', 'duplicate reminder', () => { const again = tick(NEW, 'W5 – Every 15 minutes', N5.g, { now: F.NOW + 15 * MIN }); assert.strictEqual(again.meta.calls.length, 0); return 'next run 15 min later: no second message (flag checked first)'; });
check('W5.4', 'cancelled appointment', () => { assert(!N5.sent.some((s) => s.startsWith('53:'))); return 'no reminder'; });
check('W5.5', 'already reminded', () => { assert.strictEqual(rows(N5.g, 'Appointments').find((a) => a.Lead === 54).R24_Sent, sec(F.NOW - HOUR)); assert(!N5.meta.calls.some((c, i) => (N5.r.runData['W5 – Decide send'] || [])[i] && N5.r.runData['W5 – Decide send'][i].json.appt_row_id === 54)); return 'R24_Sent already set: skipped'; });
check('W5.6', 'quiet hours', () => { const x = w5(NEW, { now: Date.parse('2026-10-06T22:00:00+05:30') }); assert.deepStrictEqual([x.meta.calls.length, x.sent], [0, []]); return '22:00 IST: nothing sent, no flag'; });
check('W5.7', 'human-handled conversation', () => {
  assert.deepStrictEqual([N5.sent.includes('55:r24'), O5.sent.includes('55:r24'), N5.sent.includes('56:r2'), N5.sent.includes('57:r24')], [false, true, true, true]);
  return 'pending WhatsApp cancel request: 24 h reminder held (the original sent it); the 2 h reminder still goes; a complaint (Needs_Human) still gets its reminder';
});
check('W5.8', 'AI context present', () => { assert(N5.sent.includes('58:r24')); return 'hot lead with summary: reminder exactly as before (AI context never adds or changes a reminder)'; });
check('W5.9', 'AI context absent', () => {
  const plain = (w) => w5(w, { convs: [] }).sent;
  assert.deepStrictEqual(plain(NEW), plain(OLD));
  return `no conversations: identical to the original (${plain(NEW).length} reminders)`;
});
check('W5.10', 'Conversations unreadable', () => { const x = w5(NEW, { failConv: true }); assert.deepStrictEqual([x.errors, x.sent], [[], O5.sent]); return 'no error; every due reminder goes, as before'; });

// ================================================================ W6 follow-ups + no-show
const D3 = sec(F.NOW - 3 * DAYMS);
const W6_LEADS = () => [
  [61, D3 - 12 * 3600, {}], [62, D3, { Lead_Stage: 'hot', AI_Summary: 'Wants evening knee sessions.' }], [63, D3, {}], [64, D3, {}], [65, D3, {}],
  [66, D3, { Opted_Out: true }], [67, D3, { Next_Action_At: sec(F.NOW + DAYMS) }], [68, D3, {}],
  [71, D3, { Status: 'Booked' }], [72, D3, { Status: 'Booked' }], [73, D3, { Status: 'Booked' }],
].map(([id, at, f]) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: at, Name: `Lead ${id}`, Phone: phone(id), Source: 'WhatsApp', Status: 'Contacted', ...f } }));
const W6_CONVS = () => [
  [63, { Last_Inbound_At: sec(F.NOW - 10 * HOUR) }], [64, { Needs_Human: true }], [65, { Assigned_To: 'Ravi' }], [68, { Automation_Paused: true }],
  [72, { Last_Inbound_At: sec(F.NOW - 2 * HOUR), Last_Intent: 'book_appointment' }], [73, { Needs_Human: true, Last_Intent: 'complaint' }],
].map(([lead, f], i) => ({ id: i + 1, fields: { Lead: lead, Phone: phone(lead), Automation_Paused: false, ...f } }));
const W6_APPTS = () => [71, 72, 73].map((lead) => ({ id: lead, fields: { Booking_UID: `ns-${lead}`, Lead: lead, Service: 'Assessment', Start: sec(F.NOW - 26 * HOUR), Status: 'No-show' } }));
const w6 = (w, o = {}) => {
  const ww = clone(w);
  if (o.cap) ww.nodes.find((n) => n.name === 'W6 – Config').parameters.assignments.assignments.find((a) => a.name === 'max_followups_per_run').value = o.cap;
  const g = crm({ settings: { TEST_MODE: 'true' }, leads: o.leads || W6_LEADS(), convs: o.convs || W6_CONVS(), msgs: [], appts: o.appts || W6_APPTS() });
  const x = tick(ww, 'W6 – Daily 10:00', g);
  const dec = Object.fromEntries((x.r.runData['W6 – Decide send'] || []).map((d) => [d.json.lead_row_id, d.json.decision.reason]));
  return { ...x, followed: rows(g, 'LEADS').filter((l) => l.Followup_Sent).map((l) => l.id), rebooked: rows(g, 'Appointments').filter((a) => a.Rebook_Sent).map((a) => a.Lead), dec, planned: (x.r.runData['W6 – Plan follow-ups'] || []).map((i) => i.json.lead_row_id) };
};
const N6 = w6(NEW); const O6 = w6(OLD);
check('W6.1', 'day-2 follow-up', () => { onlyW12(N6); assert.deepStrictEqual(N6.followed.sort(), [61, 62]); return 'sent through W12 (TEST_MODE), Followup_Sent'; });
check('W6.2', 'no-show', () => { assert(N6.rebooked.includes(71) && N6.meta.calls.some((c) => c.body.template.name === 'noshow_rebook')); return 'noshow_rebook through W12, Rebook_Sent'; });
check('W6.3', 'recently replied patient', () => {
  assert(!N6.planned.includes(63) && !N6.rebooked.includes(72) && O6.rebooked.includes(72));
  return 'day-2 held (wrote 10 h ago); rebook held because the patient wrote AFTER the missed visit (the original sent it)';
});
check('W6.4', 'human-owned conversation', () => {
  assert(!N6.planned.includes(64) && !N6.planned.includes(65) && !N6.rebooked.includes(73) && O6.followed.includes(65) && O6.rebooked.includes(73));
  return 'Needs_Human / Assigned_To: no day-2, no rebook (the original sent the Assigned_To day-2 and the Needs_Human rebook)';
});
check('W6.5', 'opted-out patient', () => { assert.deepStrictEqual([N6.dec[66], O6.dec[66], N6.followed.includes(66)], ['opted out', 'opted out', false]); return 'stopped by W6 – Decide send, as before'; });
check('W6.6', 'future next action', () => { assert(!N6.planned.includes(67)); return 'held'; });
check('W6.7', 'automation paused', () => { assert.deepStrictEqual([N6.dec[68], N6.followed.includes(68)], ['automation paused', false]); return 'stopped by W6 – Decide send, as before'; });
check('W6.8', 'AI summary present (hot first)', () => {
  assert.deepStrictEqual([w6(NEW, { cap: 1 }).followed, w6(OLD, { cap: 1 }).followed], [[62], [61]]);
  return 'only 1 follow-up allowed: the hot lead gets it (the original picked the oldest)';
});
check('W6.9', 'AI summary absent', () => {
  const plain = () => W6_LEADS().map((l) => { const f = { ...l.fields }; delete f.Lead_Stage; delete f.AI_Summary; delete f.Next_Action_At; return { id: l.id, fields: f }; });
  const a = w6(NEW, { leads: plain(), convs: [] }); const b = w6(OLD, { leads: plain(), convs: [] });
  assert.deepStrictEqual([a.followed.sort(), a.rebooked.sort()], [b.followed.sort(), b.rebooked.sort()]);
  return `no AI data: identical to the original (${a.followed.length} follow-ups, ${a.rebooked.length} rebooks)`;
});

// ================================================================ W11 error handler
const w11 = (message, node = 'W4 – Reject') => run(NEW, 'W11 – Error Trigger', [{ json: { execution: { id: '77', url: 'https://n8n.example/workflow/x/executions/77', error: { message }, lastNodeExecuted: node, mode: 'webhook' }, workflow: { id: 'MASTER', name: NEW.name } } }]);
check('W11.1', 'simulated workflow failure', () => { const x = cal(NEW, calBody('BOOKING_CREATED'), { sig: 'bad' }); assert.strictEqual(x.r.error.node, 'W4 – Reject'); return 'bad Cal.com signature stops the execution at W4 – Reject'; });
check('W11.2', 'error alert', () => { const x = w11('bad signature'); assert(x.r.telegram.length === 1 && x.r.telegram[0].text.includes('Step: W4 – Reject') && x.r.telegram[0].text.includes(NEW.name)); return 'Telegram alert names the workflow and the failing step'; });
check('W11.3', 'no patient data / secrets in the alert', () => {
  const t = w11('Grist 500 for patient +91 98765 43210 token=abc123secret Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 api_key=fake-key-for-test').r.telegram[0].text;
  assert(!/98765|abc123secret|eyJhbGci|fake-key-for-test/.test(t) && /\[number\]/.test(t) && /\[hidden\]/.test(t), t);
  return 'phone -> [number], token / bearer / api key -> [hidden]';
});

// ================================================================ W12 the only WhatsApp sender
const w12item = (over = {}) => ({ grist_base_url: 'http://grist:8484', doc_id: 'DOCA', source_workflow: 'system-test', audience: 'staff', template: 'hello_world', template_params: {}, message_text: 't',
  wa_phone_number_id: PNID, decision: { send: true, to: TESTP, reason: 't', test_mode: true }, lead_phone: F.ASHA, lead_row_id: 1, ...over });
const w12 = (item, o = {}) => { const x = run(NEW, 'W12 – When called by another workflow', [{ json: item }], o); return { ...x, out: x.r.runData['W12 – Return result'][0].json }; };
const textItem = (ago) => w12item({ audience: 'patient', message_type: 'text', text_body: 'Hello from the clinic', message_text: 'Hello from the clinic', template: '', last_inbound_at: sec(F.NOW) - ago });
check('W12.1', 'text send (24 h window open)', () => { const x = w12(textItem(600)); assert.deepStrictEqual([x.out.sent, x.meta.calls[0].body.type, x.meta.calls[0].body.text.body], [true, 'text', 'Hello from the clinic']); return 'free text accepted'; });
check('W12.2', 'template send', () => { const x = w12(w12item()); assert.deepStrictEqual([x.out.sent, x.meta.calls[0].body.template.name], [true, 'hello_world']); return 'template sent'; });
check('W12.3', 'allowlist', () => { const x = w12(w12item({ decision: { send: true, to: '+919111111111', reason: 't', test_mode: false } })); assert.deepStrictEqual([x.out.sent, x.meta.calls.length, /allowlist/.test(x.out.send_error)], [false, 0, true]); return 'number not on the allowlist: blocked, Meta never called'; });
check('W12.4', 'quiet hours', () => { const x = w12(w12item(), { now: Date.parse('2026-10-06T22:00:00+05:30') }); assert.deepStrictEqual([x.out.sent, x.meta.calls.length, /quiet hours/.test(x.out.send_error)], [false, 0, true]); return '22:00 IST: blocked'; });
check('W12.5', '24-hour window', () => { const x = w12(textItem(30 * 3600)); assert.deepStrictEqual([x.out.sent, x.meta.calls.length], [false, 0]); return `free text 30 h after the last message: refused before Meta (${x.out.send_error.slice(0, 60)})`; });
check('W12.6', 'failed Meta send', () => { const x = w12(w12item(), { metaAnswer: () => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }) }); assert.deepStrictEqual([x.out.sent, /131047/.test(x.out.send_error), x.errors], [false, true, []]); return 'sent = false with Meta\'s error, no crash'; });
check('W12.7', 'successful Meta send', () => { const x = w12(w12item()); assert.deepStrictEqual([x.out.sent, x.out.wa_message_id], [true, 'wamid.SENT.1']); return 'sent = true, wamid returned'; });

// ================================================================ W13 AI receptionist (through W2, as in production)
const decide = (over) => (req) => ({ ...F.fakeDecide(req), ...over });
const w13 = [
  ['W13.1', 'normal enquiry', 'Hi, I want to know about your services.', {}, (x) => x.last.AI_Status === 'replied' && /Knee pain physiotherapy/.test(x.texts[0]), 'replied from the knowledge base'],
  ['W13.2', 'service question', 'What services do you offer?', {}, (x) => /Knee pain physiotherapy and Back pain physiotherapy/.test(x.texts[0]), 'only services that are in Knowledge'],
  ['W13.3', 'price question', 'How much does this cost?', {}, (x) => x.texts[0] === 'The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each.', 'exact KB prices'],
  ['W13.4', 'availability', 'Can I come tomorrow evening?', {}, (x) => /^Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free/.test(x.texts[0]), 'real free slots only (17:00 taken)'],
  ['W13.5', 'booking intent', 'Book me for Saturday at 5.', {}, (x) => /cal\.com\/demo-physio\/assessment\?date=2026-10-10/.test(x.texts[0]), 'booking link for that day (link mode)'],
  ['W13.6', 'cancellation', 'Cancel my appointment tomorrow.', {}, (x) => /cal-uid-asha-1\?cancel=true/.test(x.texts[0]), 'cancel link of THAT booking'],
  ['W13.7', 'unknown question', 'Do you accept the XYZ health insurance card?', {}, (x) => x.last.AI_Status === 'handed_off' && x.texts[0] === HOLD, 'hand-off, nothing invented'],
  ['W13.8', 'human hand-off (asks for a person)', 'I want to talk to the doctor', { ai: decide({ intent: 'human_request', action: 'handoff', needs_human: true, reply: '', handoff_reason: 'wants the doctor' }) }, (x) => x.last.AI_Status === 'handed_off' && x.texts[1] === '[human_handoff_alert]', 'holding reply + staff alert'],
  ['W13.9', 'low confidence', 'How much does this cost?', { ai: decide({ confidence: 0.6 }) }, (x) => x.last.AI_Status === 'handed_off' && x.last.AI_Reason === 'low confidence (0.6)', 'person answers; the AI text is never sent'],
  ['W13.10', 'negative sentiment', 'Book me for Saturday at 5.', { ai: decide({ sentiment: 'negative' }) }, (x) => x.last.AI_Status === 'handed_off', 'non-informational + negative -> person'],
  ['W13.11', 'emergency keyword', 'I have severe chest pain', {}, (x) => x.claude.calls.length === 0 && x.last.AI_Reason.startsWith('[urgent · emergency]'), 'URGENT hand-off without an AI call'],
  ['W13.12', 'STOP', 'STOP', {}, (x) => x.last.AI_Status === 'opted_out' && x.meta.calls.length === 0, 'opted out, nothing sent'],
  ['W13.14', 'AI provider failure', 'How much does this cost?', { ai: () => ({ throw: 'timeout of 45000ms exceeded' }) }, (x) => x.last.AI_Status === 'handed_off' && x.last.AI_Reason.startsWith('fallback: ') && x.texts[0] === HOLD, 'timeout -> hand-off, marked fallback'],
];
for (const [id, title, text, o, ok, why] of w13) check(id, title, () => { const x = post(text, o); onlyW12(x); assert(ok(x), `${x.last.AI_Status} | ${x.last.AI_Reason} | ${x.texts.join(' / ')}`); return why; });
check('W13.13', 'duplicate', () => {
  const x = post('How much does this cost?', { id: 'wamid.D2' }); post('How much does this cost?', { id: 'wamid.D2', g: x.g, meta: x.meta, claude: x.claude });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length], [1, 1]);
  return 'one AI call, one reply';
});
check('W13.15', 'Grist failure', () => {
  const x = post('How much does this cost?', { g: crm().failAt('PATCH', 'Messages', 1) });
  assert.deepStrictEqual([x.claude.calls.length, x.meta.calls.length], [0, 0]);
  return 'claim fails -> no AI call, nothing sent';
});

// ================================================================ cross-cutting safety
check('X.1', 'AI context only holds back: W3 / W5 / W6 sends after ⊆ before, 120 random CRM states', () => {
  let n = 0; let rnd = 7;
  const r = (k) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % k; };
  const pick = (a) => a[r(a.length)];
  const conv = (lead) => ({ id: lead, fields: { Lead: lead, Phone: phone(lead), Automation_Paused: pick([true, false, false, false]), Assigned_To: pick(['', '', '', 'R']), Needs_Human: pick([true, false, false]),
    Last_Intent: pick(['', 'pricing', 'not_interested', 'opt_out', 'cancel_appointment', 'reschedule_appointment', 'junk']), Last_Inbound_At: pick([undefined, sec(F.NOW - 5 * MIN), sec(F.NOW - 20 * HOUR), sec(F.NOW - 4 * DAYMS)]) } });
  const ai = () => ({ Lead_Stage: pick(['hot', 'warm', 'cold', '', 'HOT!!']), AI_Summary: pick(['', 'x']), Next_Action_At: pick([undefined, sec(F.NOW + DAYMS), sec(F.NOW - DAYMS), 'soon']), Opted_Out: pick([false, false, true]) });
  for (let i = 0; i < 40; i++) {
    const ids = [81, 82, 83, 84, 85];
    const convs = ids.map(conv);
    const l3 = ids.map((id) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: sec(F.NOW - (35 + r(60)) * MIN), Name: 'x', Phone: phone(id), Status: 'New', Enquiry: 'e', ...ai() } }));
    const a3 = (w) => w3(w, crm({ settings: { TEST_MODE: 'true' }, leads: clone(l3), convs: clone(convs), msgs: [], appts: [] })).order;
    const l5 = ids.map((id) => ({ id, fields: { Name: 'x', Phone: phone(id), Status: 'Booked', Created_At: sec(F.NOW - 9 * DAYMS), ...ai() } }));
    const ap5 = ids.map((id) => ({ id, fields: { Booking_UID: `u${id}`, Lead: id, Start: sec(F.NOW + pick([22 * 60, 90, 30 * 60]) * MIN), Status: 'Booked' } }));
    const a5 = (w) => w5(w, { g: crm({ settings: { TEST_MODE: 'true' }, leads: clone(l5), convs: clone(convs), msgs: [], appts: clone(ap5) }) }).sent;
    const l6 = ids.map((id) => ({ id, fields: { Lead_id: `L-${id}`, Created_At: sec(F.NOW - 3 * DAYMS), Name: 'x', Phone: phone(id), Status: pick(['Contacted', 'New', 'Booked']), ...ai() } }));
    const ap6 = ids.filter(() => r(2)).map((id) => ({ id, fields: { Booking_UID: `n${id}`, Lead: id, Start: sec(F.NOW - 26 * HOUR), Status: 'No-show' } }));
    const a6 = (w) => { const x = w6(w, { leads: clone(l6), convs: clone(convs), appts: clone(ap6) }); return [...x.followed.map((v) => `f${v}`), ...x.rebooked.map((v) => `r${v}`)]; };
    for (const [after, before] of [[a3(NEW), a3(OLD)], [a5(NEW), a5(OLD)], [a6(NEW), a6(OLD)]]) { assert(after.every((s) => before.includes(s)), `state ${i}: ${after} not within ${before}`); n++; }
  }
  return `${n} comparisons: never a send the original would not have made`;
});
check('X.2', 'broken AI fields fall back to the original behaviour', () => {
  const junk = (l) => ({ id: l.id, fields: { ...l.fields, Lead_Stage: 'HOT!!', Next_Action_At: 'tomorrow', AI_Summary: null } });
  const junkConvs = (c) => ({ id: c.id, fields: { ...c.fields, Needs_Human: 'yes', Last_Intent: 12, Last_Inbound_At: 'today' } });
  const a = w6(NEW, { leads: W6_LEADS().map(junk), convs: W6_CONVS().map(junkConvs) }); const b = w6(OLD, { leads: W6_LEADS().map(junk), convs: [] });
  assert.deepStrictEqual(a.rebooked.sort(), b.rebooked.sort());
  return 'unreadable stage / dates / toggles are treated as unknown, never guessed';
});
check('X.3', 'no new model call anywhere outside W13', () => {
  const xs = [w3(NEW), w5(NEW), w6(NEW), cal(NEW, calBody('BOOKING_CREATED'))];
  assert(xs.every((x) => x.claude.calls.length === 0));
  return 'W3, W4, W5, W6 runs: 0 AI calls';
});
check('X.4', 'real connections', () => {
  throw new Error('NOT RUN: this sandbox cannot reach your n8n / Grist (Tailscale) and the export holds only credential references, no keys; real tests must be run in your n8n (see the README checklist)');
});

// ---------------------------------------------------------------- report
const width = Math.max(...results.map((r) => `${r.id} ${r.title}`.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${`${r.id} ${r.title}`.padEnd(width)}  ${r.why}`);
const expected = new Set(['X.4']);   // known, reported: no real connections from this sandbox
const bad = results.filter((r) => !r.ok && !expected.has(r.id));
const known = results.filter((r) => !r.ok && expected.has(r.id));
console.log(`\n${results.length - bad.length - known.length} PASS, ${known.length} known FAIL (reported, not caused by this change), ${bad.length} unexpected FAIL`);
if (process.env.SYSTEM_REPORT) fs.writeFileSync(process.env.SYSTEM_REPORT, JSON.stringify(results, null, 2));
if (bad.length) process.exit(1);
console.log(`SYSTEM TEST: ${results.length} checks run on ${path.basename(FILE)}`);
