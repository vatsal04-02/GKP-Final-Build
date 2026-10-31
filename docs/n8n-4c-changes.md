# Slice 4C: the n8n changes (reminder consent, message purposes, central booking)

Status: **built and tested in the simulator. NOT imported into any n8n, NOT activated.** The repo gets a NEW candidate file, `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4c.json` (463 nodes, `active: false`); the earlier `...candidatefinal.json` is untouched and remains the rollback file. Nothing here has been compared with the workflows that are actually deployed (no production access: `docs/n8n-deployed-export-procedure.md`), so every statement below is about the repo candidate, **unverified against production**.

Build it: `node n8n/final/tools/build-4c.js` (= `patch-4c-consent.js`, then `patch-4c-w13-booking.js`; proves only the intended nodes changed, refuses to run twice, never overwrites its input).
Test it: `node n8n/final/run-tests.js fourc` (all older suites + the new ones; every intended difference is listed with its reason in `run-tests.js`) and `node n8n/snippets/*.test.js`.

## 1. Message purposes (decisions D3, D4)
Every patient-facing message has exactly ONE purpose. It is derived from the template (and the audience / message type), never trusted from the caller, except that a caller may RAISE a message to a reminder purpose (W15 sends its in-window reminder as free text and must still be checked). Code: `n8n/snippets/reminder-consent.js` (pasted into W12 / W5 / W15), kept equal to `flowhq/src/server/booking/consent.ts` by a parity test.

| Purpose | Templates / messages | What W12 requires before it calls Meta |
|---|---|---|
| `reply` | free text answering a patient who wrote in the last 24 h (W13) | nothing here (24 h window + the pause check + opt-out via the callers' send guard) |
| `booking_transaction` | `booking_confirmation` (W4) | a **Meta opt-in on file**: the lead's `Consent_WhatsApp` (they wrote to us / ticked the form) or a recorded reminder Yes. An **opt-out always blocks**. Declining reminders (No) does **not** block it. A booking is not consent for reminders or marketing |
| `appointment_reminder` | `reminder_24h`, `reminder_2h` (W5) | `Reminder_Consent = Yes` for the phone and no opt-out |
| `followup_reminder` | `followup_reminder` (W15), template or free text | the same as above |
| `engagement` | `followup_day2`, `noshow_rebook`, `outcome_check`, `review_request`, any template not listed | the **existing, unchanged** rule: the lead exists, `Consent_WhatsApp = true`, not opted out. A reminder Yes does not unlock it |
| `staff_alert` | `new_lead_staff_alert`, `lead_escalation`, `human_handoff_alert`, `weekly_owner_report` (audience `staff`) | none (the clinic's own phone) |

**Reminder consent rule** (`rcEffective` = `effectiveConsent`): opt-out (ANY lead with the phone) beats everything → `Reminder_Consent = No` → `Yes` → anything else (no row, blank, a typo, **an unreadable table**) = Unknown = suppressed. A patient messaging first, `whatsapp-inbound` and the website tick-box are NOT reminder consent. **No consent was migrated or back-filled** (D2: the registration form has not been reviewed), so on day one every reminder is suppressed until staff record consent in FLOW HQ > Schedule (`docs/booking-operations.md`). This is deliberate; it is not tuned to keep old delivery rates.

`wa-send.js` is intentionally NOT edited: the older lineages (`n8n/integrated`, `merged`, `workflows`) validate that exact text. The purpose map lives in the sibling snippet `reminder-consent.js` and is pasted into W12 – Prepare request (which computes `prep.purpose`) and W12 – Consent decide (which enforces it). Meta's own rules still apply on top (approved template, variables, 24 h window for free text, `send_mode` allow-list, quiet hours 21:00-08:00 IST, ledger idempotency, TEST_MODE): none of those were touched.

## 2. W12
- **New node** `W12 – Reminder consent`: reads the `Reminder_Consent` row of the phone **from the clinic's own document** (never another clinic's). A read error is passed on and **blocks reminders** (fail closed) but not the other purposes.
- `W12 – Prepare request`: adds `prep.purpose`; `needs_consent` is now also true for a reminder sent as free text. `W12 – Consent decide`: replaced by the purpose-based gate (`rcDecide`). The send reason says what to do: "no reminder consent on file … record reminder consent in FLOW HQ > Schedule".
- The W12 pause check (W13 reply) still comes after the consent step; ledger, Meta and receipt handling untouched.

## 3. W5 (appointment reminders)
Unchanged: the 15-minute schedule, the 24 h / 2 h windows, `Status === 'Booked'`, the `R24_Sent` / `R2_Sent` check-and-set, send-guard (opt-out, quiet hours, TEST_MODE), the "patient asked to cancel / reschedule" hold, W12 as the only sender.
New:
- **A `Pending confirmation` appointment is never reminded** (`Appt_Stage`); `Confirmed`, `Checked in`, blank (every legacy / Cal.com row) proceed. Status is untouched.
- **Patients without a Lead**: phone and name come from the lead, else `Appointments.Patient_Phone` / `Patient_Name`, else the `Patients` row (`Patient_ID`). No Lead is ever created.
- **Reminder consent** as in section 1, evaluated before W12 is called (so a suppressed reminder costs no ledger row) and again by W12 (defence in depth). It is evaluated **in TEST_MODE too**: a patient who would not be reminded does not get a test message either.
- **Every due-but-unsent reminder has a reason**, written to `Run_Log` by `W5 – Skip digest`: one line per clinic in the first run of each hour (08:00-20:59 IST), only when something was held, with the reason and the booking references (never a phone or a name): `pending confirmation`, `no reminder consent on file`, `reminder consent is No`, `opted out`, `reminder consent could not be read`, `no valid phone on the lead, the appointment or the patient record`, or the cancel/reschedule hold text. Quiet hours and the sent flag stay silent, as before. **Nothing is written to `Appointments`** for a skipped reminder. FLOW HQ shows the same answer per appointment (drawer: "Reminders").
- A held reminder claims nothing, so it goes as soon as consent is recorded and the normal window still allows it.
- New reads per clinic per run: `Reminder_Consent`, `Patients` (a read error is tolerated; consent unreadable = nothing sent).

## 4. W15 (follow-up reminders)
Same consent rule; a patient with no Lead can be reminded (`Patients.Phone`); the existing `frPlan` still holds "no booking link / no valid phone", and its lead-based holds are re-decided with `rcEffective`. Held patients are not claimed, so a reminder still goes the same day once consent is recorded. The daily Run_Log summary carries the new reasons. The send carries `purpose: followup_reminder`.

## 5. W13 (AI receptionist): central booking, no Cal.com, no direct writes
- `Settings.booking_mode = direct` is **ignored** (and noted in the message's `AI_Reason`). W13 writes **no `Appointments` row any more** (test: `n8n/final/tests/4c-w13-booking.test.js` inspects every Grist call).
- Free times: `W13 – Availability days → Booking availability → Availability collect` call `GET {FLOWHQ_BOOKING_API_URL}/api/booking/availability?date=…` for each of the next 7 days with the **new credential `FlowHQ Booking API`**. Not configured / unreachable / 401 / non-200 / `ai_booking.available:false` = **no time is offered at all** and a booking request goes to a person.
- **Explicit confirmation**: a first request is answered by code (not by the AI) with "Shall I book Wed 07 Oct at 10:00 AM with Dr. Mahesh Tiwari? Reply YES to confirm." Only a patient message that STARTS with a yes (English / Hinglish / Hindi), in answer to the newest clinic message, if that message is the question for exactly that day, time and doctor and is less than 3 hours old, counts. Same for cancel and reschedule.
- One call at most per message: `W13 – Central calls?` → `Split central calls` → `Booking API` (create / cancel / reschedule, bearer credential, `Idempotency-Key = w13-<hash of the WhatsApp message id and slot id>`, stable across retries) → `Central collect` → `Plan Ready` applies the answer. The patient is told "booked" **only after 200/201 with a booking reference**; `409 slot_unavailable` → "just taken" + the API's fresh times; `403 ai_booking_disabled`, any 5xx, `write_unverified`, network error, no answer → a **hand-off** (staff alert) that never says booked.
- **Cal.com**: no Cal.com URL is built or accepted. `Settings.booking_link` is accepted only if it is `https://` and **not** a Cal.com host; W6 (`followup_day2`, `noshow_rebook`) and W15 treat a Cal.com link as "no link" (W6 logs the failure and sends nothing; W15 holds and counts it). Safe replacement: set `booking_link` to a clinic-owned page or a `https://wa.me/91…` click-to-chat link, or leave it empty (the AI books through the API; W6/W15 follow-ups then wait). Old Cal.com bookings can still be cancelled / moved through the API (matched by `Booking_UID` and the patient's phone); **W4 (Cal.com → Grist sync) is unchanged** and stays on until `docs/calcom-cutover.md` is complete.
- Generated copy for review and unit tests: `n8n/snippets/ai-receptionist-central.js` (the original `ai-receptionist.js` is untouched: older lineages validate it). Tests: `node n8n/snippets/ai-receptionist-central.test.js`.

## 6. What an operator must set up (nothing is done for them)
| Item | Value |
|---|---|
| n8n env `FLOWHQ_BOOKING_API_URL` | the FLOW HQ address on the private Docker network, e.g. `http://flowhq:8787` (never the public URL). Empty = W13 books nothing |
| n8n credential `FlowHQ Booking API` | Header Auth: name `Authorization`, value `Bearer <id>.<secret>` from `npm run booking-token -- n8n-whatsapp <clinic-slug> --days 90`. Scopes: `availability:read appointments:read appointments:create appointments:update appointments:cancel` (+ `config:read` is not used). One credential = one clinic (the token decides the clinic). The credential id in the JSON (`FhqCredBooking01`) is a placeholder: re-link it after import |
| Grist (per clinic) | `npm run provision-booking -- <slug> --apply` (additive) creates `Reminder_Consent`, `Reminder_Consent_Log` and the `Appointments` columns. **Until `Reminder_Consent` exists every reminder is held** |
| FLOW HQ | a user with the `consent:write` grant (or an admin) records consent; `approved_consent_forms` in Booking Config stays empty until the owner approves the registration form (D2) |
| Settings | `booking_link` = a non-Cal.com https link or empty; `booking_mode` is ignored |
| `booking_enabled` | stays **OFF** until the activation procedure in `docs/production-readiness.md` |

## 7. Known limits (honest list)
- Not run against a real n8n, a real Grist or Meta yet (Phase 4 staging, `docs/n8n-staging.md`). The simulator proves the workflow logic with fakes.
- `Appointments` rows created by the API need the new columns; a clinic doc that has not been provisioned has none of this.
- Seven availability GETs run for every inbound WhatsApp message that reaches W13 (read-only, private network). If that load matters, restrict the fetch to booking-like messages later.
- The W5 digest and the FLOW HQ drawer explain a skipped reminder; W5 does not write a per-appointment note to Grist (by design, to keep W5 off `Appointments`).
- `ops` suite (shell scripts, file modes) fails on Windows in every target; it needs a Linux shell (run in the Phase 4 container).
