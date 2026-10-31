#!/usr/bin/env node
// 4E (n8n/final/tools/patch-4e-no-quiet-hours.js): staff alerts, hand-off alerts, booking confirmations and replies to a patient who wrote to us are NOT held back at night;
// reminders, follow-ups, outcome check-ins and review requests (messages WE start) still are. Simulator with fake Grist / Meta / AI: nothing leaves this computer.
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const FILE_4E = process.env.FOURE_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4e.json');
const FILE_4D = path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4d.json');
process.env.PROD_FILE = FILE_4E;
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const H = require('../../production/tests/harness');
const { run, runItem, inboundRequest, messageBody, fakeMeta, ledger, rows, freshGrist, sendItem, test, finish, DAY, NIGHT, P, F, ENV, PNID, DOC } = H;
const patch = require('../tools/patch-4e-no-quiet-hours');
const D = '–';

const wf4e = JSON.parse(fs.readFileSync(FILE_4E, 'utf8'));
const wf4d = JSON.parse(fs.readFileSync(FILE_4D, 'utf8'));
const LIVE = { ...ENV, FLOWHQ_WA_SEND_MODE: 'live' };

test('the committed 4E file is exactly patch(4D): new id and name, inactive, 466 nodes', () => {
  assert.deepStrictEqual(patch.patch(wf4d), wf4e);
  assert.strictEqual(wf4e.id, patch.NEW_ID); assert.strictEqual(wf4e.active, false); assert.strictEqual(wf4e.nodes.length, wf4d.nodes.length);
  assert.notStrictEqual(wf4e.id, wf4d.id);
});
test('only code nodes changed; no node, connection or credential was added or removed', () => {
  assert.deepStrictEqual(wf4e.connections, wf4d.connections);
  const d = new Map(wf4d.nodes.map((n) => [n.name, n]));
  const changed = [];
  for (const n of wf4e.nodes) {
    const o = d.get(n.name); assert(o, `node ${n.name} is new`);
    assert.deepStrictEqual({ ...n, parameters: null }, { ...o, parameters: null }, `${n.name}: non-parameter fields changed`);
    if (JSON.stringify(n.parameters) !== JSON.stringify(o.parameters)) { changed.push(n.name); assert(typeof n.parameters.jsCode === 'string', `${n.name} changed but is not a code node`); }
  }
  for (const k of patch.KEEP) assert(changed.includes(k), `${k} should carry only the shared guard line`); // the guard copy changes, its call does not (checked below)
  assert(changed.includes(`W12 ${D} Prepare request`) && changed.includes(`W1 ${D} Staff alert plan`));
});

// --- the decision each caller makes, run through the simulator at 22:30 IST --------------------------------------------------------------------------------------
const base = { grist_base_url: ENV.FLOWHQ_GRIST_URL, doc_id: DOC, clinic_name: 'Demo Physio', test_mode: 'false', test_phone: P.TEST, wa_phone_number_id: PNID };
const decision = (wf, node, item, now) => {
  const res = run(wf, node, [item], { grist: freshGrist({ LEADS: [H.ashaLead()] }), meta: fakeMeta(), now, env: LIVE });
  return (res.r.runData[node] || [])[0].json.decision;
};
const proactive = [
  [`W6 ${D} Decide send`, { ...base, lead_phone: P.ASHA, flag_value: null, opted_out: false, automation_paused: false, kind: 'followup', lead_name: 'Asha', flag_row_id: 7, lead_row_id: 7 }],
];
test('staff escalation (W3) at 22:30: 4D holds it, 4E sends it at once', () => {
  const item = { ...base, owner_phone: P.OWNER, escalated: false, lead_phone: P.ASHA, lead_name: 'Asha', lead_row_id: 7 };
  assert.strictEqual(decision(wf4d, `W3 ${D} Decide send`, item, NIGHT).send, false);
  assert.deepStrictEqual(decision(wf4e, `W3 ${D} Decide send`, item, NIGHT), { send: true, to: P.OWNER, reason: 'ok', test_mode: false });
});
test('TEST_MODE still redirects the staff alert to TEST_PHONE, at night too', () => {
  const d = decision(wf4e, `W3 ${D} Decide send`, { ...base, test_mode: 'TRUE', owner_phone: P.OWNER, escalated: false, lead_phone: P.ASHA, lead_name: 'Asha', lead_row_id: 7 }, NIGHT);
  assert.deepStrictEqual([d.send, d.to, d.test_mode], [true, P.TEST, true]);
});
test('the "already escalated" sent flag still stops a second staff alert (rule 4)', () => {
  const d = decision(wf4e, `W3 ${D} Decide send`, { ...base, owner_phone: P.OWNER, escalated: true, lead_phone: P.ASHA, lead_name: 'Asha', lead_row_id: 7 }, NIGHT);
  assert.deepStrictEqual([d.send, d.reason], [false, 'already sent']);
});
test('a follow-up WE start (W6) is still held at 22:30 and goes out at 11:00', () => {
  for (const [node, item] of proactive) {
    assert.deepStrictEqual(decision(wf4e, node, item, NIGHT), { send: false, to: null, reason: 'quiet hours', test_mode: false });
    assert.strictEqual(decision(wf4e, node, item, DAY).send, true);
  }
});

// --- W12, the one sender -------------------------------------------------------------------------------------------------------------------------------------
const W12_START = `W12 ${D} When called by another workflow`;
const send = (over, now = NIGHT) => {
  const meta = fakeMeta(); const grist = freshGrist({ LEADS: [{ ...H.ashaLead(), fields: { ...H.ashaLead().fields, Consent_WhatsApp: true } }] });
  const res = run(wf4e, W12_START, [sendItem(over)], { grist, meta, now, env: LIVE });
  const o = (res.r.runData[`W12 ${D} Return result`] || [])[0].json;
  return { o, meta, grist };
};
const staff = { audience: 'staff', source_workflow: 'W1-website-lead', template: 'new_lead_staff_alert', idem_key: 'W1:created:L-1', template_params: { clinic_name: 'Demo Physio', lead_name: 'Asha', lead_phone: '+919000000011', enquiry: 'knee pain' }, decision: { send: true, to: P.OWNER, reason: 'ok', test_mode: false } };
test('W12 at 22:30: a new-lead staff alert is sent to Meta at once', () => { const x = send(staff); assert.deepStrictEqual([x.o.sent, x.o.send_status, x.meta.calls.length], [true, 'accepted', 1]); assert.strictEqual(x.meta.calls[0].body.template.name, 'new_lead_staff_alert'); });
test('W12 at 22:30: a human-hand-off alert is sent at once', () => { const x = send({ ...staff, source_workflow: 'W13-ai-receptionist', template: 'human_handoff_alert', idem_key: 'W13:h:1', template_params: { clinic_name: 'Demo Physio', lead_name: 'Asha', lead_phone: '+919000000011', reason: 'severe pain' } }); assert.deepStrictEqual([x.o.sent, x.meta.calls.length], [true, 1]); });
test('W12 at 22:30: the weekly owner report (staff audience) is sent', () => { const x = send({ ...staff, source_workflow: 'W9-weekly-report', template: 'weekly_owner_report', idem_key: 'W9:r:1', template_params: { clinic_name: 'Demo Physio', week: '26 Oct - 1 Nov', summary: 'ok', action: 'ok' } }); assert.deepStrictEqual([x.o.sent, x.meta.calls.length], [true, 1]); });
test('W12 at 22:30: a booking confirmation is sent', () => { const x = send({ source_workflow: 'W4-booking-sync', template: 'booking_confirmation', idem_key: 'W4:c:1', template_params: { name: 'Asha', clinic_name: 'Demo Physio', date: '15 Oct', time: '9:00 AM', service: 'Assessment' } }); assert.deepStrictEqual([x.o.sent, x.meta.calls.length], [true, 1]); });
test('W12 at 22:30: the AI reply (W13) and a staff-typed reply (W10) to a patient who wrote 5 minutes ago are sent', () => {
  for (const src of ['W13-ai-receptionist', 'W10-staff-reply']) {
    const x = send({ source_workflow: src, message_type: 'text', text_body: 'Our timings are 9 to 1 and 4 to 8.', last_inbound_at: Math.floor(NIGHT / 1000) - 300, template: '', idem_key: `${src}:t:1` });
    assert.deepStrictEqual([x.o.sent, x.meta.calls.length], [true, 1], `${src}: ${x.o.send_error}`);
  }
});
test('W12 at 22:30: messages WE start stay blocked by quiet hours (reminder, follow-up, rebook, outcome check, review request, a reminder sent as text)', () => {
  const cases = [
    { source_workflow: 'W5-reminders', template: 'reminder_24h', idem_key: 'k1' },
    { source_workflow: 'W6-followups', template: 'followup_day2', idem_key: 'k2', template_params: { name: 'Asha', clinic_name: 'Demo Physio', booking_link: 'https://x.example/b' } },
    { source_workflow: 'W6-followups', template: 'noshow_rebook', idem_key: 'k3', template_params: { name: 'Asha', service: 'Assessment', clinic_name: 'Demo Physio', date: '14 Oct 2026', booking_link: 'https://x.example/b' } },
    { source_workflow: 'W7-outcome-nudge', template: 'outcome_check', idem_key: 'k4', template_params: { name: 'Asha', clinic_name: 'Demo Physio', service: 'Assessment' } },
    { source_workflow: 'W8-review-request', template: 'review_request', idem_key: 'k5', template_params: { name: 'Asha', clinic_name: 'Demo Physio', review_link: 'https://x.example/r' } },
    { source_workflow: 'W15-followup-reminder', message_type: 'text', text_body: 'reminder', last_inbound_at: Math.floor(NIGHT / 1000) - 300, template: '', idem_key: 'k6' },
  ];
  for (const c of cases) { const x = send(c); assert.deepStrictEqual([x.o.sent, x.o.send_status, x.meta.calls.length], [false, 'blocked', 0], c.template || c.source_workflow); assert.match(x.o.send_error, /quiet hours/); }
});
test('W12: the same non-exempt messages DO go out at 11:00 (nothing else changed)', () => { const x = send({ source_workflow: 'W6-followups', template: 'followup_day2', idem_key: 'k9', template_params: { name: 'Asha', clinic_name: 'Demo Physio', booking_link: 'https://x.example/b' } }, DAY); assert.strictEqual(x.meta.calls.length, 1); });
test('W12 at 22:30: the allowlist still applies to a staff alert (a number that is not listed is blocked)', () => {
  const meta = fakeMeta(); const res = run(wf4e, W12_START, [sendItem(staff)], { grist: freshGrist({ LEADS: [H.ashaLead()] }), meta, now: NIGHT, env: { ...ENV, FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: P.TEST } });
  const o = (res.r.runData[`W12 ${D} Return result`] || [])[0].json; assert.deepStrictEqual([o.sent, o.send_status, meta.calls.length], [false, 'blocked', 0]); assert.match(o.send_error, /allowlist/);
});
test('W12 at 22:30: the send ledger still prevents a duplicate staff alert', () => {
  const meta = fakeMeta(); const grist = freshGrist({ LEADS: [H.ashaLead()] });
  for (let i = 0; i < 2; i++) run(wf4e, W12_START, [sendItem(staff)], { grist, meta, now: NIGHT, env: LIVE });
  assert.strictEqual(meta.calls.length, 1); assert.strictEqual(ledger(grist).length, 1);
});

// --- whole flows at night ---------------------------------------------------------------------------------------------------------------------------------
const settings = () => F.settingsRows({ TEST_MODE: 'false', owner_phone: P.OWNER, TEST_PHONE: P.TEST, booking_link: 'https://clinic.example.test/#book' });
test('W1 at 22:30: a website lead is stored AND the staff alert reaches Meta in the same run (4D: held, "quiet hours")', () => {
  const body = { clinic_slug: 'demo-physio', name: 'Test Patient', phone: '+919876543210', enquiry: 'Concern: Back Pain', page_url: 'https://site.example.test/', utm_campaign: '', consent_whatsapp: true, consent_version: 'DRAFT-2026-10-v1', request_id: 'req-00000077' };
  const go = (wf) => { const meta = fakeMeta(); const grist = freshGrist({ Settings: settings() }); const r = run(wf, `W1 ${D} Webhook`, [{ headers: {}, params: {}, query: {}, body }], { grist, meta, now: NIGHT, env: LIVE }); assert.strictEqual(r.r.error, null, r.r.error && `${r.r.error.node}: ${r.r.error.message}`); return { meta, grist }; };
  const before = go(wf4d); const after = go(wf4e);
  assert.strictEqual(before.meta.calls.length, 0, 'control: 4D holds the alert at night');
  assert.strictEqual(rows(after.grist, 'LEADS').length, 1);
  assert.strictEqual(after.meta.calls.length, 1); assert.strictEqual(after.meta.calls[0].body.template.name, 'new_lead_staff_alert');
  assert.strictEqual(String(after.meta.calls[0].body.to).replace(/\D/g, ''), String(P.OWNER).replace(/\D/g, ''));
  assert(!rows(after.grist, 'Run_Log').some((r) => /quiet hours/.test(String(r.Error || ''))), 'no "quiet hours" entry in Run_Log');
});
test('W13 at 22:30: a patient who writes at night gets the AI reply at once (4D defers it to 08:05)', () => {
  const go = (wf) => {
    const cl = F.fakeClaude(); const or = F.fakeOpenRouter(cl); const meta = fakeMeta();
    const g = freshGrist({ Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER }), LEADS: F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } })), Conversations: [], Messages: [] });
    const res = runItem(wf, `W2 ${D} Webhook Inbound`, inboundRequest(messageBody('What are your timings?', { id: `wamid.N.${wf.id}`, from: P.ASHA, name: 'Asha Patel', ts: Math.floor(NIGHT / 1000) })), { grist: g, now: NIGHT, openrouter: or, meta, env: { ...LIVE, FLOWHQ_AI_EXTERNAL_ENABLED: 'true' } });
    const errs = [res.r, ...(res.r.subRuns || [])].filter((x) => x.error).map((x) => `${x.error.node}: ${x.error.message}`); assert.deepStrictEqual(errs, [], errs.join(' | '));
    return { g, meta, msg: rows(g, 'Messages').find((m) => m.Direction === 'In') };
  };
  const toAsha = (m) => m.calls.filter((c) => c.body && String(c.body.to || '').replace(/\D/g, '') === String(P.ASHA).replace(/\D/g, ''));
  const before = go(wf4d); const after = go(wf4e);
  assert.strictEqual(toAsha(before.meta).length, 0, 'control: 4D sends nothing at night'); assert.strictEqual(before.msg.AI_Status, 'deferred');
  assert.strictEqual(toAsha(after.meta).length, 1, '4E answers at once'); assert.notStrictEqual(after.msg.AI_Status, 'deferred');
});

finish('4e-no-quiet-hours');
