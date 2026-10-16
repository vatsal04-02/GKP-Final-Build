# CHECKLIST: what is ready, what needs credentials, what is disabled, what is still open

## Component status

| Component | Status | Needs before it runs for real |
|---|---|---|
| W1 website enquiry | **ready** (tested: simulator + real n8n) | Header-auth credential, Grist API key, consent checkbox on the form, registry row |
| W2 inbound WhatsApp + receipts | **ready, needs credentials** | Meta App secret, verify token, webhook subscription, a real Meta number (never observed live) |
| W3 speed to lead | ready, needs credentials | owner_phone, approved template `new_lead_staff_alert` |
| W4 Cal.com | **ready, needs credentials** | Cal.com secret + webhook, approved `booking_confirmation` |
| W5 reminders / W6 follow-ups / W7 outcome / W8 review / W10 staff reply | ready, needs credentials | approved templates; per-clinic Settings switches (W7, W8 default off) |
| W9 weekly report | ready; AI text **disabled** | `weekly_report_whatsapp=on`, template `weekly_owner_report` |
| W11 error alert | ready, needs credentials | Telegram bot token + chat id (without them failures are only in the n8n list) |
| W12 sender (ledger, consent, quiet hours) | **ready** | `FLOWHQ_WA_*`; allowlist mode until go-live |
| W13 AI receptionist | **disabled by default** (external AI off) | provider, terms, clinic approval, API key, PRIVACY.md |
| W14 ledger reconcile | ready | nothing |
| E-mail gateway | ready (staff alert), patient acknowledgement **off** | SMTP credential, `FLOWHQ_ALERT_EMAIL_TO` |
| Missed-call capture | **not implemented** | a telephony provider (MISSED_CALL.md) |
| Docker stack (production / staging) | files validated, **never started** | a server, domains, images pulled |
| Backup / restore | scripts tested on directories; **not on real volumes** | BACKUP_PASSPHRASE, off-site storage, a restore drill |

## Residual risks (after all fixes)

**P0 — none known. "No known P0" is not "production ready": the P1 items below are go-live blockers until they are closed.**

**P1 (blocks go-live)**
1. Nothing was verified against the real Meta Cloud API: template approval, real error codes, `biz_opaque_callback_data` echo, delivery receipts, the 24 h window. Rehearse in allowlist mode first.
2. The Docker stack and the Grist migration were never run against real images / a real Grist (only validated / run against fakes).
3. Consent for **existing** patients is undecided (empty = no template is sent to them).
4. Backups were never restored on real volumes.

**P2**
1. `Lead_id` (`L-YYYYMMDD-NNNN`) is computed from the 200 newest leads: two simultaneous new leads can get the same id (both rows exist and are distinct by row id; the id is only a label). Fix: use the row id or a Grist formula.
2. A booking confirmation blocked by quiet hours (21:00–08:00 IST) or the allowlist is logged but **not** retried; the 24 h / 2 h reminders still follow.
3. Staff alerts obey quiet hours too: an enquiry at 23:00 is alerted next morning (the e-mail alert is not held).
4. W3 / W5 / W6 log a **rejected** send on every cycle until it is fixed (e.g. unapproved template): noisy Run_Log, but visible.
5. No rate limiting on the public webhooks beyond Caddy's body-size limit and signature checks (Caddy's rate-limit module is not part of the stock image).
6. Failed executions (with patient phone numbers and text) stay in the n8n database for 7 days.
7. One timezone (IST) for all clinics; a clinic elsewhere is not supported.
8. n8n Community Edition: a single owner login, no roles, no audit log. Anyone with editor access can read the `FLOWHQ_*` variables.
9. The consent text and legal basis are the clinic's decision (PRIVACY.md); not reviewed by a lawyer.
10. WhatsApp number validity is only checked by Meta at send time (error 131026).
11. W14 only marks stuck sends; nothing queries Meta for a message's final state (the Cloud API has no such call).

**P3**
1. `lead_escalation` template is defined in W12 but no section uses it.
2. `W12 – Manual test` / `Test input` nodes remain for operators (allowlist and ledger apply).
3. Mailpit and Caddy were validated by running the real binaries only for syntax / SMTP delivery, not behind Docker.
4. Hosting cost: a ₹500/month server is not realistic (DEPLOYMENT.md "Cost").
