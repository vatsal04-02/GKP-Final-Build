# n8n tests

Run everything (stops at the first failure):

```bash
node n8n/tests/run-all.js
```

| File | What it checks |
|---|---|
| `../snippets/*.test.js` | The pasted-into-n8n helper functions: phone normaliser, send guard, HMAC-SHA256 |
| `wN.checks.test.js` | One workflow's JSON: nodes connected, expressions compile, Code-node logic on test data, column names match `grist/schema.md`, no secrets |
| `wN.flow.test.js`, `w4.test.js` | The workflow **run end to end** in `n8n-sim.js` against an in-memory fake Grist |
| `n8n-sim.js` | A tiny n8n executor (webhook / schedule / set / code / if / HTTP / stop-and-error / telegram nodes) and the fake Grist. The fake Grist rejects columns that are not in the schema, invalid Choice values, and DateTimes that are not epoch seconds |
| `fixtures/` | Real Cal.com payload structure with fake people |

The workflow JSON files in `../workflows/` are the source of truth. Edit them (in n8n, then export) and re-run the tests.

What these tests cannot see: real n8n behaviour (credentials, item pairing across several clinics, the Webhook node's exact response) and the real Grist
API. After importing a workflow, one real run is still the final check.
