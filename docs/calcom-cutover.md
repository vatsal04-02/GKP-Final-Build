# Retiring Cal.com for new patient bookings: cutover plan

Decision: Cal.com stops being an independent way for patients to book. New bookings (WhatsApp AI and staff) go only through the CRM booking
service (`docs/booking-api.md`). **This is a plan. Nothing here has been executed, and nothing in n8n or production has been changed.**
Do not start until the CRM booking service has been verified end to end (step 4) and the owner has approved each phase.

## Why "sync after the fact" is not the answer
Cal.com confirms a booking to the patient first; W4 copies it into `Appointments` afterwards. Nothing can stop Cal.com accepting a time the CRM has
already given to someone else (or blocked for leave or a closure). The CRM counts synced Cal.com rows so it will not double-book on top of them,
but only retiring Cal.com as a patient-facing channel removes the conflict. So the permanent fix is to turn off new Cal.com bookings, not to sync faster.

## What is preserved (and how)
- **Existing appointments and history stay exactly as they are.** No row is deleted, renamed or retyped. The booking provisioning only ADDS columns to `Appointments`.
- Old Cal.com rows keep their `Booking_UID`, `Lead`, `Service`, `Physio`, `Start`, `End`, `Status` and reminder flags; W5-W9 keep working on them; the Bookings page and dashboard keep showing them.
- They count against availability (matched to a doctor by the `Physio` name, or holding the time for every doctor if it cannot be matched), so a slot already booked on Cal.com is never offered again.
- The new columns are empty on old rows; the six staff statuses derive from `Status`, so old rows display correctly (`Booked` shows as Confirmed).
- W4 stays enabled during and after cutover, **only** to sync bookings that already exist in Cal.com (reschedules and cancellations of them). When none remain in the future, it can be disabled. Do not delete W4 or the Cal.com webhook until then.

## Things that still point patients at Cal.com (found in the repo, must be dealt with before the switch)
The Settings key `booking_link` (the Cal.com page) is put into patient messages by **W6** (follow-ups), **W13** (AI replies) and **W15** (follow-up reminders).
If Cal.com is retired while `booking_link` still points at it, patients are sent to a page that no longer works. In step 5 the clinic must decide the replacement
(for example "reply to this message and we will book you in", or a CRM-hosted page if one is ever built) and change that Settings value; the workflows read it, so no workflow edit should be needed unless they require the key to be a link. W13 `booking_mode` **must not be `direct`** (it writes appointments itself and bypasses the CRM checks), and must no longer be `link` pointing at Cal.com. These are n8n-side changes for the n8n developer; the CRM does not make them.

## Phases
Each phase needs the owner's approval before it starts. Each can be undone without losing data.

1. **Prepare (no patient impact).** Run `npm run provision-booking -- <clinic-slug>` (dry run) against a COPY of the clinic doc; review; then `--apply --seed` on the copy. Check `Appointments` kept every old column and row. Only after approval, run the same on production (additive, repeatable). `booking_enabled` is seeded OFF.
2. **Create the n8n token and configure.** An admin runs `npm run booking-token`, adds the hash entry to `config/booking-tokens.json` on the server, restarts FLOW HQ. Review the doctors, schedules and settings in the CRM (editable from Slice 3; until then in Grist) and confirm: 30-minute slots, capacity 1, Mon-Sat 9-1 (Dr. Mahesh Tiwari) and 4-8 (Dr. Sandeep Tiwari), Sunday closed, minimum notice 120 minutes.
3. **n8n integration (the n8n developer).** Build and test the WhatsApp AI flow against the contract, with `booking_enabled` OFF and a test recipient only. Confirm it handles `ai_booking_disabled`, `slot_unavailable`, `502 write_unverified` retries with the same key, and never confirms a booking to a patient without a `201`/`200`.
4. **Verify end to end (no real patients).** With synthetic patients and an authorised test number: availability, book, retry (same key), conflict (two requests, one slot), reschedule, cancel, switch OFF then ON, a closure and a leave day, a Sunday. Compare every result with the CRM screen and `Booking_Audit`. Confirm W13 `direct` is off. Do not continue if anything differs.
5. **Prepare the cutover message and links.** Decide the `booking_link` replacement (see above). Take a backup/export of the `Appointments` table and the Cal.com booking list. Note the number of future Cal.com bookings.
6. **Cutover (a quiet window, owner present).** (a) In the CRM, turn `booking_enabled` ON. (b) In Cal.com, **disable new bookings** for the clinic's event types (set availability to none or unpublish the booking page; do NOT delete the event types, the account or the webhook). (c) Update `booking_link`. (d) Watch `Run_Log`, `Booking_Audit` and W11 alerts for a day.
7. **Drain.** Leave W4 and the Cal.com webhook on until the last future Cal.com booking has passed or been moved into the CRM (staff can re-book it from the CRM and cancel the Cal.com one). Then disable W4. Keep the Cal.com account read-only for history.

## Rollback
- **Before step 6:** nothing patient-facing changed. Turn `booking_enabled` OFF (the AI stops being offered or creating times at once), or revoke the token (set `"revoked": true` in `config/booking-tokens.json` and restart). Provisioned tables/columns can stay (they are inert) or be hidden; nothing is dropped.
- **After step 6:** (a) turn `booking_enabled` OFF in the CRM, (b) re-enable the Cal.com event types and restore the old `booking_link`, (c) W4 is still running, so Cal.com bookings sync again. Bookings made through the CRM meanwhile stay in `Appointments` and keep counting against availability, so nothing is lost or double-booked. (d) Ask the n8n developer to put W13 back in the previous mode only if the owner wants the old behaviour.
- A booking made in the CRM can always be cancelled or moved by staff; cancelled rows are kept, never deleted.

## Open decisions for the owner
- The wording and target of the new `booking_link` (step 5).
- Whether patients who have never messaged the clinic (no lead) matter for reminders: W5 only reminds appointments linked to a lead.
- The cancellation notice rule for patients (`cancel_min_notice_minutes`, currently 0 = no limit).
