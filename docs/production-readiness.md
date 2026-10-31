# Production readiness (as of 31 October 2026)

**Nothing was deployed, provisioned, activated or sent to a patient. `booking_enabled` is OFF everywhere. The live n8n and Grist were never touched or even reachable.**

## 1. Verdict
**NO-GO for switching on AI booking or any patient-facing activation today. GO to start the staged pre-production steps in section 5 (backups, proxy hardening, read-only n8n export and compare, rehearsal on a copy of the live Grist document).**
Blockers, in order:
1. The deployed n8n workflows were never exported or compared with the repo candidate (no access). Drift is unknown (`docs/n8n-deployed-export-procedure.md`).
2. WhatsApp was never tested for real (no authorised number or Meta credential). Template approval, `booking_confirmation` / `reminder_*` wording without a Cal.com link, real error codes: unverified.
3. The AI model was a deterministic stub. A supervised run with the real model and a synthetic patient is required (section 6).
4. The current proxy file publishes the n8n editor (`docs/security-review.md` S1). Deploy `Caddyfile.production` first.
5. Staging used a Grist document built from `grist/schema.md`, not the live one. Rehearse `provision-booking` on a copy of the live document.
6. Owner decision D2 (registration form) is pending: until reminder consent is recorded, **every automated reminder is suppressed** (deliberate).

## 2. What is built
FLOW HQ: booking engine and service (one writer, idempotent, verified writes), token API for n8n, staff Schedule page (day, **week**, **per-doctor week**, list with filters, doctors and hours, leave and blocks, settings, history), per-appointment **reminder outlook**, reminder-consent records with append-only history and permissions, durable audit outbox, operator tools (provision, token `--write`/`revoke`), `audit_outbox` on `/api/health`.
n8n (new candidate `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4c.json`, inactive): reminder consent and message purposes (W5/W12/W15), pending appointments not reminded, patients without a Lead reminded, skip reasons logged, Cal.com links refused (W6/W13/W15), W13 books/cancels/moves **only** through the FLOW HQ API after an explicit YES. Details: `docs/n8n-4c-changes.md`.
Schema (additive only): tables `Doctors`, `Doctor_Schedules`, `Booking_Config`, `Closures_Blocks`, `Booking_Audit`, `Reminder_Consent`, `Reminder_Consent_Log`; extra `Appointments` columns (`grist/booking-schema.md`); n8n side `Send_Ledger` and consent columns (existing `migrate-grist.js`).

## 3. Test results (final code)
| Suite | Result |
|---|---|
| Typecheck, production build | clean |
| FLOW HQ unit / API suite (in-memory) | **494 passed**, 40 skipped (the real-environment tests below) |
| Real Grist 1.7.20 + real server process (Windows host): journey, concurrency, consent, audit flush, restart, corrupt outbox, second process, token expiry/revocation, permissions, **backup and restore**, **Grist outage**, production image | **23 passed** |
| Same, in Linux: **SIGTERM, SIGINT, SIGKILL recovery, disk full** | **21 passed** (booking 11 + lifecycle 10) |
| Real n8n 2.43.5 + real Grist + real FLOW HQ, 12-step journey (WhatsApp, AI stubbed) | **12 / 12** |
| Repo's real-n8n suite on the reference workflow | 11 / 11 |
| n8n regression runner (Linux, incl. shell `ops` suite) | reference 205, authoritative 216, 4C 231 checks, **0 unexpected failures** |
| n8n snippet and lineage tests | all pass; new: consent 10, central booking 20, 4C workflow 25 + 13 |
| Real Caddy: production Caddyfile | 20 / 20 in both admin cases; current file confirmed to expose the editor |
Real bugs found by real systems and fixed: blank Int = 0 in Grist (no doctor had slots), chunked bodies bypassed the size cap, empty model reply forced a hand-off, tools not runnable in the image, tokens never expired by default. Open: S6, S8 and the remaining dependency advisories (`docs/security-review.md`).

## 4. Hardening
Security review: `docs/security-review.md`. Runbooks (monitoring, backup, restore drill, rollback, incidents): `docs/runbooks.md`. Variables, credentials, domains, commands: `docs/environment-reference.md`. Staging and its limits: `docs/staging-environment.md`.

## 5. Production deployment sequence (each step needs your approval; none was run)
Stop at the first failed check. Take backups first (`docs/runbooks.md` section 2).
1. **Read-only n8n export, sanitize, diff** against `candidatefinal` and `candidate4c`. Reconcile if different.
2. **Rehearse** on a copy of the live Grist document and on a staging n8n.
3. **Proxy:** add `N8N_ADMIN_DOMAIN` (DNS) and `ADMIN_ALLOW_CIDR` to `.env`; mount `flowhq/deploy/Caddyfile.production`; `docker compose ... up -d caddy`. Check: `https://<N8N_DOMAIN>/rest/login` is 404, a Meta test delivery to `/webhook/whatsapp-inbound` still works, the editor opens from the allowed address only.
4. **FLOW HQ image:** `docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --build flowhq`. Check `/api/health` shows `audit_outbox` ok and run the canary in `docs/booking-operations.md`.
5. **Provision (additive):** `docker compose exec flowhq node dist/tools/provision-booking.mjs <slug>` (dry run), then `... --apply --seed`. Confirm `booking_enabled` = off. Then `node n8n/production/scripts/migrate-grist.js --doc <docId>` then `--apply`.
6. **Token and env:** `docker compose exec flowhq node dist/tools/booking-token.mjs n8n-whatsapp <slug> --days 90 --write`; `docker compose restart flowhq`; create credential `FlowHQ Booking API` in n8n; set `FLOWHQ_BOOKING_API_URL=http://flowhq:8787` and `FLOWHQ_AI_MAX_REPLIES_PER_HOUR=12`; recreate n8n.
7. **n8n workflow:** import 4C as a new inactive workflow, re-link credentials, test with `FLOWHQ_WA_SEND_MODE=allowlist` and `TEST_MODE=true`, then swap (`docs/runbooks.md` section 4).
8. **Consent:** staff record reminder consent only with evidence (`consent:write` grant); no bulk conversion; `approved_consent_forms` stays empty until the owner approves the form.

## 6. AI-booking activation (a separate approval, after section 5)
Preconditions: blockers 1-5 closed; Meta templates approved; a test number authorised. Then: (a) supervised run with the **real model** and a synthetic patient through the whole journey in allowlist/TEST mode; (b) staff trained on the Schedule page, reminder panel and the "stop the AI" ladder (`docs/runbooks.md` section 6); (c) admin turns **AI booking ON** in the Schedule page for one day with staff watching; (d) review `Booking_Audit`, hand-offs and `Run_Log` after 24 h and 48 h; (e) only then retire Cal.com per `docs/calcom-cutover.md`.

## 7. Known limitations
Concurrent duplicate WhatsApp delivery stores a duplicate inbox row (no duplicate booking/message); Grist API key is per user; `zod` major upgrade pending; a 0-minute buffer cannot override a larger clinic buffer; one FLOW HQ instance only; no load testing beyond 12 concurrent requests.
