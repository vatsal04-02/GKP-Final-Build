# Website enquiry form -> FLOW HQ CRM: audit, root causes, fix (31 Oct 2026)

Scope of this work: connect the existing live website form to the existing CRM. The website design and code were not changed (they were already correct). The live V4 n8n workflow was not touched, n8n was not recreated, 4D was not activated, no real patient was contacted, `booking_enabled` is unchanged. **The production connection is NOT live yet: it is blocked on one n8n decision (section 4).**

## 1. The path, and what is true at each hop (evidence)
| Hop | Finding |
|---|---|
| Vercel project | `gkp-final-build` (team `vatsals-projects-e2c87193`), Root Directory `apps/clinic-website`, Astro. **Production branch = `main`**: every push to `main` creates a Production deployment, other branches create Previews; the Production deployment is aliased to `geetakrishnaphysiotherapy.co.in`, `www.` and `...-git-main-...`. |
| Live build | The live HTML has the form (`#book-form`, `data-endpoint="/api/enquiry"`, fields name, phone, concern, visit, day, slot, consent_whatsapp, honeypot) and the client script posts JSON with a stable `request_id` and shows an honest failure message. It matches the repo. |
| Form -> API | `apps/clinic-website/src/scripts/booking.ts` -> `POST /api/enquiry` (`apps/clinic-website/api/enquiry.mjs`). Validation, same-origin check, rate limit, honeypot, 10-minute request-id memory, forwards to n8n with header `X-Lead-Secret`. A failure is shown to the visitor (never a false "received"); a retry with the same details reuses the same `request_id`. |
| **Vercel environment** | **The project has NO environment variables.** `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `CLINIC_SLUG` are all missing. The function therefore answers **503** to every valid enquiry (probed on the live site with a synthetic enquiry with the consent box unticked, which the CRM refuses by design, so it could not have created a lead). The visitor sees "We couldn't send your request right now". **Nothing ever reaches n8n.** |
| n8n webhook | `POST https://n8n.geetakrishnaphysiotherapy.co.in/webhook/website-lead` is live (owned by V4) with header authentication. |
| **n8n authentication** | In the live V4, `W1 - Webhook` is bound to the credential **`OpenRouter API`**, and so are 7 Grist nodes of W1 (`Clinic lookup`, `Find lead by phone`, `Update lead`, `Recent leads`, `Create lead`, `Write Run_Log`, `Alert settings`) plus `W4 - Clinic lookup` and `W5 - Set sent flag`. This is the "as supplied" binding documented in `docs/CREDENTIAL_AUDIT.md`: the corrected binding exists in the repo (`candidatefinal`, `4C`, `4D`: dedicated `FlowHQ W1 Webhook Auth`, Grist credential for Grist) but **was never applied to the deployed V4**. The website function refuses an OpenRouter-looking secret by design, and a dedicated credential `FlowHQ W1 Webhook Auth` does not exist in n8n. So even with Vercel configured, the website could not authenticate, and W1's Grist calls would carry the wrong credential. |
| W1 field mapping | Compatible: W1 reads `clinic_slug, name, phone, enquiry, page_url, utm_campaign, consent_whatsapp, consent_version` (the website sends exactly these), normalises the phone, de-duplicates by phone, writes `LEADS` (`Name, Phone, Source=Website, Enquiry, Page_URL, UTM_Campaign, Status=New, Consent_WhatsApp, Consent_Source, Consent_At, Consent_Version`), and answers `{status: ok\|duplicate\|invalid}` which the website maps. The form's concern / visit / day / slot are composed into the existing `Enquiry` text (there are no separate LEADS columns): nothing is discarded. |
| CRM display | FLOW HQ lists LEADS rows (Contacts / Enquiries). |

**Third cause, found during the production test (31 Oct, 23:5x IST):** production's `LEADS` table lacked the consent columns W1 writes (`Email, Email_Opted_Out, Consent_WhatsApp, Consent_Email, Consent_Source, Consent_At, Consent_Version`): W1 failed with `Invalid column "Consent_At"` and the website saw 502. `n8n/production/scripts/migrate-grist.js` (additive, already part of every staging run) had never been run on production. **Cutover step to add for any clinic: run `migrate-grist.js --doc <docId>` (dry run), check it proposes only these columns, then `--apply`, before the first website submission.**

## 2. Root cause
1. **Vercel has no environment variables** -> the function drops every enquiry with 503 before contacting n8n.
2. **The deployed n8n workflow (V4) authenticates the website webhook, and W1's Grist writes, with the wrong credential** (`OpenRouter API`). The fix is in the repo and has never been deployed.
Both must be fixed; fixing only the first moves the failure from Vercel to n8n (403).

## 3. What was verified end to end (staging, real parts)
`flowhq/tests/real-grist/staging-website.real.test.ts` (run with `flowhq/deploy/staging/run-staging-n8n.ps1 -Filter tests/real-grist/staging-website`, `STAGING_WORKFLOW=...candidate4d.json`): the website's **actual** `api/enquiry.mjs` -> a **real n8n 2.43.5** running 4D (W1 with the dedicated credential, consent required as in production) -> a **real Grist** -> the **real FLOW HQ** server. **7 / 7 pass:**
1. valid enquiry: "received"; lead in Grist with **every** field (name, phone, composed concern/visit/day/slot, page, campaign, source Website, consent, consent source, consent text version, consent time);
2. FLOW HQ lists the lead (name, phone, source, enquiry);
3. phone typed with spaces = same patient; resubmitting (same and new request id) -> still ONE lead;
4. an existing CRM lead (status Contacted, notes) is updated, not duplicated: Lead id, status, notes, source untouched, enquiry appended, consent added;
5. invalid phone / no name / choice not offered / honeypot / consent box unticked: rejected (422), nothing stored, W1 logs the skip;
6. wrong secret -> n8n 403 -> the visitor sees a failure, nothing stored; direct call without the header -> 403;
7. no secret, webhook address or internal URL in any response body or header.
The website function's own unit tests (`apps/clinic-website/tests/enquiry-api.test.mjs`) already cover timeouts, upstream failure (never a false success), rate limiting, origin checks and request-id memory.

## 4. What is needed in production (and why I stopped)
The only way to make the production webhook accept the website is a change inside n8n's active workflow, which this task forbids (V4 must not be modified, 4D must not be activated). Two ways, each needs the owner's approval:
- **A (recommended): the 4D cutover** (`docs/n8n-4d-cutover.md`, scripts in `scripts/4d/`). It creates `FlowHQ W1 Webhook Auth`, binds W1 correctly, fixes the Grist bindings and brings everything else. Steps 40 (credentials), 50 (import) and 70 (swap) are what make the website work; the website env change below is done at the swap.
- **B (smaller, still edits V4): rebind 10 credential references in the n8n editor** (admin IP only): `W1 - Webhook` -> new Header Auth credential `FlowHQ W1 Webhook Auth` (name `X-Lead-Secret`, value = the new website secret); the 7 W1 Grist nodes, `W4 - Clinic lookup`, `W5 - Set sent flag` -> `Header Auth account 2`. First confirm in the editor (value masked, never copied) that `Header Auth account 2` is the Grist key and `OpenRouter API` starts with `Bearer sk-or-` (`docs/CREDENTIAL_AUDIT.md` section 3).

## 5. Vercel production configuration (to apply together with the n8n change)
Server-only variables (Project > Settings > Environment Variables, **Production**; never `PUBLIC_*`):
| Variable | Value |
|---|---|
| `N8N_WEBHOOK_URL` | `https://n8n.geetakrishnaphysiotherapy.co.in/webhook/website-lead` (the production URL, not `webhook-test`) |
| `N8N_WEBHOOK_SECRET` | a NEW random secret, identical to the value of the n8n credential `FlowHQ W1 Webhook Auth`. Never an OpenRouter or Grist key. Never printed or committed. |
| `N8N_WEBHOOK_AUTH_HEADER` | `X-Lead-Secret` |
| `CLINIC_SLUG` | `demo-clinic` (the production Clinic_Slug in the Agency Registry) |
| `ALLOWED_ORIGINS` | `https://geetakrishnaphysiotherapy.co.in,https://www.geetakrishnaphysiotherapy.co.in` |
| `N8N_TIMEOUT_MS` | optional, default 8000 |
Setting them from this PC without showing the secret (the secret is read from the private file the cutover creates on the server, `~/.4d-secrets/w1-webhook-secret`; copy that file yourself to a private place first, never into chat or git):
```powershell
# one-time link in a throwaway folder outside the repo
vercel link --yes --project gkp-final-build --scope vatsals-projects-e2c87193 --cwd $env:TEMP\vlink-gkp
"https://n8n.geetakrishnaphysiotherapy.co.in/webhook/website-lead" | vercel env add N8N_WEBHOOK_URL production --cwd $env:TEMP\vlink-gkp --scope vatsals-projects-e2c87193
"X-Lead-Secret"  | vercel env add N8N_WEBHOOK_AUTH_HEADER production --cwd $env:TEMP\vlink-gkp --scope vatsals-projects-e2c87193
"demo-clinic"    | vercel env add CLINIC_SLUG production --cwd $env:TEMP\vlink-gkp --scope vatsals-projects-e2c87193
"https://geetakrishnaphysiotherapy.co.in,https://www.geetakrishnaphysiotherapy.co.in" | vercel env add ALLOWED_ORIGINS production --cwd $env:TEMP\vlink-gkp --scope vatsals-projects-e2c87193
Get-Content "$HOME\gkp-private\w1-webhook-secret" -Raw | vercel env add N8N_WEBHOOK_SECRET production --cwd $env:TEMP\vlink-gkp --scope vatsals-projects-e2c87193
# environment variables only apply to a NEW deployment: redeploy the current production deployment (same code, branch main)
vercel redeploy <current production deployment url> --target production --scope vatsals-projects-e2c87193
```
Do it only after the n8n side accepts the secret (otherwise visitors see the failure message exactly as today).

## 6. Production verification (after the n8n change and the Vercel redeploy)
1. **Probe that creates no lead** (consent unticked; the CRM refuses it by design): `POST https://geetakrishnaphysiotherapy.co.in/api/enquiry` with a synthetic body, header `Origin: https://geetakrishnaphysiotherapy.co.in`, `consent_whatsapp:false`. Meaning of the answer: **503** Vercel variables missing; **502** n8n refused or unreachable (secret/credential mismatch or n8n down); **422 `consent_required`** = the whole path works (Vercel -> n8n authenticated -> W1 ran); 200 would mean a lead was created.
2. **One synthetic lead** (consent ticked, name starting `ZZ`, phone `+91 90000 3xxxx`): expect 200 "received"; the row appears in Grist LEADS (`demo-clinic`) and in FLOW HQ; submit it again: still one row. Staff then mark the test row as lost/delete it (a person does this; no patient is messaged because WhatsApp sends are limited to the allowlist and W1 sends nothing to the visitor).
3. Check Vercel function logs: only event names, request id and status codes appear (no personal data or secret).

## 6b. Production result (31 Oct 2026)
n8n swapped to 4D (`F4dRetryd0c49396`); Vercel variables set and production redeployed (`dpl_7ay8W1gUNY97KdBhQ88c6A5Z8YhA`); `LEADS` migrated (7 columns, verified: no row or other table changed; backup checksum reconfirmed first). Probe with consent unticked: **422 `consent_required`**, no lead. One synthetic lead `ZZ Synthetic Test Lead` (+91 90000 30101): **200 "received"**, stored as Grist record 5 (`L-20261031-0001`) with every field correct; the identical repeat and a same-details/new-request-id repeat both returned 200 and created nothing (W1 logged "duplicate submission"). The W1 staff alert was held by quiet hours; no message was sent. The synthetic lead is left in place until staff confirm it in FLOW HQ and then delete it.

## 7. Files
Added: `flowhq/tests/real-grist/staging-website.real.test.ts`, this document. Changed: `flowhq/deploy/staging/run-staging-n8n.ps1` (copies the website function into the staging container). No website, workflow or production file was changed.
