# Reading what is actually deployed in n8n (read-only) and comparing it with the repo

Status: **NOT DONE. Blocked: this repository session has no access to the production n8n (no URL, API key, SSH or container access, and none may be invented).** Everything in `docs/n8n-4c-changes.md` is therefore about the repo candidate and is **unverified against production**. The repo candidate and the deployed workflows must not be assumed identical. This procedure is the safe way to find out. It follows decision D5: read-only inspection; never activate, edit, re-import or execute an exported workflow.

## What is allowed and what is not
- Allowed: export the workflow JSON (a read), sanitize it, compare it.
- Not allowed: import it anywhere, activate it, edit the live workflow, run it, paste it into a chat or a ticket before sanitizing, commit the raw export.
- The raw export can contain credential **references** (id + name, no secret values), webhook paths, phone numbers, patient names in manual-test fixtures, and clinic ids. Treat it as private until sanitized.

## Steps (run by someone with access to the server; about 10 minutes)
1. **Export (read-only).** On the VPS, from the compose directory:
   `docker compose exec -T n8n n8n export:workflow --all --output=/tmp/wf-export.json`
   (writes one file inside the n8n container; changes nothing in n8n). Copy it out: `docker compose cp n8n:/tmp/wf-export.json ./wf-export.json`, then `docker compose exec -T n8n rm /tmp/wf-export.json`.
   Do **not** use `--decrypted` or `export:credentials`: they would put secrets in the file.
2. **Move it to a private folder outside git.** Never `git add` it.
3. **List the private values** (clinic phone numbers, the WhatsApp phone_number_id, any real patient number) one per line in a deny file kept outside git, e.g. `~/private/deny.txt`.
4. **Sanitize:** `node n8n/final/tools/sanitize-export.js wf-export.json wf-deployed.sanitized.json --deny ~/private/deny.txt`. It sets `active:false`, removes the instance id, replaces manual-test fixtures with fictional values and REFUSES to write if a deny-listed value is still inside. If the export holds several workflows or a list, split it first (one workflow object per file).
5. **Compare:** `node n8n/final/tools/diff-workflows.js wf-deployed.sanitized.json n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`
   and again against `...candidate4c.json`. The tool refuses a file that is still active or contains a token-like value. It lists nodes only in one side, nodes that differ (code / parameters / credentials / typeVersion), connection differences and the credential NAMES each side uses. Add `--code` to see the changed code, `--json` for a machine-readable result.
6. **Decide.** If the deployed workflow equals `...candidatefinal.json` (identical, or only credential ids differ), the 4C delta (`diff-workflows.js candidatefinal candidate4c`) is exactly what an import would change. If it differs, stop: reconcile first (which one is newer? which nodes were edited by hand?) before any import.
7. **Keep** the sanitized deployed export in `n8n/final/workflows/history/` (git) as the rollback reference, named with the date, only after the deny-list check passed.

## Findings that cannot be known without step 1 (open questions for the report)
- Is the deployed W12 the same as the candidate's (consent gate on `Consent_WhatsApp`, send ledger, pause check)?
- Does the deployed W5 skip patients with no Lead / skip the pending stage (it cannot, if it matches the candidate)?
- Are the deployed template names / languages identical to `WA_TEMPLATES`?
- Is Cal.com's webhook still pointed at W4 (expected: yes, until `docs/calcom-cutover.md`)?
- Which credential ids are bound (the candidate's ids are placeholders that n8n re-links)?

## Rollback of an n8n import (for the day an import is approved)
n8n keeps no version history of a replaced workflow. Before importing the 4C file: (a) keep the sanitized deployed export from step 7 (and take a fresh raw export into the private folder), (b) import the 4C file as a NEW inactive workflow named with the date, never over the live one, (c) activate only after the staging checks pass, deactivating the old one in the same step, (d) to roll back: deactivate the new workflow, re-activate the old one (still present), and put the previous `Settings.booking_link` back. W4 stays active throughout, so Cal.com bookings keep syncing.
