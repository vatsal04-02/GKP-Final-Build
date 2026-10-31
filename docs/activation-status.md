# Production activation status (1 Nov 2026, after the 4D cutover)

Verified against production, not assumed. "LIVE" means observed working on production; "TEST ONLY" means working but restricted to the authorized test number.

| Component | Status | Evidence |
|---|---|---|
| FLOW HQ CRM, audit outbox | LIVE | `/api/health` ok, `audit_outbox: ok` |
| n8n workflow | **4D `F4dRetryd0c49396` is the one active workflow**; V4 `VaZ0abHwRICrx6C0` preserved inactive | `00-preflight` / `80-verify` |
| Booking schema (`demo-clinic`) | LIVE (7 booking tables, Appointments columns, LEADS consent columns) | verified; every existing row unchanged |
| Website form -> n8n -> Grist | **LIVE** | production probe 422 `consent_required`; synthetic lead stored with every field; a genuine visitor lead (`L-20261101-0001`) arrived through it |
| Staff alert for new website leads | held by quiet hours (21:00-08:00 IST); `owner_phone` in Settings is a placeholder | Run_Log "staff alert not sent now: quiet hours" |
| `booking_enabled` | **OFF** (waiting for the owner's approval of the schedules below) | Booking_Config |
| External AI | **ON, TEST ONLY**: allowlist = the authorized number only, `TEST_MODE=TRUE`, 12 replies/hour; other numbers are skipped before the AI is called | `95-ai-external.sh` interlocks |
| WhatsApp sending | allowlist mode; with `TEST_MODE=TRUE` every outgoing message is redirected to `TEST_PHONE` (+919322146560) | Settings, env |
| Reminders / follow-ups / review requests to patients | **OFF in effect**: `Reminder_Consent` is empty (no one is eligible), send mode is allowlist | Send_Ledger unchanged |
| Marketing messages | OFF | none exist |

## Staff-managed booking (1 Nov 2026): already live, and it does NOT depend on `booking_enabled`
**`booking_enabled` is an AI-only switch** (`permissions.ts`: "it never limits what staff may do"; `engine.ts`: `aiOk = channel === 'staff' || aiBookingEnabled`; the token/AI path answers 403 `ai_booking_disabled`). So no production setting was changed to enable staff booking, and `booking_enabled` stays OFF (switching it ON would enable AI booking: not done, per the owner's rule).
Owner-approved schedules verified against what production serves: Dr. Mahesh Tiwari Mon-Sat morning 09:00-13:00, Dr. Sandeep Tiwari Mon-Sat evening 16:00-20:00, Sunday closed, 30-minute slots, capacity 1, both shifts on, no configuration problems.
Verified with the REAL FLOW HQ server process and a real Grist, switch OFF (`flowhq/tests/real-grist/staff-booking.real.test.ts`, 9/9): staff create (right doctor and shift, read-back, written with an audit id by the signed-in user), duplicate key replays, a full slot or non-existent slot is refused, move keeps the reference and frees the old slot, cancel is idempotent and keeps the record, every operation and refusal is audited and only an admin can read the log, the outbox is clean, signed-out = 401 everywhere, front desk cannot change settings or the AI switch, a service token cannot use the staff routes, and the AI path cannot create or move while the switch is off.
**Decided 1 Nov 2026: the AI path is read-only while the switch is OFF.** The service token can no longer create, move OR cancel (cancel returns 403 `ai_booking_disabled`, the same answer for a right or wrong phone); staff cancellation is unaffected. Covered by unit, API and real-Grist tests; see the "Cancel gate" row in `docs/operations-handover.md` for the deployment state.
**Logins:** production has ONE login (an admin). Front-desk and doctor logins do not exist yet; add them to `flowhq/config/users.json` (`role: staff`, a doctor login also `clinician` and `doctorId`; `docs/booking-operations.md`). A doctor login can only manage its own doctor's appointments.

## Seeded schedules (APPROVED by the owner on 1 Nov 2026) (production `Doctors` / `Doctor_Schedules` / `Booking_Config`)
| Doctor | Shift | Days | Hours |
|---|---|---|---|
| Dr. Mahesh Tiwari (DR-001, MPT (PT)) | Morning | Mon-Sat | 09:00-13:00 |
| Dr. Sandeep Tiwari (DR-002, MPT (PT)) | Evening | Mon-Sat | 16:00-20:00 |
Sunday closed. 30-minute slots, capacity 1 per slot, AI needs 120 minutes notice, buffer 0, no closures or leave entered, both shifts enabled. (The schedule rows leave slot length and capacity blank: they inherit the clinic values above.) Edit in FLOW HQ > Schedule > Doctors & hours. **Approve or change these, then `booking_enabled` can be switched ON in Schedule (admin).**

## Live Settings placeholders (corrected on 1 Nov 2026 from verified information; one set still open)
Corrected: `clinic_name` = Geeta Krishna Physiotherapy Centre (registry and `flowhq/config/clinic.json`), `booking_link` = https://geetakrishnaphysiotherapy.co.in/#book (the clinic's own website booking form), `review_link` = empty (no verified Google review link exists, and review requests are not sent while it is empty). Before: `Clinic CRM Test`, `https://example.com/book`, `https://example.com/review`.
STILL OPEN, no verified value exists: `owner_phone` and `staff_alert_phones` end in `9999` (a placeholder). With `TEST_MODE=TRUE` staff alerts go to `TEST_PHONE`, so nothing is lost today; before going live the owner must supply the real WhatsApp number(s) for alerts.

## Evidence that real AI and real WhatsApp delivery already worked (31 Oct, under V4)
The real model (`openai/gpt-4o-mini`) held a Hinglish conversation with +919322146560 (availability, services, doctors, a booking attempt); every reply was delivered and read (Send_Ledger `read`). Under 4D this still has to be re-proved (section below).

## Supervised WhatsApp test for 4D (from +919322146560 to the clinic's WhatsApp number)
Time: 08:00-20:30 IST. Send these one at a time and wait for each reply; then ask for `./scripts/4d/96-whatsapp-test-report.sh 30`.
1. `Hello, do you treat knee pain?` (greeting + services, in the clinic's words)
2. `What is the fee for the first visit?` (expects Rs 500)
3. `What are your timings and is Dr Sandeep there in the evening?`
4. `I want to book tomorrow morning` (while `booking_enabled` is OFF: no times are offered and the request goes to a person)
5. `I have severe chest pain and can't breathe` (expects a hand-off to staff, no AI booking)
6. With `booking_enabled` ON (after approval): `Book me for Monday at 10`, wait for the question naming day, time and doctor, reply `Yes`; then `Move it to Tuesday at 10` / `Yes`; then `Cancel my appointment` / `Yes`. Expect ONE appointment in Schedule with the right doctor and shift, the same reference moved, the slot freed, an audit row for each step.
7. Last, if wanted: `STOP` (sets Opted_Out for this number; **staff must untick Opted_Out afterwards** or later tests are blocked).
The report shows each message, the AI decision, what W12 sent or blocked, appointments created through FLOW HQ, and n8n errors.

## Blocked, and the exact action needed
| Blocked | Why | Action |
|---|---|---|
| `booking_enabled` ON, AI booking, staff-booking tests in production | the owner has not yet approved the schedules; staff-booking tests need a staff login (not available to me) | approve/change the schedules above; then an admin switches booking ON in Schedule and a staff user runs: New appointment, move, cancel (or tells me to) |
| Reminders and consent | the registration form has not been supplied; Meta template names / approval status are unverified (the Meta credential is inside n8n, not readable by me) | send the registration form (scan or text); tell me the approved template names (WhatsApp Manager) for confirmation and reminders; staff then record explicit consent with evidence in the Schedule drawer |
| Messaging real patients (`FLOWHQ_WA_SEND_MODE=live`, `TEST_MODE=FALSE`) | placeholders in Settings; no consent/templates; supervised 4D test not yet done | correct the Settings above, then approve going live |
| Cal.com retirement | `FLOWHQ_CAL_WEBHOOK_SECRET` is not set, so W4 cannot verify Cal.com events | set the secret in `.env` (and in Cal.com) before the cut-over in `docs/calcom-cutover.md` |
| Synthetic lead cleanup | the owner has not yet confirmed it in FLOW HQ. Kept (not deleted). Production record read 1 Nov 2026: Grist `LEADS` row 5, `Lead_id` L-20261031-0001, Source Website, Status New, `Consent_WhatsApp` true (source `website-form`, version `DRAFT-2026-10-v1`), UTM campaign `zz-cutover-test`, phone ends 0101; W1 Run_Log "lead stored" and a duplicate resubmission "skipped". Note it has WhatsApp consent, so W6 may send its day-2 follow-up on 2 Nov 10:00 to the TEST number only (`docs/proactive-workflows.md`) | confirm `ZZ Synthetic Test Lead` is visible in FLOW HQ > Contacts, then staff delete it |
| Secrets cleanup | rollback and recovery material is deliberately kept | after sign-off: `shred -u ~/.4d-secrets/*` |

## Rollback
`CONFIRM=yes ./scripts/4d/90-rollback.sh` (V4 back, 4D off, `.env` restored, token revoked). AI only: `CONFIRM=yes ./scripts/4d/95-ai-external.sh off`. Backups: `~/backups/4d-cutover-20261031-231443/` (full, off-server copy verified), `pre-ai-20261101-000344/` (clinic and registry documents), earlier `pre-deploy-*` and `pre-provision-*`.
