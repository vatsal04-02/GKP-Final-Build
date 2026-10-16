# INSTALL AND SET-UP

Nothing below was executed against your live systems. Every step that touches live systems is marked **[LIVE]** and must be done by you, deliberately, in the order given. Steps without that mark can be run on any laptop.

## 0. Requirements
Git, Node.js ≥ 20 and npm. For the optional real-n8n tests: n8n 2.43.x installed in a folder (`N8N_RUNTIME_DIR`), a Node ≥ 24 (`N8N_NODE_DIR`), the `mailpit` binary, libfaketime. For the browser test: Playwright with Chromium.

## 1. The website (`apps/clinic-website`)
```bash
cd apps/clinic-website
npm ci
npm run dev                    # http://localhost:4321
npm run build                  # static site in dist/ (needs no environment variables)
npm run check                  # type check (0 errors expected)
npm test                       # 18 tests of api/enquiry.mjs and the shared rules (fake n8n, no network)
PLAYWRIGHT_MODULE=<path>/node_modules/playwright CHROMIUM=<chrome binary> node tests/e2e/booking-browser.mjs   # optional: 11 checks in a real browser
```
There is no linter configured in the website project.

### 1a. Run the form locally against a fake n8n (no live system)
`npm run dev` serves the page, but `/api/enquiry` is a Vercel Function: without Vercel it is not served by Astro. To exercise the whole form locally use the browser test above (it serves `dist/` and routes `/api/enquiry` to the real function with a fake n8n), or install the Vercel CLI and run `vercel dev` with the variables below pointing at a **fake** URL.

### 1b. Vercel server-side environment variables **[LIVE]**
Vercel → Project → Settings → Environment Variables. **Never** give these a `PUBLIC_` prefix (that would ship them to the browser).

| Variable | Value |
|---|---|
| `N8N_WEBHOOK_URL` | start with the n8n **test** URL `https://<n8n-host>/webhook-test/website-lead`; change to `…/webhook/website-lead` only at go-live |
| `N8N_WEBHOOK_SECRET` | the value n8n's header-auth credential for that webhook expects (a **website webhook secret**, see `docs/CREDENTIAL_AUDIT.md`: never an AI key) |
| `N8N_WEBHOOK_AUTH_HEADER` | that credential's header **name** (default `X-Lead-Secret`) |
| `CLINIC_SLUG` | the `Clinic_Slug` of this clinic in the Agency Registry's `Clinics` table (**not known from the files; set it only after reading it there**) |
| `ALLOWED_ORIGINS` | optional, e.g. `https://physio-two-umber.vercel.app` (default: the request's own host) |
| `N8N_TIMEOUT_MS` | optional, default 8000 |

Use a **Preview** deployment for the first test. Without these variables the form shows "we couldn't send your request" and offers WhatsApp and the phone number: nothing is lost silently.

## 2. Server stack (Caddy → n8n + Grist) **[LIVE]**
`docker-compose.yml` (production, with Caddy), `docker-compose.nodomain.yml` (Tailscale), `docker-compose.local.yml` (Cloudflare tunnel). Start from `.env.example` (`cp .env.example .env`, `chmod 600 .env`, then `./scripts/gen-secrets.sh` for the encryption key and session secret). **Never change `N8N_ENCRYPTION_KEY` on an existing install** (every stored credential becomes unreadable) and keep the `n8n_data` and `grist_data` volumes.
`docker-compose.yml` sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (the workflow reads `$env.FLOWHQ_*`) and passes the `FLOWHQ_*` variables from `.env` to n8n. Fill them from `config/env/n8n-flowhq.env.example`; leave the safe defaults (`FLOWHQ_WA_SEND_MODE=off`, `FLOWHQ_ALERT_EMAIL_TO` empty, `FLOWHQ_AI_EXTERNAL_ENABLED=false`) until the checklist is done. After editing `.env`:
```bash
docker compose config -q && echo ok
docker compose up -d n8n                       # recreates only n8n; volumes are kept
docker compose exec n8n sh -c 'printenv | grep -c ^FLOWHQ_'     # 22 expected
docker compose exec n8n printenv N8N_BLOCK_ENV_ACCESS_IN_NODE    # false
```
The editor's expression preview shows `[not accessible via UI, please run node]` for `$env`: that is only the browser preview; values resolve when a node runs.

## 3. Grist: verify the `LEADS` table **[LIVE, read-only until `--apply`]**
Grist is the CRM database; nothing here replaces it. The workflow reads and writes the table **`LEADS`** (the FlowHQ app labels it "Enquiries" for physiotherapy; no table called "Enquiries" exists in the configuration). Verify it in the clinic's own document:
1. In Grist open the clinic document → Raw Data: a table with id `LEADS` must exist with the columns of `grist/schema.md` (`Name`, `Phone`, `Source`, `Status`, `Enquiry`, …).
2. Check programmatically (dry run, changes nothing): `node n8n/production/scripts/migrate-grist.js --env-file .env --check` (needs `FLOWHQ_GRIST_URL` reachable from where you run it, `FLOWHQ_GRIST_API_KEY`, `FLOWHQ_REGISTRY_DOC_ID` in that env file; never commit it).
3. The workflow also needs the table `Send_Ledger` and the `LEADS` columns `Email`, `Email_Opted_Out`, `Consent_WhatsApp`, `Consent_Email`, `Consent_Source`, `Consent_At`, `Consent_Version` (`n8n/production/schema/production-schema.json`). The same script creates what is missing with `--apply` (idempotent, never deletes). Do this only after a Grist backup (`n8n/production/scripts/backup.sh`).
4. Agency Registry (`FLOWHQ_REGISTRY_DOC_ID`), table `Clinics`: one row per clinic with `Clinic_Slug`, `Clinic_Name`, `Grist_Doc_ID`, `WA_Phone_Number_ID`, `Active`. **The `Clinic_Slug` you read there is the value for `CLINIC_SLUG`.**

## 4. n8n: webhook, authentication, credentials **[LIVE]**
* The website webhook is `POST /webhook/website-lead` (workflow W1), `authentication: headerAuth`, `responseMode: responseNode`. n8n compares the request header with the **credential** attached to the `W1 – Webhook` node. The website function sends header name `N8N_WEBHOOK_AUTH_HEADER` with value `N8N_WEBHOOK_SECRET`; both must equal that credential's header name and value.
* n8n registers `/webhook/…` only while the workflow is **active** and `/webhook-test/…` only while the editor is listening ("Listen for test event"). With the workflow active, the test URL answers 404.
* **Three credentials, three roles, never shared.** The selected workflow now assigns them by what each node calls (full table: `docs/OPENROUTER.md`, audit: `docs/CREDENTIAL_AUDIT.md`):

  | Role | n8n credential (type) | Used by | Holds |
  |---|---|---|---|
  | Grist API | `Header Auth account 2` (Header Auth) | every Grist node | `Authorization: Bearer <Grist API key>` |
  | OpenRouter | `OpenRouter API` (Header Auth) | `W13 – Ask Model`, `W9 – Ask Model` only | `Authorization: Bearer <OpenRouter key>` |
  | Website webhook | `FlowHQ W1 Webhook Auth` (Header Auth) | `W1 – Webhook` only | header `X-Lead-Secret` (or `N8N_WEBHOOK_AUTH_HEADER`) = a random secret you generate; the same value is `N8N_WEBHOOK_SECRET` on Vercel |

* **Credentials are matched by id on import.** `OpenRouter API` and `Header Auth account 2` already exist in your instance and re-link on import. `FlowHQ W1 Webhook Auth` (id `FhqCredW1Hook001`) is **new**: create it before activation, either in the UI (Credentials → Header Auth, name exactly `FlowHQ W1 Webhook Auth`; then select it on `W1 – Webhook` if n8n does not re-link by id) or with `node n8n/production/scripts/create-credentials.js --only FhqCredW1Hook001` (reads `FLOWHQ_W1_WEBHOOK_SECRET`, at least 20 characters, from your local environment and prints no values; use the same value as `N8N_WEBHOOK_SECRET` on Vercel). Never reuse the OpenRouter key as the webhook secret: the website function refuses an `sk-or-…` value or one equal to `OPENROUTER_API_KEY`. Check what you have: `node n8n/final/tools/audit-credentials.js --check n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` must print `OK: every credential serves exactly one role`. The assumption that `Header Auth account 2` holds the Grist key and `OpenRouter API` the OpenRouter key could not be verified from the repository (F-GRIST-CRED): open each credential once and confirm. Credential values are never in this repository.
* **External AI (OpenRouter) stays off until you switch it on.** One switch, `FLOWHQ_AI_EXTERNAL_ENABLED` (only `true` enables it), plus `FLOWHQ_AI_MODEL` (`vendor/model`, default `openai/gpt-4o-mini`). With the switch on, a missing or malformed model or a non-OpenRouter `FLOWHQ_AI_BASE_URL` stops W13 and W9 at the config guard instead of calling out. See `docs/OPENROUTER.md`.
* `n8n/production/scripts/create-credentials.js` creates six **new** credentials named `FlowHQ …` for a fresh install (reference export). Do not run it on the existing instance unless you want those extra credentials.

## 5. Import and validate the selected workflow **[LIVE: import only; do not activate]**
1. Export your current workflow from n8n first (backup; see `docs/ROLLBACK.md`).
2. Import `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` through the UI ("Import from file") into a **copy**; the CLI `n8n import:workflow` deactivates what it imports. The file says `active: false`.
3. Validate offline before and after: `node n8n/final/tools/audit-credentials.js <file>`; `node n8n/final/tests/final.test.js`; `node n8n/final/run-tests.js authoritative`.
4. Review `docs/KNOWN_FINDINGS.md`; decide whether to import the **proposed** file instead (`n8n/final/workflows/proposed/…`: the selected workflow plus the W1 race guard).
5. `W12 – Test input` (manual test node) carries fictional values; put a number you own in it **locally** if you use it, never in git.

## 6. Synthetic tests (all offline, fake services)
```bash
node n8n/final/run-tests.js                       # reference, authoritative and proposed; unexpected failures only -> exit 1
node n8n/final/run-tests.js proposed              # one target
node n8n/production/tests/website-w1.test.js      # website payload -> W1 -> LEADS, consent, downstream consent, race guard
node n8n/production/tests/w13-visible-skip.test.js
SITE_DIR=apps/clinic-website node n8n/production/tests/website-w1.test.js     # also proves the website's payload equals the tested fixture
# real n8n 2.43.5 in a scratch folder with fake Grist/Meta/AI (+Mailpit, libfaketime): needs N8N_RUNTIME_DIR and N8N_NODE_DIR
N8N_RUNTIME_DIR=… N8N_NODE_DIR=… node n8n/production/tests/real/real-n8n.test.js
N8N_RUNTIME_DIR=… N8N_NODE_DIR=… SITE_DIR=apps/clinic-website MAILPIT_BIN=… node n8n/production/tests/real/website-real-n8n.test.js
```
Test files for the credential names of an imported instance use `SIM_CRED='{"meta":"…","openrouter":"…"}'` and `SIM_ALLOW_SHARED_CRED=1` (`run-tests.js` sets `SIM_CRED` for the selected workflow; credential sharing is no longer allowed there).

## 7. A controlled first live test **[LIVE]**, only after `docs/PRODUCTION_CHECKLIST.md` items 1 to 6
`FLOWHQ_WA_SEND_MODE=off`, `FLOWHQ_ALERT_EMAIL_TO` empty, `FLOWHQ_AI_EXTERNAL_ENABLED=false`; a **Preview** deployment of the website with `N8N_WEBHOOK_URL` = the n8n **test** URL; click "Listen for test event" in n8n; submit one form with a made-up name and a number you own. Expect: one new row in Grist `LEADS` (consent flag as ticked), one `W1-website-lead` row in `Run_Log`, no WhatsApp or e-mail sent, no AI call.
