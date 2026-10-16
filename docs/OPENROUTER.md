# OPENROUTER: the external AI provider (exact configuration)

OpenRouter (`https://openrouter.ai/api/v1`, OpenAI-compatible chat completions) is the only external AI provider of the clinic workflow. It is used by exactly two sections: **W13** (the WhatsApp receptionist: proposes a reply or a hand-off; W12 does the sending) and **W9** (the weekly owner report: writes the text from numbers the workflow computed). AI never sends a message and never computes a number. **No real OpenRouter call was made while preparing this change: every test uses a mocked provider.**

## 1. Environment variables (n8n container; set in the server's `.env`, never in git)
| Variable | Value | Notes |
|---|---|---|
| `FLOWHQ_AI_EXTERNAL_ENABLED` | `true` to switch OpenRouter ON; anything else (unset, empty, `false`, `1`, `yes`, `on`, typos) = **OFF** | the **one** switch for W13 **and** W9. Case and surrounding spaces are ignored (`TRUE`, ` true `). Default in this repository: `false` |
| `FLOWHQ_AI_MODEL` | an OpenRouter model id `vendor/model`, e.g. `openai/gpt-4o-mini` (default), `anthropic/claude-3.5-haiku` | must match `vendor/model`; checked while the switch is ON |
| `FLOWHQ_AI_MAX_REPLIES_PER_HOUR` | whole number, default `6` | W13 hands over to staff after this many automatic replies in an hour (cost and runaway protection) |
| `FLOWHQ_AI_BASE_URL` | **leave unset** (default `https://openrouter.ai/api/v1`) | not passed to the container by `docker-compose.yml`. If you do set it, it must be `https://openrouter.ai/…` (or `http://127.0.0.1…` / `localhost` for a local mock): anything else stops the run, so the API key can never be sent to another host |

There is **no environment variable for the API key**. It lives only in the n8n credential `OpenRouter API` (§2). Clinic-level on/off for the receptionist is a separate Grist setting (`Settings.ai_mode`: `off | auto | draft`), unchanged; both must allow AI for a patient message to reach OpenRouter.

## 2. Credentials: one role each (create or check them in n8n; never put values in git)
| n8n credential | Type | Header name | Header value | Used by |
|---|---|---|---|---|
| **`OpenRouter API`** (`As1GpZb3W665Na7C`) | Header Auth | `Authorization` | `Bearer <your OpenRouter API key, sk-or-v1-…>` | **only** `W13 – Ask Model` and `W9 – Ask Model` |
| **`FlowHQ W1 Webhook Auth`** (`FhqCredW1Hook001`) | Header Auth | `X-Lead-Secret` (or your choice) | a long random secret made for **this webhook only** (≥ 20 characters) | **only** `W1 – Webhook` (the website's enquiry endpoint) |
| **`Header Auth account 2`** (`9J6XxrIQoFDcQZ0Y`) | Header Auth | `Authorization` | `Bearer <Grist API key of a service user that can edit the clinic documents>` | every Grist node (116) |
| `WhatsApp Cloud API`, `SMTP account`, `Telegram account` | as before | | | W12, W1 e-mail, W11 |

Rules: **never** use the OpenRouter key as the website webhook secret (or the Grist key); never reuse a credential across roles. `node n8n/final/tools/audit-credentials.js <export> --check` verifies the separation of an export; the audit and the nine-node change history are in `docs/CREDENTIAL_AUDIT.md`.

## 3. Creating the one credential that is new: the website webhook secret
`FlowHQ W1 Webhook Auth` does not exist in your n8n yet. Until it exists, the imported `W1 – Webhook` node shows "credential not found" and the workflow cannot be activated (it fails closed: nothing is exposed). Either:
* **From the CLI (keeps the id the workflow expects):** put `FLOWHQ_W1_WEBHOOK_SECRET=<new secret, ≥ 20 chars>` in a private env file and run `node n8n/production/scripts/create-credentials.js --only FhqCredW1Hook001 --env-file <file> --import "<command that runs n8n import:credentials --input=%FILE%>"` (see the script header; it prints no value and deletes its temporary file). `--only` creates just this credential and leaves your Grist, OpenRouter and WhatsApp credentials untouched.
* **Or in the n8n UI:** create a Header Auth credential (name `FlowHQ W1 Webhook Auth`, header `X-Lead-Secret`, your secret), then open `W1 – Webhook` and select it.

Then give the website the same two values: Vercel `N8N_WEBHOOK_AUTH_HEADER` = that header name, `N8N_WEBHOOK_SECRET` = that secret (the website function also refuses a value that looks like an OpenRouter key).

## 4. How the switch behaves (tested)
| Situation | W13 | W9 |
|---|---|---|
| `FLOWHQ_AI_EXTERNAL_ENABLED` unset / empty / `false` / `0` / `1` / `yes` / `on` / typo | message gets `AI_Status = skipped`, `AI_Action = skip`, the reason and a `Run_Log` row; **no OpenRouter call, nothing sent** | no provider call; the report is still written from the numbers and sent as before |
| `true` / `TRUE` / ` True ` | one call to OpenRouter with the configured model; the answer is validated; invalid or unavailable AI = hand-off to staff with the fixed holding text | one call with only computed numbers (no names, no phone numbers) |
| ON with a bad `FLOWHQ_AI_MODEL` or a non-OpenRouter `FLOWHQ_AI_BASE_URL` | the run **stops** before Grist, Meta or the provider is touched; the message names the variable (never a value) | same |
| OFF with a bad model/URL | not validated; W13 keeps working (an emergency still alerts staff, `STOP` still opts out) | same |
The enable flag is evaluated **once**, in `W13 – Config` / `W9 – Config`; the W13 gate reads only that value. Consent, opt-out, pause, human hand-off, quiet hours and the W12 send checks are not touched by the switch.

## 5. Turning it on (a decision for the clinic; nothing here does it)
1. Credentials in place and verified (§2, §3); `docs/CREDENTIAL_AUDIT.md` §3 done.
2. The clinic has approved sending **masked** patient messages to the provider (`docs/PRIVACY_DRAFT.md`; identifiers are replaced by `[PATIENT]`, `[NUMBER]`, `[EMAIL]` before the request).
3. `FLOWHQ_AI_EXTERNAL_ENABLED=true`, `FLOWHQ_AI_MODEL=…` in the server `.env`, `docker compose up -d n8n`, then `docker compose exec n8n printenv FLOWHQ_AI_EXTERNAL_ENABLED`.
4. Start with `FLOWHQ_WA_SEND_MODE=allowlist` (your own numbers) and `Settings.ai_mode=draft` if you want to review replies first; check `Messages.AI_Status` / `Run_Log`.

## 6. What was verified, and what was not
Verified offline with mocked providers (`n8n/production/tests/openrouter.test.js`, 16 checks, plus the W13/W9/W2 suites and the real-n8n 2.43.5 scratch run): single switch, value matrix, model and endpoint validation, request URL and model, credential-role separation and its enforcement. **Not verified:** a real OpenRouter request (no key was used), that your key has credit/model access, the actual contents of your n8n credentials, and the new webhook credential in your instance.
