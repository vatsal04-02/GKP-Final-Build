// Run: node n8n/snippets/wa-send.test.js
const assert = require('assert');
const { normalizeIndianPhone } = require('./normalize-phone');
const { inQuietHours } = require('./send-guard');
const { WA_TEMPLATES, waCleanParam, waPrepare, waClassify, waInboxPlan, waInboxRow } = require('./wa-send');

const h = { normalizeIndianPhone, inQuietHours };
const DAY = Date.parse('2026-10-05T10:00:00+05:30');       // 10:00 IST
const NIGHT = Date.parse('2026-10-05T22:00:00+05:30');
const cfg = { send_mode: 'allowlist', allowlist: '98765 43210, +91 90000 00001', graph_api_version: 'v23.0', default_language: 'en' };
const base = {
  decision: { send: true, to: '+919876543210', reason: 'ok', test_mode: false },
  template: 'reminder_24h',
  template_params: { name: 'Asha', service: 'Assessment', clinic_name: 'Demo Physio', date: '06 Oct', time: '9:00 AM', physio: 'Dr Rao' },
  wa_phone_number_id: '123456789012345',
};
let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };
const prep = (over = {}, c = cfg, now = DAY) => waPrepare({ ...base, ...over }, c, now, h);

// ---------------------------------------------------------------- waPrepare: the request
let p = prep();
eq(p.call_meta, true);
eq(p.meta_url, 'https://graph.facebook.com/v23.0/123456789012345/messages');
eq(p.meta_request, {
  messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template',
  template: { name: 'reminder_24h', language: { code: 'en' }, components: [{ type: 'body', parameters: ['Asha', 'Assessment', 'Demo Physio', '06 Oct', '9:00 AM'].map((text) => ({ type: 'text', text })) }] },
}, 'reminder_24h: positional variables in the documented order; extra params (physio) ignored; "to" without +');
eq(prep({ template: 'hello_world', template_params: {} }).meta_request.template, { name: 'hello_world', language: { code: 'en_US' } }, 'hello_world: no components, en_US');
eq(prep({ template_language: 'en_GB' }).meta_request.template.language, { code: 'en_GB' }, 'caller can override the language');
eq(prep({}, { ...cfg, default_language: undefined }).meta_request.template.language, { code: 'en' }, 'default language en');
eq(prep({ template_params: { ...base.template_params, name: 'Asha\nRao\t  X     Y' } }).meta_request.template.components[0].parameters[0].text, 'Asha Rao X Y', 'new-lines, tabs and runs of spaces cleaned');
eq(prep({ template: 'new_lead_staff_alert', template_params: { clinic_name: 'D', lead_name: 'A', lead_phone: '+919800000001', enquiry: '' } }).meta_request.template.components[0].parameters[3].text, '(no message)', 'optional variable falls back');
eq(waCleanParam('x'.repeat(400)).length, 250);
eq(waCleanParam(42), '42');
eq(prep({ template: 'lead_escalation', template_params: { clinic_name: 'D', lead_name: 'A', lead_phone: '+91', waiting_minutes: 31 } }).meta_request.template.components[0].parameters[3].text, '31', 'numbers become text');
for (const t of Object.keys(WA_TEMPLATES)) assert(Array.isArray(WA_TEMPLATES[t].params));

// ---------------------------------------------------------------- waPrepare: when it must NOT call Meta
const stop = (o) => [o.call_meta, o.send_status];
eq(stop(prep({ decision: undefined })), [false, 'not_requested']);
eq(stop(prep({ decision: { send: false, reason: 'opted out' } })), [false, 'not_requested']);
eq(prep({ decision: { send: false, reason: 'opted out' } }).send_error, 'guard said no: opted out');
eq(stop(prep({ decision: { send: 'true', to: '+919876543210' } })), [false, 'not_requested'], 'only boolean true counts');
eq(stop(prep({}, { ...cfg, send_mode: 'off' })), [false, 'blocked']);
eq(stop(prep({}, { ...cfg, send_mode: 'LIVE ' })), [true, 'pending'], 'send_mode is trimmed and case-insensitive');
eq(stop(prep({}, { ...cfg, send_mode: undefined })), [false, 'blocked'], 'missing send_mode = off (fail safe)');
eq(stop(prep({}, { ...cfg, send_mode: 'everything' })), [false, 'blocked'], 'unknown send_mode = off');
eq(stop(prep({ decision: { ...base.decision, to: '+919811111111' } })), [false, 'blocked'], 'allowlist: other numbers refused');
eq(stop(prep({ decision: { ...base.decision, to: '+919811111111' } }, { ...cfg, send_mode: 'live' })), [true, 'pending'], 'live: anyone');
eq(stop(prep({ decision: { ...base.decision, to: '9000000001' } })), [true, 'pending'], 'allowlist entries in any phone format');
eq(stop(prep({}, { ...cfg, allowlist: '' })), [false, 'blocked'], 'empty allowlist = nobody');
eq(stop(prep({ decision: { ...base.decision, to: '12345' } })), [false, 'invalid']);
eq(stop(prep({}, { ...cfg, graph_api_version: 'REPLACE_WITH_GRAPH_API_VERSION' })), [false, 'invalid']);
eq(stop(prep({ wa_phone_number_id: '' })), [false, 'invalid']);
eq(stop(prep({ wa_phone_number_id: 'REPLACE_ME' })), [false, 'invalid']);
eq(stop(prep({ template: 'no_such_template' })), [false, 'invalid']);
eq(prep({ template: 'followup_day2', template_params: { name: 'A', clinic_name: 'D', booking_link: '' } }).send_error, 'template followup_day2: variable "booking_link" is empty', 'required variable empty -> refused before Meta');
eq(prep({ decision: { ...base.decision, to: '+919811111111' }, template: 'followup_day2', template_params: { name: 'A', clinic_name: 'D', booking_link: '' } }).send_status, 'invalid', 'a broken message is reported as invalid even when the allowlist would block it');
eq(prep({ wa_phone_number_id: '' }, { ...cfg, allowlist: '' }).send_status, 'invalid', 'set-up errors come before the allowlist');
eq(stop(prep({}, cfg, NIGHT)), [false, 'blocked']);
eq(prep({}, cfg, NIGHT).send_error, 'quiet hours (21:00-08:00 IST)');
eq(prep({ wa_phone_number_id: '' }, cfg, NIGHT).send_status, 'invalid', 'set-up errors are reported even at night');

// ---------------------------------------------------------------- waClassify
const ok = { statusCode: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: '919876543210', wa_id: '919876543210' }], messages: [{ id: 'wamid.ABC123', message_status: 'accepted' }] } };
let r = waClassify(ok, {});
eq([r.send_status, r.sent, r.wa_message_id, r.send_http_status, r.send_error], ['accepted', true, 'wamid.ABC123', 200, '']);
eq(waClassify({ statusCode: 200, body: JSON.stringify(ok.body) }, {}).wa_message_id, 'wamid.ABC123', 'string body parsed');
r = waClassify({ statusCode: 200, body: {} }, {});
eq([r.send_status, r.sent], ['uncertain', true], '200 without id = uncertain');

const metaErr = (status, code, message, details) => ({ statusCode: status, body: { error: { message, type: 'OAuthException', code, error_data: details ? { messaging_product: 'whatsapp', details } : undefined, fbtrace_id: 'x' } } });
r = waClassify(metaErr(400, 131030, '(#131030) Recipient phone number not in allowed list', 'Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again.'), {});
eq([r.send_status, r.sent, r.send_error_code, r.send_http_status], ['rejected', false, 131030, 400]);
assert(r.send_error.startsWith('131030: Recipient phone number not in allowed list') && r.send_error.includes("allowed list - add it in Meta"), r.send_error);
r = waClassify(metaErr(401, 190, 'Error validating access token: Session has expired'), {});
eq([r.send_status, r.sent, r.send_error_code], ['rejected', false, 190]);
assert(r.send_error.includes('permanent System User token'));
r = waClassify(metaErr(404, 132001, 'Template name does not exist in the translation', 'template name (reminder_24h) does not exist in en'), {});
assert(r.send_error.startsWith('132001: template name (reminder_24h) does not exist in en (template not found'), r.send_error);
eq(waClassify({ statusCode: 500, body: 'oops' }, {}).send_status, 'rejected', '5xx with junk body');
eq(waClassify({ statusCode: 429, body: { error: { code: 130429, message: 'Rate limit hit' } } }, {}).send_error_code, 130429);
eq(waClassify({ statusCode: 400, body: { error: { code: 99999, message: 'new code' } } }, {}).send_error, '99999: new code', 'unknown code: no hint, no crash');

r = waClassify({ error: { message: 'timeout of 15000ms exceeded' } }, {});
eq([r.send_status, r.sent], ['uncertain', true], 'timeout: uncertain, counted as sent (no double message)');
eq(waClassify({ error: { message: 'socket hang up' } }, { uncertain_counts_as_sent: false }).sent, false, 'switch: uncertain counted as NOT sent');
eq(waClassify({ error: 'The connection to the server was closed unexpectedly' }, {}).send_status, 'uncertain', 'string error');
for (const m of ['getaddrinfo ENOTFOUND graph.facebook.com', 'connect ECONNREFUSED 1.2.3.4:443', 'getaddrinfo EAI_AGAIN graph.facebook.com', 'unable to verify the first certificate']) {
  r = waClassify({ error: { message: m } }, {});
  eq([r.send_status, r.sent], ['rejected', false], `never left the machine: ${m}`);
}
// n8n's friendly rewrites of network errors, and error objects with the code in another field
for (const e of [{ message: 'The service refused the connection - perhaps it is offline' }, { message: 'The DNS server returned an error, perhaps the server is offline' }, { message: 'Request failed', code: 'ECONNREFUSED' }, { description: 'connect EHOSTUNREACH' }]) {
  r = waClassify({ error: e }, {});
  eq([r.send_status, r.sent], ['rejected', false], JSON.stringify(e));
}
for (const e of [{ message: 'The connection timed out, consider setting the Retry on Fail option' }, { message: 'The connection to the server was closed unexpectedly, perhaps it is offline' }, { name: 'NodeApiError' }]) {
  r = waClassify({ error: e }, {});
  eq([r.send_status, r.sent], ['uncertain', true], JSON.stringify(e));
}
eq(waClassify({ error: { name: 'NodeApiError' } }, {}).send_error, 'no clear answer from Meta (it may or may not have been sent): no reply from Meta', 'object without message: no "[object Object]"');
eq(waClassify(undefined, {}).send_status, 'uncertain', 'nothing at all');

// ---------------------------------------------------------------- inbox
const input = { ...base, audience: 'patient', lead_phone: '98765 43210', grist_base_url: 'http://grist:8484', doc_id: 'DOCA', source_workflow: 'W5-reminders', message_text: 'Hi Asha', lead_row_id: 7 };
eq(waInboxPlan(input, {}, { send_status: 'accepted' }, h), { log: true, patient_phone: '+919876543210' });
eq(waInboxPlan(input, { log_to_inbox: false }, { send_status: 'accepted' }, h).log, false, 'switch off');
eq(waInboxPlan({ ...input, audience: 'staff' }, {}, { send_status: 'accepted' }, h).log, false, 'staff alerts never go to the patient Inbox');
for (const s of ['not_requested', 'blocked', 'invalid']) eq(waInboxPlan(input, {}, { send_status: s }, h).log, false, `nothing attempted: ${s}`);
eq(waInboxPlan(input, {}, { send_status: 'rejected' }, h).log, true, 'a refused send is logged (as failed)');
eq(waInboxPlan({ ...input, lead_phone: '', patient_phone: '+919811111111' }, {}, { send_status: 'accepted' }, h).patient_phone, '+919811111111', 'patient_phone fallback');
eq(waInboxPlan({ ...input, doc_id: '' }, {}, { send_status: 'accepted' }, h).log, false, 'no doc id');

eq(waInboxRow(input, { send_status: 'accepted', wa_message_id: 'wamid.X' }, 1759640000), { Direction: 'Out', Body: 'Hi Asha', Template: 'reminder_24h', Sent_By: 'W5-reminders', WA_Message_ID: 'wamid.X', Status: 'queued', Send: false, Created_At: 1759640000 });
const testRow = waInboxRow({ ...input, decision: { ...base.decision, test_mode: true, to: '+919000000001' } }, { send_status: 'rejected', wa_message_id: '' }, 1);
eq([testRow.Status, testRow.Sent_By, testRow.Send], ['failed', 'W5-reminders (TEST_MODE: sent to +919000000001)', false]);
eq(waInboxRow({ template: 'hello_world' }, { send_status: 'uncertain' }, 1).Body, '[template hello_world]');

// ---------------------------------------------------------------- free-text replies (W13), 24-hour window
const LAST = Math.floor(DAY / 1000) - 600;   // the patient wrote 10 minutes ago
const text = (over = {}, c = cfg, now = DAY) => waPrepare({ ...base, template: '', template_params: {}, message_type: 'text', text_body: 'Hello! We are open 9-7.', last_inbound_at: LAST, ...over }, c, now, h);
p = text();
eq([p.call_meta, p.send_status], [true, 'pending']);
eq(p.meta_request, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text', text: { preview_url: false, body: 'Hello! We are open 9-7.' } }, 'text: type text, body as given, no template');
eq(text({ text_body: 'Book here: https://cal.com/demo' }).meta_request.text.preview_url, true, 'a link gets a preview');
eq(text({ text_body: '  a\u0000b\u0007  ' }).meta_request.text.body, 'ab', 'control characters removed, trimmed');
eq(text({ text_body: 'x'.repeat(5000) }).meta_request.text.body.length, 4096, 'WhatsApp text limit');
eq(stop(text({ text_body: '   ' })), [false, 'invalid']);
eq(stop(text({ last_inbound_at: undefined })), [false, 'invalid'], 'no last_inbound_at: refused (cannot prove the 24h window)');
eq(stop(text({ last_inbound_at: Math.floor(DAY / 1000) - 23 * 3600 })), [true, 'pending'], '23 h after the patient wrote: allowed');
eq(stop(text({ last_inbound_at: Math.floor(DAY / 1000) - 24 * 3600 })), [false, 'blocked'], '24 h: outside the window');
eq(text({ last_inbound_at: Math.floor(DAY / 1000) - 24 * 3600 }).send_error, 'outside the 24-hour WhatsApp window: only an approved template may be sent');
eq(stop(text({ decision: { ...base.decision, to: '+919811111111' } })), [false, 'blocked'], 'text obeys the allowlist');
eq(stop(text({}, cfg, NIGHT)), [false, 'blocked'], 'text obeys quiet hours');
eq(stop(text({ decision: { send: false, reason: 'automation paused' } })), [false, 'not_requested'], 'text obeys the caller guard');
eq(prep({ template: 'human_handoff_alert', template_params: { clinic_name: 'D', lead_name: 'A', lead_phone: '+919800000001', reason: '' } }).meta_request.template.components[0].parameters.map((x) => x.text), ['D', 'A', '+919800000001', '(see the Grist inbox)'], 'handoff alert template, reason falls back');
eq(waInboxRow({ ...input, message_type: 'text', template: '', message_text: '', text_body: 'Hi there' }, { send_status: 'accepted', wa_message_id: 'wamid.T' }, 5), { Direction: 'Out', Body: 'Hi there', Template: '', Sent_By: 'W5-reminders', WA_Message_ID: 'wamid.T', Status: 'queued', Send: false, Created_At: 5 }, 'text rows: body = the text, no template');

// ---------------------------------------------------------------- W7 / W8 / W9 templates and the W10 own-row flag
const vars = (t, tp) => prep({ template: t, template_params: tp }).meta_request.template.components[0].parameters.map((x) => x.text);
eq(vars('outcome_check', { name: 'Asha', clinic_name: 'Demo Physio', service: 'Knee rehab' }), ['Asha', 'Demo Physio', 'Knee rehab'], 'W7 outcome_check');
eq(vars('outcome_check', { name: 'Asha', clinic_name: 'Demo Physio', service: '' }), ['Asha', 'Demo Physio', 'visit'], 'W7: no service -> "visit"');
eq(vars('review_request', { name: 'Asha', clinic_name: 'Demo Physio', review_link: 'https://g.page/r/demo/review' }), ['Asha', 'Demo Physio', 'https://g.page/r/demo/review'], 'W8 review_request');
eq(stop(prep({ template: 'review_request', template_params: { name: 'Asha', clinic_name: 'Demo Physio', review_link: '' } })), [false, 'invalid'], 'W8: never sent without a review link');
eq(vars('weekly_owner_report', { clinic_name: 'Demo Physio', week: '29 Sep - 05 Oct', summary: '24 new leads, 11 booked', action: '' }), ['Demo Physio', '29 Sep - 05 Oct', '24 new leads, 11 booked', 'see the full report in Grist'], 'W9 weekly_owner_report');
eq(waInboxPlan({ ...input, inbox_row_id: 77 }, cfg, { send_status: 'accepted' }, h).log, false, 'W10: the staff row exists already -> not written again');
eq(waInboxPlan({ ...input, inbox_row_id: 0 }, cfg, { send_status: 'accepted' }, h).log, true, 'no own row -> logged as before');

console.log(`All ${n} wa-send cases pass`);
