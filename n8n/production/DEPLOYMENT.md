# DEPLOYMENT

Everything below runs from `n8n/production/` on the server. **Do not activate the workflow, do not set `FLOWHQ_WA_SEND_MODE=live` and do not set `TEST_MODE=false` until the go-live checklist at the end is complete.** Nothing in this package has been run against Meta, a real Grist or a real server (see TEST_REPORT.md "Not tested"): the first deployment is a rehearsal, treat it as one.

## 0. What you need

| Item | Notes |
|---|---|
| A server | Ubuntu 24.04, Docker + the compose plugin, 2 vCPU / 4 GB RAM is comfortable (n8n limit 1.5 GB, Grist 1 GB). See "Cost" below. |
| Two or three DNS names | `N8N_DOMAIN` (public webhooks), `N8N_ADMIN_DOMAIN` (editor, IP-restricted), `GRIST_DOMAIN` (CRM). A records to the server. |
| Meta | a WhatsApp Business Account, a phone number per clinic, a Meta app (App secret), a permanent **System User** token with `whatsapp_business_messaging`, **approved templates** (templates/whatsapp-templates.md) |
| Grist | one Agency Registry document (table `Clinics`) and one document per clinic (grist/schema.md), plus a service user's API key |
| Cal.com | a webhook (secret, three events) and a required phone question |
| Optional | Telegram bot (error alerts), an SMTP account (staff e-mail), an AI provider (leave off) |

## 1. Server

```bash
git clone <repo> && cd <repo>/n8n/production      # or copy the folder
cp .env.example .env && chmod 600 .env            # fill in EVERY CHANGE_ME (never commit it)
scripts/init-secrets.sh                           # creates secrets/n8n_encryption_key and data/ (never overwrites). BACK THE KEY UP, separately.
node scripts/preflight.js                         # must print no FAIL
```
Firewall: allow 22 (your IP), 80, 443 only. The n8n and Grist containers publish nothing.

## 2. Start the stack (workflow still not imported)

```bash
docker compose -f ops/docker-compose.production.yml --env-file .env up -d
docker compose -f ops/docker-compose.production.yml --env-file .env ps       # n8n, grist: healthy
scripts/healthcheck.sh                                                         # public /healthz ok, editor and test webhooks NOT public
```
Open `https://$N8N_ADMIN_DOMAIN` from an allowed address and create the n8n owner account. Open Grist, sign in, create the Registry and the clinic documents, and create the API key (profile → API) for a dedicated service user.

## 3. Grist: schema and clinic rows

1. Registry `Clinics` row per clinic: see `config/clinic.example.json` (`WA_Phone_Number_ID` is that clinic's own Meta phone-number id; `Active` true).
2. In the clinic document create the tables of `grist/schema.md` (LEADS is the live name of Leads).
3. Add what this release needs (dry run first, then apply):
```bash
node scripts/migrate-grist.js --env-file .env --check          # shows what the existing schema lacks
node scripts/migrate-grist.js --env-file .env                  # dry run: Send_Ledger + Email / Consent_* columns
node scripts/migrate-grist.js --env-file .env --apply
```
Grist is private (no published port), so run the script from a machine that can reach it: point it at the public CRM address, which accepts the API key as a Bearer token: `--grist-url https://$GRIST_DOMAIN` (the script also reads `FLOWHQ_GRIST_URL_ADMIN`). `FLOWHQ_GRIST_API_KEY` and `FLOWHQ_REGISTRY_DOC_ID` come from `.env` (`--env-file .env`). The script never deletes or overwrites anything; a second run says "nothing to do".
4. Settings table per clinic: `owner_phone`, `clinic_name`, `TEST_MODE=true`, `TEST_PHONE`, `booking_link`, hours (config/clinic.example.json).
5. Existing patients: decide the consent question (PRIVACY.md) before go-live.

## 4. Credentials and workflow (inactive)

```bash
node scripts/create-credentials.js --dry-run --env-file .env       # which are ready / missing; no value is printed
C="docker compose -f ops/docker-compose.production.yml --env-file .env"
node scripts/create-credentials.js --env-file .env --out credentials.import.local.json \
  --import "$C cp %FILE% n8n:/tmp/c.json && $C exec -T n8n n8n import:credentials --input=/tmp/c.json && $C exec -T n8n rm -f /tmp/c.json"
scripts/import-workflow.sh                                          # imports clinic-autopilot-production.json: INACTIVE, own id FhqClinicProd001
```
The credential file is overwritten and deleted by the script even when the import fails. Credentials are named exactly as the workflow expects: FlowHQ Grist API, FlowHQ W1 Webhook Auth, FlowHQ WhatsApp Cloud API, FlowHQ AI Provider (optional), FlowHQ Telegram Alerts, FlowHQ SMTP (optional).

## 5. Meta, Cal.com, website

* **Templates**: create and get approved every template in `templates/whatsapp-templates.md`. Until then W3 / W5 / W6 / W4 log "rejected (template not found, 132001)" and nothing reaches patients.
* **Meta webhook**: callback URL `https://<N8N_DOMAIN>/webhook/whatsapp-inbound`, verify token = `FLOWHQ_META_VERIFY_TOKEN`, subscribe to `messages`. The workflow must be active for Meta's verification (step 7): use staging first.
* **Cal.com webhook**: `https://<N8N_DOMAIN>/webhook/cal?clinic=<Clinic_Slug>`, secret = `FLOWHQ_CAL_WEBHOOK_SECRET`; add the consent sentence and a required phone question to the event type.
* **Website form**: POST JSON to `/webhook/website-lead` with header `X-Lead-Secret` (the value of `FLOWHQ_W1_WEBHOOK_SECRET`) and the fields in `config/clinic.example.json` (consent checkbox required). The secret must live on **your server side** (the form's backend route), never in browser code.

## 6. Staging rehearsal (do this first, on your laptop or a second server)

```bash
cp .env.example .env.staging   # staging values; FLOWHQ_SMTP_HOST=mailpit FLOWHQ_SMTP_PORT=1025
scripts/init-secrets.sh --staging
docker compose -f ops/docker-compose.staging.yml --env-file .env.staging up -d      # n8n :5678, Grist :8484, Mailpit UI :8025 (127.0.0.1 only)
```
Import the credentials and workflow as above, activate, then: send a website enquiry (Mailpit shows the staff e-mail; the WhatsApp alert goes to the allowlisted number only), a signed Meta test message, a Cal.com test booking. Check Grist: LEADS (with consent columns), Send_Ledger (`accepted`), Run_Log (honest outcomes). Delivery statuses should move the ledger to `delivered` / `read`.

## 7. Activation (production)

1. `node scripts/preflight.js --online --grist-url https://$GRIST_DOMAIN` → no FAIL (it reads each clinic document and reports missing tables / columns).
2. Keep `FLOWHQ_WA_SEND_MODE=allowlist`, `TEST_MODE=true`. Activate the workflow in the editor (or `n8n publish:workflow --id=FhqClinicProd001` and restart n8n).
3. Run the rehearsal of step 6 against production with your own phone numbers in the allowlist.
4. Watch Run_Log, Send_Ledger, Telegram for a day.

## Go-live checklist (all must be true)

- [ ] Templates approved in Meta for every clinic number; wording signed off by the clinic.
- [ ] Consent wording on the website form and the Cal.com page; existing-patient consent decided.
- [ ] `scripts/preflight.js --online` has no FAIL; `scripts/healthcheck.sh` is healthy; the editor is not reachable from the public host.
- [ ] A backup was made **and restored once** on a spare machine (OPERATIONS.md).
- [ ] The n8n encryption key and the backup passphrase are stored outside the server.
- [ ] Telegram alerts tested (a deliberate failure arrives).
- [ ] Meta app secret, verify token, Cal secret, Grist API key, WhatsApp token rotated if they were ever pasted anywhere else.
- [ ] A 48-hour allowlist run: the owner received the staff alerts, the delivery statuses reached Send_Ledger, no `uncertain` row without an explanation.
- [ ] Then, per clinic and one at a time: `TEST_MODE=false` in that clinic's Settings, and `FLOWHQ_WA_SEND_MODE=live`. Watch the first day.
- [ ] External AI stays **off** unless PRIVACY.md section "External AI" is done.

## Cost (honest)

* **Server.** Hetzner Cloud prices were raised in 2026 and sources disagree on the current figure; the most recent comparison found (August 2026, excluding VAT) lists the 2 vCPU / 4 GB shared plans (CX23, ARM CAX11) at roughly **€5.5–6.5 per month including an IPv4 address** ([comparison](https://kimmo.suominen.com/stuff/cpc-2026-08.txt), [June 2026 report](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do)). At about ₹100 per euro that is **₹550–700 plus VAT** for the server alone, plus roughly 20 % for Hetzner's automatic backups, plus a domain. **A budget of ₹500 per month does not cover a server that runs n8n + Grist + Caddy with backups.** Verify on hetzner.com/cloud before quoting a client; a 1 vCPU / 2 GB server would be cheaper but n8n (1.5 GB limit) and Grist together will swap.
* **WhatsApp.** Meta charges per delivered template message, by category and country; third-party sources put India utility at about ₹0.115 and marketing at about ₹0.86–0.78 per message before GST, and say free-text replies inside the 24-hour window are free ([overview](https://baat.ai/blog/whatsapp-api-pricing-india)). These are third-party figures: read your own rate card in Meta Business Manager.
* **AI (optional).** Per-message provider fees; off by default.
* **Not included:** your time, a monitoring service, a second server for staging (the staging compose runs on a laptop).

## Upgrade, rollback

See OPERATIONS.md. Never switch `N8N_VERSION` without re-running `tests/`, and never overwrite the live workflow: the export has its own id and is imported inactive.
