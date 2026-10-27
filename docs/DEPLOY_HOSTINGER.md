# Deploy the backend on a Hostinger VPS (the website stays on Vercel)

The server runs only the **backend**: n8n (automations), Grist (the CRM database), FlowHQ (the staff app) and Caddy (HTTPS). The clinic website stays on Vercel and talks to n8n through the booking form. These steps were written for a **Hostinger KVM 2** (2 vCPU, 8 GB RAM, 100 GB) with plain **Ubuntu 24.04**, but any VPS with root SSH works.

```
visitor ── website (Vercel) ── POST /api/enquiry ──► https://n8n.<domain>/webhook/website-lead ─┐
WhatsApp (Meta) ────────────────────────────────────► https://n8n.<domain>/webhook/...         ├─► n8n ─► Grist
staff ── https://app.<domain>  (FlowHQ) ─────────────────────────────────────────────────────┘          ▲
you ──── https://n8n-admin.<domain> (n8n editor, only from your IP) ─────────────────────────────────────┘
you/staff ── https://crm.<domain> (Grist, Google sign-in)
```

**Status:** the pieces are tested separately (workflow simulator, FlowHQ, website). This stack has **not** been started on a real server yet, so treat the first run as a rehearsal: keep `FLOWHQ_WA_SEND_MODE=off` and `FLOWHQ_AI_EXTERNAL_ENABLED=false` until `docs/PRODUCTION_CHECKLIST.md` is done.

## 0. What you need first
| Thing | Notes |
|---|---|
| A domain name | About ₹700–1,200 a year. HTTPS certificates cannot be issued without one. |
| **Four DNS A records** → the server's IP | `n8n.`, `n8n-admin.`, `crm.`, `app.` (for example `n8n.yourclinic.in`). Check from your PC: `nslookup n8n.yourclinic.in` |
| A Google OAuth client (free, no billing) | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web). Authorised redirect URI: `https://crm.yourclinic.in/oauth2/callback`. It signs people in to Grist. |
| Your SSH key on the server | Added when the VPS was created. |

## 1. Secure the server (about 5 minutes)
From PowerShell on your PC, in the repo folder:
```powershell
scp scripts/setup-server.sh root@<server-ip>:/root/
ssh root@<server-ip>
bash setup-server.sh
```
It updates the system, creates the `deploy` user with your key, turns off password and root login, opens only ports 22/80/443, installs fail2ban and automatic security updates, adds 2 GB of swap, sets the timezone and installs Docker. It prints the SSH settings it ended up with. **Before closing that window, open a second terminal and check `ssh deploy@<server-ip>` works.** From now on always use `deploy`.

## 2. Put the code on the server
The repo is private, so give the server a read-only **deploy key**:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/gkp_deploy -N ""
cat ~/.ssh/gkp_deploy.pub            # copy this line
```
GitHub → the repository → Settings → Deploy keys → Add deploy key (leave "Allow write access" off). Then:
```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/gkp_deploy\n' >> ~/.ssh/config
git clone git@github.com:vatsal04-02/GKP-Final-Build.git
cd GKP-Final-Build
```

## 3. Configure
```bash
cp .env.example .env && chmod 600 .env
./scripts/gen-secrets.sh             # fills N8N_ENCRYPTION_KEY and GRIST_SESSION_SECRET
nano .env
```
Fill in the four domains, `ACME_EMAIL`, `GRIST_ADMIN_EMAIL` (the Google account that administers Grist), `GRIST_TEAM_NAME`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BACKUP_PASSPHRASE` (a long passphrase). **Save `N8N_ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` in your password manager now:** if the encryption key is lost, every credential stored in n8n becomes unreadable, and without the passphrase a backup cannot be opened. Leave the `FLOWHQ_*` safe defaults.

## 4. First start
```bash
./scripts/deploy.sh --check          # changes nothing; lists everything that is wrong
./scripts/deploy.sh                  # starts n8n + Grist (+ FlowHQ once configured) and waits until they are healthy
./scripts/allow-admin-ip.sh          # lets the address you are connected from open the n8n editor
```
`deploy.sh` refuses to start while a setting is still a placeholder, a domain does not yet point at the server, or the Caddy / compose files do not validate. The first visit to each address takes a minute while its certificate is issued. `https://n8n.<domain>/healthz` should answer `ok`.

## 5. Grist (the CRM)
Open `https://crm.<domain>` and sign in with the `GRIST_ADMIN_EMAIL` account. Create the Agency Registry and the clinic document, or upload your existing ones (download each as `.grist` from the old Grist, then import here). The schema is in `grist/schema.md`; `docs/INSTALL.md` §3 verifies the tables. Then create an API key (profile → API) for FlowHQ.

## 6. n8n (the automations)
Open `https://n8n-admin.<domain>`, create the owner account, then follow `docs/INSTALL.md` §4–5: create the three credentials (Grist API key, the website-webhook secret, OpenRouter if you use AI) and **import** `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`. **Do not activate it yet.**

## 7. FlowHQ (the staff app)
```bash
cp flowhq/.env.example flowhq/.env && chmod 600 flowhq/.env
nano flowhq/.env      # GRIST_API_KEY, GRIST_REGISTRY_DOC_ID, FLOWHQ_SESSION_SECRET (from: openssl rand -base64 48)
```
Make the staff logins **on your PC** (it needs Node): `cd flowhq`, `npm ci`, `npm run hash-password -- "a long password"`. Put the result into `flowhq/config/users.json` on the server (shape: `flowhq/config/users.example.json`), then run `./scripts/deploy.sh` again. Sign in at `https://app.<domain>`.

## 8. Connect the website (still on Vercel)
Vercel → the project → Settings → Environment Variables: `N8N_WEBHOOK_URL` (for the first test the **test** address `https://n8n.<domain>/webhook-test/website-lead`), `N8N_WEBHOOK_SECRET`, `CLINIC_SLUG`; redeploy.

The public address deliberately serves **production** webhooks only, so for this one controlled test open the test path for a short while: on the server set `N8N_EXTRA_WEBHOOK_PATH=/webhook-test/*` in `.env`, run `docker compose up -d caddy`, put the workflow's webhook node in "Listen for test event" in the editor, and send one fake enquiry from the website; check it lands in Grist. **Then empty `N8N_EXTRA_WEBHOOK_PATH` again**, run `docker compose up -d caddy`, switch Vercel to `https://n8n.<domain>/webhook/website-lead` and activate the workflow, following `docs/PRODUCTION_CHECKLIST.md`. (`deploy.sh` warns while the test path is open.)

## 9. Backups (do this before real patient data)
```bash
./scripts/backup.sh                  # try one now
./scripts/install-cron.sh            # then every night at 02:30
```
Archives are AES-256 encrypted and kept 14 days in `backups/`. **They sit on the same disk**, so copy them off the server: from your PC, `scp deploy@<server-ip>:GKP-Final-Build/backups/*.enc .` (or schedule that in Windows Task Scheduler). Also take a Hostinger snapshot after each big change. **Test a restore** once on a spare server (`./scripts/restore.sh <archive>`); an untested backup is a hope, not a backup.

## 10. Updating and going back
```bash
cd ~/GKP-Final-Build && git pull && ./scripts/deploy.sh    # update; also re-checks everything
docker compose logs --tail 100 n8n                          # when something misbehaves (also: grist, caddy, flowhq)
./scripts/allow-admin-ip.sh                                 # the editor says 403 after your home IP changed
```
`docs/ROLLBACK.md` covers going back to a previous workflow.

## What the setup protects
- Only Caddy faces the internet. The public n8n address serves **webhooks only**; the editor, its API and test webhooks are limited to your IP. Grist needs Google sign-in; FlowHQ needs its own login.
- n8n keeps only **failed** executions, for 7 days (successful runs hold patient phone numbers and messages and are not stored). Shell and file nodes are switched off.
- Logs rotate (10 MB × 5 per container). Containers have memory caps (n8n 2 GB, Grist 1 GB, FlowHQ 512 MB).
- Passwords and root login are off for SSH; fail2ban, a firewall and automatic security updates are on.

## Known limits (honest list)
- **Not run on a real server yet.** `docker compose config` passes for the files here, and the scripts' checks and encryption were exercised without Docker, but the images were not started and the Caddyfile is validated only by `deploy.sh` on the server.
- **Grist's formula sandbox** uses `gvisor`. If formulas fail on this host, set `GRIST_SANDBOX_FLAVOR=unsandboxed` in `.env` (and see the comment in `docker-compose.yml`).
- **One clinic's worth of capacity.** KVM 2 has plenty of room, but nothing here is tuned for many clinics.
- **IPv4 only** for the editor allow-list. Your IP address changes sometimes: re-run `allow-admin-ip.sh`.
- **WhatsApp (Meta) setup, SMTP and the message templates** are outside this guide: see `docs/PRODUCTION_CHECKLIST.md` and `n8n/production/` for the template list.

## When something is wrong
| Symptom | Check |
|---|---|
| `deploy.sh` says a domain "resolves to nothing" | The DNS record is missing or still spreading (minutes to hours). Check `nslookup`. |
| Browser warns about the certificate | The domain did not point at the server when Caddy first tried. Fix DNS, then `docker compose restart caddy` and wait a minute. |
| n8n editor says 403 | Your IP changed: `./scripts/allow-admin-ip.sh` on the server. |
| FlowHQ login page loops or fails | `flowhq/config/users.json` must be a file (not a directory), and `FLOWHQ_SECURE_COOKIES=true` needs the HTTPS address. |
| n8n restarts or is killed | `docker compose logs n8n`; check memory with `free -h` and that swap is on. |
| Disk filling up | `df -h`; `docker system df`; old backups: lower `BACKUP_KEEP_DAYS`. |
