# PRIVACY, CONSENT AND RETENTION

*Engineering notes, not legal advice. India's Digital Personal Data Protection Act, 2023 and the WhatsApp Business / Meta commerce policies apply to the clinic (data fiduciary) and to you (processor). Have the clinic's lawyer confirm the consent wording, the legal basis for health-related messages and the retention periods.*

## What personal data the system handles

Name, phone number, optional e-mail, the enquiry text, appointment times and services, WhatsApp conversation text, consent records, delivery status. Health information appears in free text that patients write ("knee pain after surgery"): the system does not remove it.

## Consent

| Source | What is recorded | Where |
|---|---|---|
| Website form | `Consent_WhatsApp` (checkbox, **required** unless `FLOWHQ_W1_REQUIRE_CONSENT=false`), optional `Consent_Email`, `Consent_Source=website-form`, `Consent_At`, `Consent_Version` (which consent text was shown) | LEADS |
| Patient starts a WhatsApp chat | `Consent_WhatsApp=true`, source `whatsapp-inbound` (switch off with `FLOWHQ_W2_IMPLIED_CONSENT=false`) | LEADS |
| Cal.com booking | `Consent_WhatsApp=true`, source `cal.com-booking` — **the Cal.com page must say** that booking lets the clinic message the person about it | LEADS |
| Staff | tick the column by hand, source `staff` | LEADS |
| Existing patients | **unknown**: empty = not consented. W12 sends them no business-initiated template. Decide with the clinic; `scripts/migrate-grist.js --backfill-legacy-consent "<why>"` marks leads that already have a conversation or appointment (never opted-out leads) | LEADS |

Enforcement is central in W12: a template to a patient is sent only when `Consent_WhatsApp` is true and `Opted_Out` is not (exempt: TEST_MODE sends to the clinic's own phone, free-text replies to a patient who wrote within 24 h, staff alerts). **Opt-out:** the message `STOP` (and a few Hindi variants) sets `Opted_Out` without any AI and is honoured by every sender. There is no automatic e-mail opt-out (no inbound e-mail processing): `Email_Opted_Out` is set by staff, and the optional acknowledgement e-mail is off by default and only goes to a new lead with an address and `Consent_Email`, never in TEST_MODE or quiet hours.

Withdrawal and erasure requests are manual (Grist): clear the lead's fields / delete the rows. Send_Ledger holds only an idempotency key, template name, status and a Meta message id — no phone number, no text.

## External AI is OFF

`FLOWHQ_AI_EXTERNAL_ENABLED` defaults to `false`. While it is false nothing is sent to an AI provider: W13 treats the clinic's `ai_mode` as off (staff read the message in the Grist inbox; STOP still works) and the W9 weekly report is written from the computed numbers alone.

Before you turn it on:
1. Choose the provider and the model; read its data-processing terms (retention, training, sub-processors, region). The default configuration points at OpenRouter, which routes to other model vendors: that is a chain of processors.
2. Get the clinic's written approval and update its privacy notice.
3. Understand what is sent. W13 sends the clinic's rules and knowledge base (not masked: prices and hours), the calendar, free appointment times, and — **masked** — the patient's messages and history. The filter replaces the patient's name with `[PATIENT]`, phone numbers with `[NUMBER]`, e-mail addresses with `[EMAIL]` and any long digit run (ID, Aadhaar, card). It does **not** anonymise health information, nicknames, addresses or free-text identifiers it cannot recognise, and a request that does not have the expected shape (or still contains the lead's phone digits) is not sent. The AI never sends to a patient and never computes the numbers (CLAUDE.md rule 8): its text is validated, fact-checked against the knowledge base, and anything medical, urgent or unclear goes to a person.
4. The AI must not diagnose; the prompt and the validation enforce hand-off for medical questions and emergencies (tested in the repository's suites, with a fake model — not with a live one).

## Retention

* n8n stores **no** successful executions. Failed executions keep their input (a failed webhook request, with the phone number and text) for 7 days (max 5000): that is the debugging cost of failure alerts; shorten `EXECUTIONS_DATA_MAX_AGE` if the clinic requires.
* Grist is the clinic's record: they decide how long leads, messages and appointments are kept; no automatic deletion exists.
* Backups are encrypted and kept `BACKUP_KEEP_DAYS` (14): a deleted record can still be in a backup for that long.
* The Telegram alert contains only workflow name, step and a masked error (digits and token-like text are removed), never patient content.

## Access

n8n editor: IP-restricted host + n8n's own login (Community Edition: one owner; no roles). Grist: Google sign-in, per-document access. The Grist API key used by n8n can edit every clinic document: create it for a dedicated service user and rotate it when staff leave.
