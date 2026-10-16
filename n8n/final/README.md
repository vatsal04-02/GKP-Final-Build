# n8n/final: the selected workflow and what surrounds it

| File | What |
|---|---|
| `workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` | **Authoritative.** The workflow supplied as "final" (418 nodes, id `sUaNZ0rqAG67HNih`), sanitized: `active:false`, `meta.instanceId` removed, real phone number / WhatsApp phone-number id in `W12 – Test input` replaced by fictional values. Node ids, credential references, URLs, logic: as supplied |
| `workflows/proposed/FlowHQ_final_proposed_safe-ai-gate_w1-race-guard.json` | **Proposed, not applied anywhere.** Authoritative + (1) the literal `ai_external_enabled = true` override removed from `W13 – Config` (F-AI-01) + (2) the W1 race guard (6 nodes, F-RACE-01). Import into a **copy** only after reading `docs/KNOWN_FINDINGS.md` |
| `tools/sanitize-export.js` | makes an export safe for git; `--deny <file>` refuses to write when a private value is still inside |
| `tools/audit-credentials.js` | what each credential is used for, by node role; flags credentials serving several roles (`docs/CREDENTIAL_AUDIT.md`) |
| `tools/propose-fixes.js` | regenerates the proposed file from the authoritative one and proves only the intended nodes differ |
| `run-tests.js` | runs the 15 simulator suites (+ mutation on the reference) against the reference, authoritative and proposed files; failures are classified as known findings or UNEXPECTED |
| `tests/final.test.js` | checks on the selected files themselves |

Regenerate the proposal: `node n8n/final/tools/propose-fixes.js n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json n8n/final/workflows/proposed/FlowHQ_final_proposed_safe-ai-gate_w1-race-guard.json`
To refresh the authoritative copy from a newer private export: `node n8n/final/tools/sanitize-export.js <export.json> n8n/final/workflows/<name>.json --deny <private-values.txt>` (keep the deny list and the export out of git).
The earlier hardened reference build and its reproducible generator (`n8n/production/apply-production-hardening.js`, which needs the private original and therefore cannot be re-run from this repository alone) live in `n8n/production/`.
