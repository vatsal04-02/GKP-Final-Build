> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# ROLLBACK

Nothing was deployed, activated or committed. Everything below restores the state before this work.

## Website (`Physio`)
* The work is on branch `claude/website-enquiry-integration` (worktree `physio-enquiry`); `main` is untouched. To drop it: `git worktree remove ../physio-enquiry && git branch -D claude/website-enquiry-integration`.
* If it was deployed: in Vercel > Deployments, **Promote** the previous production deployment (instant), or `git revert` the merge commit. Remove the server variables `N8N_*` and `CLINIC_SLUG` afterwards. The original form (WhatsApp message) comes back unchanged.

## n8n
* **Before importing anything, export the live workflow** (n8n > workflow > ⋯ > Download) and keep it: that file is the backup. Your uploaded v1 (`FlowHQ_Clinic_Automation_production_candidatev1.json`) is also unchanged.
* The race guard is additive (6 nodes). To remove it from a workflow that has it: delete the six nodes `W1 – Recheck lead`, `W1 – Race guard`, `W1 – Race?`, `W1 – Respond Duplicate (race)`, `W1 – Remove duplicate row`, `W1 – Race log`, and connect `W1 – Create lead` to `W1 – Respond Created` again. Or re-import the backup.
* Settings: put `FLOWHQ_W1_REQUIRE_CONSENT` back to `true` (or remove it) and restart n8n.
* A lead stored by a test can be deleted in Grist (LEADS). The guard only ever deletes the row its own run just created.

## Repository branches
`claude/website-integration` in the automation repo holds the tests, tools and these documents; delete it the same way.
