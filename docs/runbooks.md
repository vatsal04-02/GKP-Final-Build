# Runbooks: monitoring, backup and restore, rollback, incidents

Commands are for the production host (Ubuntu, Docker Compose, bash) and use placeholders in `<angle brackets>`. **They were written from, and the key ones rehearsed in, the staging environment (`docs/staging-environment.md`); none was run against production.** Where a step was rehearsed, it says so.

## 1. Monitoring and alerts
| Signal | Where | Alert when | Who |
|---|---|---|---|
| FLOW HQ up and the audit outbox healthy | `GET https://<FLOWHQ_DOMAIN>/api/health` (public) → `{"ok":true,…,"audit_outbox":"ok"}` | not HTTP 200, or `ok` is false, or **`audit_outbox` is `red`** (page now) or `amber` for 15 min. The status code stays 200 on an outbox problem on purpose (a container health check must not restart-loop a healthy app), so the monitor must read the field | uptime monitor (any: UptimeRobot, Better Stack, a cron + curl) |
| n8n webhook path up | `GET https://<N8N_DOMAIN>/healthz` → `ok` | not 200 | uptime monitor |
| Workflow failures | n8n error workflow W11 → Telegram | any alert | owner / agency |
| Reminders not sent and why | Grist `Run_Log`, Workflow `W5-reminders`, Outcome `skipped` (hourly digest) | a sudden jump in "no reminder consent" or "could not be read" (a table was removed) | agency, daily |
| Failed sends | `Run_Log` Outcome `failed`, `Send_Ledger` status `uncertain` / `unconfirmed` / `failed` | any new row | agency, daily |
| AI hand-offs | `Messages.AI_Status = handed_off`; staff alert (WhatsApp to the owner) | a hand-off with reason "booking system…" means FLOW HQ was unreachable or refused | front desk |
| Booking API trouble | FLOW HQ log: `AUDIT OUTBOX`, `AUDIT WRITE FAILED`; Schedule page red banner (admins) | any | agency |
| Bad tokens | many `401` / a `429 rate_limited` from n8n's address | after a rotation or a leak | agency |
| Disk | host disk and the `flowhq_config` volume | > 80 % | agency |
Keep the monitor's own credentials out of the repository. A weekly check: open Schedule → History (admin) and read the audit-outbox line; read `Run_Log` for `failed`.

## 2. Backups (what, how often, how)
| What | How | Frequency |
|---|---|---|
| Every Grist document (registry + each clinic) | download the SQLite file (below) | daily + before any change in this document |
| Docker volumes `grist_data`, `n8n_data`, `flowhq_config`, `caddy_data` | stop-free tar snapshot (below); **`flowhq_config` holds the audit outbox, user profiles and the token file** | daily; before every upgrade |
| n8n workflows | `n8n export:workflow --all` into a **private** folder, sanitize before it goes anywhere near git (`docs/n8n-deployed-export-procedure.md`) | before every import |
| n8n credentials | **not exported** (secrets). Re-create from your password manager; the n8n encryption key (`N8N_ENCRYPTION_KEY`) must be backed up with `.env` | when changed |
| `.env`, `flowhq/.env`, `flowhq/config/users.json`, `clinic.json` | copy to an encrypted store | when changed |
Store backups off the server, encrypted, and **test a restore every quarter** (section 3).
```bash
# Grist document (rehearsed in staging: GET /api/docs/<id>/download returns the SQLite file)
KEY=$(cat ~/.grist-backup-key)            # a key file, mode 600; never typed on the command line
curl -fsS -H "Authorization: Bearer $KEY" "https://<GRIST_DOMAIN>/api/docs/<docId>/download" -o "grist-<slug>-$(date +%F).grist"
# a Docker volume (flowhq_config shown); the container keeps running, the outbox file is append-only
docker run --rm -v <project>_flowhq_config:/v:ro -v "$PWD":/b alpine tar czf /b/flowhq_config-$(date +%F).tgz -C /v .
```

## 3. Restore drills
### 3a. A Grist document (REHEARSED end to end against real Grist: `lifecycle.real.test.ts`, "BACKUP AND RESTORE")
1. Stop bookings first so nothing writes during the swap: admin turns **AI booking OFF** (Schedule page).
2. Import the backup as a **new** document (the damaged one is left alone until you are sure): Grist UI "Import document", or `POST /api/workspaces/<workspaceId>/import` (multipart field `upload`) which returns `{"id":"<newDocId>"}`.
3. Check it: row counts of `Appointments`, `LEADS`, `Reminder_Consent`, `Reminder_Consent_Log`, `Booking_Audit`; the `Booking_Config` row `booking_enabled` (leave it off).
4. Cut over: in the **Agency Registry** change that clinic's `Grist_Doc_ID` to the new id. Nothing else changes; n8n and FLOW HQ resolve the clinic through the registry on every run (FLOW HQ caches it for 60 s: restart FLOW HQ to be immediate).
5. Verify in staging style: the restored document still refuses a taken slot, an old idempotency key still replays, a new booking works; the audit outbox is unaffected.
6. Only then switch AI booking back on. Anything booked between the backup and the loss must be re-entered from n8n / Meta logs and the paper register.
### 3b. The audit outbox (volume)
Restore the `flowhq_config` snapshot into a new volume and start FLOW HQ on it. Flushing is idempotent by `Audit_ID`, so entries already in `Booking_Audit` are never duplicated; entries that were still unflushed at snapshot time and not in the snapshot are lost (counts are in the last alert). An intent without an outcome and without a matching row is finalised `aborted` (REHEARSED: restart recovery after SIGKILL, restore onto a copy).
### 3c. n8n
Import the sanitized workflow export as a **new** inactive workflow, re-link its credentials, then swap (section 4). Credentials are re-created from the password manager.

## 4. Changing or rolling back the n8n workflow
n8n keeps no history of a replaced workflow. The safe pattern is **import as new, swap, keep the old one**:
1. Take a fresh raw export into the private folder; keep the sanitized one in `n8n/final/workflows/history/` (git) with today's date.
2. Import the new file; n8n creates an **inactive** workflow. Re-link every credential in the UI. Check `FLOWHQ_BOOKING_API_URL` and `FLOWHQ_AI_MAX_REPLIES_PER_HOUR` in the container environment.
3. With `FLOWHQ_WA_SEND_MODE=allowlist` and Settings `TEST_MODE=true` (the existing safety levers), run the checks in `docs/production-readiness.md` section 6 on the new workflow only.
4. Swap in one step: deactivate the old workflow, activate the new one (their webhook paths are identical, so only one can be active; Meta and Cal.com retry a refused delivery, so a swap of a few seconds loses nothing).
5. **Rollback:** deactivate the new workflow, activate the old one (still there), put the previous `Settings.booking_link` back if you changed it. W4 (Cal.com sync) stays active throughout, so Cal.com bookings keep syncing in both directions of the swap.

## 5. Rolling back FLOW HQ
Tag every image you deploy (`flowhq:<date>`) and keep the previous one. To roll back: `docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d flowhq` with the previous tag. The Grist changes are additive (new tables and columns), so an older FLOW HQ simply ignores them. Do **not** roll back below the version that added the audit outbox while bookings are on (the older version has no write-ahead log). Restore `flowhq_config` only if it was damaged.

## 6. Stopping the AI quickly (a ladder: use the first rung that fits)
1. **Schedule page → AI booking OFF** (admin). Effective on the very next request: no times are offered, no booking is created or moved. Existing appointments are untouched. Staff keep booking. W13 then hands booking requests to a person.
2. Set `FLOWHQ_BOOKING_API_URL=` (empty) in `.env` and recreate the n8n container: W13 cannot reach the booking system at all.
3. Settings `ai_mode = off` for the clinic in Grist: W13 stops answering altogether.
4. `FLOWHQ_AI_EXTERNAL_ENABLED=false`: nothing is sent to the AI provider.
5. Deactivate the workflow in n8n (everything stops, including Cal.com sync, reminders and alerts: last resort).
6. `FLOWHQ_WA_SEND_MODE=off` and recreate n8n: nothing is sent to anyone.

## 7. Token rotation and revocation (REHEARSED inside the production image)
Rotate every 90 days or on any suspicion:
```bash
docker compose exec flowhq node dist/tools/booking-token.mjs n8n-whatsapp-2 <clinic-slug> --days 90 --write   # prints the new token ONCE
docker compose restart flowhq                                                                                  # tokens are loaded at start-up
# put the new token into the n8n credential "FlowHQ Booking API", test, then retire the old one:
docker compose exec flowhq node dist/tools/booking-token.mjs revoke n8n-whatsapp
docker compose restart flowhq
```
A revoked, expired or unknown token gets the same `401`. If a token leaks: revoke first, rotate second.

## 8. Incident playbooks
| Situation | What the system does | What you do |
|---|---|---|
| **Grist down** (REHEARSED) | availability and bookings answer 502/503, never a false "booked"; the server stays up; the audit outbox keeps entries and flushes later; W13 offers the clinic's own booking page | nothing to restart. Restart Grist; the next request works. Staff: use the paper register meanwhile |
| **FLOW HQ down** (REHEARSED in the journey) | W13 cannot get times: the patient gets the clinic's booking page or a hand-off; the owner is alerted; Cal.com sync and reminders are unaffected | `docker compose up -d flowhq`; the outbox waits for the stale lock (≤ 30 s after a crash, immediate after a clean stop) |
| **n8n down** (REHEARSED) | Meta retries each message for days; FLOW HQ and staff are unaffected | start n8n; re-delivered messages are answered once |
| **Red audit banner / `audit_outbox: red`** (REHEARSED: disk full, no volume, second process, corrupt file) | new bookings are refused with 503 `audit_unavailable` and write nothing; reads work | `docs/booking-operations.md` "Audit outbox" recovery: free disk, check the volume with `audit-outbox.mjs status`, restart. Break-glass only with the owner's consent |
| **Container re-created** (REHEARSED) | same outbox identity, keys still replay | none |
| **Two FLOW HQ instances by mistake** (REHEARSED) | the second refuses booking writes | stop it |
| **A patient says "I got a reminder I did not want" / "STOP"** | `STOP` sets Opted_Out immediately; an opt-out beats any consent | record **No** in the Schedule drawer; check `Reminder_Consent_Log` for who recorded the Yes and on what evidence |
| **Double booking reported** | the CRM refuses a second booking of a full slot; a collision is detected after the write and the later row is undone | find both references; read `Booking_Audit` for the two `Audit_ID`s; if it ever happens, **stop** and treat it as a defect (do not scale FLOW HQ) |
| **Meta suspends the number / a template is rejected** | sends are rejected and logged `failed`; nothing is retried automatically for `uncertain` | switch to phone calls; fix in WhatsApp Manager; `W12` ledger shows what was attempted |
| **Lost the Grist key / n8n encryption key** | | rotate the Grist key (create a new, update both credentials, delete the old); the n8n encryption key cannot be recovered: restore `.env` from backup or re-create all credentials |

## 9. The whole go-live, in reverse (final rollback plan)
Go-live steps are in `docs/production-readiness.md` section 5; to undo, reverse them:
1. AI booking OFF; set `FLOWHQ_BOOKING_API_URL` empty; recreate n8n.
2. Deactivate the 4C workflow, activate the previous one (section 4).
3. Roll FLOW HQ back to the previous image (section 5) if needed.
4. Switch Caddy back (`Caddyfile`) only if the new proxy rules broke a webhook (note this re-opens the n8n editor to the internet: prefer fixing the rule).
5. Grist: nothing to undo (additive). If a document was damaged, restore it (3a).
6. Cal.com stays the booking channel until `docs/calcom-cutover.md` is completed; nothing was ever disabled there.
