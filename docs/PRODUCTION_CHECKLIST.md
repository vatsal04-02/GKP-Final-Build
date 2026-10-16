# BEFORE PRODUCTION ACTIVATION (none of this has been done)

Activation needs your explicit decision for each step. This repository did not deploy, activate or change anything live.

## Must be resolved first
1. **Credentials (F-WEBHOOK-CRED, F-GRIST-CRED).** Create `FlowHQ W1 Webhook Auth` (`docs/OPENROUTER.md` §3). In n8n open `OpenRouter API` and `Header Auth account 2` and confirm the header **names** (`Authorization`; values never leave n8n): the first must hold the OpenRouter key, the second the Grist key. Run `node n8n/final/tools/audit-credentials.js <export> --check`: every credential serves one role.
2. **OpenRouter.** Decide when to switch it on: `FLOWHQ_AI_EXTERNAL_ENABLED=true` and `FLOWHQ_AI_MODEL` (`docs/OPENROUTER.md`). It stays **off** until the clinic has approved the privacy notice (`docs/PRIVACY_DRAFT.md`) and your OpenRouter key has credit and access to the model.
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
No real-provider verification of any kind has happened (no real OpenRouter request was ever made). W6 stays silent for leads without consent (F-W6-SILENT). The selected workflow has no split opening hours (F-HOURS).
