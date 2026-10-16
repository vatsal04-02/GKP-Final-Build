> Working copy written before the consolidation (paths and branch names refer to the earlier worktrees). Current versions: `docs/TESTING.md`, `docs/ROLLBACK.md`, `docs/SOURCES.md`, `docs/KNOWN_FINDINGS.md`.

# TEST PLAN AND RESULTS (synthetic data only)

All people, numbers and secrets in these tests are made up (`Test Patient`, `+91 98765 43210`, `synthetic-test-secret-…`). Grist, Meta, the AI provider and SMTP are fakes on this computer; nothing was sent anywhere and no AI provider was called.
Legend: **SIM** = n8n simulator with fake services (`tests/website-w1.test.js`) · **REAL** = the installed n8n 2.43.5 started in a scratch folder with fake services (`tests/real/website-real-n8n.test.js`) · **API** = `npm test` in the website repo · **BROWSER** = real Chromium against the built site (`tests/e2e/booking-browser.mjs`).

| # | Case | Input | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| 1 | Valid enquiry | name, `+91 98765 43210`, Back Pain, Home visit, Mon 6, Morning, box unticked | stored in LEADS (Source Website, Status New, consent false, Enquiry composed); visitor sees "received…not confirmed"; no message | as expected in all four layers | PASS | API 1; SIM 1/1b; REAL R1; BROWSER "valid request" |
| 2 | Missing name | `name: "   "` | 422, nothing forwarded / stored; inline error in the form | as expected | PASS | API 2; SIM 3; BROWSER "missing name" |
| 3 | Invalid phone | `12345`, 9 or 11 digits, starts with 5, letters, empty, foreign | refused, never padded | 7 inputs refused; digits never invented | PASS | API 3; SIM 3; BROWSER "invalid phone" |
| 4 | Optional fields missing | name + phone only | accepted, empty `Enquiry`, consent false | as expected | PASS | API 4; SIM 4 |
| 5 | Duplicate submission | same request twice; same phone with a new request id | one lead; second answered "received"/`duplicate`; no second alert | one lead (n8n `duplicate`), one forward at the function | PASS | API 5; SIM 5; REAL R2 |
| 6 | Two simultaneous, same key | (a) same request id twice at once; (b) same phone, different ids, two tabs | (a) one forward; (b) one lead | (a) PASS. (b) **without the guard 7 of 60 pairs made two leads (REAL)**; with the guard **0 of 60**, guard fired 4 times | PASS with the proposed race guard (FAIL without it) | API 6; REAL R3 (before/after); SIM "SIMULTANEOUS" ×3 |
| 7 | Grist unavailable | Grist errors on create / re-read / delete | visitor never sees "received"; no lead; same request id succeeds after Grist returns; re-read or delete failure never blocks the answer | as expected | PASS | SIM 7 + 3 race tests; REAL R5 |
| 8 | n8n timeout | n8n never answers | function aborts at `N8N_TIMEOUT_MS` → 504 `timeout`; visitor told it *may not* have arrived and offered WhatsApp | as expected | PASS (n8n side simulated, not a real stalled n8n) | API 8; BROWSER "timeout" |
| 9 | Invalid / unexpected payload | array, non-JSON, wrong content type, 20 kB body, unknown concern/day/slot, GET, foreign or missing Origin, filled honeypot, n8n 401/404/500 | refused with the right status, n8n not called (honeypot: "received", not stored) | as expected | PASS | API 9, 9b–9e |
| 10 | Refresh / retry after a submission | reload after success; retry the same details after a failure | empty form, no new request; the retry reuses the same request id and succeeds | as expected | PASS | BROWSER "refresh", "CRM down" |
| 11 | Accurate visitor messages | success, validation, CRM down, timeout, consent required | success never says "confirmed"; failures never say "received"; details kept; WhatsApp + phone fallback shown | as expected | PASS | BROWSER (4 cases) |
| 12 | No real WhatsApp / e-mail / staff alert | `FLOWHQ_WA_SEND_MODE=off`, e-mail address empty | 0 Meta calls, 0 e-mails | 0 and 0 (REAL run used the real Mailpit binary) | PASS | SIM 12/13; REAL R1 |
| 13 | No external AI call | AI disabled | 0 AI calls; no AI node reachable from the W1 webhook | 0; graph walk found none | PASS | SIM 12/13; REAL R1 |
| 14 | Workflows and credentials intact | existing exports | no existing node, id, credential reference or URL changed by the patch; this branch changes no workflow file | the patch adds 6 nodes and changes only the connection leaving `Create lead`; new HTTP nodes copy the credential reference of `Find lead by phone` | PASS | SIM 14; `patch-w1-race-guard.js` self-check; `git diff` of the export is empty |

## Consent (decision 2)
| Check | Result |
|---|---|
| Enquiry with the box unticked and `FLOWHQ_W1_REQUIRE_CONSENT=false` is stored with `Consent_WhatsApp=false`, `Consent_At` empty, `Consent_Source "website-form (no consent given)"` | PASS (SIM 1, REAL R1) |
| Today's setting (`…REQUIRE_CONSENT=true`) with the box unticked: HTTP 400 and **nothing stored** (why the change is proposed) | PASS (SIM 2) |
| **DOWNSTREAM CONSENT:** such a lead, three days old and still open, with sending set to `allowlist` (a send would be possible), gets no patient message from W6 or W3; W3 alerts only the clinic | PASS (SIM) |
| The same lead with the box ticked IS eligible for the W6 follow-up (the gate is consent, not the website) | PASS (SIM) |
| W12 blocks a template to a patient without consent (existing suite `consent.test.js`) | PASS |
| Recommendation: `FLOWHQ_W1_REQUIRE_CONSENT=false` is safe **as far as these tests go**; W6 stays silent for such leads (audit A7) | |

## Other suites that ran
| Suite | Result |
|---|---|
| Website `npm test` (API + shared rules) | 18 / 18 |
| Website mutation check (6 mutants: honeypot, consent mapping, origin check, consent forwarding, de-dup cache, secret header) | 6 / 6 killed |
| Website browser (Chromium, built site, real `api/enquiry.mjs`, fake n8n) | 11 / 11 (incl. 390 px width: no sideways scroll) |
| Website `npm run build`, `npm run check` | OK, 0 errors |
| n8n `website-w1.test.js` on the production export + race guard | 18 / 18 |
| n8n `website-w1.test.js` on **your v1** (with the guard added in memory and as a file) | 18 / 18 (credential names given to the simulator with `SIM_CRED`) |
| Existing suites on production export + guard: static 14, phone 7, ops 15, templates 3, w1 15, w2 15, w4 16, w12 17, callers 16, senders 7, consent 7, email 8, w14 4 | all pass |
| Existing `w1` and `email` suites on **your v1** | 14/15 and 1/2: the two failures only assert the credential **names** `FlowHQ W1 Webhook Auth` / `FlowHQ SMTP`; v1 has `OpenRouter API` / `SMTP account` (audit A5). The guard does not change them |
| REAL n8n (scratch instance): website function → webhook → Grist | 5 / 5 (R1–R5) |

## Not tested (and why)
* The live Vercel deployment (the function ran under Node with its handler signature, not on Vercel), the live n8n, live Grist, real Meta/WhatsApp, real SMTP: not available / not allowed.
* Your credential values and the real clinic slug: not seen. `OpenRouter API` credential contents (audit A5): not seen.
* A real stalled n8n (case 8) and real concurrency on **your** exact v1 file: the REAL run used the repo's production export, whose W1 code nodes are identical to v1's (checked); v1's credential references would not resolve in a scratch instance.
* Two tabs in one browser racing the same phone through the real n8n from a real browser: the race was driven through the function, not two browsers.
* Lighthouse / accessibility audit of the changed form (only a 390 px layout screenshot check).
