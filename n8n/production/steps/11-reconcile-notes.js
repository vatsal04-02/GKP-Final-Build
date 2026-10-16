// STEP 11 - W14 send-ledger reconcile job, removal of the dead "W2 – Test Cases" node, and operator notes that match the production behaviour.
const note = (ctx, name, content) => { ctx.node(name).parameters.content = content; };

module.exports = {
  id: '11-reconcile-notes',
  title: 'W14 reconcile job, dead test node removed, operator notes rewritten',
  run(ctx) {
    // ---- the dead manual-test node of W2: no trigger reaches it, and its output would bypass the signature check if someone connected one
    ctx.removeNode('W2 – Test Cases');
    ctx.log('11', 'removed "W2 – Test Cases" (reachable by no trigger; it fed W2 – Config and so would have bypassed the signature check)');

    // ---- W14: settle ledger rows that never got a result
    const sched = ctx.node('W3 – Every 10 minutes');
    const at = (i, row = 0) => [sched.position[0] + 224 * i, sched.position[1] + 1400 + 180 * row];
    ctx.add({ name: 'W14 – Every 15 minutes', type: sched.type, typeVersion: sched.typeVersion, position: at(0), parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } });
    ctx.setNode('W14 – Config', [['grist_base_url', "={{ $env.FLOWHQ_GRIST_URL || 'http://grist:8484' }}"], ['registry_doc_id', "={{ $env.FLOWHQ_REGISTRY_DOC_ID || '' }}"], ['stale_minutes', 15, 'number'], ['unconfirmed_hours', 24, 'number']], at(1));
    ctx.codeNode('W14 – Config Guard', ctx.node('W3 – Config Guard').parameters.jsCode.replace(/W3/g, 'W14'), at(2));
    ctx.httpGrist('W14 – Clinics', 'GET', '={{ $json.grist_base_url }}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records', at(3), {}, { continueOnError: false });
    ctx.codeNode('W14 – Split clinics', ctx.node('W3 – Split clinics').parameters.jsCode.replace(/W3 – Config/g, 'W14 – Config'), at(4));
    ctx.httpGrist('W14 – Ledger rows', 'GET', '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Send_Ledger/records', at(5), { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: "={{ JSON.stringify({ Status: ['sending', 'uncertain'] }) }}" }, { name: 'limit', value: '500' }] } }, { continueOnError: false });
    ctx.codeNode('W14 – Plan', `// W14 SEND-LEDGER RECONCILE. A ledger row stays "sending" when the run died (or Grist was down) after Meta was called; it stays "uncertain" when Meta gave no
// clear answer. Neither is ever re-sent. Here they are only MARKED so a person can look: sending older than stale_minutes -> uncertain; uncertain older than
// unconfirmed_hours (no delivery receipt arrived) -> unconfirmed. Each change is a failed Run_Log row (Workflow W14-send-ledger). A delivery receipt (W2)
// settles a row at any time and wins over this job.
const cfg = $('W14 – Config').first().json;
const clinics = $('W14 – Split clinics').all();
const now = Math.floor(Date.now() / 1000);
const staleSec = (Number(cfg.stale_minutes) || 15) * 60;
const longSec = (Number(cfg.unconfirmed_hours) || 24) * 3600;
return $input.all().map((it, i) => {
  const clinic = clinics[i].json;
  const patches = [];
  const logs = [];
  for (const r of Array.isArray(it.json.records) ? it.json.records : []) {
    const f = r.fields || {};
    const age = now - (Number(f.Updated_At) || Number(f.Created_At) || now);
    if (f.Status === 'sending' && age >= staleSec) {
      patches.push({ id: r.id, fields: { Status: 'uncertain', Error: 'no result was recorded (the run may have stopped after calling Meta); not sent again', Updated_At: now } });
      logs.push({ Workflow: 'W14-send-ledger', Record: \`\${f.Idem_Key} (sending -> uncertain)\`.slice(0, 200), Outcome: 'failed', Error: 'no result recorded after the send was claimed; check WhatsApp Manager; it will not be sent again', At: now });
    } else if (f.Status === 'uncertain' && age >= longSec) {
      patches.push({ id: r.id, fields: { Status: 'unconfirmed', Updated_At: now } });
      logs.push({ Workflow: 'W14-send-ledger', Record: \`\${f.Idem_Key} (uncertain -> unconfirmed)\`.slice(0, 200), Outcome: 'failed', Error: \`no delivery receipt within \${cfg.unconfirmed_hours} h; it is unknown whether the message arrived; it will not be sent again\`, At: now });
    }
  }
  return { json: { ...clinic, has_changes: patches.length > 0, patch: { records: patches.slice(0, 100) }, logs: { records: logs.slice(0, 100).map((fields) => ({ fields })) } }, pairedItem: { item: i } };
});
`, at(6));
    ctx.ifNode('W14 – Has changes?', '={{ $json.has_changes === true }}', at(7));
    ctx.httpGrist('W14 – Patch ledger', 'PATCH', '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/Send_Ledger/records', at(8), { sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.patch) }}' }, { continueOnError: false });
    ctx.httpGrist('W14 – Write logs', 'POST', "={{ $('W14 – Plan').item.json.grist_base_url }}/api/docs/{{ $('W14 – Plan').item.json.doc_id }}/tables/Run_Log/records", at(9), { sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('W14 – Plan').item.json.logs) }}" }, { continueOnError: false });
    ctx.setOutputs('W14 – Every 15 minutes', [['W14 – Config']]);
    ctx.setOutputs('W14 – Config', [['W14 – Config Guard']]);
    ctx.setOutputs('W14 – Config Guard', [['W14 – Clinics']]);
    ctx.setOutputs('W14 – Clinics', [['W14 – Split clinics']]);
    ctx.setOutputs('W14 – Split clinics', [['W14 – Ledger rows']]);
    ctx.setOutputs('W14 – Ledger rows', [['W14 – Plan']]);
    ctx.setOutputs('W14 – Plan', [['W14 – Has changes?']]);
    ctx.setOutputs('W14 – Has changes?', [['W14 – Patch ledger']]);
    ctx.setOutputs('W14 – Patch ledger', [['W14 – Write logs']]);
    ctx.add({ name: 'Section W14', type: 'n8n-nodes-base.stickyNote', typeVersion: ctx.like('n8n-nodes-base.stickyNote').typeVersion, position: [sched.position[0], sched.position[1] + 1250], parameters: { content: '## SECTION W14 — SEND-LEDGER RECONCILE\n**Starts from:** Schedule: every 15 minutes\n\nFor every ACTIVE clinic: ledger rows still "sending" after 15 minutes become "uncertain"; "uncertain" rows with no delivery receipt after 24 hours become "unconfirmed". Nothing is ever re-sent. Each change is a failed Run_Log row (Workflow `W14-send-ledger`): look there after an outage.\n\nDelivery receipts (W2) settle ledger rows by themselves and win over this job.', width: 1500, height: 160 } });
    ctx.log('11', 'W14 – send-ledger reconcile (new section, every 15 minutes): stale "sending" -> "uncertain", old "uncertain" -> "unconfirmed", each logged in Run_Log; never re-sends');

    // ---- operator notes that match the production behaviour
    note(ctx, 'Section 00', `## SECTION 00 — MASTER / ENTRY POINTS (production candidate)
**FlowHQ Clinic Automation runs as ONE workflow.** Every trigger below starts only its own section. Sections are not chained.
This export is **inactive**. Read DEPLOYMENT.md, create the credentials (scripts/create-credentials.js), set the FLOWHQ_* environment variables, run scripts/migrate-grist.js, test in Mailpit/allowlist mode, then activate.

- **W1 – Webhook** — POST /webhook/website-lead (n8n Header Auth) -> SECTION W1
- **W2 – Webhook Verify / Inbound** — GET + POST /webhook/whatsapp-inbound (Meta; POST needs a valid X-Hub-Signature-256) -> SECTION W2
- **W3 – Every 10 minutes** -> SECTION W3 (speed to lead)
- **W4 – Webhook1** — POST /webhook/cal?clinic=<slug> (Cal.com, HMAC over the raw body) -> SECTION W4
- **W5 – Every 15 minutes** -> SECTION W5 (reminders)
- **W6 – Daily 10:00** -> SECTION W6 (follow-ups)
- **W7 / W8 – Every hour** -> outcome check-in / review request
- **W9 – Monday 09:00** -> weekly report (AI text only if FLOWHQ_AI_EXTERNAL_ENABLED=true)
- **W10 – Every minute** -> staff reply from the Grist inbox
- **W11 – Error Trigger** -> Telegram alert (needs FLOWHQ_TELEGRAM_CHAT_ID)
- **W12 – When called by another workflow** -> the ONE WhatsApp sender (send ledger, consent gate, quiet hours, TEST_MODE)
- **W14 – Every 15 minutes** -> send-ledger reconcile

**Secrets and settings** are never stored in this file: Config nodes read FLOWHQ_* environment variables, credentials are n8n credentials.
**WhatsApp:** only SECTION W12 calls Meta. A message needs idem_key (or booking_uid / inbox_row_id / message_row_id / week), an approved template and a decision from the caller's send guard.
**Missed-call capture is NOT part of this workflow** (no telephony provider is connected): see MISSED_CALL.md.`);
    note(ctx, 'Section W1', '## SECTION W1 — WEBSITE LEADS\n**Starts from:** POST /webhook/website-lead (n8n Header Auth)\n\nValidate (name, phone E.164, optional e-mail, consent) -> clinic lookup (Agency Registry) -> find / create / update the LEADS row (+ consent) -> **answer the website only after the lead is stored** (200 ok / duplicate, 400 invalid, 404 unknown clinic, 500 = try again) -> staff alert through W12 (`new_lead_staff_alert`, send guard, idempotency key) and optional e-mail (Mailpit locally) -> Run_Log.');
    note(ctx, 'W1 – Notes', `## W1 - Website lead intake
Form -> POST https://<your-domain>/webhook/website-lead with the header set in the credential "FlowHQ W1 Webhook Auth" (Header Auth: name X-Lead-Secret, a long random value).
Body (JSON): clinic_slug, name, phone, enquiry, page_url, utm_campaign, **consent_whatsapp** (checkbox: true / "on"), consent_email, email, consent_version (which consent text was shown), website (hidden honeypot: must be empty).
Answers: 200 {status ok|duplicate} - 400 {status invalid, error: missing name | invalid phone | invalid email | consent required} - 404 unknown clinic - 500 (Grist unavailable: the form may retry; a retry is a harmless duplicate).
FLOWHQ_W1_REQUIRE_CONSENT=false accepts forms without the checkbox but records "no consent given": W12 then sends that person no business-initiated template.
Staff are alerted on WhatsApp (owner_phone in the clinic's Settings; TEST_MODE sends to TEST_PHONE; quiet hours hold it) and, if FLOWHQ_ALERT_EMAIL_TO is set, by e-mail.`);
    note(ctx, 'W3 – Notes', '## W3 - Speed-to-lead\nEvery 10 minutes, for every ACTIVE clinic: finds leads still on Status = New that waited 30+ minutes and are not Escalated, runs the send guard and alerts the clinic OWNER through W12 (`new_lead_staff_alert`).\nEscalated is ticked when W12 handled the alert (sent, uncertain or duplicate), so an unclear Meta answer never makes the alert repeat. A refused or invalid send is logged in Run_Log.');
    note(ctx, 'Section W3', '## SECTION W3 — SPEED TO LEAD\n**Starts from:** Schedule: every 10 minutes\n\nNew leads waiting 30 min - 48 h -> guard (TEST_MODE / quiet hours) -> **W3 – Call W12** (`new_lead_staff_alert`, key W3:new_lead_staff_alert:<lead>) -> if handled: Escalated + Run_Log (ok / skipped / failed with the reason).');
    note(ctx, 'Section W4', '## SECTION W4 — BOOKING\n**Starts from:** POST /webhook/cal?clinic=<slug> (Cal.com, HMAC-signed)\n\nVerify the signature over the RAW body + replay window -> clinic lookup -> create / reschedule / cancel the Appointments row (+ LEADS) -> **answer** (401 / 422 / 404 / 200; 500 on a Grist failure) -> confirmation through W12 (`booking_confirmation`) -> Confirm_Sent + Run_Log.');
    note(ctx, 'W4 – Notes', `## W4 - Booking sync (Cal.com -> Grist)
Cal.com webhook URL: https://<your-domain>/webhook/cal?clinic=<Clinic_Slug>   Secret: the same value as FLOWHQ_CAL_WEBHOOK_SECRET (min 16 characters). Triggers: Booking created / rescheduled / cancelled.
The signature is checked over the exact bytes Cal.com sent (Webhook option "Raw Body"): a wrong or missing signature gets 401 and no alert. Events older than FLOWHQ_CAL_MAX_AGE_HOURS (default 24) are refused (replay).
Add to the Cal.com event type: a REQUIRED phone question, and a sentence saying the booking lets the clinic message the person about it (a lead created by a booking records Consent_Source cal.com-booking).
The confirmation is sent after the Grist writes. Not sent: TEST_MODE (goes to TEST_PHONE), opted-out, quiet hours (logged in Run_Log; no automatic catch-up).`);
    note(ctx, 'W5 – Notes', '## W5 - Appointment reminders (24h and 2h)\nEvery 15 minutes, for every ACTIVE clinic: finds Booked appointments due a reminder, runs the send guard and sends `reminder_24h` / `reminder_2h` through W12.\nR24_Sent / R2_Sent is set when W12 handled the message (sent, uncertain or duplicate). Rejected / invalid sends are logged in Run_Log; the next run tries again (a rejected message was never sent).');
    note(ctx, 'Section W5', '## SECTION W5 — REMINDERS\n**Starts from:** Schedule: every 15 minutes\n\nBooked appointments due for the 24 h / 2 h reminder -> guard -> **W5 – Call W12** (`reminder_24h` / `reminder_2h`, key W5:<template>:<booking>) -> if handled: R24_Sent / R2_Sent + Run_Log.');
    note(ctx, 'W6 – Notes', '## W6 - Follow-ups (daily 10:00 India time)\nFor every ACTIVE clinic:\n1. **No-show rebook** (`noshow_rebook`) - appointments marked No-show yesterday or the day before, no new booking.\n2. **Day-2 follow-up** (`followup_day2`, needs Settings > booking_link) - one per open lead.\n3. **Mark Lost** (mark_lost is OFF).\nFlags are set when W12 handled the message; a missing booking link or an unapproved template is logged, not silently skipped.');
    note(ctx, 'Section W6', '## SECTION W6 — FOLLOW UPS\n**Starts from:** Schedule: daily 10:00 (workflow time zone Asia/Kolkata)\n\nNo-show rebook, day-2 follow-up, mark Lost (mark_lost is OFF) -> guard -> **W6 – Call W12** -> if handled: Rebook_Sent / Followup_Sent + Run_Log.');
    note(ctx, 'Section W12', '## SECTION W12 — WHATSAPP SEND ENGINE\n**Starts from:** Execute Workflow Trigger (called by W1 / W3 / W4 / W5 / W6 / W7 / W8 / W9 / W10 / W13, one item per call) + Manual test\n\nThe ONE place that talks to Meta: decision from the caller -> send_mode allowlist / live -> template check (no hello_world) -> quiet hours -> **consent gate** -> **send ledger claim** -> Meta call (15 s, no retry) -> classification (accepted / rejected / uncertain) -> ledger result -> Grist inbox log.');
    note(ctx, 'W12 – Notes', `## W12 - WhatsApp send (reusable sub-workflow)
Other sections call it with **Execute Workflow** (mode: each). It sends ONE approved template or one free-text reply (inside the 24 h window) and returns the caller's item plus:
sent - uncertain - duplicate - idem_key - send_status - wa_message_id - send_error - send_error_code - send_http_status - inbox_logged - inbox_error.
send_status: accepted (sent) | rejected (not sent, may be tried again) | **uncertain** (no clear answer: it may have been delivered; NEVER re-sent automatically, NOT reported as sent) | duplicate (this idem_key was already handled) | blocked / invalid / not_requested (Meta was not called).
**Safety:** idempotency key required; a ledger row (Send_Ledger) is claimed BEFORE Meta is called; a business-initiated template to a patient needs LEADS.Consent_WhatsApp; hello_world is refused; quiet hours 21:00-08:00 IST block every send.
**Environment:** FLOWHQ_WA_SEND_MODE (allowlist | live | off; start with allowlist), FLOWHQ_WA_ALLOWLIST, FLOWHQ_WA_GRAPH_VERSION, FLOWHQ_WA_TEMPLATE_LANGUAGE.
**Test:** edit "Test input" (phone number id, doc id, your number) and Execute workflow. Delivery receipts (W2) update the ledger and Messages.Status.`);
    note(ctx, 'W2 – Section 00 Read Me', `## W2 – WhatsApp Inbound
Meta WhatsApp Cloud API -> n8n -> the clinic's Grist CRM. Sends nothing by itself (a reply, if any, is W13 -> W12).
**Webhook:** GET + POST /webhook/whatsapp-inbound. The POST must carry a valid X-Hub-Signature-256 (App Secret = FLOWHQ_META_APP_SECRET): otherwise 401 and nothing is read or written. The GET handshake uses FLOWHQ_META_VERIFY_TOKEN.
Delivery receipts (sent / delivered / read / failed) arrive on the same URL: they update Send_Ledger and Messages.Status.
Duplicates (same WA_Message_ID) change nothing. A patient who starts the chat is recorded with Consent_Source whatsapp-inbound (FLOWHQ_W2_IMPLIED_CONSENT=false turns that off). STOP opts the patient out (no AI needed).`);
    note(ctx, 'W11 – Notes', '## W11 - Error alert (Telegram)\nThis workflow contains the Error Trigger, so n8n runs it for failures of the whole workflow (all sections).\nThe alert holds only the workflow name, step, a trimmed error and a link: no patient data. The same failure alerts at most once per 10 minutes.\n**Set up:** credential "FlowHQ Telegram Alerts" (bot token) and FLOWHQ_TELEGRAM_CHAT_ID. Without a chat id no alert is sent (the failure is still in the execution list).');
  },
};
