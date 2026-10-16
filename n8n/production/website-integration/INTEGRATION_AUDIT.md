> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# INTEGRATION AUDIT: clinic website → n8n → Grist

Scope read: website repo `vatsal04-02/Physio` (Astro), CRM repo `vatsal04-02/Geeta-krishna-CRM` (branch `claude/adoring-darwin-9py5im`), the user's imported workflow `FlowHQ Clinic Automation (production candidate)` (418 nodes, id `sUaNZ0rqAG67HNih`, v1) and the uploaded `.env` (secret values were not copied anywhere).
**Not seen:** the live Vercel site, the live n8n, the live Grist, the credential values, the clinic registry's Clinics table.

## Architecture as found
```
Physio site (Astro 7, static, Vercel)
  Booking form ── validate ── opens https://wa.me/<clinic>?text=…            (no backend; page says "Nothing is stored")

n8n (Docker, one integrated workflow, W1..W14)
  POST /webhook/website-lead  (header auth)  ─► W1 ─► Grist registry (Clinics) ─► clinic doc ─► LEADS (find by phone → update | create)
                                                  └► Run_Log, staff alert via W12 (WhatsApp, allowlist/live/off), optional e-mail
  W3 (every 10 min) / W5 / W6 (daily) read LEADS and send through W12 only (consent, opt-out, quiet hours, test mode, ledger)
  W13 (AI receptionist) is reached from W2 (inbound WhatsApp), never from W1
```

## Findings
| # | Finding | Evidence | Risk | Handled by |
|---|---|---|---|---|
| A1 | The website form is not connected to anything; it only opens WhatsApp. The copy says nothing is stored. | `src/scripts/booking.ts`, `Booking.astro` | enquiries only exist if the visitor presses send in WhatsApp | site patch |
| A2 | The leads table is `LEADS` (the CRM app labels it "Enquiries" for physiotherapy). | n8n Config nodes `leads_table: 'LEADS'`, FlowHQ `GRIST_LEADS_TABLE \|\| 'LEADS'`, `grist/schema.md` | none; no table called `Enquiries` exists in any file | confirmed from config, live Grist not seen |
| A3 | W1 requires `consent_whatsapp` when `FLOWHQ_W1_REQUIRE_CONSENT=true` (your `.env` today): an unticked box means HTTP 400 and **nothing stored**. | W1 `Prepare lead`; test `website-w1` case 2 | an enquiry from someone who declines WhatsApp is lost | `FLOWHQ_W1_REQUIRE_CONSENT=false` (proposed, needs your approval) |
| A4 | W1 de-duplicates by phone (`Find lead by phone` → update or create) but two requests for the same phone at the same moment both create a lead. **Measured in real n8n: 7 of 60 simultaneous pairs created two leads.** | `tests/real/website-real-n8n.test.js` R3 | duplicate lead rows, two staff alerts | W1 race guard (6 nodes) |
| A5 | **Credential mix-up in the imported v1:** the W1 webhook's header-auth credential, nine Grist nodes (W1 ×7, W4 `Clinic lookup`, W5 `Set sent flag`) **and** W13 `Ask Model` all reference the one credential named `OpenRouter API` (id As1GpZb3W665Na7C). The other 106 Grist nodes use `Header Auth account 2`. | credential references in the file; the repo's own tests also fail on these names (see TEST_PLAN) | if that credential is the OpenRouter key, the website would have to send the AI key as the webhook secret and Grist would receive it. Probably an import-time mapping slip. **I did not change any credential.** | you check: open that credential and read its header NAME only (never the value); the website's header name is configurable (`N8N_WEBHOOK_AUTH_HEADER`) |
| A6 | Your v1 W12 differs from the repo's production export (no `Consent needed?` node; `Consent decide` handles `needs_consent` itself). | node diff | none found: consent tests pass on both | tested on both |
| A7 | W6 silently does nothing for a lead without consent (no log line, no flag): nobody sees why no follow-up went. | `website-w1` downstream test | visibility only; no message is sent | documented, not changed |
| A8 | Real recipients in `.env`: `FLOWHQ_ALERT_EMAIL_TO` and `FLOWHQ_WA_ALLOWLIST` are real. A live test would alert them. | `.env` | patient/staff messages during tests | tests use mocks; the live test needs `FLOWHQ_WA_SEND_MODE=off` and the e-mail empty |
| A9 | The clinic slug is not in any supplied file (only test slugs in the repos). | grep | W1 answers 404 `unknown_clinic` without it | `CLINIC_SLUG` server env var, set at deploy, never guessed |
| A10 | Test vs production webhook: n8n registers `/webhook/…` only while the workflow is active and `/webhook-test/…` only while the editor listens. With the workflow active the test URL answers 404. | real n8n test R4 | the first test URL attempt fails unless the editor is listening | documented in the test procedure |
| A11 | Patient-facing sends and external AI reachable from W1: none. W1 only calls W12 for a **staff** alert and SMTP for the optional e-mail. No AI node is reachable from the W1 webhook. | graph walk in `website-w1` test 12/13 | none | test |

## Security weaknesses of a naive integration (and what the patch does about each)
* Posting from the browser straight to n8n would put the webhook URL in the page and cannot carry a secret → a **server function** holds URL and secret.
* No CORS/origin control on n8n webhook → the function accepts only the site's own origin(s).
* Bots → hidden honeypot field (`website`, answered "received", nothing stored) + per-address rate limit (best effort per serverless instance).
* PII in logs → the function logs only an event name, request id and status code (tested).
* Health data (concern) in free text → documented in `PRIVACY_DRAFT.md`; no detailed history is asked for.
