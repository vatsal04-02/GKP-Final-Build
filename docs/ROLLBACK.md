# ROLLBACK

Nothing in this repository changes a live system by itself. Each step below undoes what a step in `docs/INSTALL.md` did.

## Website (Vercel)
* Vercel → Deployments → **Promote** the previous production deployment (instant), or `git revert` the commit that added `apps/clinic-website` changes in the website's own repository.
* Remove the server variables `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `N8N_WEBHOOK_AUTH_HEADER`, `CLINIC_SLUG`, `ALLOWED_ORIGINS`, `N8N_TIMEOUT_MS`. The previous form (a WhatsApp message, nothing stored) is restored by the previous deployment.
* Original website source: `vatsal04-02/Physio`, branch `claude/determined-clarke-5l1ji9`, commit `e5f2a6c45ffe916469c7156afeda3e5dc6a8f150` (see `docs/SOURCES.md`). Every file this build changed or added in it is listed in `n8n/production/website-integration/CHANGES.md` (section "Website repo").

## n8n workflow
* **Before importing anything, export the live workflow** (workflow ⋯ → Download) and keep that file: it is the only exact copy of what runs today. The selected file is a *sanitized* copy and is not a substitute.
* To restore: re-import that backup (importing a file with the same workflow id into the same instance replaces the workflow there). The CLI deactivates what it imports; activate deliberately.
* The selected workflow differs from the supplied one by 16 nodes (the OpenRouter switch and the credential roles). The supplied file is `n8n/final/workflows/history/…as-supplied.sanitized.json` (sanitized, for diffing); your **export of the live workflow** remains the only exact restore point. To go back to the supplied credential wiring and the hard-coded AI override, re-import that backup.
* The proposed file's changes are additive and small (remove the AI override; six W1 nodes). To undo the race guard by hand: delete `W1 – Recheck lead`, `W1 – Race guard`, `W1 – Race?`, `W1 – Respond Duplicate (race)`, `W1 – Remove duplicate row`, `W1 – Race log` and connect `W1 – Create lead` to `W1 – Respond Created` again.

## Settings
* `.env`: restore the previous file (keep a copy before editing). `FLOWHQ_W1_REQUIRE_CONSENT=true` is the previous behaviour. Never change `N8N_ENCRYPTION_KEY` on an existing install.
* `docker-compose.yml`: the only change this build made is the block that passes `FLOWHQ_*` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` to n8n (git shows exactly those added lines). Remove them and run `docker compose up -d n8n`; volumes are untouched.
* Grist: `migrate-grist.js --apply` only adds the `Send_Ledger` table and columns; nothing is deleted or overwritten, so there is nothing to undo. Restore from a Grist backup (`n8n/production/scripts/backup.sh`, `restore.sh`) only if you need to remove the additions.

## Leads created by tests
Delete them in Grist (`LEADS`, and their `Run_Log` rows). The race guard only ever deletes the row its own run created.
