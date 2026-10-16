# Tests of the production package

| Command | What it needs | What it proves |
|---|---|---|
| `node n8n/production/tools/run-all-tests.js` | node 22+ | static, phone, privacy filter, ops (compose via `docker compose config`, scripts), and every simulator test |
| `… --real` | `N8N_RUNTIME_DIR` (a folder with `node_modules/.bin/n8n`, tested with 2.43.5) and `N8N_NODE_DIR` (a node 24 `bin` folder); optional `MAILPIT_BIN` (real Mailpit), `FAKETIME_LIB` (libfaketime; without it the real clock is used and sends are blocked 21:00–08:00 IST) | the real n8n runs the export: credentials import, webhooks, raw-body signatures, header auth, `$env`, encryption key file, timeouts, SMTP, AI request masking |
| `… --mutation` | nothing extra (slow, ~3 min) | the tests fail when the export is broken on purpose (30 mutants) |
| `… --baseline` | nothing extra (~2 min) | the repository's own 77 test files still pass |
| `CADDY_BIN=<caddy> node n8n/production/tests/ops.test.js` | a Caddy binary | the Caddyfile is accepted by Caddy itself |

A single file: `node n8n/production/tests/w12.test.js`. `PROD_FILE=<workflow.json>` runs a file against another export (the mutation check uses this).

Simulator = `tests/sim.js`, a fork of `n8n/tests/n8n-sim.js` (production credential names, `$env`, the Send Email node, the production Grist tables). It is not n8n: that is why the real-n8n test exists. All data in the tests is fictional (`+9190000000xx`, made-up ids and secrets); nothing talks to the internet.

Exit codes of `real/real-n8n.test.js`: 0 pass, 1 fail, 3 **not run** (prerequisites missing: reported as "not tested", never as a pass).
