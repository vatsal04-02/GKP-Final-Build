# BEFORE PRODUCTION ACTIVATION (none of this has been done)

Activation needs your explicit decision for each step. This repository did not deploy, activate or change anything live.

## Must be resolved first
1. **Credential roles (F-CRED-ROLE).** Inspect the credentials `OpenRouter API` and `Header Auth account 2` in n8n (header **names** only), re-assign the 11 nodes listed in `docs/CREDENTIAL_AUDIT.md` to credentials of the right role, give the website webhook its own secret. Re-run `audit-credentials.js`: no credential may serve two roles.
2. **External AI (F-AI-01).** Decide whether the AI override stays. If AI should be off by default, import the proposed workflow (or delete the second `ai_external_enabled = true` in `W13 – Config`). Enabling external AI needs the clinic's approval of the privacy notice (`docs/PRIVACY_DRAFT.md`).
3. **Verify Grist.** The live document has a `LEADS` table with the columns of `grist/schema.md`, plus `Send_Ledger` and the consent columns (`migrate-grist.js --check`, then `--apply` after a backup).
4. **Verify the clinic slug** in the registry's `Clinics` table and set `CLINIC_SLUG` in Vercel. `FLOWHQ_REGISTRY_DOC_ID` set on the server.
5. **Clinic approval of the wording** (`PRIVACY_DRAFT.md`), a published privacy page, a retention period, and the `CONSENT_VERSION` bumped (drop `DRAFT-`).
6. **Backups.** Export the live n8n workflow; back up the n8n volume and Grist (`n8n/production/scripts/backup.sh`); keep `N8N_ENCRYPTION_KEY` separately. Never change that key.
7. **Race guard (F-RACE-01).** Decide to import the proposed workflow (recommended): without it two simultaneous enquiries from one phone can create two leads.

## Then, in this order
8. Controlled test (docs/INSTALL.md §7): `FLOWHQ_WA_SEND_MODE=off`, no alert e-mail, AI off, Vercel **Preview**, n8n **test** webhook, one synthetic enquiry.
9. Decide `FLOWHQ_W1_REQUIRE_CONSENT=false` (verified: a no-consent lead gets no patient message). Restart n8n.
10. Meta/WhatsApp: approved templates (`n8n/production/templates/`), webhook verification token, app secret, permanent token as the **WhatsApp** credential; `FLOWHQ_WA_SEND_MODE=allowlist` with your own numbers first; `live` only after you have seen the Run_Log and ledger.
11. Activate the workflow, set `N8N_WEBHOOK_URL` to the production webhook, promote the Vercel deployment. Watch `Run_Log` and `LEADS` for the first day.

## Known gaps to accept or fix (see `docs/KNOWN_FINDINGS.md`)
No real-provider verification of any kind has happened. W6 stays silent for leads without consent (F-W6-SILENT). The selected workflow has no split opening hours (F-HOURS).
