> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# CHANGES (every changed file, node and setting)

Nothing is committed, pushed, deployed or activated. Both repos have the work as uncommitted changes on separate branches/worktrees.

## Website repo `Physio`: branch `claude/website-enquiry-integration` (worktree `physio-enquiry`)
| File | Change | Why |
|---|---|---|
| `api/enquiry.mjs` (new) | Vercel Function: origin check, JSON/size checks, validation, honeypot, per-address rate limit, request-id de-dup cache, forward to n8n with a server-held header secret and a timeout, honest status mapping, no PII in logs | the browser must not hold the webhook URL or secret; the visitor must get an accurate answer |
| `src/lib/enquiry-shared.mjs` (new) | choices (concerns, visits, slots), phone normaliser (never pads), enquiry text composer, validator, `CONSENT_VERSION` | one set of rules for form and API |
| `src/scripts/booking.ts` | submit now POSTs to `/api/enquiry`; loading/disabled state, one request in flight, request id reused for identical details, 12 s client timeout, success/failure messages, WhatsApp fallback button; the old `bookingMessage` + `openWhatsApp` are kept | the form was not a real submission |
| `src/components/Booking.astro` | lists imported from the shared module; honeypot field; WhatsApp consent checkbox (unticked); button label "Send request"; new draft wording (replaces "Nothing is stored"); fallback button; small styles | patch only: **wording needs clinic approval** |
| `.env.example`, `README.md`, `package.json` | server-only variables documented; form description updated; `npm test` | |
| `tests/enquiry-api.test.mjs`, `tests/e2e/booking-browser.mjs` (new) | 18 API/unit tests; 11 browser checks (optional, needs Playwright) | |
| `ENQUIRY_INTEGRATION.md`, `PRIVACY_DRAFT.md` (new) | how it works / safe test; DRAFT privacy + consent wording (marked as needing clinic approval) | |

Unchanged: styling/layout classes, hero, every other component, the phone and WhatsApp links elsewhere, `astro.config.mjs`.

## Automation repo (`clinic-autopilot-starter_free`): branch `claude/website-integration` (worktree `starter-website-integration`)
| File | Change | Why |
|---|---|---|
| `n8n/production/tools/patch-w1-race-guard.js` (new) | anchored patch tool: adds 6 nodes to W1 and rewires only the connection leaving `W1 – Create lead`; refuses a second run or an edited workflow; proves nothing else changed | simultaneous submissions made duplicate leads (7/60) |
| `n8n/production/tests/website-w1.test.js` (new) | 18 simulator tests (website payload contract, consent, downstream consent, race, credentials intact) | |
| `n8n/production/tests/real/website-real-n8n.test.js` (new) | real-n8n end-to-end test (5 checks + race measurement) | |
| `n8n/production/tests/sim.js` | `SIM_CRED` option (credential names of another export) and Grist `data/delete` support in the fake | test infrastructure only |
| `n8n/production/tools/run-all-tests.js` | registers the new suite | |
| `n8n/production/website-integration/*.md` (new) | these documents | |

No workflow export in the repo is modified. The proposed workflow changes are in the artifacts folder (not in git).

## Proposed workflow change (artifact, not applied to your n8n)
New nodes in W1, added between `W1 – Create lead` and `W1 – Respond Created`:
`W1 – Recheck lead` (HTTP GET LEADS by phone, credential copied from `W1 – Find lead by phone`, continues on error) → `W1 – Race guard` (code) → `W1 – Race?` (IF) → true: `W1 – Respond Duplicate (race)` → `W1 – Remove duplicate row` (HTTP POST `…/tables/LEADS/data/delete`, continues on error) → `W1 – Race log` (code) → existing `W1 – Log skipped`; false: existing `W1 – Respond Created`.
Credentials: none created, renamed or replaced. Node ids of existing nodes: unchanged.

## Settings (documented, not changed)
`FLOWHQ_W1_REQUIRE_CONSENT=false`; Vercel server variables `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `N8N_WEBHOOK_AUTH_HEADER`, `CLINIC_SLUG`, `ALLOWED_ORIGINS`, `N8N_TIMEOUT_MS`; controlled live test: `FLOWHQ_WA_SEND_MODE=off`, `FLOWHQ_ALERT_EMAIL_TO` empty.
