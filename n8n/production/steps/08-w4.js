// STEP 08 - W4 (Cal.com bookings).
//  * the webhook answers AFTER the outcome is known: 401 bad/missing signature, 422 malformed booking, 404 unknown clinic, 200 ok / ignored; a Grist failure is a 500
//  * HMAC-SHA256 is computed over the EXACT raw bytes (Webhook option Raw Body), not over a re-serialised copy of the parsed JSON
//  * replay window: the event's createdAt must be within FLOWHQ_CAL_MAX_AGE_HOURS (default 24) of now
//  * the booking confirmation stub is replaced by a real confirmation through W12 (template booking_confirmation, idempotency key, Confirm_Sent set when handled, honest Run_Log)
//  * a lead created by a booking carries its consent (Consent_Source cal.com-booking); the Cal.com page must say that booking = contact about the booking
//  * the obsolete test webhook /cal-w4-test was removed in step 01
const fs = require('fs');
const path = require('path');
const META = fs.readFileSync(path.join(__dirname, '..', '..', 'snippets', 'meta-signature.js'), 'utf8');
const slice = (a, b) => { const i = META.indexOf(a); const j = META.indexOf(b); if (i < 0 || j < 0 || j < i) throw new Error(`meta-signature.js changed: ${a}`); return META.slice(i, j).trim(); };
const RAW_FUNCS = `${slice('// HMAC-SHA256 of raw bytes', 'const metaSigSecretUsable')}\n\n${slice('// The raw body out of the Webhook', '// in: { headers')}`;
const JSON_HEADERS = { entries: [{ name: 'Content-Type', value: 'application/json' }] };

module.exports = {
  id: '08-w4',
  title: 'W4: raw-body HMAC, replay window, respond after the outcome, real confirmation',
  run(ctx) {
    const hook = ctx.node('W4 – Webhook1');
    hook.parameters.responseMode = 'responseNode';
    hook.parameters.options = { rawBody: true };
    ctx.setValue('W4 – Config', 'cal_max_age_hours', "={{ Number($env.FLOWHQ_CAL_MAX_AGE_HOURS || 24) }}", 'number');

    // ---- signature over the raw bytes + replay window + reject kinds
    ctx.editCode('W4 – Verify & parse', [
      { find: "function safeEqual(a, b) {", replace: `${RAW_FUNCS}\n\nfunction safeEqual(a, b) {` },
      { find: "  const reject = (reason) => ({ json: { route: 'reject', reject_reason: reason } });", replace: "  const reject = (reason, kind) => ({ json: { route: 'reject', reject_kind: kind || 'bad_request', reject_reason: reason } });   // kind 'auth' = answered 401, no alert" },
      {
        find: `  // 1. Is it really Cal.com? It signs JSON.stringify(body) with the webhook secret (HMAC-SHA256, hex) in
  //    X-Cal-Signature-256. With no secret set, Cal.com sends the text "no-secret-provided".
  if ($json.require_signature !== false) {
    const secret = String($json.cal_webhook_secret || '');
    const sig = String(headers['x-cal-signature-256'] || '').trim().toLowerCase();
    if (!secret || secret.startsWith('REPLACE_')) return reject('Cal.com webhook secret is not set in the Config node');
    if (!sig || sig === 'no-secret-provided') return reject('unsigned request: set the same Secret in the Cal.com webhook');
    if (!body || typeof body !== 'object' || !safeEqual(hmacSha256Hex(secret, JSON.stringify(body)), sig)) return reject('bad signature');
  }`,
        replace: `  // 1. Is it really Cal.com? It signs the EXACT bytes it sends (HMAC-SHA256, hex) with the webhook secret in X-Cal-Signature-256.
  //    The bytes come from the Webhook node option "Raw Body" (a re-serialised copy of the parsed JSON is not the same bytes).
  //    With no secret set, Cal.com sends the text "no-secret-provided". A signature problem is answered 401 and does not raise an alert.
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const secret = String($json.cal_webhook_secret || '');
  const sig = String(lower['x-cal-signature-256'] || '').trim().toLowerCase();
  if (secret.length < 16 || /^(REPLACE_|PASTE_)/i.test(secret)) return reject('Cal.com webhook secret is not set', 'auth');
  if (!/^[0-9a-f]{64}$/.test(sig)) return reject(sig === 'no-secret-provided' ? 'unsigned request: set the same Secret in the Cal.com webhook' : 'missing or malformed signature', 'auth');
  const webItem = $('W4 – Webhook1').item;
  const bytes = metaSigRawBytes(webItem && webItem.binary);
  if (!bytes) return reject('the raw body is not available (Webhook option Raw Body off, or binary data not stored in memory)', 'auth');
  if (!safeEqual(hmacSha256HexBytes(secret, bytes), sig)) return reject('bad signature', 'auth');`,
      },
      {
        find: "  const p = body.payload || {};\n",
        replace: `  const p = body.payload || {};

  // 2b. Replay window: Cal.com puts the time of the event in createdAt. An old, captured request is refused even if its signature is valid.
  const maxAgeH = Number($json.cal_max_age_hours) > 0 ? Number($json.cal_max_age_hours) : 24;
  const createdMs = Date.parse(body.createdAt);
  if (!(createdMs > 0)) return reject('the webhook body has no createdAt', 'bad_request');
  if (Math.abs(Date.now() - createdMs) > maxAgeH * 3600 * 1000) return reject(\`event time is outside the \${maxAgeH} h replay window\`, 'auth');
`,
      },
    ]);
    ctx.editCode('W4 – Resolve clinic', [{ find: "      clinic_name: found ? String(f.Clinic_Name || '') : '',\n", replace: "      clinic_name: found ? String(f.Clinic_Name || '') : '',\n      wa_phone_number_id: found ? String(f.WA_Phone_Number_ID || '').trim() : '',\n" }]);
    ctx.editCode('W4 – Build new lead', [{ find: "    Status: 'Booked',\n  };", replace: "    Status: 'Booked',\n    Consent_WhatsApp: true,                    // booking = contact about the booking (the Cal.com page says so)\n    Consent_Source: 'cal.com-booking',\n    Consent_At: Math.floor(now / 1000),\n    Consent_Version: 'cal-booking',\n  };" }]);
    ctx.editCode('W4 – Plan writes', [
      { find: "  // Confirmation: STUB. Nothing is sent. The guard still runs so the log shows what would happen.\n  // There is no \"confirmation sent\" column, so a repeated BOOKING_CREATED is stopped earlier (the row exists).", replace: "  // Confirmation: sent by W12 after the writes (W4 – Confirm item). The guard decides who gets it (TEST_MODE -> TEST_PHONE, Opted_Out, quiet hours).\n  // A repeated BOOKING_CREATED is stopped earlier (the row exists); W12's ledger also refuses a second send for the same booking." },
      { find: '    sent: false,\n    stub: true,\n  };', replace: '    lead_row_id: lead.id,\n    lead_phone: patient_phone,\n  };' },
    ]);
    ctx.log('08', 'W4 – Verify & parse: HMAC over the raw body (Raw Body option), 401 without alert for signature problems, replay window (createdAt); W4 – Resolve clinic carries wa_phone_number_id; leads created by a booking carry consent');

    // ---- answers
    const respond = (name, code, body, pos, extra = {}) => ctx.add({ name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: ctx.like('n8n-nodes-base.respondToWebhook').typeVersion, position: pos, parameters: { respondWith: 'text', responseBody: body, options: { responseCode: code, responseHeaders: JSON_HEADERS } }, ...extra });
    respond('W4 – Respond Rejected', "={{ $json.reject_kind === 'auth' ? 401 : 422 }}", "={{ JSON.stringify($json.reject_kind === 'auth' ? { status: 'unauthorized' } : { status: 'rejected' }) }}", ctx.pos('W4 – Rejected?', 224, -120));
    ctx.ifNode('W4 – Alert worthy?', "={{ $json.reject_kind !== 'auth' }}", ctx.pos('W4 – Rejected?', 448, -120));
    respond('W4 – Respond Ignored', 200, "={{ JSON.stringify({ status: 'ignored' }) }}", ctx.pos('W4 – Rejected?', 224, 120));
    respond('W4 – Respond Unknown clinic', 404, "={{ JSON.stringify({ status: 'unknown_clinic' }) }}", ctx.pos('W4 – Clinic found?', 224, 140));
    ctx.insertAfter('W4 – Rejected?', 0, 'W4 – Respond Rejected');
    ctx.insertAfter('W4 – Respond Rejected', 0, 'W4 – Alert worthy?');
    ctx.addOutput('W4 – Rejected?', 1, 'W4 – Respond Ignored');
    ctx.insertAfter('W4 – Clinic found?', 1, 'W4 – Respond Unknown clinic');

    ctx.codeNode('W4 – Writes done', `// Every Grist write succeeded (a failed write stops the run: the webhook then answers 500 and Cal.com / a person can retry).
// confirm = a booking was created or moved AND the send guard allows a confirmation now.
const from = (name) => {
  try { return $(name).first().json; } catch (e) { return null; }   // throws if that branch did not run
};
const made = from('W4 – Plan writes');
const planned = made || from('W4 – Plan appointment');
const action = planned && planned.plan ? planned.plan.action : 'skip';
const confirm = !!made && ['create', 'update'].includes(action) && !!made.confirmation && made.confirmation.decision && made.confirmation.decision.send === true;
return { json: { action, confirm, uid: planned ? planned.uid : '' } };
`, ctx.pos('W4 – Grist write', 224, 0));
    respond('W4 – Respond OK', 200, "={{ JSON.stringify({ status: 'ok', action: $json.action }) }}", ctx.pos('W4 – Grist write', 448, 0), { executeOnce: true });
    ctx.ifNode('W4 – Confirm?', '={{ $json.confirm === true }}', ctx.pos('W4 – Grist write', 672, 0));
    ctx.codeNode('W4 – Confirm item', `// The booking confirmation for W12 (approved template booking_confirmation). Recipient and permission come from the guard in W4 – Plan writes.
const p = $('W4 – Plan writes').first().json;
const c = p.confirmation;
const wrote = $('W4 – Grist write').all();
const expanded = $('W4 – Expand writes').all();
let appt_row_id = 0;                                  // the appointment row this confirmation is about (new row id, or the one that was updated)
expanded.forEach((e, i) => {
  if (e.json.table !== 'Appointments') return;
  const recs = ((wrote[i] || {}).json || {}).records;
  if (e.json.method === 'POST' && recs && recs[0]) appt_row_id = Number(recs[0].id) || appt_row_id;
  if (e.json.method === 'PATCH' && e.json.body.records[0].fields.Status === 'Booked') appt_row_id = e.json.body.records[0].id;
});
return { json: {
  source_workflow: 'W4-booking-sync', audience: 'patient', idem_key: \`W4:booking_confirmation:\${p.uid}:\${p.start}\`,   // one confirmation per booking and time
  template: c.template, template_params: c.template_params, message_text: c.message_text, decision: c.decision,
  wa_phone_number_id: p.wa_phone_number_id, grist_base_url: p.grist_base_url, doc_id: p.doc_id, lead_row_id: c.lead_row_id, lead_phone: c.lead_phone,
  appt_row_id, booking_uid: p.uid, start: p.start, lead_label: p.lead_label,
} };
`, ctx.pos('W4 – Grist write', 896, -100));
    ctx.add({
      name: 'W4 – Call W12', type: 'n8n-nodes-base.executeWorkflow', typeVersion: ctx.node("W3 – Call 'W12 - WhatsApp send'").typeVersion, position: ctx.pos('W4 – Grist write', 1120, -100),
      parameters: JSON.parse(JSON.stringify(ctx.node("W3 – Call 'W12 - WhatsApp send'").parameters)),
    });
    ctx.codeNode('W4 – Confirm result', `// What happened to the confirmation. Confirm_Sent is set when W12 handled it (sent, uncertain or duplicate), so it is never sent twice.
const j = $json;
const handled = j.sent === true || j.uncertain === true || j.duplicate === true;
const outcome = j.sent === true ? 'ok' : (j.duplicate === true ? 'skipped' : (j.uncertain === true || ['rejected', 'invalid'].includes(j.send_status) ? 'failed' : 'skipped'));
const error = j.sent === true ? '' : (j.uncertain === true ? \`uncertain: \${j.send_error || 'no clear answer from Meta'} (not sent again)\` : String(j.send_error || j.send_status || 'not sent'));
return { json: { ...j, confirm_patch: handled && Number(j.appt_row_id) > 0 ? { records: [{ id: Number(j.appt_row_id), fields: { Confirm_Sent: Math.floor(Date.now() / 1000) } }] } : null, log: { Workflow: 'W4-booking-sync', Record: \`\${j.booking_uid} (confirmation) \${j.lead_label || ''}\`.trim().slice(0, 200), Outcome: outcome, Error: error.slice(0, 500), At: Math.floor(Date.now() / 1000) } } };
`, ctx.pos('W4 – Grist write', 1344, -100));
    ctx.ifNode('W4 – Mark confirmed?', '={{ !!$json.confirm_patch }}', ctx.pos('W4 – Grist write', 1568, -100));
    ctx.httpGrist('W4 – Write Confirm_Sent', 'PATCH', "={{ $('W4 – Confirm result').first().json.grist_base_url }}/api/docs/{{ $('W4 – Confirm result').first().json.doc_id }}/tables/Appointments/records", ctx.pos('W4 – Grist write', 1792, -200), { sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('W4 – Confirm result').first().json.confirm_patch) }}" });
    ctx.httpGrist('W4 – Write confirm log', 'POST', "={{ $('W4 – Confirm result').first().json.grist_base_url }}/api/docs/{{ $('W4 – Confirm result').first().json.doc_id }}/tables/Run_Log/records", ctx.pos('W4 – Grist write', 2016, -100), { sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ records: [{ fields: $('W4 – Confirm result').first().json.log }] }) }}" });

    ctx.setOutputs('W4 – Grist write', [['W4 – Writes done']]);
    ctx.setOutputs('W4 – Writes done', [['W4 – Respond OK']]);
    ctx.setOutputs('W4 – Respond OK', [['W4 – Confirm?']]);
    ctx.setOutputs('W4 – Confirm?', [['W4 – Confirm item']]);
    ctx.setOutputs('W4 – Confirm item', [['W4 – Call W12']]);
    ctx.setOutputs('W4 – Call W12', [['W4 – Confirm result']]);
    ctx.setOutputs('W4 – Confirm result', [['W4 – Mark confirmed?']]);
    ctx.setOutputs('W4 – Mark confirmed?', [['W4 – Write Confirm_Sent'], ['W4 – Write confirm log']]);
    ctx.setOutputs('W4 – Write Confirm_Sent', [['W4 – Write confirm log']]);
    ctx.log('08', 'W4: answers via Respond to Webhook after the outcome (401 / 422 / 404 / 200; Grist failure = 500); the confirmation stub is replaced by Confirm item -> W12 (booking_confirmation, key W4:booking_confirmation:<uid>:<start>) -> Confirm_Sent + honest Run_Log');
  },
};
