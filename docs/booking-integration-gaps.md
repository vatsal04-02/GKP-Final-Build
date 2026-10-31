# Booking: what n8n must change before patient-facing AI booking is enabled

Status: **analysis only. No n8n workflow, template or setting was changed in Slice 3.** The CRM side is built and tested; the items below are the
n8n-side work that must be approved as its own slice. Until they are done, `booking_enabled` stays OFF and Cal.com stays the live booking channel.

> **Update (Slice 4C): the items below are BUILT in the repo candidate `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4c.json` and tested in the simulator** (W5 no-lead + pending + consent + skip digest, W12 purposes, W15 consent, W6/W13/W15 Cal.com links, W13 central booking with direct mode ignored). See `docs/n8n-4c-changes.md`. Not imported, not activated, not compared with the deployed workflows. The text below is the original analysis.
>
> **Updated by `docs/slice4-plan.md` section 0.** The deployment candidate (`n8n/final/workflows/...production_candidatefinal.json`) also skips a no-Lead booking silently, and its W12 additionally blocks any patient with no Lead or no `Consent_WhatsApp`. Reminder eligibility, consent and per-purpose rules for W5 / W12 / W15 are planned there; this section describes the gap as first found in the older copy.

## 1. W5 reminders: appointments without a Lead are silently skipped

**The gap.** W5 (`n8n/workflows/W5-reminders.json`, node "build candidates", inline code) resolves the patient only through `Appointments.Lead`:
```js
if (f.Status !== 'Booked' || !f.Start) continue;
...
const lead = leads[f.Lead];
if (!lead) continue;            // <- an appointment with no Lead is dropped, no reminder, no log line
...
patient_name: lead.Name || '', patient_phone: lead.Phone || '', opted_out: lead.Opted_Out === true,
```
Cal.com rows always have a Lead (W4 creates one). The CRM booking service links an EXISTING lead by phone when it can, so a patient who has messaged the clinic
(the WhatsApp AI case) normally has one. It does not create one, so these get **no reminder**: staff bookings for a walk-in or a new person, and any booking whose phone matches no lead.
(Not yet verified against a live clinic: whether W2 always creates a Lead for a first WhatsApp message. Check before relying on "AI bookings always have a lead".)

**Options considered.**
| Option | Verdict |
|---|---|
| A. Change W5 to fall back to `Patient_Phone` / `Patient_Name` (then the register patient's phone via `Patient_ID`) when `Lead` is empty, and look opt-outs up by phone | **Recommended** |
| B. CRM links an existing Lead by phone at booking time | **Already built** (reduces the gap, cannot close it) |
| C. CRM creates a Lead for every booking | Rejected: pollutes enquiry metrics (W3 speed-to-lead alerts, W9 report, "new enquiries"), creates duplicate people, and a Lead carries consent / opt-out meaning that a booking does not give |
| D. Back-fill `Lead` later when the patient first messages | Optional nice-to-have, not needed if A is done |

**Required W5 change (when approved).** Resolve the contact in this order and keep everything else (window maths, `Status === 'Booked'`, `R24_Sent` / `R2_Sent` check-and-set, send guard, `TEST_MODE`, quiet hours) exactly as is:
1. `Lead` set and found: **today's behaviour, unchanged** (legacy and Cal.com rows must produce byte-identical candidates).
2. Else `Patient_Phone` + `Patient_Name` from the appointment row.
3. Else `Patients.Phone` / `Name` for `Patient_ID` (Clinic Records table).
4. Else skip, but **write a Run_Log row** (`W5-reminders`, outcome `skipped`, reason `no_contact`, the booking reference): never silent.
Opt-out: build a phone index of Leads (W5 already loads them) and skip if ANY lead with the same normalised phone has `Opted_Out` ticked, whichever path found the phone.
Phones are normalised with `n8n/snippets/normalize-phone.js` (`+91XXXXXXXXXX`); an invalid phone is skipped and logged.
**Owner decisions (recorded in `docs/booking-decisions.md`, not yet built):**
- **Pending confirmation appointments get NO W5 reminders** (add `if (f.Appt_Stage === 'Pending confirmation') continue;` to the candidate step; blank stage = every legacy row, unchanged; `Status` stays untouched).
- **A booking is not consent.** Reminders also require explicit consent: `Reminder_Consent` Yes / No / Unknown (+ `_At`, `_Source`) on the appointment; Unknown and No suppress; Unknown is never turned into Yes. A linked Lead keeps today's consent behaviour; no Lead needs `Reminder_Consent = Yes`. A phone that opted out or said No is suppressed everywhere. Full rule and tests: `docs/booking-decisions.md` section 2. (W15 enforces `Consent_WhatsApp`; no consent check was found in W5 / W12 / `wa-send.js` in this repo: verify in the deployed workflows.)

**Tests required** (move the inline code to `n8n/snippets/` with a `*.test.js`, like the other workflows, so it is testable; `node n8n/snippets/*.test.js` per CLAUDE.md rule 10):
legacy Lead row unchanged; no Lead + `Patient_Phone` gives a candidate; `Patient_ID` fallback; opted-out lead matched by phone is skipped; no contact is skipped AND logged; invalid phone skipped and logged; already-sent flag respected; `Status !== 'Booked'` skipped; a rescheduled row (flags cleared by the CRM) is reminded for the new time; a Cal.com row and a CRM row for the same phone do not double-remind.

## 2. Remaining Cal.com booking-link references (W6, W13, W15)

All three put `Settings.booking_link` (today the Cal.com page) into patient messages. If Cal.com is retired while it still points there, patients are sent to a dead page.

| Where | Exact reference | Needed change |
|---|---|---|
| **W6** follow-ups, `n8n/workflows/W6-followups.json` (node building the message) | `booking_link: String(s.booking_link).trim()`; message text ``Book a time here: ${booking_link}``; templates `noshow_rebook` (params name, service, clinic_name, date, **booking_link**) and `followup_day2` (name, clinic_name, **booking_link**) in `n8n/snippets/wa-send.js` lines 16-17 and `n8n/whatsapp-templates.md` | Interim, no template change: set `booking_link` to a neutral https link such as the clinic's WhatsApp click-to-chat link (`https://wa.me/91XXXXXXXXXX`), so a tap opens a chat the AI/staff can book from. Proper fix: reword the templates ("reply to this message to book") and re-approve them with Meta |
| **W15** follow-up reminder, `n8n/snippets/followup-reminder.js` lines 48, 78, 94, 108, 112 (also in `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`) | `frHttps(settings.booking_link)`; **holds the send** with `Settings > booking_link is not set (an https link)` when empty; text "Please book or confirm your time here: ${link} or simply reply"; template `followup_reminder` param `booking_link` | Same interim link. Do NOT empty the setting: W15 would then hold every reminder |
| **W13** AI receptionist, `n8n/snippets/ai-receptionist.js` (workflow `n8n/w13/W13-AI-Receptionist.json`) | placeholders `{{BOOKING_LINK}}`, `{{CANCEL_LINK}}`, `{{RESCHEDULE_LINK}}` (line 22); `profile.booking_link` (123); cancel / reschedule links built from the Cal.com origin `aiCalOrigin(booking_link) \|\| 'https://cal.com'` (820-822); hand-off when "needs a booking link" (749-751, 801-802, 872-874); prompt text "patients book through the link (the system cannot book for them)" (467); free times computed from Settings `open_hours` / `slot_minutes` / `booking_capacity` and the Booked rows "which W4 keeps in step with Cal.com" (190) | Replace with the CRM API (below) |

**W13 must change before AI booking goes live (n8n developer, separate approved slice):**
1. **`booking_mode=direct` must be off and its code path removed or unreachable** (lines 122, 465, 789-802): it writes a `Booked` row itself and bypasses every CRM check. The CRM cannot stop it.
2. Free times: stop computing them from Settings; call `GET /api/booking/availability` (and `/config`) and offer only returned `slot_id`s.
3. Booking: `POST /api/booking/appointments` with an `Idempotency-Key`; tell the patient it is booked only on `201`/`200`; handle `slot_unavailable` (offer `availability.slots`), `ai_booking_disabled` (hand off to staff), `write_unverified` (retry with the SAME key, never confirm).
4. Cancel / reschedule: `POST .../cancel` and `PATCH` with the patient's phone as proof; remove the Cal.com cancel / reschedule links.
5. Check `ai_booking.available` before offering anything. Details: `docs/booking-api.md`.

**Unchanged and required:** W4 (Cal.com webhook sync) stays enabled until the last future Cal.com booking has passed (`docs/calcom-cutover.md`). Other copies of these workflows under `n8n/integrated/`, `n8n/merged/`, `n8n/production/` and `n8n/final/` hold the same references; whichever copy is deployed is the one to change.

## 3. Tests that must pass before patient-facing AI booking is enabled
CRM (done, in the suite): single-process lock, idempotency, concurrency, verified writes, switch semantics, roles, audit, security.
n8n side (not done): the W5 tests above; a W13 test that it never writes `Appointments` directly and never confirms without `201`/`200`; an end-to-end run with synthetic patients and an authorised test number (`docs/calcom-cutover.md` step 4).
