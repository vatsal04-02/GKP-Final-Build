# n8n/final: the selected workflow and what surrounds it

| File | What |
|---|---|
| `workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` | **Authoritative.** The workflow supplied as "final" (429 nodes, id `sUaNZ0rqAG67HNih`), sanitized, plus (1) the OpenRouter configuration: ONE AI switch (`FLOWHQ_AI_EXTERNAL_ENABLED`), model/endpoint checks, and one credential per role (16 nodes changed, `tools/apply-openrouter-config.js`) (2) the W1 race guard (6 nodes added, F-RACE-01) and (3) the W12 pre-send pause check (5 nodes added, 2 changed, see below). Built by `tools/build-selected.js`; node ids, connections and logic as supplied |
| `workflows/history/…as-supplied.sanitized.json` | the supplied workflow, sanitized only (for diffs and rollback of the OpenRouter changes) |
| `tools/sanitize-export.js` | makes an export safe for git; `--deny <file>` refuses to write when a private value is still inside |
| `tools/apply-openrouter-config.js` | as-supplied → authoritative (anchored, proves only the intended 16 nodes change; refuses to run twice) |
| `tools/audit-credentials.js` | what each credential is used for, by node role; `--check` fails when a credential serves several roles (`docs/CREDENTIAL_AUDIT.md`) |
| `tools/remap-credentials-for-scratch.js` | TEST ONLY: re-points credentials by role to the ids `create-credentials.js` makes, so the real-n8n tests can run the workflow in a scratch n8n |
| `tools/build-selected.js` | rebuilds the authoritative file from the as-supplied copy (OpenRouter step, then race guard, then the W12 pause check) and proves only the intended nodes differ |
| `tools/propose-fixes.js` | legacy helper (`restoreAiEnvGate` is used by a test); on the selected file it changes nothing |
| `workflows/FlowHQ_Clinic_Automation_production_candidate4c.json` | **Slice 4C candidate (not imported, not active).** `candidatefinal` + reminder consent / message purposes (W5, W12, W15), central booking for W13 (no direct Grist writes, no Cal.com), Cal.com links refused in W6/W15. 463 nodes. Built by `tools/build-4c.js`; details in `docs/n8n-4c-changes.md`. `candidatefinal` stays as the rollback file |
| `tools/build-4c.js`, `tools/patch-4c-consent.js`, `tools/patch-4c-w13-booking.js`, `tools/4c/` | build the 4C candidate from `candidatefinal` (anchored, prove only the intended nodes changed, refuse to run twice, never overwrite the input; also regenerates `n8n/snippets/ai-receptionist-central.js`) |
| `tools/diff-workflows.js` | READ-ONLY node-by-node comparison of a sanitized deployed export with a repo candidate (`docs/n8n-deployed-export-procedure.md`); refuses an active or secret-bearing file |
| `run-tests.js` | runs the 15 simulator suites (+ mutation on the reference) against the reference and authoritative files; failures are classified as known findings or UNEXPECTED |
| `tests/final.test.js` | checks on the selected files themselves |

Regenerate the authoritative file from the supplied copy: `node n8n/final/tools/apply-openrouter-config.js n8n/final/workflows/history/FlowHQ_Clinic_Automation_production_candidatefinal.as-supplied.sanitized.json n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`.
Rebuild the selected file: `node n8n/final/tools/build-selected.js n8n/final/workflows/history/FlowHQ_Clinic_Automation_production_candidatefinal.as-supplied.sanitized.json <out.json>` (the output must equal the committed file; `tests/final.test.js` checks it).
To refresh the authoritative copy from a newer private export: `node n8n/final/tools/sanitize-export.js <export.json> n8n/final/workflows/<name>.json --deny <private-values.txt>` (keep the deny list and the export out of git).
The earlier hardened reference build and its reproducible generator (`n8n/production/apply-production-hardening.js`, which needs the private original and therefore cannot be re-run from this repository alone) live in `n8n/production/`.

## W12 pre-send pause check (`tools/patch-w12-pause-check.js`, `tests/w12-pause.test.js`)

The CRM's **Human handling** switch writes `Conversations.Automation_Paused`. W13 reads it once, before it asks the model. While the model thinks (seconds) staff can switch Human handling on; without this check the reply was still sent. W12 is the only sender, so the last Grist read belongs there.

- **Only W13 patient replies** (`input.w13_kind === 'patient_reply'`) are checked. Staff alerts, staff replies (W10), W3 / W5 / W6 / W7 / W8 / W14 messages and templates are not, and W13's own gate is unchanged.
- After the consent step and **before the send-ledger lookup and claim and before Meta**, W12 reads the inbound message row named by `idem_key` (`W13:patient_reply:<Messages row id>`), then its `Conversation`, then that `Conversations` row, in the clinic document named in the message. It checks that the row is the one it asked for and that lead and phone agree.
- `Automation_Paused === true` -> blocked: `send_status blocked`, nothing claimed in the ledger, Meta not called. **Only an explicit `false` continues.** A read error, no or several rows, the wrong row, another lead's or phone's conversation, or a missing / non-boolean value also blocks (fail closed).
- A blocked reply is recorded by W13 exactly as any unsent reply: `AI_Status = failed`, `Needs_Human = true`, a failed `Run_Log` line, reason "reply not sent: paused by staff…". `aiFinalWrites` and the shared snippets are unchanged.
- **Residual race (not closed):** the check reads Grist, then W12 still does the ledger lookup, claim and verify before Meta. A switch flipped inside that short window (a few Grist round trips) still lets that one reply out, and a sent WhatsApp message cannot be recalled. The check shrinks the window from "the whole model call" to that; it does not remove it.
- A conversation whose `Automation_Paused` cell is empty or whose column is missing blocks AI replies (fail closed), with the reason in the run log. Grist reads a Toggle as `false` unless it is set, so this only happens with a missing column.
- TEST_MODE patient replies (sent to the clinic's own phone) are checked too.
- The simulator's fake Grist now gives a Toggle column the default `false` on insert, like real Grist (`production/tests/sim.js`), so rows created by W2 read back as `false`, not as a missing value.
