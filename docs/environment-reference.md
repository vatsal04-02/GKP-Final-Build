# Environment reference: every variable, credential, domain, service and command

Names and meanings only. **No value is recorded here and none should be pasted into a chat, ticket or commit.** Real values live in the server's `.env` files (mode 600), in n8n credentials, and in the Grist user's API key.

## 1. Domains and DNS (A records to the server's IP, before the first start)
| Variable | Purpose | Public? |
|---|---|---|
| `N8N_DOMAIN` | n8n webhooks (Meta, Cal.com, the website form) | yes, but the root `Caddyfile` publishes **only `/webhook/*` and `/healthz`** |
| `N8N_ADMIN_DOMAIN` (root `Caddyfile`) | the n8n editor / REST API | no: `ADMIN_ALLOW_CIDR` only |
| `ADMIN_ALLOW_CIDR` (new) | who may open the editor, e.g. `203.0.113.7/32` (several separated by spaces) | n/a |
| `GRIST_DOMAIN` | the CRM tables (Google sign-in) | yes (Grist's own login) |
| `FLOWHQ_DOMAIN` | the FLOW HQ web app | yes (login); `/api/booking/*` is answered 404 by the root `Caddyfile` |
| `ACME_EMAIL` | Let's Encrypt notices | n/a |

## 2. Services and versions
| Service | Image / version | Persistent volume | Notes |
|---|---|---|---|
| Caddy | `caddy:2` | `caddy_data`, `caddy_config` | the only service with published ports (80, 443) |
| n8n | `docker.n8n.io/n8nio/n8n:${N8N_VERSION}` (compose default 2.41.6; staging used 2.43.5) | `n8n_data` | pin the version; test the 4C file on the version you run |
| Grist | `gristlabs/grist:${GRIST_VERSION}` (default **1.7.20**, the version staging ran) | `grist_data` | |
| FLOW HQ | built from `flowhq/Dockerfile` (Node 20 alpine, user `node`) | **`flowhq_config` (mandatory)** | exactly ONE instance; `stop_grace_period: 30s` |

## 3. FLOW HQ server (`flowhq/.env`, read by `loadConfig`)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8787 | listen port (inside the container) |
| `FLOWHQ_DEMO` | false | sample data; **never true in production** |
| `GRIST_BASE_URL` | (required) | `http://grist:8484` inside the stack |
| `GRIST_API_KEY` | (required, secret) | a dedicated Grist user's key |
| `GRIST_REGISTRY_DOC_ID` | (required) | the Agency Registry document |
| `GRIST_LEADS_TABLE` | LEADS | |
| `FLOWHQ_SESSION_SECRET` | (required, secret, 32+ chars) | cookie signing |
| `FLOWHQ_SECURE_COOKIES` | true outside demo | keep true behind HTTPS |
| `FLOWHQ_USERS_FILE` / `FLOWHQ_USERS` | `config/users.json` | staff logins: password hashes, `role`, `doctorId`, `grants` (`consent:write`) |
| `FLOWHQ_WORKSPACES_FILE`, `FLOWHQ_CLINIC_FILE`, `FLOWHQ_STATIC_DIR`, `FLOWHQ_SNIPPETS_DIR` | image defaults | paths |
| `FLOWHQ_TIMEZONE`, `FLOWHQ_LOCALE`, `FLOWHQ_CURRENCY`, `FLOWHQ_DEFAULT_INDUSTRY` | Asia/Kolkata, en-IN, INR, clinic | |
| `FLOWHQ_TRUST_PROXY` | true | false if FLOW HQ is ever reachable without Caddy |
| `FLOWHQ_AUDIT_OUTBOX_DIR` | `config/audit-outbox` | on the volume |
| `FLOWHQ_AUDIT_REQUIRE_VOLUME` | true (image, Linux, production) | refuse an outbox on the container layer |
| `FLOWHQ_AUDIT_BREAKGLASS` | false | emergency only |
| `FLOWHQ_BOOKING_TOKENS_FILE` / `FLOWHQ_BOOKING_TOKENS` | `config/booking-tokens.json` | hashes of the n8n service tokens |
| `NODE_ENV` | production (image) | |

## 4. n8n container (`docker-compose.yml` passes these; read in workflows as `$env.FLOWHQ_*`)
`N8N_ENCRYPTION_KEY` (secret), `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (required by the workflows), `GENERIC_TIMEZONE`/`TZ`, `WEBHOOK_URL`, plus:
| Variable | Default | Purpose |
|---|---|---|
| `FLOWHQ_GRIST_URL`, `FLOWHQ_REGISTRY_DOC_ID`, `FLOWHQ_DEFAULT_COUNTRY_CODE` | grist:8484, -, 91 | |
| `FLOWHQ_WA_SEND_MODE` | allowlist | `off` / `allowlist` / `live` |
| `FLOWHQ_WA_ALLOWLIST` | empty | numbers that may receive a send while in `allowlist` |
| `FLOWHQ_WA_GRAPH_VERSION`, `FLOWHQ_WA_TEMPLATE_LANGUAGE`, `FLOWHQ_WA_ALLOW_HELLO_WORLD`, `FLOWHQ_WA_GRAPH_BASE_URL` | v23.0, en, false, graph.facebook.com | the last is for tests only |
| `FLOWHQ_META_APP_SECRET`, `FLOWHQ_META_VERIFY_TOKEN` | (secret) | WhatsApp webhook signature and handshake |
| `FLOWHQ_W1_REQUIRE_CONSENT`, `FLOWHQ_W2_IMPLIED_CONSENT` | true, true | website form / first-message consent capture (**not reminder consent**) |
| `FLOWHQ_CAL_WEBHOOK_SECRET`, `FLOWHQ_CAL_MAX_AGE_HOURS` | (secret), 24 | W4 (Cal.com) until the cut-over is complete |
| `FLOWHQ_TELEGRAM_CHAT_ID`, `FLOWHQ_TEST_PHONE`, `FLOWHQ_ALERT_EMAIL_TO`, `FLOWHQ_EMAIL_FROM`, `FLOWHQ_EMAIL_PATIENT_ACK` | | alerts and test routing |
| `FLOWHQ_AI_EXTERNAL_ENABLED` | false | the one switch for sending text to the AI provider |
| `FLOWHQ_AI_MODEL` | openai/gpt-4o-mini | |
| `FLOWHQ_AI_MAX_REPLIES_PER_HOUR` | 6 | **set 12 before AI booking** (two replies per booking action) |
| **`FLOWHQ_BOOKING_API_URL`** (new) | empty | `http://flowhq:8787` (private network). Empty = W13 books nothing |

## 5. n8n credentials (names are what the workflows reference)
| Credential | Type | Holds | Used by |
|---|---|---|---|
| clinic's existing Grist credential (`Header Auth account 2` in the candidate) | Header Auth | `Authorization: Bearer <Grist API key>` | all Grist reads / writes (131 nodes, one role) |
| `WhatsApp Cloud API` | Header Auth | `Authorization: Bearer <Meta system-user token>` | W12 "Meta send" only |
| `OpenRouter API` | Header Auth | provider key | W13 / W9 "Ask Model" only |
| `FlowHQ W1 Webhook Auth` | Header Auth | `X-Lead-Secret` | website form webhook |
| `Telegram account`, `SMTP account` | | alert transport | W11, W1 |
| **`FlowHQ Booking API`** (new, id `FhqCredBooking01`) | Header Auth | `Authorization: Bearer <id>.<secret>` from `booking-token` | W13 "Booking availability" and "Booking API" only (audited: exactly one role, two nodes) |
Create the new one in the n8n UI, or `FLOWHQ_BOOKING_API_TOKEN=… node n8n/production/scripts/create-credentials.js --only FhqCredBooking01 --out … --import …` (it deletes its file after import and never prints the value). Importing the 4C workflow requires **re-linking** credentials in the UI.

## 6. External accounts and dependencies
Meta WhatsApp Business (phone number id, system-user token, app secret, **approved templates** listed in `n8n/whatsapp-templates.md`; `booking_confirmation`, `reminder_24h`, `reminder_2h`, `followup_reminder` and the engagement templates) · Google Cloud OAuth client (Grist sign-in) · OpenRouter account (AI) · Cal.com (until cut-over) · a DNS provider · the VPS (Hetzner Ubuntu 24.04, Docker Compose) · Telegram bot / SMTP (alerts).

## 7. Commands (production container; none was run against production by this work)
| Task | Command |
|---|---|
| Show what provisioning would change (read-only) | `docker compose exec flowhq node dist/tools/provision-booking.mjs <clinic-slug>` |
| Provision the booking tables and seed (additive; AI booking stays OFF) | `docker compose exec flowhq node dist/tools/provision-booking.mjs <clinic-slug> --apply --seed` |
| Create the Clinic Records tables (earlier slice; Patients etc.) | `docker compose exec flowhq node dist/tools/provision-records.mjs <clinic-slug>` (dry run) then `--apply` |
| Make an n8n service token (shown once, hash stored) | `docker compose exec flowhq node dist/tools/booking-token.mjs n8n-whatsapp <clinic-slug> --days 90 --write` then `docker compose restart flowhq` |
| Revoke a token | `docker compose exec flowhq node dist/tools/booking-token.mjs revoke <token-id>` then `docker compose restart flowhq` |
| Audit outbox checks | `docker compose exec flowhq node dist/tools/audit-outbox.mjs status config/audit-outbox` (also `verify`, `canary`, `selftest`) |
| Hash a staff password | `npm run hash-password -- "<password>"` (checkout) |
| Migrate Grist for the n8n workflows (Send_Ledger, consent columns) | `node n8n/production/scripts/migrate-grist.js --doc <docId>` (dry run) then `--apply` |
| Read-only n8n export + sanitize + diff | `docs/n8n-deployed-export-procedure.md` |
| Health (public) | `curl https://<FLOWHQ_DOMAIN>/api/health` → `{"ok":true,…,"audit_outbox":"ok"}` |
