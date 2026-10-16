# OPERATIONS: monitoring, backup / restore, rollback, upgrades

## Daily / weekly

| What | How |
|---|---|
| Is it alive? | `scripts/healthcheck.sh` (cron every 5 min, mail on exit code 1). Also `docker compose … ps`. |
| Did a section fail? | Telegram alert (W11, one per failure per 10 min). Grist **Run_Log**: filter `Outcome = failed`. |
| Messages in doubt | Grist **Send_Ledger**: `Status = uncertain` / `unconfirmed` / `sending`, and Run_Log rows by `W14-send-ledger`. An `uncertain` message was **not** re-sent: look in WhatsApp Manager, then tell the patient if needed. |
| Delivery failures | Run_Log `W2-delivery-status` (e.g. 131026 not on WhatsApp). |
| Disk | `df -h`; Docker logs are capped (10 MB × 5 per service). |

## Backup

```bash
BACKUP_PASSPHRASE=… scripts/backup.sh            # stops n8n and Grist for a few seconds, archives, AES-256 encrypts, writes .sha256
scripts/backup.sh --online                       # no stop (SQLite files may be copied mid-write)
```
What is in it: `data/n8n` (database with encrypted credentials and the workflows), `data/grist` (all clinic documents), `secrets/`, `.env`. Copy the archive **off the server** (rclone / scp to storage you control); keep the passphrase elsewhere. Schedule (example): `15 3 * * * cd /opt/flowhq/n8n/production && ./scripts/backup.sh >> /var/log/flowhq-backup.log 2>&1`. Also enable the hosting provider's snapshots as a second layer.

## Restore (test it at least once before go-live, then every quarter)

```bash
docker compose -f ops/docker-compose.production.yml --env-file .env down
BACKUP_PASSPHRASE=… scripts/restore.sh /path/flowhq-YYYYmmdd-HHMMSS.tar.gz.enc [--target DIR] [--force]
docker compose -f ops/docker-compose.production.yml --env-file .env up -d && scripts/healthcheck.sh
```
`restore.sh` verifies the checksum, refuses a wrong passphrase or a damaged file, refuses to run while services are up, never overwrites: with `--force` it moves the existing `data`, `secrets` and `.env` to `*.before-restore-<timestamp>`. After a restore: Meta may have re-sent webhooks meanwhile (harmless: idempotent), and Send_Ledger protects against re-sending anything already recorded.

## Rollback of the workflow

The export is a single JSON with its own id. To roll back: (1) deactivate it in the editor (or `n8n unpublish:workflow --id=FhqClinicProd001`, restart); (2) import the previous export (kept in git / your backups) — importing a file with the **same id** replaces that workflow; (3) re-activate. The Grist additions (Send_Ledger, Consent_* columns) are additive and can stay. To go back to the **old uploaded workflow** (not recommended: it has open P0 findings) import `backup/ai_updated_workflow_clinic_final_v3_v1.original.local.json` — it contains live secrets, so only from a private location.

Never run two copies active at once: both would register the same webhook paths and both would run the schedules.

## Upgrading n8n / Grist

1. Back up. 2. Read the release notes (breaking changes, especially Code-node and webhook behaviour). 3. Upgrade **staging** (`N8N_VERSION`), re-run `node tests/real/real-n8n.test.js`-style checks (the rehearsal in DEPLOYMENT.md §6). 4. Production: change the pinned version in `.env`, `docker compose … pull && up -d`. Check `Graph API version` (`FLOWHQ_WA_GRAPH_VERSION`) against Meta's changelog every few months: old versions are retired.

## Rotating secrets

| Secret | Where to change |
|---|---|
| Meta App secret, verify token, Cal secret | `.env` then `docker compose … up -d` (n8n restarts), then the same value in Meta / Cal.com |
| Grist API key, WhatsApp token, SMTP password, Telegram token, W1 secret | create the new value, re-run `scripts/create-credentials.js` (importing replaces by id), update the website backend for the W1 secret |
| n8n encryption key | **do not rotate casually**: every credential is encrypted with it. Export credentials, change the key, re-import. |

## Incident: "something sent twice / nothing arrives"

1. Send_Ledger by `Idem_Key`: one row ⇒ one attempt. 2. `uncertain` ⇒ no clear answer from Meta: check WhatsApp Manager. 3. `rejected` ⇒ Run_Log has Meta's code (132001 template missing, 131030 number not allowed, 190 token). 4. `blocked` ⇒ allowlist / quiet hours / consent / outside 24 h window: the reason is in the Run_Log or the execution. 5. Nothing at all ⇒ Telegram, `docker compose logs n8n`, then the n8n execution list (failed runs only).
