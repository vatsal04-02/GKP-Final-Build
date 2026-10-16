> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# FIELD MAPPING: website → API → n8n W1 → Grist `LEADS`

Columns were checked against `grist/schema.md`, the production schema (`schema/production-schema.json`) and the fake Grist's column list used by the tests (which refuses unknown columns). **The live Grist was not inspected.** No column was invented; there are no separate columns for visit type / day / time, so they go into the existing `Enquiry` text.

| Website form | `POST /api/enquiry` JSON | Payload to n8n (`/website-lead`) | Grist LEADS column | Rule |
|---|---|---|---|---|
| Name (`#book-name`) | `name` | `name` | `Name` | required, ≤ 60 chars, control characters removed |
| Phone (`+91` + 10 digits) | `phone` (`+91…`) | `phone` `+91XXXXXXXXXX` | `Phone` | exactly 10 digits starting 6–9 after removing `+91`/`91`/leading `0`; never padded; W1 normalises again |
| Concern (select) | `concern` | part of `enquiry` | `Enquiry` | must be one of the 10 listed concerns |
| Visit type (radio) | `visit` | part of `enquiry` | `Enquiry` | `At the clinic` / `Home visit` |
| Preferred day (chips) | `day` e.g. `Mon 6` | part of `enquiry` | `Enquiry` | pattern `Ddd N` |
| Time (chips) | `slot` | part of `enquiry` | `Enquiry` | one of the two sessions |
| (composed) | | `enquiry` = `Concern: … · Visit: … · Preferred: Mon 6, Morning 9 AM–1 PM` | `Enquiry` | ≤ 1000 chars. A later enquiry from the same phone is **appended** with its date, never overwritten |
| WhatsApp checkbox | `consent_whatsapp` boolean | `consent_whatsapp` | `Consent_WhatsApp` | unticked = `false` (still stored when `FLOWHQ_W1_REQUIRE_CONSENT=false`). Consent already on file is never removed |
| (constant) | | `consent_version` = `DRAFT-2026-10-v1` | `Consent_Version` | the wording the visitor saw |
| (set by W1) | | | `Consent_Source` (`website-form` / `website-form (no consent given)`), `Consent_At` (time, or empty) | |
| (constant) | | | `Source` = `Website`, `Status` = `New` | W1 |
| (set by W1) | | | `Lead_id` (`L-YYYYMMDD-####`), `Created_At` | W1 |
| page URL, `?utm_campaign=` | `page_url`, `utm_campaign` | same | `Page_URL`, `UTM_Campaign` | ≤ 500 / 100 chars |
| (none) | `request_id` (uuid per distinct submission) | `request_id` | not stored | idempotency in the function; W1 ignores it |
| honeypot `website` | `website` | not forwarded | not stored | filled = bot: answered "received", nothing stored |
| (server env) | | `clinic_slug` ← `CLINIC_SLUG` | | looks up the clinic in the registry; unknown = 404 |

**Deduplication key:** the normalised phone number (existing W1 behaviour) plus, per submission, the `request_id` (function level, best effort per instance). Simultaneous submissions of the same phone are handled by the proposed race guard.
**Not collected:** e-mail (the form has no field), so `Email*` columns stay empty.
