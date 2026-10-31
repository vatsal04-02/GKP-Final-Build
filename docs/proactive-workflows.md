# Proactive workflows W6, W7, W8, W9: what they do and what they can send (reviewed 1 Nov 2026)

Reviewed from the ACTIVE production workflow (4D `F4dRetryd0c49396`, exported from n8n and compared with `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4d.json`) and the live Settings of the clinic document. **Nothing here was activated, changed or sent by this review.** None of these workflows sends by itself: every message goes through **W12**, the only sender (allowlist, quiet hours 21:00-08:00 IST, opt-out, pause, send ledger, consent by purpose).

## Update 1 Nov 2026 (workflow 4E, owner directive)
Quiet hours no longer apply to operational messages: **W9's weekly report goes to the owner at once** (it was already Monday 09:00), and staff alerts, hand-off alerts, booking confirmations and replies to patients who wrote in are not held at night. **W6, W7 and W8 still wait for 08:00** because they are messages WE start (follow-ups, rebook, outcome check-ins, review requests). The templates they use (`followup_day2`, `noshow_rebook`, `outcome_check`, `review_request`, `weekly_owner_report`) are expected to be absent on the WhatsApp number now connected (Meta's test number): the two templates actually tried on 1 Nov (`new_lead_staff_alert`, `booking_confirmation`) were rejected as non-existent, so Meta would most likely reject these too, even in test mode. Details: `docs/operations-handover.md` item 9.

## What stops a message reaching a real patient today
1. `FLOWHQ_WA_SEND_MODE=allowlist` and the allowlist holds only the authorized test number: W12 refuses every other recipient.
2. Settings `TEST_MODE=TRUE`: the recipient is replaced by `TEST_PHONE` (the same authorized number) before W12 is called.
3. W12 consent rule for these templates (`engagement` purpose): the lead must have `LEADS.Consent_WhatsApp = true`, must not be opted out or paused.
4. Quiet hours: no send between 21:00 and 08:00 IST (a held message is NOT queued: the next run re-evaluates).
5. Each message sets its "sent" flag (`Followup_Sent`, `Rebook_Sent`, `Outcome_Sent`, `Review_Sent`) and has a ledger idempotency key, so it is sent once.

So while `TEST_MODE=TRUE` the worst case is a template message arriving on the authorized test number. **Before going live** (`TEST_MODE=FALSE`, send mode `live`) each switch below must be a deliberate decision.

## Current switches (live Settings, read 1 Nov 2026)
| Setting | Value | Effect |
|---|---|---|
| `outcome_checkin` | **on** | W7 is eligible to run |
| `review_requests` | **on** | W8 is eligible, but `review_link` is empty, so it only logs a warning (nothing to send) |
| `weekly_report_whatsapp` | **on** | W9 sends the weekly report to `owner_phone` (a placeholder ending 9999; with TEST_MODE it goes to TEST_PHONE) |
| W6 | no switch (always runs) | `mark_lost` is **false** in the workflow, so W6 never marks a lead Lost |
| `TEST_MODE` / `TEST_PHONE` | TRUE / +91 xxxxx 6560 | every message above is redirected to the test number |

**Recommendation:** set `outcome_checkin`, `review_requests` and `weekly_report_whatsapp` to `off` in Settings until the owner approves each one (and the Meta template behind it is approved). This review did not change them because the owner asked for documentation, not a change; they can only reach the test number today.

## W6 - follow-ups (daily 10:00 IST)
- **Trigger:** cron `0 10 * * *`, all active clinics in the registry.
- **Who:** (a) **No-show rebook:** the newest No-show per patient in the last 2 days (not today), `Rebook_Sent` empty, no future booking, patient has not written since. (b) **Day-2 follow-up:** `New`/`Contacted` leads created 2 to 6 days ago, `Followup_Sent` off, nothing booked, patient did not write in the last 48 h, not cold, not Needs_Human, no staff owner, no `Next_Action_At` in the future, hot leads first, at most 30 per run. (c) **Mark Lost:** disabled (`mark_lost=false`).
- **Messages:** `followup_day2`: "Hi {name}, thanks for contacting {clinic}. Would you like to book your visit? {booking_link}". `noshow_rebook`: "Hi {name}, we missed you at your {service} appointment at {clinic} on {date}. You can book another time here: {booking_link}". `booking_link` is blank if it is a Cal.com link (currently the clinic website form).
- **Recipient:** the lead's phone (TEST_PHONE while TEST_MODE). Needs `Consent_WhatsApp=true`.
- **Side effects:** sets `LEADS.Followup_Sent` or `Appointments.Rebook_Sent` after a send; writes `Run_Log`.
- **Live in the next days (test number only):** two leads have `Consent_WhatsApp=true` and no follow-up yet: the synthetic lead (L-20261031-0001, eligible 2 Nov 10:00) and a genuine website lead (created 1 Nov, eligible 3 Nov 10:00). While TEST_MODE is on, both messages arrive on the test number, not on the patients' phones. This is expected; do not read it as a delivery to the patient.

## W7 - outcome check-in (hourly at :20)
- **Switch:** Settings `outcome_checkin` (off or missing = nothing happens).
- **Who:** `Completed` appointments whose visit ended 20 to 72 hours ago, `Outcome_Sent` empty, at most one per patient per 7 days, max 30 per run, not paused / opted out / Needs_Human.
- **Message:** `outcome_check`: "Hi {name}, thank you for visiting {clinic} for your {service}. How are you feeling now? Just reply here: better, the same or worse. If you would like another appointment, tell us and we will help." Free text if the patient wrote in the last 24 h, else the template.
- **Side effects:** claims `Appointments.Outcome_Sent` BEFORE sending (restored if the send fails), `Run_Log`; the patient's reply is handled by W13 like any message.
- **State:** one `Completed` appointment exists in production; whether it is inside the 20-72 h window is time dependent. Any message would go to the test number.

## W8 - review request (hourly at :35)
- **Switch:** Settings `review_requests`. Also needs a non-empty https `review_link` (currently EMPTY: W8 only writes a once-a-day "review link missing" warning at 10:00 to `Run_Log`).
- **Who:** `Completed` appointments ended 3 hours to 7 days ago, `Review_Sent` empty, one per patient per 90 days, max 30 per run.
- **Message:** `review_request`: "Hi {name}, thank you for choosing {clinic}. If you have a minute, we would be grateful for your honest review here: {review_link} Thank you!"
- **Side effects:** claims `Appointments.Review_Sent` before sending, `Run_Log`.
- **Owner decision:** whether review requests are wanted at all and the verified Google review link. Nothing is sent without it.

## W9 - weekly owner report (Monday 09:00 IST)
- **Trigger:** cron `0 9 * * 1`. Next run: Monday 2 Nov 2026 09:00.
- **Reads:** leads, appointments, conversations, messages and `Run_Log` (up to 5000 rows each).
- **Numbers:** computed in code (`W9 - Metrics`). The AI (OpenRouter, `openai/gpt-4o-mini`) only writes the wording; it is called only if `FLOWHQ_AI_EXTERNAL_ENABLED=true` (it is, test mode), otherwise the report is written from the numbers alone.
- **Writes:** the report to `Run_Log` (always).
- **Message:** only if `weekly_report_whatsapp=on`: template `weekly_owner_report` "Weekly report {week} for {clinic}: {summary}. Next: {action}" to `owner_phone` (placeholder, so TEST_MODE sends it to TEST_PHONE; once per week, not in quiet hours). Staff-type message (no patient consent rule). The template's Meta approval is unverified.
- **Data to the AI provider:** aggregated metrics for the week (counts, rates, stages), not message text. The owner should confirm this is acceptable before `FLOWHQ_AI_EXTERNAL_ENABLED` stays on after the test phase.

## Decisions the owner must make before live mode
1. Keep or turn off each of `outcome_checkin`, `review_requests`, `weekly_report_whatsapp` (recommended: off until the Meta template is approved).
2. Approve W6 day-2 follow-up and no-show rebook for leads that ticked the WhatsApp consent on the website form. The consent wording in production is still labelled `DRAFT-2026-10-v1` (see `docs/website-lead-integration.md`): finalise the text before relying on it.
3. Supply `owner_phone` (the weekly report and staff alerts) and the Google review link.
