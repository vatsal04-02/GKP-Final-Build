// STEP 04 - the three sections that sent Meta's sample template ("Hello World") and set their sent flag AFTER the send: W3, W5, W6.
//  * approved templates only (new_lead_staff_alert, reminder_24h / reminder_2h, noshow_rebook / followup_day2); nothing is sent with hello_world
//  * every message has an idempotency key; W12's send ledger refuses a second send, whatever the flag says
//  * the sent flag is set when W12 handled the message: sent, uncertain (may have been delivered: never retried automatically) or duplicate
//  * honest logs: Run_Log says ok / skipped (duplicate) / failed (uncertain, with the reason); a refused or invalid send is logged instead of vanishing
const GRIST_CRED = { httpHeaderAuth: { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' } };
const HANDLED = "={{ $json.sent === true || $json.uncertain === true || $json.duplicate === true }}";
const OUTCOME = "$json.sent === true ? 'ok' : ($json.duplicate === true ? 'skipped' : 'failed')";
const ERROR = "$json.sent === true ? '' : String($json.uncertain === true ? `uncertain: ${$json.send_error || 'no clear answer from Meta'} (not sent again; check the Send_Ledger and WhatsApp Manager)` : ($json.send_error || $json.send_status || 'not sent')).slice(0, 500)";

module.exports = {
  id: '04-callers',
  title: 'W3/W5/W6: approved templates, idempotency keys, honest sent flag and logs',
  run(ctx) {
    // ---- W3
    ctx.editCode('W3 – Build Message', [
      { find: "const template = 'hello_world';", replace: "const template = 'new_lead_staff_alert';   // PRODUCTION: the approved staff-alert template (never Meta's sample \"hello_world\")" },
      { find: "    audience: 'staff',\n", replace: "    audience: 'staff',\n    idem_key: `W3:new_lead_staff_alert:${item.lead_row_id}`,   // one alert per lead, whatever happens to the flag\n" },
    ]);
    ctx.editCode('W3 – Prepare sent log', [{ find: "Outcome: 'ok', Error: '', At: now", replace: `Outcome: ${OUTCOME}, Error: ${ERROR}, At: now` }]);
    // ---- W5
    ctx.editCode('W5 – Code in JavaScript', [
      { find: "const template = 'hello_world';", replace: "const template = ['reminder_24h', 'reminder_2h'].includes(item.template) ? item.template : (reminderType === 'r2' ? 'reminder_2h' : 'reminder_24h');   // PRODUCTION: approved templates only" },
      { find: "    audience: 'patient',\n", replace: "    audience: 'patient',\n    idem_key: `W5:${template}:${item.booking_uid || item.appt_row_id}`,\n" },
      { find: "    grist_base_url: 'http://grist:8484',\n", replace: "    grist_base_url: $('W5 – Config').first().json.grist_base_url,\n" },
    ]);
    ctx.editCode('W5 – Prepare sent log', [{ find: "Outcome: 'ok', Error: '', At: now", replace: `Outcome: ${OUTCOME}, Error: ${ERROR}, At: now` }]);
    // ---- W6
    ctx.editCode('W6 – Build Message', [
      { find: "  template = 'hello_world';\n\n  template_params = {};\n", replace: "  template = 'followup_day2';   // PRODUCTION: approved template (name, clinic_name, booking_link)\n\n  template_params = { name, clinic_name: clinic, booking_link };\n" },
      { find: "    audience: 'patient',\n    source_workflow: 'W6-followups',\n", replace: "    audience: 'patient',\n    source_workflow: 'W6-followups',\n    idem_key: `W6:${template}:${item.flag_row_id || item.lead_row_id}`,\n" },
    ]);
    ctx.editCode('W6 – Prepare writes', [
      { find: "const log = (record) => ({ Workflow: 'W6-followups', Record: record, Outcome: 'ok', Error: '', At: now });", replace: `const log = (record) => ({ Workflow: 'W6-followups', Record: record, Outcome: $json.kind === 'lost' ? 'ok' : ${OUTCOME}, Error: $json.kind === 'lost' ? '' : ${ERROR}, At: now });` },
    ]);
    ctx.log('04', 'W3 Build Message: hello_world -> new_lead_staff_alert; W5: hello_world -> reminder_24h / reminder_2h (and the literal Grist URL -> W5 – Config); W6: hello_world -> followup_day2 (needs booking_link); idem_key on every message');

    // ---- W13: every message it hands to W12 gets a key (the inbound message row + what it is for)
    ctx.editCode('W13 – Plan Ready', [{ find: 'const send_items = aiSendItems(plan, b.x, h);', replace: "const send_items = aiSendItems(plan, b.x, h).map((it) => ({ ...it, idem_key: `W13:${it.w13_kind}:${b.x.msg.row_id}` }));   // one reply / one staff alert per inbound message" }]);
    ctx.log('04', 'W13 – Plan Ready: idem_key W13:<kind>:<inbound message row> on every send item');

    // ---- sent flag: handled = sent | uncertain | duplicate; failures that matter are logged
    const section = {
      W3: { sent: 'W3 – Sent?', log: 'W3 – Prepare sent log', record: '`${j.lead_id} (alert not sent)`', wf: 'W3-speed-to-lead' },
      W5: { sent: 'W5 – Sent?', log: 'W5 – Prepare sent log', record: '`${j.booking_uid} (${j.kind}) not sent`', wf: 'W5-reminders' },
      W6: { sent: 'W6 – Sent?', log: 'W6 – Prepare writes', record: "j.kind === 'rebook' ? `${j.booking_uid} (rebook) ${j.lead_id} not sent` : `${j.lead_id} (followup) not sent`", wf: 'W6-followups' },
    };
    for (const [s, d] of Object.entries(section)) {
      ctx.node(d.sent).parameters.conditions.conditions[0].leftValue = HANDLED;
      const base = ctx.node(d.sent).position;
      ctx.ifNode(`${s} – Failed send to log?`, "={{ ['rejected', 'invalid'].includes($json.send_status) }}", [base[0] + 224, base[1] + 192]);
      ctx.codeNode(`${s} – Prepare failed log`, `// A send that Meta rejected or W12 found invalid (unknown template, empty variable, no key...) is logged: it used to vanish and be retried every run.
// "blocked" (allowlist, quiet hours, ledger unreachable) is normal and stays silent.
return $input.all().map((it) => { const j = it.json; return { json: { ...j, log: { Workflow: '${d.wf}', Record: ${d.record}, Outcome: 'failed', Error: String(j.send_error || j.send_status || 'not sent').slice(0, 500), At: Math.floor(Date.now() / 1000) } } }; });
`, [base[0] + 448, base[1] + 192]);
      ctx.add({
        name: `${s} – Write failed log`, type: 'n8n-nodes-base.httpRequest', typeVersion: ctx.like('n8n-nodes-base.httpRequest').typeVersion, position: [base[0] + 672, base[1] + 192], credentials: GRIST_CRED,
        parameters: { method: 'POST', url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Run_Log/records', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}', options: {} },
      });
      ctx.addOutput(d.sent, 1, `${s} – Failed send to log?`);
      ctx.setOutputs(`${s} – Failed send to log?`, [[`${s} – Prepare failed log`]]);
      ctx.setOutputs(`${s} – Prepare failed log`, [[`${s} – Write failed log`]]);
    }
    ctx.log('04', 'W3/W5/W6 "Sent?" now means handled (sent, uncertain or duplicate): the flag is set, so an uncertain send is never retried; Run_Log is honest (ok / skipped / failed with the reason); rejected or invalid sends are logged (new nodes "Failed send to log?", "Prepare failed log", "Write failed log")');
  },
};
