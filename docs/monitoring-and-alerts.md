# Monitoring, alerts and the nightly backup (1 Nov 2026)

## 1. Nightly backup: INSTALLED
The `deploy` user's crontab on the VPS holds `30 2 * * * cd /home/deploy/GKP-Final-Build && ./scripts/backup.sh >> .../backups/backup.log 2>&1 # gkp-backup` (installed 1 Nov 2026 at the owner's direct request). It makes the encrypted archive at 02:30 IST and keeps 14 days (about 1.4 GB each; 78 GB free). It stops the containers for about a minute; FLOW HQ reopens its audit log by itself afterwards (commit `7e307d7`). Check each morning: `ls -lh ~/GKP-Final-Build/backups | tail` and `tail ~/GKP-Final-Build/backups/backup.log`.
Off-server copy: `scp -r deploy@201.18.202.128:backups/<newest folder> .` and compare with `Get-FileHash`/`sha256sum -c SHA256SUMS`. The newest full backup `4d-cutover-20261101-003743` is on the admin PC with both SHA-256 values matching. The archive needs `BACKUP_PASSPHRASE` (in `.env`): keep a copy of it OFF the server.

## 2. Health checks and the uptime monitor
- `scripts/health-check.sh` (read-only; any machine): website, FLOW HQ + audit log, n8n, Grist, that the booking API / `/rest` / `/webhook-test` are NOT public, that staff routes need a login, and certificate lifetime. Exit 0 = fine.
- `scripts/monitor.sh` runs it every 5 minutes, logs every state change to `backups/monitor.log`, and after two failures in a row (about 10 minutes) sends ONE Telegram alert (and one when it recovers). State machine tested on the server (fail, fail, recovered). **Not scheduled yet:** the permission system refused creating this second cron entry. Owner command, as `deploy` on the VPS: `cd ~/GKP-Final-Build && ./scripts/install-monitor-cron.sh`.
- It runs ON the VPS, so it cannot report that the VPS itself is down. Add an external monitor too (free UptimeRobot or Better Stack; needs an account): HTTPS monitors for `https://geetakrishnaphysiotherapy.co.in/` (200), `https://app.geetakrishnaphysiotherapy.co.in/api/health` (200 and keyword `"audit_outbox":"ok"`), `https://n8n.geetakrishnaphysiotherapy.co.in/healthz` (keyword `ok`), every 5 minutes.

## 3. Telegram alerts for failed workflows
- Bot: the credential "Telegram account" already exists in n8n; Telegram confirms the bot (`@Error0402Bot`) is valid. **Nobody has ever written to it, so there is no chat id**, and `FLOWHQ_TELEGRAM_CHAT_ID` is empty: workflow failures (W11) and the monitor stay silent.
- Owner step (1 minute): open `@Error0402Bot` in Telegram, press Start and send any message (for a group: add the bot and send a message there). Then on the VPS: `cd ~/GKP-Final-Build && ./scripts/4d/98-telegram-chat.sh` (shows the chat found), then `CONFIRM=yes ./scripts/4d/98-telegram-chat.sh` (sets the id, recreates n8n, sends a test message to that chat). It refuses if more than one chat has written.
- Alerts contain the workflow name, the step and a trimmed error, never patient data; W11 sends at most one per 10 minutes.

## 4. Other alert channels: none configured yet
WhatsApp staff alerts are rejected by Meta (templates missing, `docs/activation-status.md`); e-mail alerts (`FLOWHQ_ALERT_EMAIL_TO`, SMTP) are not set. Until a channel is configured, new leads are visible in FLOW HQ > Contacts and the n8n execution list, but nobody is told.
