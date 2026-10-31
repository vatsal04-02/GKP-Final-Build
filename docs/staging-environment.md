# The staging environment: how to run it, and what it proves (and does not)

Everything here runs on a developer machine with Docker. **Nothing touches a clinic, a real patient, the production VPS or any production credential.** Every document, phone number and name is synthetic. Every secret is a throw-away value generated for the run and kept in a scratch file.

## What is REAL and what is a STAND-IN

| Piece | In staging | Notes |
|---|---|---|
| Grist | **REAL** `gristlabs/grist:1.7.20` (the version `docker-compose.yml` pins) in a throw-away container | documents are created through Grist's REST API; deleted afterwards |
| FLOW HQ server | **REAL** process (`src/server/index.ts`) and the **REAL production image** (`flowhq/Dockerfile`) | real tokens, sessions, audit outbox on a real file / volume |
| n8n | **REAL** n8n 2.43.5 (the version the repo's real-n8n harness targets) in a Linux container; the 4C workflow candidate is imported through n8n's own CLI | credentials are created with the shipped `create-credentials.js`; one change for testing: the W5 schedule trigger is replaced by a webhook (a 15-minute timer cannot be waited for) |
| Caddy | **REAL** `caddy:2` with stub upstreams | the production Caddyfile's own handlers; only the site addresses are rewritten to `http://*.test` |
| WhatsApp / Meta | **STAND-IN**: a local HTTP server that records every send | **no authorised test number or Meta credential exists, so nothing reaches WhatsApp. This is NOT a WhatsApp test** (no template approval, no real error codes, no delivery receipts from Meta) |
| The AI model | **STAND-IN**: a deterministic stub returning fixed decisions | tests the workflow *around* the model (redaction layer, validation, the YES gate, the booking calls), **not the model's judgement** |
| Cal.com | not run; its legacy rows are created directly in Grist | W4 itself is covered by the repo's real-n8n suite |

## One-time setup
1. **Docker Desktop** (Linux containers). Pull once: `gristlabs/grist:1.7.20`, `node:20-alpine`, `caddy:2`.
2. **A throw-away Grist** on a Docker network, logged in through Grist's supported forward-auth header, with an API key written to a file (never printed):
   ```
   docker network create gkp-staging
   docker volume create gkp-staging-grist-data
   docker run -d --name gkp-staging-grist --network gkp-staging -p 127.0.0.1:18484:8484 ^
     -e GRIST_IN_SERVICE=true -e GRIST_FORWARD_AUTH_HEADER=X-Staging-User -e GRIST_FORWARD_AUTH_LOGOUT_PATH=/signed-out ^
     -e GRIST_SINGLE_ORG=docs -e GRIST_SESSION_SECRET=<any 32+ chars> -e APP_HOME_URL=http://127.0.0.1:18484 -e GRIST_SANDBOX_FLAVOR=unsandboxed ^
     -v gkp-staging-grist-data:/persist gristlabs/grist:1.7.20
   ```
   Then log in once (`GET /auth/login` with header `X-Staging-User: staging@example.test`), `POST /api/profile/apikey` with `X-Requested-With: XMLHttpRequest`, and save the key to a file outside the repo.
   *Grist 1.7.x quirk found while building this:* a fresh install answers every API call `503 "Grist is not yet configured"` until `GRIST_IN_SERVICE=true` is set (or the /boot setup is completed). A production Grist that is already configured is unaffected; a **new** Grist install will hit it.
3. **The n8n runner image** (once, ~2 minutes, 7 GB): `docker build -f flowhq/deploy/staging/Dockerfile.n8n-runner -t gkp-staging-n8n:local flowhq/deploy/staging`
4. **The production image** (to test the image itself): `docker build -f flowhq/Dockerfile -t flowhq-final:local .`

## Running the suites
All of these are skipped unless their environment variables are set, so the normal `npm test` never needs Docker.

| What | Command (from `flowhq/` unless noted) | Where |
|---|---|---|
| Normal suite (in-memory Grist) | `npm test` | any OS |
| Real Grist + real server: journey, concurrency, consent, audit flush; restart, corrupt outbox, second process, token expiry / revocation, permissions, **backup and restore**; **Grist outage** | `$env:REAL_GRIST_URL='http://127.0.0.1:18484'; $env:REAL_GRIST_KEY_FILE='<key file>'; $env:REAL_GRIST_CONTAINER='gkp-staging-grist'; npm run test:real-grist` | Windows / macOS / Linux |
| **SIGTERM / SIGINT / SIGKILL recovery and DISK FULL** (need real signals and a tiny filesystem) | `powershell -File flowhq\deploy\staging\run-real-grist-linux.ps1 -KeyFile <key file>` (runs the suite in `node:20-alpine` with a 256 KB tmpfs) | Linux container |
| **The 12-step patient journey in a real n8n** | `powershell -File flowhq\deploy\staging\run-staging-n8n.ps1 -KeyFile <key file>` | Linux container (`gkp-staging-n8n:local`) |
| The production image: persistent volume, `docker stop`, re-creation, operator tools | `$env:REAL_IMAGE='flowhq-final:local'; npm run test:real-grist` (or `npx vitest run tests/real-grist/image`) | needs Docker |
| Reverse proxy | `powershell -File flowhq\deploy\staging\verify-caddy.ps1` | needs Docker |
| All n8n suites incl. the shell-script `ops` suite | `docker run --rm -v <repo>:/src:ro gkp-staging-n8n:local sh -c "mkdir -p /work && cd /src && tar cf - --exclude=node_modules --exclude=.git n8n docs grist | tar xf - -C /work; cd /work && node n8n/final/run-tests.js"` | Linux container (the `ops` suite needs bash and file modes) |

## Results (last run, 31 October 2026)
See `docs/production-readiness.md` section 3 for the table with counts. Short version: the in-memory suite, every real-Grist test, the Linux signal / disk-full tests, the real-n8n journey (12 steps + n8n-unavailable + concurrent duplicate), the image tests and the 20-check proxy verification all pass.

## What staging cannot tell you (do not skip these on the way to production)
1. **WhatsApp.** Template approval, Meta's real error codes, the 24-hour window, delivery receipts, rate limits and opt-in rules were never exercised. Needs an authorised test number and Meta credentials.
2. **The real model.** The stub answers by pattern. Whether a real model puts the right date and time in a decision (it is told to copy them from AVAILABILITY and from the question it asked) is untested. The explicit-YES gate and the booking API's own checks limit the damage of a wrong decision to "asks again" or "refused", but a supervised run with the real model and a synthetic patient is required.
3. **Your clinic's Grist document.** The staging documents were built from `grist/schema.md` (the template's documented columns). The live document may differ (extra columns, renamed choices, access rules). Rehearse `provision-booking` on a **copy of the live document** first.
4. **The deployed n8n.** It was never exported (no access), so nothing here says the deployed workflows equal the repo candidate (`docs/n8n-deployed-export-procedure.md`).
5. **Load.** Only small concurrency (12 simultaneous requests for one slot, 8 for one key) was exercised.
