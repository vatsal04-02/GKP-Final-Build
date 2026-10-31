# Booking service API (for the n8n developer)

Status: **built and tested in the CRM. Not deployed.** The repo n8n candidate `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4c.json` (Slice 4C, `docs/n8n-4c-changes.md`) calls these routes from W13 in the simulator only; no live n8n workflow calls them yet and nothing has been run against a real n8n. This document is the contract. Do not assume anything not written here.

The CRM (FLOW HQ) is the single source of truth for availability and appointments. All new WhatsApp AI and staff bookings go through
this service. **W13 `booking_mode=direct` MUST be switched off before this API goes live** (it writes `Appointments` itself, skipping every check below).

## Basics
- Base path: `/api/booking` on the FLOW HQ server (HTTPS only in production). JSON in, JSON out, UTF-8.
- One token = one clinic. There is no workspace parameter: the token decides which clinic's data you are talking to.
- **Time zone: Asia/Kolkata (IST).** Dates are `YYYY-MM-DD`, times are `HH:MM` 24-hour, both on the clinic's wall clock. `start` / `end` in appointment
  objects are UTC ISO-8601 instants (`2026-10-08T03:30:00.000Z` = 09:00 IST). Never build a time yourself: use the `slot_id` the availability call gave you.
- Responses are `Cache-Control: no-store`. Weekdays: Monday = 1 ... Sunday = 7 (names `Mon..Sun` in JSON).

## Authentication
`Authorization: Bearer <token-id>.<secret>` on **every** call. Nothing else is accepted: no cookie, no CSRF header, no query-string token.
- Create a token (an admin, on the server): `npm run booking-token -- n8n-whatsapp <clinic-slug> --days 90`. The token is printed once; only its SHA-256 hash is stored (`config/booking-tokens.json`, git-ignored). Store it as an n8n credential, never in a workflow body or a log.
- Scopes (a token carries only what n8n needs): `config:read`, `availability:read`, `appointments:read`, `appointments:create`, `appointments:update`, `appointments:cancel`.
- `401 unauthorized` for a missing, malformed, unknown, revoked or expired token (one identical body, it never says which). `403 forbidden` for a valid token without the scope.
- 20 failed attempts per source address per 15 minutes, then `429 rate_limited`. Successful calls are never counted. "Source address" is the real client behind the reverse proxy (see `docs/booking-operations.md`); n8n should call over the private Docker network.
- A token with no clinic, no hash or a bad id is rejected at startup. No tokens configured = the whole API answers 401.

## The booking switch (server-enforced)
`Booking_Config.booking_enabled` (an admin changes it in the CRM; it applies to the very next request, no n8n change or redeploy).
It is **off by default**, and **a missing, blank or unreadable value, an invalid setting anywhere in the booking configuration, an unreadable closure/leave/schedule/doctor row, or unreachable booking tables all count as OFF for the AI** (fail closed).

| Switch | `GET /availability` | `POST /appointments` | `PATCH` (reschedule) | `POST .../cancel`, `GET` |
|---|---|---|---|---|
| ON | slots | creates | moves | works |
| OFF / fail-closed | `ai_booking.available:false`, `slots: []` | `403 ai_booking_disabled` | `403 ai_booking_disabled` | **still works** (existing appointments are never locked out) |

`ai_booking.reason` / the `reason` field of the 403 is one of `disabled`, `config_invalid`, `config_unavailable`. Existing appointments are never deleted by any of this.
n8n must check `ai_booking.available` before offering times, and must not offer a time that did not come from an availability call made in the same conversation turn.

## Idempotency (required on create)
Send `Idempotency-Key: <8-64 chars of A-Z a-z 0-9 . _ : ->` (or `idempotency_key` in the body; if both are sent they must match). Use a value that is
stable across retries of the same patient request (for example the WhatsApp message id plus the slot), never a fresh random value per retry.
- Same key, same slot and phone: **`200` with `"replayed": true` and the ORIGINAL booking**, whatever has happened since (even if the slot is now full or AI booking is off). Nothing is created.
- Same key, different slot or phone: `409 idempotency_conflict`.
- A request that was refused does not use up its key; the retry is judged afresh.
- Different keys for the same full slot: exactly one succeeds, the others get `409 slot_unavailable` (`reason: slot_full`) with fresh availability. Verified with 20 simultaneous requests.
- Reschedule is naturally idempotent (a retry to where the appointment already is returns `replayed: true`). Cancel is idempotent (`already_cancelled: true`).

## Endpoints

### `GET /config`  (scope `config:read`)
```json
{ "ai_booking": { "enabled": true, "reason": null }, "booking_enabled": true, "timezone": "Asia/Kolkata",
  "operating_days": ["Mon","Tue","Wed","Thu","Fri","Sat"], "open_windows": [{"start_time":"09:00","end_time":"13:00"},{"start_time":"16:00","end_time":"20:00"}],
  "slot_minutes": 30, "buffer_minutes": 0, "capacity": 1, "min_notice_minutes": 120, "cancel_min_notice_minutes": 0, "max_advance_days": null,
  "shifts": { "morning": {"enabled": true}, "evening": {"enabled": true} },
  "doctors": [{ "doctor_id":"DR-001","name":"Dr. Mahesh Tiwari","qualification":"MPT (PT)","active":true,"default_shift":"morning" }],
  "schedules": [{ "schedule_id":"SCH-001","doctor_id":"DR-001","weekday":"Mon","shift":"morning","start_time":"09:00","end_time":"13:00","slot_minutes":null,"buffer_minutes":null,"capacity":null,"effective_from":null,"effective_to":null,"active":true,"is_override":false }],
  "config_problems": [] }
```
`booking_enabled` here is the **effective** value (false whenever the AI is failed closed). For information and wording only; availability is always the authority.

### `GET /availability?date=YYYY-MM-DD[&doctor_id=DR-001][&shift=morning|evening]`  (scope `availability:read`)
```json
{ "date": "2026-10-08", "timezone": "Asia/Kolkata", "ai_booking": { "available": true, "reason": null }, "closed": null,
  "slots": [{ "slot_id": "DR-001|2026-10-08|09:00", "date": "2026-10-08", "start_time": "09:00", "end_time": "09:30",
              "doctor_id": "DR-001", "doctor_name": "Dr. Mahesh Tiwari", "shift": "morning", "remaining_capacity": 1 }],
  "generated_at": "2026-10-07T06:30:00.000Z" }
```
Only slots the AI may book **right now** are returned (not full, not blocked, not on leave, inside the doctor's shift and the clinic's opening hours, and at least `min_notice_minutes` away).
`closed` is `null`, `not_operating_day` (Sunday), `clinic_closure` or `beyond_booking_window`. Always `200` when authorised, including when AI booking is off (then `slots: []`).
`400 invalid_date` / `invalid_shift` for bad parameters. `503 booking_unavailable` when the data store cannot be reached (this is NOT "no slots": retry later).
A slot can disappear between this call and the booking: that is a normal `409`, handled below.

### `POST /appointments`  (scope `appointments:create`)  headers: `Idempotency-Key`
```json
{ "slot_id": "DR-001|2026-10-08|09:00", "patient": { "name": "Test Patient One", "phone": "9876543210" }, "reason": "Knee pain", "service": "Physiotherapy" }
```
`phone`: any usual Indian mobile spelling; stored as `+91XXXXXXXXXX`. Unknown fields are rejected (`400`). `reason` (≤300), `service` (≤120, default "Physiotherapy") are optional.
Success `201` (new) or `200` (replayed):
```json
{ "replayed": false, "appointment": {
  "booking_reference": "wa-GKA-000001", "status": "Confirmed", "date": "2026-10-08", "start_time": "09:00", "end_time": "09:30",
  "start": "2026-10-08T03:30:00.000Z", "end": "2026-10-08T04:00:00.000Z", "doctor_id": "DR-001", "doctor_name": "Dr. Mahesh Tiwari", "shift": "morning",
  "slot_id": "DR-001|2026-10-08|09:00", "patient": { "name": "Test Patient One", "phone_masked": "+91******3210" },
  "reason": "Knee pain", "service": "Physiotherapy", "source": "WhatsApp AI", "created_at": "...", "updated_at": "..." } }
```
**A booking exists only when you receive this `201`/`200`.** It is returned only after the CRM has written the row and read it back. Anything else means: do not tell the patient it is booked.
The full phone number is never returned (masked). The CRM never creates a patient or a lead; it links to an existing lead / patient by phone when there is one. Reminders (4C candidate): W5 finds the contact from the lead, else the appointment's own `Patient_Phone` / `Patient_Name`, else the register patient, so a booking without a lead can be reminded. A reminder is sent only for a **Confirmed** (not Pending) appointment and only when a **Reminder_Consent = Yes** is recorded for the phone (a booking is not consent). The staff drawer shows the outcome per appointment (`GET /schedule/appointments/:ref` → `reminder`).

### `GET /appointments/{booking_reference}?patient_phone=...`  (scope `appointments:read`)
`200 {"appointment": {...}}`. The patient's phone is the proof of ownership: a missing/wrong phone and an unknown reference both return `404 not_found` (indistinguishable). Works for older Cal.com bookings too (matched by `Booking_UID`, phone from the lead).

### `PATCH /appointments/{booking_reference}`  (scope `appointments:update`)
`{ "patient_phone": "9876543210", "slot_id": "DR-001|2026-10-08|10:00", "reason": "optional" }` -> `200 {"appointment": {...}, "replayed": false}`.
Moves the **same** booking (same reference) to the new slot, atomically: the new slot is re-checked inside the lock, the old one is freed, reminder flags are cleared so the new time gets reminders, and `Status` stays `Booked` (W5 only reminds `Booked`). Refused when AI booking is off (`403`), the appointment is cancelled/completed/no-show (`409 not_reschedulable`), the slot is unavailable (`409 slot_unavailable`, the appointment stays where it was), or the change is later than `cancel_min_notice_minutes` allows (`409 change_too_late`).

### `POST /appointments/{booking_reference}/cancel`  (scope `appointments:cancel`)
`{ "patient_phone": "9876543210", "reason": "optional" }` -> `200 {"appointment": {...status:"Cancelled"}, "already_cancelled": false}`. The row is kept (nothing is ever deleted); the slot becomes bookable again.
`409 not_cancellable` (completed / no-show / already started), `409 cancel_too_late` (policy `cancel_min_notice_minutes`, default 0 = no limit; staff are exempt). **Still works while AI booking is off.**

## Statuses
`Pending confirmation`, `Confirmed`, `Checked in`, `Completed`, `Cancelled`, `No-show`. AI-created bookings are `Confirmed` (call create only after the patient confirmed). Internally the existing `Appointments.Status` column is unchanged (Booked / Rescheduled / Cancelled / Completed / No-show) so W4-W9 keep working; the six statuses are derived (see `grist/booking-schema.md`).

## Errors
Body: `{ "error": { "code": "...", "message": "..." } }` plus context fields. Retry guidance:

| HTTP | `error.code` | Meaning | Retry? |
|---|---|---|---|
| 400 | `invalid`, `invalid_json`, `invalid_date`, `invalid_shift`, `invalid_slot_id`, `invalid_phone`, `invalid_patient`, `invalid_idempotency_key` | Bad request | No, fix it |
| 401 | `unauthorized` | Bad/missing token | No |
| 403 | `forbidden` | Token lacks the scope | No |
| 403 | `ai_booking_disabled` (+`reason`) | AI booking is off / failed closed | No; tell the patient the team will confirm manually |
| 404 | `not_found` | Unknown reference or wrong phone | No |
| 409 | `slot_unavailable` (+`reason`, `availability`) | Slot cannot be booked now | No; offer `availability.slots` |
| 409 | `idempotency_conflict`, `duplicate_booking` (+`booking_reference`), `not_reschedulable`, `not_cancellable`, `cancel_too_late`, `change_too_late` | Business rule | No |
| 413 | `too_large` | Body over 20 KB | No |
| 429 | `rate_limited` | Too many failed token attempts | Later |
| 502 | `write_unverified` | The write could not be confirmed. **Do not tell the patient it is booked.** | **Yes, with the SAME Idempotency-Key** (it returns the row if it was saved) |
| 502/503 | `backend_*`, `booking_unavailable` | Data store unreachable | Yes, same key, with backoff |
| 503 | `audit_unavailable` | Bookings are paused because the audit log cannot be saved. **Nothing was changed.** | Yes, later, with the SAME key (an operator must fix the volume; see `docs/booking-operations.md`) |

`slot_unavailable.reason`: `slot_full`, `blocked`, `in_past` (also "less than the minimum notice"), `closed` (+`closed`: `not_operating_day` / `clinic_closure`), `beyond_booking_window`, `shift_disabled`, `doctor_unavailable`, `slot_not_found`.
`slot_unavailable.availability` = `{ date, closed, slots[] }` for the same doctor and day, so n8n can offer the next best time without another call.

## Audit
Every create (including replays and refusals), reschedule and cancel is logged in `Booking_Audit` with the token id as actor (`token:<id>`), source `API`, the action, the booking reference (or slot id), outcome and reason. No patient name, phone or free text and no secret is logged. Reads are not logged. The audit write is best-effort: if it fails the change is still saved and an error is written to the server log.

## Limits you must respect
- **One FLOW HQ process.** Writes are serialised by an in-process lock. If a second instance (or any other writer, such as W13 direct mode or Cal.com/W4 inserting rows) takes the same slot in the same instant, the CRM detects it after writing and undoes the LATER row (`409 slot_unavailable`), but that is a safety net, not a guarantee. Run exactly one instance. If more than one is ever needed, stop and add distributed locking first.
- Cal.com keeps accepting bookings on its own until it is retired (`docs/calcom-cutover.md`). The CRM counts those rows against capacity, so it never double-books on top of one, but it cannot stop Cal.com from taking a slot first.
- Test with synthetic patients and an explicitly authorised test recipient only. These routes send no WhatsApp message; sending stays in n8n.
