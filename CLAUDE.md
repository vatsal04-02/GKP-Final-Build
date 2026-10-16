# CLAUDE.md — Clinic Autopilot (agency repo)

Read this before every task in this repo.

## What this is
An agency service for physio clinics: n8n automations + a Grist CRM per clinic + WhatsApp Cloud API.
Specs live in `grist/schema.md` (data) and the "Option B: Low-Code Clinic CRM Build Guide" doc (workflows W0–W10).

## Stack
- Hetzner Ubuntu 24.04, Docker Compose: Caddy (HTTPS) → n8n (5678) and Grist (8484). See `docker-compose.yml`.
- n8n Community Edition: all automation. Grist (grist-core): the clinic-facing CRM.
- WhatsApp Cloud API (Meta), Cal.com webhooks, Claude Haiku via Anthropic API (from n8n only).

## Rules for every change
1. Inspect before modifying. Plan one slice, list files touched, wait for approval, then build.
2. Never print, commit or ask for secrets: `.env`, API keys, tokens. `.env` is git-ignored.
3. Column and table names must match `grist/schema.md` exactly.
4. Every patient-facing send checks its "sent" flag first and sets it right after (no double messages).
5. Every patient-facing send respects `Opted_Out`, `Automation_Paused`, clinic hours (no messages 21:00–08:00 IST) and `TEST_MODE`.
6. Webhook workflows respond 200 immediately, then process. Dedupe on WA_Message_ID / Booking_UID.
7. Phones are always `+91XXXXXXXXXX` — use `n8n/snippets/normalize-phone.js`.
8. AI (Claude) only writes summaries and report text. It never sends to patients and never computes the numbers.
9. n8n workflows are exported as JSON into `n8n/workflows/` and named `W<n>-<short-name>.json`.
10. Run relevant tests (`node n8n/snippets/*.test.js`) and stop on the first failure.

## Clinic lookup
Every workflow starts by reading the Agency Registry Grist doc to find the clinic's Grist doc id
and WhatsApp phone_number_id. Never hard-code a clinic.
