# GKP Final Build: Geeta Krishna Physiotherapy clinic platform

One repository with everything needed to build and operate the clinic's website, its enquiry integration, the n8n automation and the Grist-based CRM.
**Status: reviewed and tested against synthetic data and fake providers only. Nothing here has been deployed, and nothing was tested against the live Vercel site, live n8n, live Grist, Meta/WhatsApp or SMTP.** Production activation is a separate, explicit decision: see `docs/PRODUCTION_CHECKLIST.md`.

```
visitor ── clinic website (apps/clinic-website, Astro on Vercel)
              │  POST /api/enquiry   (Vercel Function: validates, holds the secret, times out, never says "confirmed")
              ▼
           n8n  /webhook/website-lead  (W1, header auth)  ──►  Grist CRM  table LEADS  (system of record)
              │                                                    ▲
              └─ W2 WhatsApp in, W3/W5/W6/W7/W8 follow-ups, W9 report, W10 inbox, W12 the ONLY WhatsApp sender, W13 AI receptionist, W14 reconcile
staff ── FlowHQ app (flowhq/, React + Hono)  ──►  the same Grist document
```

## What is where
| Path | What |
|---|---|
| `apps/clinic-website/` | The clinic website (Astro 7): booking form, `api/enquiry.mjs` Vercel Function, shared validation, 18 API tests + 11 browser checks, `ENQUIRY_INTEGRATION.md`, `PRIVACY_DRAFT.md` |
| `n8n/final/` | **The selected workflow** (`workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`, sanitized), the **proposed** fixes (`workflows/proposed/`), the credential audit tool, the sanitizer, and `run-tests.js` |
| `n8n/production/` | The hardened automation package the selected workflow grew from: reference export, simulator + 15 test suites, real-n8n tests, Grist migration, backup/restore/health scripts, ops compose files, WhatsApp template list |
| `flowhq/` | The existing CRM application (FlowHQ: React + Hono, reads/writes the clinic's Grist). Unchanged from `Geeta-krishna-CRM` |
| `grist/` | Grist schema documents (`schema.md`, `clinic-records-schema.md`); `n8n/production/schema/production-schema.json` adds `Send_Ledger` and the consent columns |
| `n8n/` (rest) | Earlier source lineage (snippets, per-workflow builders, 48 test files) kept because the workflow code is pasted from `n8n/snippets/`. Not authoritative: see `n8n/workflows/LEGACY.md` |
| `docker-compose.yml`, `Caddyfile`, `scripts/` | The server stack (Caddy → n8n + Grist). `docker-compose.yml` now passes the `FLOWHQ_*` settings to n8n |
| `config/` | Safe examples: `env/n8n-flowhq.env.example`, `env/vercel-server.env.example`, `clinic.example.json` |
| `docs/` | `INSTALL`, `ARCHITECTURE`, `INTEGRATION_AUDIT`, `INTEGRATION_PLAN`, `FIELD_MAPPING`, `CREDENTIAL_AUDIT`, `KNOWN_FINDINGS`, `PRIVACY_DRAFT`, `TESTING`, `ROLLBACK`, `SOURCES`, `PRODUCTION_CHECKLIST` |

## Read this before you import anything
1. **Authoritative workflow = `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`** (418 nodes, id `sUaNZ0rqAG67HNih`). It is the file supplied as "final", sanitized (only: `active` set to `false`, `meta.instanceId` removed, a real phone number and WhatsApp phone-number id in the manual-test node `W12 – Test input` replaced by fictional values). Everything else, including node ids and credential references, is as supplied.
2. **It forces external AI ON** (finding **F-AI-01**): `W13 – Config` has a second `ai_external_enabled = true` that overrides the environment, so `FLOWHQ_AI_EXTERNAL_ENABLED=false` does not stop OpenRouter being called. `n8n/final/workflows/proposed/…` removes that override; nothing was applied to your n8n.
3. **Credential references are mixed up by role** (see `docs/CREDENTIAL_AUDIT.md`): the credential named `OpenRouter API` serves the website webhook's auth, nine Grist nodes **and** the W13 AI call; `Header Auth account 2` serves 105 Grist nodes **and** `W9 – Ask Model` (an AI call). They were **not** changed. Check what each credential really holds (header **name** only, never the value) before activating, so an AI key is never used as the website secret and the Grist key never reaches the AI provider.
4. The Grist table id is `LEADS` (confirmed from the workflow and the FlowHQ app configuration; **the live Grist was not inspected**). The clinic slug is **not known** and stays a server-side `CLINIC_SLUG` variable until verified in the registry's `Clinics` table.

## Quick start (everything below runs offline; no accounts needed)
Requirements: Node.js ≥ 20 (n8n 2.x itself needs Node ≥ 24, only for the optional real-n8n tests), npm, Git. Optional: Chromium + Playwright (browser test), the `mailpit` binary and libfaketime (real-n8n tests).

```bash
# 1. the website
cd apps/clinic-website
npm ci
npm run dev            # http://localhost:4321   (the form posts to /api/enquiry; without the server variables it answers "unavailable" and offers WhatsApp)
npm run build && npm run check && npm test         # production build, type check, 18 API tests

# 2. the CRM app
cd ../../flowhq && npm ci && npm run typecheck && npm test && npm run build

# 3. the automation: simulator tests (fake Grist / Meta / AI / SMTP)
cd .. && node n8n/final/run-tests.js               # reference + authoritative + proposed; exit 1 only on an UNEXPECTED failure
node n8n/tests/run-all.js                          # the 48 older test files of the source lineage
```
Full set-up (Vercel variables, n8n webhook and authentication, Grist, importing and validating the workflow, controlled live test): **`docs/INSTALL.md`**. What was run and what was not: **`docs/TESTING.md`**. Going back: **`docs/ROLLBACK.md`**.

## Safety rules built into the workflow (and tested)
Every patient-facing message goes through W12 only: consent (`Consent_WhatsApp`), opt-out, pause, quiet hours 21:00–08:00 IST, test mode, send mode (`off | allowlist | live`), an idempotency ledger. AI never sends and never computes numbers; external AI is off unless `FLOWHQ_AI_EXTERNAL_ENABLED=true` (but see F-AI-01 above). A website enquiry is stored even when the WhatsApp box is unticked (once `FLOWHQ_W1_REQUIRE_CONSENT=false`); consent stays `false` and no template is sent to that person.

## Not in this repository
`.env` files, API keys/tokens/passwords/webhook secrets, credential values, private workflow backups (they contain live values), real patient data, personal phone numbers or recipient addresses, `node_modules`, build output. `.gitignore` enforces this; `docs/SOURCES.md` lists what was deliberately left out.
