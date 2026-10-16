# n8n/final: the selected workflow and what surrounds it

| File | What |
|---|---|
| `workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` | **Authoritative.** The workflow supplied as "final" (424 nodes, id `sUaNZ0rqAG67HNih`), sanitized, plus (1) the OpenRouter configuration: ONE AI switch (`FLOWHQ_AI_EXTERNAL_ENABLED`), model/endpoint checks, and one credential per role (16 nodes changed, `tools/apply-openrouter-config.js`) and (2) the W1 race guard (6 nodes added, F-RACE-01). Built by `tools/build-selected.js`; node ids, connections and logic as supplied |
| `workflows/history/…as-supplied.sanitized.json` | the supplied workflow, sanitized only (for diffs and rollback of the OpenRouter changes) |
| `tools/sanitize-export.js` | makes an export safe for git; `--deny <file>` refuses to write when a private value is still inside |
| `tools/apply-openrouter-config.js` | as-supplied → authoritative (anchored, proves only the intended 16 nodes change; refuses to run twice) |
| `tools/audit-credentials.js` | what each credential is used for, by node role; `--check` fails when a credential serves several roles (`docs/CREDENTIAL_AUDIT.md`) |
| `tools/remap-credentials-for-scratch.js` | TEST ONLY: re-points credentials by role to the ids `create-credentials.js` makes, so the real-n8n tests can run the workflow in a scratch n8n |
| `tools/build-selected.js` | rebuilds the authoritative file from the as-supplied copy (OpenRouter step, then race guard) and proves only the intended nodes differ |
| `tools/propose-fixes.js` | legacy helper (`restoreAiEnvGate` is used by a test); on the selected file it changes nothing |
| `run-tests.js` | runs the 15 simulator suites (+ mutation on the reference) against the reference and authoritative files; failures are classified as known findings or UNEXPECTED |
| `tests/final.test.js` | checks on the selected files themselves |

Regenerate the authoritative file from the supplied copy: `node n8n/final/tools/apply-openrouter-config.js n8n/final/workflows/history/FlowHQ_Clinic_Automation_production_candidatefinal.as-supplied.sanitized.json n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`.
Rebuild the selected file: `node n8n/final/tools/build-selected.js n8n/final/workflows/history/FlowHQ_Clinic_Automation_production_candidatefinal.as-supplied.sanitized.json <out.json>` (the output must equal the committed file; `tests/final.test.js` checks it).
To refresh the authoritative copy from a newer private export: `node n8n/final/tools/sanitize-export.js <export.json> n8n/final/workflows/<name>.json --deny <private-values.txt>` (keep the deny list and the export out of git).
The earlier hardened reference build and its reproducible generator (`n8n/production/apply-production-hardening.js`, which needs the private original and therefore cannot be re-run from this repository alone) live in `n8n/production/`.
