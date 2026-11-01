# UPI payments for appointments (workflow 4F, FLOW HQ, website)

**What it is.** A patient books a time (website or WhatsApp). The time is HELD as a *Pending confirmation* appointment, the patient is shown the clinic's UPI QR with the exact fee and a reference, sends a payment screenshot, and the appointment becomes *Confirmed* only when a person at the clinic has verified that the money reached the bank account.

**What it is not.** A screenshot, an OCR reading or an AI score is **never** proof of payment. The QR is a *static* UPI QR (it carries no amount and no reference), so nothing identifies a transfer except the UTR on the bank statement. There is no bank or payment-provider link today: **every payment is confirmed by staff.** A signed provider-event endpoint exists for a future link and is disabled until a secret is configured.

## State and who can change it
Payment status is stored apart from the appointment status (table `Booking_Payments`, one row per booking, joined by `Booking_UID`).

| Payment status | Meaning | Set by |
|---|---|---|
| `PENDING_PAYMENT` | slot held, waiting for money | the payment request |
| `SCREENSHOT_RECEIVED` | a picture was uploaded and stored | the screenshot intake |
| `REVIEW_REQUIRED` | the picture was read (or could not be); advisory flags attached | the extraction step |
| **`PAID`** | **money verified** | **staff approval** (`staff_bank_statement`) or a **signed** provider event (`provider_webhook`) |
| `REJECTED` | staff could not verify it; the patient may send a better picture while the hold lasts | staff |
| `REFUNDED` | staff recorded a refund (admin only); the appointment is cancelled, never deleted | admin |
| `EXPIRED` | not paid in time; the appointment was cancelled (row kept) and the slot is free again | housekeeping (60 s) |
| `CANCELLED` | the booking was cancelled before payment | housekeeping |

Appointment effects: request = `Appt_Stage` *Pending confirmation* (holds the slot, existing engine); **PAID = *Confirmed***; expiry = *Cancelled* with a reason. `Appointments.Status` and every existing column keep their meaning.

## Settings (FLOW HQ > Schedule > Payments, admin)
Patients see **nothing** (no QR, no payment request) until **all four** are set: `payments_enabled` on, `payee_authorized` on (with a note saying who at the clinic authorized collecting fees into the payee account, and how), `consultation_fee_inr` (no default), and the QR image installed. Withdrawing the authorization closes it at once. Also: `payment_expiry_minutes` (default 30), `payment_review_hold_minutes` (default 720, the hold while staff check a screenshot), `payee_name` (legacy, no longer used to compare screenshots: the doctor's own receiver name is), `lead_payment_requests` (website enquiry → QR, default off). Every change is recorded in `Payment_Events`.

## Checks on a screenshot (all advisory flags, shown to the reviewer)
Real file type from the bytes (JPEG/PNG/WebP only, 5 MB max, SVG/PDF/GIF refused); the same picture used for another payment; editing-software marks; amount is not the fee; no/odd UTR (12 digits expected); UTR already on another payment; payee not the configured payee; status not "success"; time outside the booking window; reader not confident; reader unavailable. A clean result is still only `REVIEW_REQUIRED`.
**Approval rules (server side):** staff must tick that they saw the money, enter the amount received (must equal the fee) and the 12-digit UTR (must not be on any other payment). A mismatch is refused and logged. Approving twice changes nothing and never creates a second appointment.

## Where things run
- **FLOW HQ** (`flowhq/src/server/payments/`): all state, rules, expiry, staff routes, token routes (`/api/booking/payments/*`, private Docker network only, scopes `payments:read`, `payments:write`), screenshot files on the persistent volume (`config/payment-files`, mode 600, served only to front-desk/admin sessions, every view logged). Doctor logins cannot see payments.
- **n8n 4F** (`n8n/final/tools/patch-4f-payments.js`): W12 can send an IMAGE (the QR); W2 turns a WhatsApp image from a patient with an open payment into a screenshot (download from Meta with the token, store, AI reader, extraction) and does NOT start the AI receptionist for it; **W16N** (every minute) asks FLOW HQ whom to tell and sends through W12; **W16S** is the website webhook `site-payments` (header secret). The AI reader runs only if external AI is on and (WhatsApp) the number is on the allowlist, or (website) `FLOWHQ_PAYMENT_OCR_WEBSITE=true`; its answer is untrusted text that FLOW HQ turns into flags.
- **Website** (`apps/clinic-website`): section "Book and pay online" is hidden unless `/api/pay?action=config` says payments are open; `/api/pay` forwards to n8n (needs `N8N_PAYMENTS_URL`).
- **Supplied QRs (one per doctor)**: `flowhq/assets/qr-dr-mahesh-tiwari.jpg` (GPay, receiver **Mahesh Tiwari**) and `flowhq/assets/qr-dr-sandeep-tiwari.jpg` (Paytm, receiver **Sandeep Kumar**), the originals the owner supplied on 2 Nov 2026, unaltered. The earlier Kotak QR (VATSAL TRIPATHI) was removed from the repo; a payment request created before the change (no `Payee_Key`) is shown the QR the clock rule picks for the minute it was created. Check for open payments before deploying.

## Which doctor's QR is sent
Chosen **once, when the payment request is created**, from the real clock in clinic time (`flowhq/src/server/payments/payees.ts`): **09:00-12:59 → Dr. Mahesh Tiwari**, **16:00-19:59 → Dr. Sandeep Tiwari**. Outside those hours (13:00-15:59, night) the QR of the **booked doctor** is used. The choice is stored on the payment (`Payee_Key`), so the QR shown on WhatsApp, on the website page, the receiver-name check on the screenshot and the staff screen always refer to the same account. The QR is served per payment (`/payments/qr?payment_ref=`), never as one fixed image. Staff see "Pays: Dr. …" on each payment.
Note: the receiver name on Dr. Sandeep's QR is **Sandeep Kumar** (as the Paytm app shows it); the screenshot check compares against that. Please confirm with the owner that this account is Dr. Sandeep Tiwari's.

## Website enquiries → held time + QR on WhatsApp (owner switch `lead_payment_requests`, default OFF)
When the switch is on, a website enquiry that ticked the WhatsApp box, arrived **after** the switch was turned on (`lead_payment_since`) and names a day and session ("Preferred: Mon 9, Morning 9 AM–1 PM") gets the first free time of that session held (*Pending confirmation*, channel `enquiry`) and a payment request, once per lead (idempotent by the lead id; no free time or no readable day is logged for staff and left alone). The 60-second FLOW HQ tick does this; n8n **W16N** (4G) then messages the patient.
Because that patient has **never written to us**, WhatsApp only allows an approved **template**, not free text or an image. 4G sends the template `booking_payment_pending` with the **QR as the image header**. A patient who chatted with us (inside 24 h) still gets the QR image and text as before.
**The owner must create and get this template approved in Meta before turning the switch on** (Utility category, language English `en`):
- Header: **Image** (sample = either QR)
- Body (8 variables): `Hello {{1}}, your appointment at {{2}} on {{3}} at {{4}} with {{5}} is held but NOT yet confirmed. Please pay ₹{{6}} using the QR above and send us the payment screenshot on this chat. Reference: {{7}}. The held time is released in {{8}} minutes if no payment is received. Never share your UPI PIN or OTP with anyone.`
  ({{1}} patient name, {{2}} clinic name, {{3}} date, {{4}} time, {{5}} doctor, {{6}} amount, {{7}} reference, {{8}} minutes)
Until it is approved Meta rejects the send (error 132001) and the failure is logged; nothing reaches the patient. While the connected number is Meta's TEST number, real patients cannot be reached at all.

## Database changes (additive)
`npm run provision-payments -- <clinic-slug> [--apply]` creates `Booking_Payments`, `Payment_Events`, `Payment_Files` (columns in `flowhq/src/server/payments/schema.ts`). Nothing existing is renamed, retyped, deleted or cleared.

## Operations
- Review queue: Schedule > Payments (filter *Verification pending*). Open a row: screenshot, what the reader found, flags, then *Mark paid and confirm appointment* (after checking the bank statement) or *Reject*. Admin: *Record a refund* (cancels the appointment; send the money back from the bank/UPI app yourself).
- A paid booking that is cancelled elsewhere shows **refund due** in the queue.
- Money that arrives after the hold was released cannot re-book the slot: it shows as *Verification pending* with the flag "Money arrived after the held time was released": refund it or book the patient again.
- Stop everything: switch **Payments on** off (patients see nothing new; held bookings expire normally).

## Not done / needs the owner or an outside party
See `docs/payments-status.md` (fee, written payee authorization, Meta production number and approved templates, authoritative bank verification, Vercel variable).

## Payment Management (sidebar: Money > Payment Management, route /w/<workspace>/payments)
The review queue lives in its own sidebar item (it replaced the Payments tab inside Schedule). Cards: total collected (sum of verified PAID amounts), awaiting verification, review required, rejected, cancelled; filters All / Pending / Screenshot received / Review required / Paid / Rejected / Cancelled and a search; a row opens the details (patient and booking, screenshot preview, what the reader found and the flags, UTR, history) with the verification form (bank amount, bank UTR, receipt tick: Approve) and Reject (reason). Admins also see the payment settings on that page and can record a refund. Front desk and admins only (a doctor login is refused by the server). Screenshots of the page on STAGING with synthetic data: docs/img/payment-management-*.png. Browser test: flowhq/tests/e2e/payment-management.e2e.ts.


