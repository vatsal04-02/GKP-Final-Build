# TESTING: what actually ran, and what did not

All data is synthetic (`Test Patient`, `+91 98765 43210`, numbers `+91 98000 000xx`, `+91 9000000xxx`); Grist, Meta, the AI provider and SMTP are fakes on the local machine. **Nothing was tested against the live Vercel site, live n8n, live Grist, real WhatsApp/Meta, real SMTP or a real AI provider.** Run on 2026-10-16 from this tree.

## Passed
| Component | Check | Result |
|---|---|---|
| Website | `npm ci`; `npm run build` | OK (1 page, sitemap) |
| Website | `npm run check` (astro check, TypeScript) | 0 errors, 0 warnings (43 files) |
| Website | `npm test`: `api/enquiry.mjs` + shared rules | 18 / 18 |
| Website | mutation check of the API (6 mutants: honeypot, consent mapping, origin check, consent forwarding, request-id cache, secret header) | 6 / 6 killed (re-run on this tree) |
| Website | browser test in Chromium against the built site with the real API function and a fake n8n | 11 / 11 (valid, double click, invalid phone, missing name, CRM down + WhatsApp fallback + retry, timeout, consent separate, consent required, refresh, honeypot, 390 px width) |
| CRM app (`flowhq/`) | `npm ci`; `npm run typecheck`; `npm test` (vitest); `npm run build` | clean; 158 / 158 (10 files); OK |
| n8n source lineage | `node n8n/tests/run-all.js` | all 48 test files pass |
| n8n selected files | `node n8n/final/tests/final.test.js` (shape, sanitization idempotent, no secret / personal number / e-mail / tailnet host, config from env, `LEADS`, credential audit, proposed = authoritative + documented fixes) | 6 / 6 |
| n8n reference export | `run-tests.js reference`: 15 simulator suites + mutation | 205 checks, 0 failures (mutation 30 / 30 killed) |
| n8n selected workflow, as supplied | `run-tests.js authoritative` | 169 passed, 6 known findings (F-ID, F-CRED-NAMES ×3, F-AI-01, F-CRED-ROLE), 0 unexpected |
| n8n proposed workflow | `run-tests.js proposed` | 169 passed, 5 known findings (F-AI-01 gone), 0 unexpected |
| Website → W1 → mocked Grist | `website-w1.test.js`: contract test (the website's real payload equals the fixture), consent separate from the enquiry, today's `REQUIRE_CONSENT=true` behaviour, repeat/duplicate, Grist failure (no 200), no Meta/e-mail/AI, downstream consent, race guard | 18 / 18 on reference, selected and proposed |
| Consent and message safety | `consent.test.js` 7; `senders.test.js`; `w12.test.js` 17 (W12 gate, ledger, quiet hours, test mode, opt-out); downstream consent tests (a no-consent website lead gets no message from W6/W3) | pass (senders: 1 known finding on the selected file) |
| W13 | `w13-visible-skip.test.js`: closed AI gate is visible (`AI_Status=skipped`), valid message → valid plan, missing input, AI down, invalid AI output, no consent, opt-out/paused/handoff, emergency | 13 / 13 (selected: includes the F-AI-01 "as supplied" check) |
| Real n8n 2.43.5 (scratch instance, fake Grist/Meta/AI, real Mailpit, clock 11:00 IST) | `real-n8n.test.js` (reference export) | 11 / 11 |
| Real n8n | `website-real-n8n.test.js`: website function → real webhook with header auth → Grist; wrong secret and test URL; Grist down; **40 simultaneous same-phone pairs** (reference export + race guard) | 5 / 5; 0 of 40 pairs produced two leads (the guard fired); **without the guard 7 of 60 pairs did** (measured earlier on the same export) |

## Not run / not verifiable here
* Live Vercel deployment (the function ran under Node with its handler signature, not on Vercel), live n8n, live Grist, real Meta/WhatsApp, real SMTP, a real AI provider: **not tested.**
* The selected workflow was **not** run inside real n8n (its credential ids exist only in the clinic's instance); the real-n8n tests use the reference export (identical W1 code nodes; checked). The selected file was tested in the simulator and structurally.
* Credential values and what `OpenRouter API` / `Header Auth account 2` really contain: not seen (F-CRED-ROLE).
* The real clinic slug and the live `LEADS` table: not seen.
* A real stalled n8n (the timeout path was simulated); two browsers racing through real n8n (the race was driven through the function); Lighthouse/accessibility audit of the changed form; `flowhq` end-to-end browser tests (`npm run test:e2e*`); no lint step exists in the website or CRM projects.
* `n8n/production/tests/real/*` need an n8n installation, Node ≥ 24, libfaketime and (optionally) Mailpit; `run-tests.js` does not need them.
