# SOURCES: what was consolidated, from where, and what was left out

Verified on 2026-10-16 (path, repository, branch, commit, working-tree state).

| Component | Source | Branch / commit | State at consolidation | Landed in |
|---|---|---|---|---|
| Clinic website | `https://github.com/vatsal04-02/Physio` (public; its only branch) | `claude/determined-clarke-5l1ji9` @ `e5f2a6c45ffe916469c7156afeda3e5dc6a8f150`; integration worktree `/home/user/vatsal04-02/physio-enquiry` on `claude/website-enquiry-integration` (same base) | 10 uncommitted paths (the enquiry integration: 5 modified, 5 new) | `apps/clinic-website/` (tracked + new files; no `node_modules`/`dist`) |
| CRM application and stack | `https://github.com/vatsal04-02/Geeta-krishna-CRM` | `claude/adoring-darwin-9py5im` @ `f9b977c5bd60fa9ca523058022f11a463a20088a` (clean). `main` (@ `e4d0397…`) has no FlowHQ code and was not used | clean checkout of the verified commit | repository root: `flowhq/`, `grist/`, `n8n/` (source lineage + tests), `docker-compose*.yml`, `Caddyfile`, `scripts/`, `privacy-policy.html`, `CLAUDE.md`, `IMPLEMENTATION_PLAN.md`; its README is `docs/STARTER-KIT.md` |
| Automation package, tests, tools | `https://github.com/vatsal04-02/clinic-autopilot-starter_free` | `claude/vibrant-ptolemy-9nynv9` @ `f883e89` (already on GitHub) + worktree `/home/user/vatsal04-02/starter-website-integration` on `claude/website-integration` (6 uncommitted paths) + the W13 files from the main working copy `/home/user/clinic-autopilot-starter_free` (uncommitted) | as listed | `n8n/production/` |
| **Authoritative workflow** | the file supplied as `FlowHQ_Clinic_Automation_production_candidatefinal.json` (sha256 `cdf576042e3559fca46e09ccd64028f6771c61efd267b85117c592c858d619c1`) | n/a | supplied by the owner | `n8n/final/workflows/…candidatefinal.json` (sanitized, sha256 of the committed copy differs by design) |
| Earlier workflow candidates | `…candidatev1.json` (418 nodes; `final` differs from it only in `W13 – Config` and `W13 – Build Context`) and the earlier hardened reference export | n/a | n/a | v1 is **not** kept (it duplicates the selected file); the reference export is `n8n/production/clinic-autopilot-production.json` |
| Docker compose edit | `/home/user/clinic-autopilot-starter_free/docker-compose.yml` (the approved block that passes `FLOWHQ_*` to n8n) | uncommitted | approved by the owner earlier | `docker-compose.yml` |

## Which workflow is authoritative, and why
The owner named `…candidatefinal.json` the main workflow. Compared with the earlier v1 it differs in exactly two nodes: `W13 – Build Context` (the closed AI gate now reports a visible skip, the change reviewed and tested here, plus an extra environment check) and `W13 – Config` (a second `ai_external_enabled = true`, **F-AI-01**). The supplied file is kept (sanitized: `active` → `false`, `meta.instanceId` removed, a real phone number and WhatsApp phone-number id in the manual-test node replaced; `n8n/final/tools/sanitize-export.js`) in `n8n/final/workflows/history/`. The **selected** file is that copy plus the OpenRouter configuration requested later (`n8n/final/tools/apply-openrouter-config.js`, 16 nodes: the single AI switch, the OpenRouter model/endpoint checks and one credential per role). The **proposed** file adds the W1 race guard on top.

## Deliberately left out
* `.env` files and every credential, token, key, password or webhook secret; credential **values** were never read.
* The private original workflow backups (they contain live values) and the redacted copies of them.
* Real patient data (none was supplied). The personal phone number and WhatsApp phone-number id found in the manual-test node, the recipient allowlist and test phone from `.env`, the alert e-mail address, the `.env` tailnet host name.
* `node_modules`, `dist`, `.astro`, test output, caches, local artifacts.
* **`products/`** (untracked in `/home/user/clinic-autopilot-starter`: the missed-call capture and iPhone demo products) and the FastAPI/FlowHQ demo stacks: separate products outside the scope of this build.
* `vatsal04-02/clinic-autopilot-starter_free` (`main` @ `a1b5e14`, a second clone) and `/home/user/clinic-autopilot-starter`: not sources of this build.

## Sanitization applied to what was copied
* `n8n/final/workflows/…candidatefinal.json`: `active` → `false`, `meta.instanceId` removed, the manual-test node's real recipient number and WhatsApp phone-number id replaced (`n8n/final/tools/sanitize-export.js`; the run refuses to write if any private value is left).
* The source lineage inherited from `Geeta-krishna-CRM` (`n8n/integrated`, `n8n/merged`, `n8n/w2`, `n8n/w13`, `privacy-policy.html`) contained four private values: the Grist **registry document id** (→ `REGISTRY_DOC_ID_PLACEHOLDER`, 127 replacements in 29 files), the Telegram alert **chat id** (→ `-1000000000001`), the WhatsApp **phone-number id** (→ the fictional `123456789012345`) and the **contact e-mail address** in `privacy-policy.html` (→ `privacy@example.com`; put the real address back before publishing that page), plus the **n8n instance id** in the workflow exports (→ zeros). Replacement tool: `n8n/final/tools/sanitize-tree.js` (the private map file is not in the repository). One consequence: `n8n/integrated/apply-ai-os.js` fingerprints the node `W13 – Config`, so its constant was re-computed; the 48 test files of that lineage pass again.
* Checked before commit by a scan of every file that would be committed against all private values found in the supplied `.env` and the private original workflow, plus patterns for tokens, keys, bearer values, long hex secrets, personal e-mail and tailnet host names: **0 hits** (the remaining pattern matches are placeholders: `you@gmail.com`/`vatsal-laptop.tail1234.ts.net` in `.env.example` and the starter-kit text, file hashes, git commit ids, a zeroed instance id and an HMAC test vector).
* `n8n/integrated/source/*.redacted.json` are the already-redacted export inputs of the legacy patchers (needed by their 48 tests); they are not private originals and passed the scan above.

## Pushing
Only `https://github.com/vatsal04-02/GKP-Final-Build.git` was written to. The source repositories were not pushed to.
