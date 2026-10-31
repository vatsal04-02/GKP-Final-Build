// Run: node n8n/snippets/followup-reminder.test.js
const assert = require('assert');
const { normalizeIndianPhone } = require('./normalize-phone');
const { frIso, frIstToday, frAddDays, frDateSec, frLabel, frOn, frPlan, frMessage, frIdemKey, frHeldSummary, FR_TEXT_WINDOW_SEC } = require('./followup-reminder');

const h = { normalizeIndianPhone };
const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const NOW = ist('2026-10-14', '10:25');                       // Wednesday 10:25 IST -> follow-ups on Thursday 15 Oct are due a reminder
const D = (iso) => frDateSec(iso);                            // a Grist Date cell
const cfg = { send_hour: 10, days_before: 1 };
const settings = { booking_link: 'https://cal.com/demo-physio' };
const lead = (over = {}) => ({ id: 7, fields: { Lead_id: 'L-1', Name: 'Asha', Phone: '+919000000011', Opted_Out: false, Consent_WhatsApp: true, ...over } });
const patient = (over = {}, id = 3) => ({ id, fields: { Patient_ID: 'GK-P-000003', Name: 'Asha Patel', Phone: '+91 90000 00011', Status: 'Active', Follow_Up_On: D('2026-10-15'), ...over } });
const plan = (o = {}) => frPlan(o.patients || [patient()], o.leads || [lead()], o.convs || [], o.now || NOW, o.cfg || cfg, o.settings || settings, h);
let n = 0;
const ok = (cond, msg) => { assert(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

// ---- dates
eq(frIso(D('2026-10-15')), '2026-10-15', 'a Grist Date cell reads as its day');
eq(frIso('2026-10-15'), '2026-10-15', 'an ISO date string is accepted');
eq([frIso(null), frIso(''), frIso('15/10/2026'), frIso(0)], ['', '', '', ''], 'empty or unreadable dates are no date');
eq(frIstToday(ist('2026-10-14', '23:30')), '2026-10-14', 'today is the IST day (23:30 IST is still the 14th)');
eq(frIstToday(Date.parse('2026-10-14T20:00:00Z')), '2026-10-15', '20:00 UTC is already the 15th in India');
eq(frAddDays('2026-10-31', 1), '2026-11-01', 'adding a day crosses the month');
eq(frAddDays('2026-12-31', 1), '2027-01-01', 'and the year');
eq(frLabel('2026-10-05'), '05 Oct 2026', 'the date as patients read it');
eq([frOn('on'), frOn('TRUE'), frOn('1'), frOn('off'), frOn(''), frOn(undefined)], [true, true, true, false, false, false], 'the switch: missing = off');

// ---- who is reminded
{
  const p = plan();
  eq([p.active, p.target, p.items.length], [true, '2026-10-15', 1], 'the day before, from 10:00 IST: one reminder planned');
  const it = p.items[0];
  eq([it.hold_reason, it.patient_id, it.lead_phone, it.lead_row_id, it.follow_up_on, it.booking_link], ['', 'GK-P-000003', '+919000000011', 7, '2026-10-15', 'https://cal.com/demo-physio'], 'the item carries what W12 needs');
}
eq(plan({ now: ist('2026-10-14', '09:59') }).items.length, 0, 'before send_hour nothing is planned');
eq(plan({ now: ist('2026-10-14', '09:59') }).active, false, 'and the run says it was not active');
eq(plan({ now: ist('2026-10-14', '20:59') }).items.length, 1, 'until quiet hours begin (a missed 10:25 run is caught later the same day)');
eq(plan({ now: ist('2026-10-14', '21:00') }).items.length, 0, 'never from 21:00 IST');
eq(plan({ patients: [patient({ Follow_Up_On: D('2026-10-16') })] }).items.length, 0, 'a follow-up two days away is not due yet');
eq(plan({ patients: [patient({ Follow_Up_On: D('2026-10-14') })] }).items.length, 0, 'a follow-up today is past the day-before reminder');
eq(plan({ patients: [patient({ Follow_Up_On: null })] }).items.length, 0, 'no follow-up date, no reminder');
eq(plan({ patients: [patient({ Status: 'Completed' })] }).items.length, 0, 'only Active patients');
eq(plan({ patients: [patient({ Followup_Reminded_For: D('2026-10-15') })] }).items.length, 0, 'rule 4: already reminded for this date -> never again');
eq(plan({ patients: [patient({ Followup_Reminded_For: D('2026-09-20') })] }).items.length, 1, 'reminded for an OLDER follow-up -> this new date is reminded');
eq(plan({ cfg: { send_hour: 10, days_before: 2 }, patients: [patient({ Follow_Up_On: D('2026-10-16') })] }).items.length, 1, 'days_before is configurable');
ok(plan({ cfg: { send_hour: 'ten', days_before: 1 } }).error, 'a broken config is reported, nothing planned');

// ---- held (not claimed, not sent)
const hold = (o) => plan(o).items[0].hold_reason;
ok(/booking_link/.test(hold({ settings: {} })), 'no booking link -> held (the template needs it)');
ok(/booking_link/.test(hold({ settings: { booking_link: 'http://not-https.example' } })), 'a non-https link is not used');
eq(hold({ patients: [patient({ Phone: '12345' })] }), 'no valid phone number', 'an invalid phone -> held');
ok(/no lead with this phone/.test(hold({ leads: [lead({ Phone: '+919000000099' })] })), 'no lead with the phone -> held (W12 would refuse it: no consent on file)');
eq(hold({ leads: [lead({ Opted_Out: true })] }), 'opted out', 'rule 5: opted out -> held');
ok(/Consent_WhatsApp/.test(hold({ leads: [lead({ Consent_WhatsApp: false })] })), 'no WhatsApp consent -> held');
ok(/Consent_WhatsApp/.test(hold({ leads: [lead({ Consent_WhatsApp: undefined })] })), 'missing consent counts as no consent');
eq(plan({ leads: [lead({ Phone: '9000000011' })] }).items[0].lead_row_id, 7, 'the lead is matched on the normalised number');
eq(plan({ leads: [lead(), lead({ Consent_WhatsApp: false }, 8)].map((l, i) => ({ ...l, id: 7 + i })) }).items[0].lead_row_id, 7, 'the FIRST lead with the number, as W12 finds it');

// ---- the conversation: paused and the 24 h window
{
  const convs = [{ id: 1, fields: { Lead: 7, Automation_Paused: true, Last_Inbound_At: Math.floor(NOW / 1000) - 3600 } }];
  const it = plan({ convs }).items[0];
  eq([it.automation_paused, it.hold_reason], [true, ''], 'Automation_Paused is passed on (send-guard.js blocks it as a non-transactional message)');
  eq(it.last_inbound_at, Math.floor(NOW / 1000) - 3600, 'the patient\'s last message is passed on');
}

// ---- the message
{
  const it = plan().items[0];
  const now = Math.floor(NOW / 1000);
  const tpl = frMessage(it, 'Demo Physio', now);
  eq([tpl.message_type, tpl.template], ['template', 'followup_reminder'], 'outside the 24 h window: the approved template');
  eq(tpl.template_params, { name: 'Asha', clinic_name: 'Demo Physio', date: '15 Oct 2026', booking_link: 'https://cal.com/demo-physio' }, 'template variables in order: name, clinic, date, link');
  eq(tpl.message_text, 'Hi Asha, a reminder from Demo Physio: your follow-up visit is due on 15 Oct 2026. Please book or confirm your time here: https://cal.com/demo-physio or simply reply to this message.', 'the inbox shows the template wording');
  const txt = frMessage({ ...it, last_inbound_at: now - 600 }, 'Demo Physio', now);
  eq([txt.message_type, txt.template, txt.text_body], ['text', '', tpl.message_text], 'inside the 24 h window: the same words as free text');
  eq(frMessage({ ...it, last_inbound_at: now - FR_TEXT_WINDOW_SEC }, 'Demo Physio', now).message_type, 'template', 'at the edge of the window: a template (W12 would refuse text)');
  eq(frMessage({ ...it, patient_name: '' }, '', now).template_params.name, 'there', 'no name -> "there"; no clinic name -> "the clinic"');
  eq(frMessage({ ...it, patient_name: '' }, '', now).template_params.clinic_name, 'the clinic', 'no clinic name -> "the clinic"');
}

// ---- the key and the summary
eq(frIdemKey({ patient_id: 'GK-P-000003', follow_up_on: '2026-10-15' }), 'W15:followup_reminder:GK-P-000003:2026-10-15', 'one key per patient per follow-up date');
ok(frIdemKey({ patient_id: 'GK-P-000003', follow_up_on: '2026-10-15' }) !== frIdemKey({ patient_id: 'GK-P-000003', follow_up_on: '2026-11-02' }), 'a new date is a new message');
eq(frHeldSummary([]), { total: 0, text: '' }, 'nothing held -> no summary line');
eq(frHeldSummary(['opted out', 'no consent', 'no consent']).text, '3 follow-up reminder(s) not sent: no consent 2; opted out 1', 'one line, the biggest reason first');

console.log(`followup-reminder: ${n} checks passed`);
