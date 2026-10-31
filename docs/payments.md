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
Patients see **nothing** (no QR, no payment request) until **all four** are set: `payments_enabled` on, `payee_authorized` on (with a note saying who at the clinic authorized collecting fees into the payee account, and how), `consultation_fee_inr` (no default), and the QR image installed. Withdrawing the authorization closes it at once. Also: `payment_expiry_minutes` (default 30), `payment_review_hold_minutes` (default 720, the hold while staff check a screenshot), `payee_name` (default `VATSAL TRIPATHI`, used to compare with the screenshot). Every change is recorded in `Payment_Events`.

## Checks on a screenshot (all advisory flags, shown to the reviewer)
Real file type from the bytes (JPEG/PNG/WebP only, 5 MB max, SVG/PDF/GIF refused); the same picture used for another payment; editing-software marks; amount is not the fee; no/odd UTR (12 digits expected); UTR already on another payment; payee not the configured payee; status not "success"; time outside the booking window; reader not confident; reader unavailable. A clean result is still only `REVIEW_REQUIRED`.
**Approval rules (server side):** staff must tick that they saw the money, enter the amount received (must equal the fee) and the 12-digit UTR (must not be on any other payment). A mismatch is refused and logged. Approving twice changes nothing and never creates a second appointment.

## Where things run
- **FLOW HQ** (`flowhq/src/server/payments/`): all state, rules, expiry, staff routes, token routes (`/api/booking/payments/*`, private Docker network only, scopes `payments:read`, `payments:write`), screenshot files on the persistent volume (`config/payment-files`, mode 600, served only to front-desk/admin sessions, every view logged). Doctor logins cannot see payments.
- **n8n 4F** (`n8n/final/tools/patch-4f-payments.js`): W12 can send an IMAGE (the QR); W2 turns a WhatsApp image from a patient with an open payment into a screenshot (download from Meta with the token, store, AI reader, extraction) and does NOT start the AI receptionist for it; **W16N** (every minute) asks FLOW HQ whom to tell and sends through W12; **W16S** is the website webhook `site-payments` (header secret). The AI reader runs only if external AI is on and (WhatsApp) the number is on the allowlist, or (website) `FLOWHQ_PAYMENT_OCR_WEBSITE=true`; its answer is untrusted text that FLOW HQ turns into flags.
- **Website** (`apps/clinic-website`): section "Book and pay online" is hidden unless `/api/pay?action=config` says payments are open; `/api/pay` forwards to n8n (needs `N8N_PAYMENTS_URL`).
- **Supplied QR**: `flowhq/assets/kotak-upi-qr.jpg`, the original image, byte for byte (SHA-256 `DE47BE92…B002E`). It shows the payee **VATSAL TRIPATHI** and a masked UPI ID; nothing was redrawn or retyped.

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

