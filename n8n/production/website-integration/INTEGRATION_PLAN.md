> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# INTEGRATION PLAN (what was built, in the order it was built)

1. **Inspect** both repos and the imported workflow (INTEGRATION_AUDIT.md). No change to the original files.
2. **Website** (`Physio`, branch `claude/website-enquiry-integration`, worktree `physio-enquiry`): `api/enquiry.mjs` (Vercel Function: validate → forward to n8n with a server-held secret → honest status), `src/lib/enquiry-shared.mjs` (one list of choices + rules shared by form and API), `booking.ts`/`Booking.astro` (submit handler, consent checkbox, honeypot, loading/error/timeout states, WhatsApp fallback, wording), `.env.example`, `README.md`, `ENQUIRY_INTEGRATION.md`, `PRIVACY_DRAFT.md`, tests.
3. **n8n:** no change needed for the normal path: W1 already stores a website lead. One **proposed** change, justified by a measurement: the W1 race guard (6 nodes, `tools/patch-w1-race-guard.js`). Applied to a copy of your v1; your file is untouched.
4. **Tests:** site unit/API (18), browser (11), n8n simulator (18 new + all existing suites), real n8n in a scratch instance (5).
5. **Stop** before: activating anything, deploying, changing `.env`, publishing the wording, real messages.

## Proposed settings (NOT applied, your decision)
| Where | Setting | Value | Why |
|---|---|---|---|
| n8n `.env` | `FLOWHQ_W1_REQUIRE_CONSENT` | `false` | store an enquiry even when the WhatsApp box is unticked; consent flag stays `false`; verified that W3/W6/W12 then send nothing to the patient (TEST_PLAN: DOWNSTREAM CONSENT) |
| Vercel (server-only) | `N8N_WEBHOOK_URL` | n8n **test** URL first, production URL after approval | |
| Vercel | `N8N_WEBHOOK_SECRET` / `N8N_WEBHOOK_AUTH_HEADER` | the existing webhook credential's value / header name | the value is never shown to me or committed |
| Vercel | `CLINIC_SLUG` | the `Clinic_Slug` in your registry's Clinics table | not guessable from the files |
| Vercel | `ALLOWED_ORIGINS` | `https://physio-two-umber.vercel.app` (+ the custom domain) | |
| Controlled live test only | `FLOWHQ_WA_SEND_MODE=off`, `FLOWHQ_ALERT_EMAIL_TO` empty, `FLOWHQ_AI_EXTERNAL_ENABLED=false` | | no real message of any kind |

## Production activation steps (listed, NOT executed)
1. Clinic approves the consent/privacy wording (`PRIVACY_DRAFT.md`) and a privacy page exists; bump `CONSENT_VERSION` (drop `DRAFT-`).
2. Resolve audit item A5 (check the webhook credential's header name) and set the Vercel server variables on a **Preview** deployment.
3. Back up the live workflow (ROLLBACK.md). Import the race-guard workflow (or add the 6 nodes), keep the workflow's credentials as they are, do not activate until step 5.
4. Controlled test with the n8n **test** URL: one synthetic enquiry; check LEADS, Run_Log, nothing sent.
5. With the clinic's go-ahead: set `FLOWHQ_W1_REQUIRE_CONSENT=false`, activate the workflow, switch `N8N_WEBHOOK_URL` to the production webhook, promote the Vercel deployment.
6. Watch Run_Log and LEADS for the first day.
