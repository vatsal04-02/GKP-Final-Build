// STEP 07 - W1 (website enquiry).
//  * the webhook answers AFTER the enquiry is validated and stored (Respond to Webhook): 200 ok / duplicate, 400 invalid (with the reason), 404 unknown clinic;
//    a Grist failure is an HTTP 500 (the website can retry; a retry is a harmless duplicate)
//  * validation: name, phone (E.164), optional e-mail, consent; a hidden honeypot field is answered 200 and logged, never stored
//  * consent is captured on the lead: Consent_WhatsApp / Consent_Email / Consent_Source / Consent_At / Consent_Version (new columns, migration script)
//  * the staff alert stub is replaced by a real alert through W12 (approved template, TEST_MODE / quiet-hours guard, idempotency key), logged honestly
const fs = require('fs');
const path = require('path');
const phone = require('./06-phones');

const JSON_HEADERS = { entries: [{ name: 'Content-Type', value: 'application/json' }] };
const respond = (ctx, name, code, body, pos) => ctx.add({
  name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: ctx.like('n8n-nodes-base.respondToWebhook').typeVersion, position: pos,
  parameters: { respondWith: 'text', responseBody: body, options: { responseCode: code, responseHeaders: JSON_HEADERS } },
});

module.exports = {
  id: '07-w1',
  title: 'W1: respond after storing, validation, consent, real staff alert',
  run(ctx) {
    const w3 = ctx.node('W3 – Decide send').parameters.jsCode;
    const a = w3.indexOf('function isTestMode');
    const b = w3.indexOf('  const { phone: owner_phone }');
    if (a < 0 || b < 0 || b < a) throw new Error('could not find the send-guard block in "W3 – Decide send"');
    const GUARD = w3.slice(a, b).trimEnd();

    ctx.node('W1 – Webhook').parameters.responseMode = 'responseNode';
    ctx.setValue('W1 – Config', 'require_consent', "={{ $env.FLOWHQ_W1_REQUIRE_CONSENT !== 'false' }}", 'boolean');

    // ---- validation + consent
    ctx.editCode('W1 – Prepare lead', [
      {
        find: '  const honeypot = line(body.website, 200);   // hidden field: humans leave it empty, bots fill it\n',
        replace: `  const honeypot = line(body.website, 200);   // hidden field: humans leave it empty, bots fill it
  const yes = (v) => v === true || ['true', 'on', 'yes', '1'].includes(String(v === null || v === undefined ? '' : v).trim().toLowerCase());
  const emailRaw = line(body.email, 120);
  const email = /^[^\\s@<>"']{1,64}@[^\\s@<>"']+\\.[A-Za-z]{2,}$/.test(emailRaw) ? emailRaw.toLowerCase() : '';
  const consent_whatsapp = yes(body.consent_whatsapp) || yes(body.consent);   // the form's consent checkbox (HTML sends "on")
  const consent_email = yes(body.consent_email) && !!email;
  const consent_version = line(body.consent_version, 40);                     // which consent text the person saw
`,
      },
      {
        find: "  else if (!valid) skip_reason = 'invalid phone';\n",
        replace: "  else if (!valid) skip_reason = 'invalid phone';\n  else if (emailRaw && !email) skip_reason = 'invalid email';\n  else if ($json.require_consent !== false && !consent_whatsapp) skip_reason = 'consent required';\n",
      },
      { find: '      utm_campaign: line(body.utm_campaign, 100),\n', replace: '      utm_campaign: line(body.utm_campaign, 100),\n      email,\n      consent_whatsapp,\n      consent_email,\n      consent_version,\n' },
    ]);
    ctx.editCode('W1 – Build new lead', [{
      find: "    Status: 'New',\n  };",
      replace: "    Status: 'New',\n    Email: ctx.email,\n    Email_Opted_Out: false,\n    Consent_WhatsApp: ctx.consent_whatsapp === true,\n    Consent_Email: ctx.consent_email === true,\n    Consent_Source: ctx.consent_whatsapp ? 'website-form' : 'website-form (no consent given)',\n    Consent_At: ctx.consent_whatsapp ? Math.floor(now / 1000) : null,\n    Consent_Version: ctx.consent_version,\n  };",
    }]);
    ctx.editCode('W1 – Build update', [
      { find: '  const has_changes = Object.keys(fields).length > 0;', replace: "  // consent given NOW is recorded; earlier consent is never removed here\n  if (ctx.consent_whatsapp && !rec.fields.Consent_WhatsApp) { fields.Consent_WhatsApp = true; fields.Consent_Source = 'website-form'; fields.Consent_At = Math.floor(Date.now() / 1000); if (ctx.consent_version) fields.Consent_Version = ctx.consent_version; }\n  if (ctx.consent_email && !rec.fields.Consent_Email) fields.Consent_Email = true;\n  if (ctx.email && !String(rec.fields.Email || '')) fields.Email = ctx.email;\n\n  const has_changes = Object.keys(fields).length > 0;" },
      { find: "      lead_id: rec.fields.Lead_ID || `row ${rec.id}`,", replace: "      lead_id: rec.fields.Lead_id || rec.fields.Lead_ID || `row ${rec.id}`,\n      lead_row_id: rec.id," },
    ]);
    ctx.editCode('W1 – Build new lead', [{ find: "  return { json: { ...ctx, action: 'created', lead_id, create: { records: [{ fields }] } } };", replace: "  return { json: { ...ctx, action: 'created', lead_id, create: { records: [{ fields }] } } };   // lead_row_id is known after the insert" }]);

    // ---- respond after storing
    const at = (name, dx, dy) => ctx.pos(name, dx, dy);
    respond(ctx, 'W1 – Respond Created', 200, "={{ JSON.stringify({ status: 'ok', action: 'created', lead_id: $('W1 – Build new lead').first().json.lead_id }) }}", at('W1 – Create lead', 112, 120));
    respond(ctx, 'W1 – Respond Updated', 200, "={{ JSON.stringify({ status: 'ok', action: 'updated', lead_id: $('W1 – Build update').first().json.lead_id }) }}", at('W1 – Update lead', 112, -120));
    respond(ctx, 'W1 – Respond Duplicate', 200, "={{ JSON.stringify({ status: 'duplicate' }) }}", at('W1 – Has changes?', 112, 140));
    respond(ctx, 'W1 – Respond Invalid', "={{ $json.skip_reason === 'honeypot filled' ? 200 : 400 }}", "={{ JSON.stringify($json.skip_reason === 'honeypot filled' ? { status: 'ok' } : { status: 'invalid', error: $json.skip_reason }) }}", at('W1 – Input valid?', 112, 140));
    respond(ctx, 'W1 – Respond Unknown clinic', 404, "={{ JSON.stringify({ status: 'unknown_clinic' }) }}", at('W1 – Clinic found?', 112, 140));
    ctx.insertAfter('W1 – Clinic found?', 1, 'W1 – Respond Unknown clinic');
    ctx.insertAfter('W1 – Input valid?', 1, 'W1 – Respond Invalid');
    ctx.insertAfter('W1 – Has changes?', 1, 'W1 – Respond Duplicate');

    // ---- the real staff alert (replaces the stub)
    ctx.httpGrist('W1 – Alert settings', 'GET', "={{ $('W1 – Resolve clinic').first().json.grist_base_url }}/api/docs/{{ $('W1 – Resolve clinic').first().json.doc_id }}/tables/Settings/records", at('W1 – Staff alert (stub)', 0, -140));
    ctx.codeNode('W1 – Staff alert plan', `${GUARD}

${phone.FN}

// W1 STAFF ALERT (replaces the stub). Who is told: the clinic owner (Settings > owner_phone), or TEST_PHONE while TEST_MODE is on (a missing TEST_MODE row counts as ON).
// Same send guard as W3: quiet hours 21:00-08:00 IST hold the alert (W3 escalates a lead nobody answered). W12 sends: approved template, idempotency key, ledger.
const from = (name) => {
  try { return $(name).first().json; } catch (e) { return null; }   // throws if that branch did not run
};
const ctx = from('W1 – Build update') || from('W1 – Build new lead');
const settings = {};
for (const r of Array.isArray($json.records) ? $json.records : []) { const f = r.fields || {}; if (f.Key) settings[String(f.Key).trim()] = f.Value; }
const owner = normalizeIndianPhone(settings.owner_phone).phone;
const testPhone = normalizeIndianPhone(settings.TEST_PHONE).phone;
const decision = decideSend({ kind: 'transactional', flag_value: null, opted_out: false, automation_paused: false, patient_phone: owner, test_mode: settings.TEST_MODE, test_phone: testPhone, now_ms: Date.now() });
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const clinic = ctx.clinic_name || ctx.clinic_slug;
const enquiry = String(ctx.enquiry || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
const what = ctx.action === 'created' ? 'New website lead' : 'Existing lead enquired again';
return {
  json: {
    ...ctx,
    source_workflow: 'W1-website-lead',
    audience: 'staff',
    template: 'new_lead_staff_alert',
    template_params: { clinic_name: clinic, lead_name: ctx.name, lead_phone: ctx.phone, enquiry: ctx.action === 'created' ? enquiry : \`(again) \${enquiry}\`.trim() },
    message_text: \`\${what} (\${clinic}): \${ctx.name}, \${ctx.phone}\${enquiry ? \` - "\${enquiry}"\` : ''}. \${ctx.lead_id}.\`,
    idem_key: \`W1:\${ctx.action}:\${ctx.lead_id}:\${hash(enquiry)}\`,   // a retried submission never alerts twice
    wa_phone_number_id: ctx.wa_phone_number_id,
    lead_phone: ctx.phone,
    decision,
    send: decision.send,
    settings_ok: Array.isArray($json.records),
  },
};
`, at('W1 – Staff alert (stub)', 0, 0));
    ctx.ifNode('W1 – Alert send?', '={{ $json.decision.send === true }}', at('W1 – Staff alert (stub)', 224, 0));
    ctx.add({
      name: 'W1 – Call W12', type: 'n8n-nodes-base.executeWorkflow', typeVersion: ctx.node("W3 – Call 'W12 - WhatsApp send'").typeVersion, position: at('W1 – Staff alert (stub)', 448, -80),
      parameters: JSON.parse(JSON.stringify(ctx.node("W3 – Call 'W12 - WhatsApp send'").parameters)),
    });
    const outcome = "j.sent === true ? 'ok' : (j.duplicate === true ? 'ok' : (['rejected', 'invalid'].includes(j.send_status) || j.uncertain === true ? 'failed' : 'ok'))";
    ctx.codeNode('W1 – Alert result', `// The lead is stored (the website already got its answer). What happened to the staff alert is logged honestly.
const j = $json;
const note = j.sent === true ? '' : (j.duplicate === true ? 'staff alert already sent earlier (duplicate)' : (j.uncertain === true ? \`lead stored; staff alert uncertain: \${j.send_error || 'no clear answer from Meta'} (not sent again)\` : \`lead stored; staff alert not sent: \${j.send_error || j.send_status || 'unknown'}\`));
return { json: { ...j, staff_alert_sent: j.sent === true, log: { Workflow: 'W1-website-lead', Record: \`\${j.lead_id} (\${j.action})\`, Outcome: ${outcome}, Error: note.slice(0, 500), At: Math.floor(Date.now() / 1000) } } };
`, at('W1 – Staff alert (stub)', 672, -80));
    ctx.codeNode('W1 – Alert skipped', `// The lead is stored; the alert was held by the guard (quiet hours, no owner number, TEST_MODE without TEST_PHONE ...). W3 escalates a lead nobody answers.
const j = $json;
return { json: { ...j, staff_alert_sent: false, log: { Workflow: 'W1-website-lead', Record: \`\${j.lead_id} (\${j.action})\`, Outcome: 'ok', Error: \`lead stored; staff alert not sent now: \${(j.decision && j.decision.reason) || 'guard'}\${j.settings_ok ? '' : ' (clinic Settings could not be read)'}\`.slice(0, 500), At: Math.floor(Date.now() / 1000) } } };
`, at('W1 – Staff alert (stub)', 448, 100));

    // rewire: Create/Update -> Respond -> Alert settings -> plan -> send? -> W12 -> result | skipped -> Run_Log
    ctx.removeNode('W1 – Staff alert (stub)');
    ctx.setOutputs('W1 – Create lead', [['W1 – Respond Created']]);
    ctx.setOutputs('W1 – Update lead', [['W1 – Respond Updated']]);
    ctx.setOutputs('W1 – Respond Created', [['W1 – Alert settings']]);
    ctx.setOutputs('W1 – Respond Updated', [['W1 – Alert settings']]);
    ctx.setOutputs('W1 – Alert settings', [['W1 – Staff alert plan']]);
    ctx.setOutputs('W1 – Staff alert plan', [['W1 – Alert send?']]);
    ctx.setOutputs('W1 – Alert send?', [['W1 – Call W12'], ['W1 – Alert skipped']]);
    ctx.setOutputs('W1 – Call W12', [['W1 – Alert result']]);
    ctx.setOutputs('W1 – Alert result', [['W1 – Write Run_Log']]);
    ctx.setOutputs('W1 – Alert skipped', [['W1 – Write Run_Log']]);
    ctx.log('07', 'W1: webhook now answers via Respond to Webhook AFTER storing (200 ok/duplicate, 400 invalid with reason, 404 unknown clinic; honeypot 200); consent + optional e-mail captured on the lead; the staff-alert stub is replaced by Alert settings -> plan (send guard) -> W12 (new_lead_staff_alert, idempotency key) -> honest Run_Log');
  },
};
