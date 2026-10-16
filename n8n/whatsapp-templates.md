# WhatsApp message templates

Every automated message is a Meta-approved **template**, with one exception: a message to a patient who wrote to the
clinic in the last 24 hours may be free text (WhatsApp's customer-service window, `message_type: 'text'`; W12 refuses free text
outside the window). W13's replies and W10's staff replies are always free text; W7 and W8 send their template's wording as
free text inside the window, the template outside it. W12 (`n8n/workflows/W12-whatsapp-send.json`) fills the
variables `{{1}}, {{2}}, ...` **by position**, in the order below (`WA_TEMPLATES` in `n8n/snippets/wa-send.js`).
The template you create in WhatsApp Manager must use the **same name, the same number of variables, in the same order**,
or Meta rejects the send (error 132000 / 132001, shown in W12's `send_error`).

Create them in **WhatsApp Manager > Message templates > Create template**:
- Language: **English** (code `en`, W12's default). If you pick *English (US)* instead, set `w12_default_language` to `en_US`.
- Meta decides the category on review. Utility costs less than Marketing (see the pricing notes in the build guide).
- Meta needs a sample value for every variable when you submit; use the examples below.
- Meta's rules: a template may not start or end with a variable, and needs enough plain words around its variables.

| Template | Used by | Suggested category | Variables, in order (example) |
|---|---|---|---|
| `hello_world` | W12 manual test | (Meta's sample, already on the test number, language `en_US`) | none |
| `booking_confirmation` | W4 | Utility | 1 name (Asha), 2 service (Assessment), 3 clinic_name (Demo Physio), 4 date (06 Oct), 5 time (9:00 AM) |
| `reminder_24h` | W5 | Utility | 1 name, 2 service, 3 clinic_name, 4 date, 5 time |
| `reminder_2h` | W5 | Utility | 1 name, 2 service, 3 clinic_name, 4 time |
| `noshow_rebook` | W6 | Marketing (likely) | 1 name, 2 service, 3 clinic_name, 4 date, 5 booking_link (https://cal.com/...) |
| `followup_day2` | W6 | Marketing (likely) | 1 name, 2 clinic_name, 3 booking_link |
| `new_lead_staff_alert` | W1 (staff) | Utility | 1 clinic_name, 2 lead_name (Ravi), 3 lead_phone (+919800000001), 4 enquiry (Back pain; empty becomes "(no message)") |
| `lead_escalation` | W3 (owner), if you choose it over `new_lead_staff_alert` | Utility | 1 clinic_name, 2 lead_name, 3 lead_phone, 4 waiting_minutes (31) |
| `human_handoff_alert` | W13 (owner) when the AI hands a conversation to a person | Utility | 1 clinic_name, 2 lead_name, 3 lead_phone, 4 reason (question not covered by the knowledge base; empty becomes "(see the Grist inbox)") |
| `outcome_check` | W7 (patient, after a Completed visit) | Utility (likely) | 1 name (Asha), 2 clinic_name (Demo Physio), 3 service (Knee pain physiotherapy; empty becomes "visit") |
| `review_request` | W8 (patient, after a Completed visit) | Marketing (likely) | 1 name (Asha), 2 clinic_name (Demo Physio), 3 review_link (https://g.page/r/.../review, from Settings > review_link) |
| `weekly_owner_report` | W9 (owner, optional) | Utility | 1 clinic_name (Demo Physio), 2 week (05 Oct 2026 to 11 Oct 2026), 3 summary (5 new leads (2 booked), 3 visits completed, 1 no-show, 2 cancelled, 2 AI hand-offs, 2 waiting for a person), 4 action (Call the 1 lead that is still New today.; empty becomes "see the full report in Grist") |

## Suggested body texts

- **booking_confirmation**: Hi {{1}}, your {{2}} at {{3}} is confirmed for {{4}} at {{5}}. Reply to this message if you need to change it.
- **reminder_24h**: Hi {{1}}, this is a reminder that your {{2}} at {{3}} is tomorrow, {{4}} at {{5}}. Reply to this message if you need to reschedule.
- **reminder_2h**: Hi {{1}}, your {{2}} at {{3}} is today at {{4}}. We look forward to seeing you.
- **noshow_rebook**: Hi {{1}}, we missed you at your {{2}} at {{3}} on {{4}}. You can pick a new time here: {{5}} or simply reply to this message and we will help.
- **followup_day2**: Hi {{1}}, thank you for contacting {{2}}. Would you like to book your visit? You can choose a time here: {{3}} or simply reply to this message.
- **new_lead_staff_alert**: New enquiry for {{1}}: {{2}} ({{3}}). Message: {{4}}. Please reply to them soon.
- **lead_escalation**: Reminder for {{1}}: {{2}} ({{3}}) has been waiting {{4}} minutes without a reply. Please contact them now.
- **human_handoff_alert**: A patient needs a person at {{1}}: {{2}} ({{3}}). Reason: {{4}}. The AI has stopped replying to them; please answer from the Grist Inbox, then untick Needs_Human.
  (Since the Needs_Human gate fix the AI answers NEW messages after a hand-off. If you re-submit this template, a closer
  wording is: "... Reason: {{4}}. Please answer from the Grist Inbox and untick Needs_Human when done.")
- **outcome_check**: Hi {{1}}, thank you for visiting {{2}} for your {{3}}. How are you feeling now? Just reply here: better, the same or worse. If you would like another appointment, tell us and we will help.
- **review_request**: Hi {{1}}, thank you for choosing {{2}}. If you have a minute, we would be grateful for your honest review here: {{3}} Thank you!
- **weekly_owner_report**: Weekly report for {{1}} ({{2}}): {{3}}. Suggested next step: {{4}}. The full report is in Grist (Run_Log, W9-weekly-report).

Keep `outcome_check` and `review_request` word for word: when the patient wrote in the last 24 hours W7 / W8 send exactly this
text as a free message, and W13 reads it back from the inbox ("How are you feeling now?" tells it the next message answers the
check-in). `review_request` must stay neutral: the same text for every patient, no incentive, no "5 stars", no request for a
positive review (WhatsApp Business policy and Google's review policy).

## Adding a template later

1. Add it to `WA_TEMPLATES` in `n8n/snippets/wa-send.js` (name + variable keys in order) and to the table above.
2. Run `node n8n/tests/run-all.js`, regenerate / update W12's "Prepare request" and "Read reply" Code nodes (they embed
   `wa-send.js` verbatim; the W12 test fails if they drift).
3. The calling workflow passes `template` and `template_params` with those keys.
