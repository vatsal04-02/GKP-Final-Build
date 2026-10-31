# Appointment booking: Grist tables (Slice 1)

Added to each clinic's Grist doc (the same doc that holds LEADS, Appointments, Settings and the Clinic Records) by
`npm run provision-booking -- <clinic-slug> [--apply] [--seed]`. **Additive only**: it creates missing tables and missing columns; it never
renames, retypes, deletes or clears anything. Dry run unless `--apply`. `--seed` writes the starting values below, and only into an EMPTY table.
Code: `flowhq/src/server/booking/schema.ts` (a test keeps this file and the code in step).

**One appointments table.** `Appointments` (the table Cal.com, W4, W5-W9 and the Bookings page already use) stays the only appointments
table. It is extended with columns; no second appointments table exists. Times are on the clinic clock (Asia/Kolkata); `Start` / `End` are Grist DateTime.

## Doctors
One row per doctor. `Doctor_ID` is the stable id (DR-001, DR-002).
Doctor_ID, Name, Qualification, Default_Shift (Morning / Evening), Active, Notes, Created_At, Updated_At, Updated_By, Audit_ID

`Active` off = the doctor offers no slots anywhere. Active does not mean available: availability comes from Doctor_Schedules, Closures_Blocks and existing appointments.

## Doctor_Schedules
One row = one doctor, one weekday, one shift window (so Mon-Sat x 2 shifts = 12 rows). Times are `HH:MM` text, 24-hour.
Schedule_ID, Doctor_ID, Weekday (Mon..Sun), Shift (Morning / Evening), Start_Time, End_Time, Slot_Minutes, Buffer_Minutes, Capacity, Effective_From, Effective_To, Active, Is_Override, Override_Reason, Updated_At, Updated_By, Audit_ID

- Blank `Slot_Minutes` / `Buffer_Minutes` / `Capacity` = use the Booking_Config value. **Real Grist stores a blank Int as `0`**, so `0` is read as blank too (0 is never a valid length or capacity; a buffer of 0 therefore means "use the clinic's buffer", and a 0-minute buffer cannot be forced for one doctor when the clinic buffer is higher). Found by the real-Grist test run (`docs/n8n-staging.md`). Blank `Effective_From` / `Effective_To` = no limit (inclusive when set).
- No row for a weekday = the doctor does not work it. No rows at all for Sunday = closed.
- **A doctor works their own `Default_Shift`.** A row for the other shift is rejected unless `Is_Override` is on, with an `Override_Reason` and both effective dates.
- An override row replaces the normal rows for that shift on the dates it covers (that is how a doctor covers the other shift, or a temporary change is made).

## Booking_Config
Key / value settings that apply immediately (read on every availability request; no redeploy).
Key, Value, Updated_At, Updated_By, Audit_ID

Keys: `booking_enabled` (on / off; **missing or unreadable = off**), `timezone`, `slot_minutes`, `buffer_minutes`, `capacity`, `min_notice_minutes`,
`approved_consent_forms` (comma-separated form versions an admin has reviewed and approved as reminder consent; **empty = none**), `cancel_min_notice_minutes` (patient cancellation / change notice; 0 = no limit; staff are exempt), `max_advance_days` (blank = no limit), `operating_days` (e.g. `Mon-Sat`), `open_windows` (e.g. `09:00-13:00, 16:00-20:00`; no slot is ever offered outside them),
`shift_morning_enabled`, `shift_evening_enabled`. A bad value falls back to the default and is reported; it never stops the engine.
Only an admin may change `booking_enabled` (enforced by the API in Slice 3). The older Settings keys (`booking_capacity`, `slot_minutes`, ...) are n8n's and are left alone.

## Closures_Blocks
Clinic closures, doctor leave and blocked time. Dates are inclusive.
Block_ID, Kind (Clinic closure / Doctor leave / Blocked time), Doctor_ID, Shift, Date_From, Date_To, Start_Time, End_Time, Reason, Active, Created_At, Created_By, Audit_ID

Blank `Doctor_ID` = every doctor. Blank `Shift` = both shifts. Blank `Start_Time` + `End_Time` = the whole day; with times, only slots that overlap the range are blocked. Both times or neither.

## Reminder_Consent
One row per phone (`+91XXXXXXXXXX`): the CURRENT answer to "may we send automated WhatsApp appointment / follow-up reminders to this number?". **No row = Unknown.** n8n (W5 / W12 / W15) reads this table. A patient messaging the clinic first and the website tick-box are NOT reminder consent and never create a row.
Consent_ID, Phone, Patient_ID, Reminder_Consent (Yes / No / Unknown), Reminder_Consent_At, Reminder_Consent_Source, Evidence_Ref, Evidence_Date, Form_Version, Recorded_By, Previous_Value, Updated_At, Audit_ID

`Reminder_Consent_Source`: Signed registration form, Told staff in person, Told staff by phone, Patient replied on WhatsApp (reviewed by staff), Patient withdrew, Admin correction, Imported with evidence. A **Yes needs** a source, an evidence reference, and for a signed form or an import the signature date and an APPROVED `Form_Version` (Booking_Config `approved_consent_forms`; none is approved yet). Unknown cannot be recorded; only an admin can reset to Unknown, as a correction with a note.

## Reminder_Consent_Log
Append-only history: every change is a NEW row (never edited or deleted), keeping the value, the previous value, when, who, the source and the evidence. It is the record of truth: if a crash leaves `Reminder_Consent` behind it, the current answer is rebuilt from the newest log row at start-up.
Log_ID, Consent_ID, Phone, Value, Previous_Value, At, Source, Evidence_Ref, Evidence_Date, Form_Version, Actor, Kind (recorded / corrected / revoked), Note, Audit_ID

**Precedence for reminders (also `n8n/snippets/reminder-consent.js`):** an opt-out (any lead with the phone) beats everything; then a recorded No; then a recorded Yes; anything else is Unknown and suppresses reminders. Permissions: a Yes needs an explicit `consent:write` grant in `users.json` (admins always); any staff member can record a No; correcting or revoking is admin only. AI and n8n tokens have no way to record consent.

## Booking_Audit
Append-only log of booking changes, API attempts and rejections. No secrets and no patient name, phone, free text or idempotency key. Rows arrive from the durable audit outbox (`outbox.jsonl` on the persistent volume), never directly from a request.
At, Actor, Source (Staff / API / System), Action, Record, Outcome (ok / rejected), Reason, Detail, Audit_ID

`Audit_ID` is unique by convention (a UUID made when the operation begins): the flush skips an id that is already here, so a retry or a recovery after a crash never writes a duplicate.

## Appointments (existing table, columns ADDED)
Reused unchanged: `Booking_UID` (the booking reference), `Lead`, `Service`, `Physio` (the doctor's name), `Start`, `End`, `Status` (Booked, Rescheduled, Cancelled, Completed, No-show), `Fee_INR`, the `R24_Sent` ... `Outcome_Sent` columns.
Added:
Patient_ID, Patient_Name, Patient_Phone, Doctor_ID, Shift, Slot_Key, Booking_Source, Appt_Stage, Reason, Idem_Key, Cancel_Reason, Created_At, Updated_At, Created_By, Audit_ID

- `Patient_ID` links to the Clinic Records patient when there is one. No patient record is created from a booking. `Lead` stays the link to the enquiry.
  `Patient_Name` / `Patient_Phone` (`+91XXXXXXXXXX`) are a snapshot so a walk-in with no Lead still has a name.
- `Slot_Key` = `doctorId|YYYY-MM-DD|HH:MM`. `Booking_Source`: WhatsApp AI / Staff / Cal.com / Other. `Idem_Key`: the idempotency key of the request that created it.
- `Audit_ID` (here and on Doctors, Doctor_Schedules, Booking_Config, Closures_Blocks) is the id of the last audited operation that changed the row. It is written in the SAME Grist write as the change, so after a crash the row itself proves whether the operation was applied. **These columns must exist before the outbox version runs** (`npm run provision-booking`, additive): without them every booking write is refused.
- **Status is not changed.** The six statuses staff see are derived: Cancelled / Completed / No-show come from `Status`; while `Status` is Booked or Rescheduled,
  `Appt_Stage` (Pending confirmation / Confirmed / Checked in) says which one, and a blank stage means Confirmed. So every existing Cal.com / W4-W9 row and filter keeps working.
- A row with no `Doctor_ID` (Cal.com, W4) is matched to a doctor by the `Physio` name; if that is not possible it holds the time for every doctor. It can block a slot; it can never cause a double booking.

## Rules every write must follow (enforced by the booking service from Slice 2)
- All appointment creation, rescheduling and cancellation goes through the FLOW HQ booking service, under the in-process Mutex, re-checking the slot inside the lock.
- **The Mutex protects only ONE FLOW HQ backend process.** Run exactly one instance. If more than one is ever needed, stop and add distributed concurrency control first.
- W13 `booking_mode=direct` must be off once the booking API is live (it writes Appointments without these checks).
