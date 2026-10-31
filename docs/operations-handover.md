# Operations handover: Geeta Krishna Physiotherapy (1 Nov 2026)

Everything below was checked against production on 31 Oct - 1 Nov 2026. Secrets are never in this repository: they are in `/home/deploy/GKP-Final-Build/.env`, `flowhq/.env`, `flowhq/config/users.json` (all mode 600, git-ignored), in n8n's credential store, and in Vercel (sensitive variable).

## 1. What runs where
| Part | Where | Address | Notes |
|---|---|---|---|
| Public website (form, content) | Vercel project `gkp-final-build`, production branch `main` | https://geetakrishnaphysiotherapy.co.in | env vars: `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET` (sensitive), `N8N_WEBHOOK_AUTH_HEADER`, `CLINIC_SLUG`, `ALLOWED_ORIGINS` |
| Caddy (HTTPS, routing) | VPS container | n8n domain: only `/webhook/*` + `/healthz`; editor only for `ADMIN_ALLOW_CIDR`; `/api/booking/*` is not published | root `Caddyfile` |
| FLOW HQ (staff CRM, Schedule, booking API) | VPS container `flowhq` | https://app.geetakrishnaphysiotherapy.co.in | staff login; booking API only on the private Docker network (`http://flowhq:8787`) |
| n8n (automations) | VPS container `n8n` | webhooks https://n8n.geetakrishnaphysiotherapy.co.in ; editor https://n8n-admin.geetakrishnaphysiotherapy.co.in (admin IP only) | **active workflow: 4D `F4dRetryd0c49396`**; V4 `VaZ0abHwRICrx6C0` kept inactive for rollback |
| Grist (database) | VPS container `grist` | https://crm.geetakrishnaphysiotherapy.co.in (Google sign-in) | clinic document `demo-clinic` (Geeta Krishna Physiotherapy Centre) |
Volumes (never delete): `gkp-final-build_{n8n_data,grist_data,flowhq_config,caddy_data,caddy_config}`.

## 2. Data flow
Website form -> Vercel `/api/enquiry` (validation, rate limit, same-origin, request-id memory) -> n8n `POST /webhook/website-lead` (header `X-Lead-Secret`, credential `FlowHQ W1 Webhook Auth`) -> W1 -> Grist `LEADS` (phone de-duplication) -> FLOW HQ Contacts. WhatsApp: Meta -> n8n `whatsapp-inbound` (signature checked) -> W2 -> W13 (AI) -> FLOW HQ booking API (the only writer of appointments) -> W12 (the only sender; allowlist, quiet hours 21:00-08:00 IST, opt-out, pause, ledger).

## 3. Current switches (all verified)
| Switch | Value | Meaning |
|---|---|---|
| `booking_enabled` (Grist Booking_Config; Schedule page, admin) | OFF | the AI booking switch only; staff can always book, move and cancel |
| `FLOWHQ_AI_EXTERNAL_ENABLED` | true | AI provider reachable, but only for the allowlisted number (see next row) |
| `FLOWHQ_WA_SEND_MODE` / `FLOWHQ_WA_ALLOWLIST` | allowlist / the authorized test number only | nothing reaches any other number; non-allowlisted messages are not sent to the AI |
| Grist Settings `TEST_MODE` / `TEST_PHONE` | TRUE / the authorized test number | every outgoing message is redirected to the test number |
| `FLOWHQ_AI_MAX_REPLIES_PER_HOUR` | 12 | |
| `FLOWHQ_W2_IMPLIED_CONSENT` | true | an inbound message permits REPLIES; it never grants reminder consent |
| `Reminder_Consent` | empty | no reminder can be sent: nobody has explicit, evidenced consent |
Settings corrected on 1 Nov from verified information: `clinic_name` = Geeta Krishna Physiotherapy Centre, `booking_link` = https://geetakrishnaphysiotherapy.co.in/#book, `review_link` = empty (no verified review link: review requests are not sent). Not changed because no verified value exists: `owner_phone`, `staff_alert_phones` (still a placeholder ending 9999).

## 4. Everyday operations
- **Health:** `https://app.../api/health` must show `"ok":true` and `"audit_outbox":"ok"` (a red banner appears in Schedule if the audit log has a problem); `https://n8n.../healthz` must say `ok`. On the server: `./scripts/4d/00-preflight.sh` (read-only) and `./scripts/4d/80-verify.sh` (read-only integration check).
- **Staff:** log in to FLOW HQ; Schedule > New appointment, move, cancel; Doctors & hours; History (admin). Add logins in `flowhq/config/users.json` (`role: staff`; a doctor login also needs `clinician` and `doctorId`) then restart FLOW HQ.
- **Stop the AI quickly:** Schedule > AI booking OFF (admin); `CONFIRM=yes ./scripts/4d/95-ai-external.sh off` (no data to the AI provider); the full ladder is in `docs/runbooks.md` section 6.
- **Rollback of the n8n cutover:** `CONFIRM=yes ./scripts/4d/90-rollback.sh` (V4 back, 4D off, `.env` restored, token revoked).

## 5. Backups
| What | How | State |
|---|---|---|
| Full encrypted backup (n8n, Grist, FLOW HQ volumes, env files, workflow export) | `CONFIRM=yes ./scripts/4d/10-backup.sh` (about 1 minute of downtime) or `./scripts/backup.sh` | latest `~/backups/4d-cutover-20261101-003743/`; checksums verified; restore test of the archive contents done |
| Encrypted Grist documents, no downtime | `95-ai-external.sh` takes one before it changes anything | `~/backups/pre-ai-20261101-000344/` |
| **Nightly schedule** | **NOT INSTALLED** (the permission system refused a cron job on the server): run once `cd ~/GKP-Final-Build && ./scripts/install-cron.sh` (02:30 daily, keeps 14 days) | **owner action** |
| Off-server copy | copy the newest `~/backups/4d-cutover-*` folder to another machine (`scp -r deploy@201.18.202.128:backups/<folder> .`) and compare with `SHA256SUMS` | a copy of the 23:14 backup is on the admin PC; the 00:37 copy was started |
Restore: `docs/runbooks.md` section 3 and `scripts/restore.sh <archive> [--with-config]`. The passphrase is `BACKUP_PASSPHRASE` in `.env`: keep a copy OFF the server.

## 6. Security controls verified
SSH key only (no passwords, no root), firewall allows 22/80/443 only, fail2ban and unattended upgrades active; n8n editor limited to `ADMIN_ALLOW_CIDR` (a changing home IP needs `./scripts/allow-admin-ip.sh`); `/rest/*` and `/webhook-test/*` not public; the booking API is not published and needs a scoped token (six scopes, 90 days, id `n8n-whatsapp`, rotate with `docs/runbooks.md` section 7); signed-out access to every staff route is 401; website webhook secret is a dedicated credential, not an AI key. `~/.4d-secrets/` still holds the booking token and the website secret: after the owner's sign-off run `shred -u ~/.4d-secrets/*`.

## 7. Remaining external dependencies (what only the owner can supply)
1. Switch `booking_enabled` ON in Schedule (admin), then run `CONFIRM=yes ./scripts/4d/97-ai-booking-api-test.sh` (synthetic appointment, proven on staging) and the supervised WhatsApp test (`docs/activation-status.md`).
2. The real `owner_phone` / `staff_alert_phones` (a WhatsApp number that should receive staff alerts) and confirmation that the Meta templates `new_lead_staff_alert` and `human_handoff_alert` are approved.
3. The registration form and the Meta-approved reminder/confirmation templates (names, language, status): reminders stay off until explicit, evidenced consent exists for a patient.
4. A Google review link (or Place ID) if review requests are wanted.
5. `FLOWHQ_CAL_WEBHOOK_SECRET` (W4 cannot verify Cal.com events without it) before Cal.com is retired.
6. Staff logins, the nightly backup cron, an uptime monitor on `/api/health` and `/healthz`, and a Telegram chat id (`FLOWHQ_TELEGRAM_CHAT_ID`) so n8n failure alerts (W11) reach someone.
7. The go-live decision for real patients (`FLOWHQ_WA_SEND_MODE=live`, `TEST_MODE=FALSE`): not done; see `docs/activation-status.md`.
