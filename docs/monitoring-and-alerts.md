# Monitoring, alerts and the nightly backup (prepared 1 Nov 2026)

Status: **nothing here needs a code change.** The script and the exact settings are ready; the three items marked OWNER need an account, a chat id or a privileged command that only the owner can give or run.

## 1. Uptime monitor (OWNER: needs an account with an uptime service)
No monitoring account or credential is available to the deployment, so none was created. Any of UptimeRobot (free), Better Stack or similar works. Create these monitors (HTTPS, check every 5 minutes, alert by e-mail/SMS/Telegram to the owner):

| Name | URL | Expected | Alert when |
|---|---|---|---|
| GKP website | `https://geetakrishnaphysiotherapy.co.in/` | HTTP 200 | not 200 |
| FLOW HQ + audit log | `https://app.geetakrishnaphysiotherapy.co.in/api/health` | HTTP 200 **and the text** `"audit_outbox":"ok"` (keyword monitor) | not 200, or the keyword is missing (page now: `red` refuses bookings) |
| n8n webhooks | `https://n8n.geetakrishnaphysiotherapy.co.in/healthz` | HTTP 200, keyword `ok` | not 200 |
| Grist CRM | `https://crm.geetakrishnaphysiotherapy.co.in/` | 200/302 | no answer |
| Certificate expiry | the three VPS hostnames | n/a | under 14 days (Caddy renews automatically at about 30 days; this only catches a failure) |

**No account needed:** `scripts/health-check.sh` makes the same checks (and also confirms the private endpoints are still NOT public). Exit code 0 = all fine. Run it from any machine, for example from the owner's PC or from an uptime service's cron: `./scripts/health-check.sh` (`QUIET=1` prints only failures). It was run against production on 1 Nov 2026 and passed (website, FLOW HQ and audit log, n8n, Grist, booking API 404, `/rest` 404, `/webhook-test` 404, staff API 401, three certificates 85 days).

## 2. Telegram alerts for failed workflows (OWNER: needs a chat id)
State found in production: n8n already holds a Telegram bot credential (**"Telegram account"**, used by workflow W11 "Error alert"). The missing piece is the **chat id**: `FLOWHQ_TELEGRAM_CHAT_ID` is empty, so W11 skips the send and failures appear only in the n8n execution list. I did not read the bot token, did not guess a chat id and changed nothing.
To enable (about 3 minutes):
1. In Telegram open the alert bot, press Start and send it any message (for a group: add the bot and send a message in the group).
2. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser with the bot token and note `message.chat.id` (a group id is negative). Do not paste the token anywhere else.
3. On the server: `cd ~/GKP-Final-Build && nano .env` and set `FLOWHQ_TELEGRAM_CHAT_ID=<that number>`.
4. Apply: `docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --no-deps n8n` (n8n restarts in a few seconds; workflows stay active).
5. Test: in the n8n editor run W11 manually, or ask for the supervised test. The alert contains only the workflow name, the step, a trimmed error and a link (no patient data) and is throttled to one per 10 minutes.

## 3. Nightly backup (OWNER: run one command; the permission system refused it twice, so it was not installed)
The deployment's permission check blocks creating a scheduled job on the server ("Unauthorized Persistence"). It was not bypassed. As the `deploy` user on the VPS run:

```
ssh deploy@201.18.202.128
cd ~/GKP-Final-Build && ./scripts/install-cron.sh
crontab -l      # must show:  30 2 * * * cd /home/deploy/GKP-Final-Build && ./scripts/backup.sh >> .../backups/backup.log 2>&1 # gkp-backup
```
No `sudo` is needed: it is the `deploy` user's own crontab. It runs the encrypted backup every night at 02:30 IST and keeps 14 days (each archive is about 1.4 GB; the disk has 78 GB free). The backup stops the containers for about a minute, so FLOW HQ restarts at 02:30: since the 1 Nov fix (commit `7e307d7`) the audit log reopens by itself after such a restart. Check next morning: `ls -lh ~/GKP-Final-Build/backups | tail` and `tail ~/GKP-Final-Build/backups/backup.log`.

## 4. Off-server backup copy
The newest full backup `~/backups/4d-cutover-20261101-003743/` was copied to the admin PC (`C:\Users\vatsa\gkp-backups\4d-cutover-20261101-003743`) and **both SHA-256 values match the server's `SHA256SUMS`** (verified 1 Nov 2026: `gkp-20261101-003747.tar.gz.enc` 653fe69c...d22b36, `n8n-workflows.json.enc` a9f5df2f...b0fb931). The archive is encrypted with `BACKUP_PASSPHRASE` (in `.env`): keep a copy of that passphrase OFF the server, or the copy cannot be restored. Repeat after each important change: `scp -r deploy@201.18.202.128:backups/<newest 4d-cutover-folder> .` and compare with `Get-FileHash`.
