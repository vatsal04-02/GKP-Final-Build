# TESTING: what actually ran, and what did not

All data is synthetic (`Test Patient`, `+91 98765 43210`, numbers `+91 98000 000xx`, `+91 9000000xxx`); Grist, Meta, the AI provider and SMTP are fakes on the local machine. **Nothing was tested against the live Vercel site, live n8n, live Grist, real WhatsApp/Meta, real SMTP or a real AI provider.** Run on 2026-10-16 from this tree.

## Passed
| Component | Check | Result |
|---|---|---|
| Website | `npm ci`; `npm run build` | OK (1 page, sitemap) |
| Website | `npm run check` (astro check, TypeScript) | 0 errors, 0 warnings (43 files) |
| Website | `npm test`: `api/enquiry.mjs` + shared rules (adds: the function refuses an OpenRouter-looking or `OPENROUTER_API_KEY`-equal webhook secret and forwards nothing) | 19 / 19 |
| Website | mutation check of the API (6 mutants: honeypot, consent mapping, origin check, consent forwarding, request-id cache, secret header) | 6 / 6 killed (re-run on this tree) |
| Website | browser test in Chromium against the built site with the real API function and a fake n8n | 11 / 11 (valid, double click, invalid phone, missing name, CRM down + WhatsApp fallback + retry, timeout, consent separate, consent required, refresh, honeypot, 390 px width) |
| CRM app (`flowhq/`) | `npm ci`; `npm run typecheck`; `npm test` (vitest); `npm run build` | clean; 158 / 158 (10 files); OK |
| n8n source lineage | `node n8n/tests/run-all.js` | all 48 test files pass |
| n8n selected files | `node n8n/final/tests/final.test.js` (shape, sanitization idempotent, no secret / personal number / e-mail / tailnet host, config from env, `LEADS`, credential audit: every credential serves exactly one role, authoritative = `apply-openrouter-config` applied to the as-supplied copy (16 nodes), proposed = authoritative + 6 race-guard nodes, `create-credentials --only`) | 8 / 8 |
| n8n reference export | `run-tests.js reference`: 15 simulator suites + mutation | 205 checks, 0 failures (mutation 30 / 30 killed) |
| n8n selected workflow (OpenRouter-configured) | `run-tests.js authoritative` | 188 passed, 3 known findings (F-ID, F-CRED-NAMES ×2), 0 unexpected |
| n8n proposed workflow (selected + W1 race guard) | `run-tests.js proposed` | 188 passed, 3 known findings (same), 0 unexpected |
| OpenRouter configuration (mocked provider, no network) | `n8n/production/tests/openrouter.test.js`: one switch for W13 and W9 (no literal override; the gate reads only Config), OFF/ON matrix, model passthrough, OFF still alerts on emergencies and honours STOP, invalid or missing model / foreign or look-alike endpoint stops W13 and W9, OFF ignores invalid AI settings, no key in `$env`, credential roles via the audit, the simulator rejects a role mix-up in both directions | 16 / 16 on the selected and proposed files (negative control: the as-supplied file fails 8 of 16) |
| Website → W1 → mocked Grist | `website-w1.test.js`: contract test (the website's real payload equals the fixture), consent separate from the enquiry, today's `REQUIRE_CONSENT=true` behaviour, repeat/duplicate, Grist failure (no 200), no Meta/e-mail/AI, downstream consent, race guard | 18 / 18 on reference, selected and proposed |
| Consent and message safety | `consent.test.js` 7; `senders.test.js`; `w12.test.js` 17 (W12 gate, ledger, quiet hours, test mode, opt-out); downstream consent tests (a no-consent website lead gets no message from W6/W3) | pass (senders: 1 known finding on the selected file) |
| W13 | `w13-visible-skip.test.js`: closed AI gate is visible (`AI_Status=skipped`), valid message → valid plan, missing input, AI down, invalid AI output, no consent, opt-out/paused/handoff, emergency | 13 / 13 |
| Real n8n 2.43.5 (scratch instance, fake Grist/Meta/AI, real Mailpit, clock 11:00 IST) | `real-n8n.test.js` on the **selected workflow** with its credentials re-mapped to scratch ones by role (`remap-credentials-for-scratch.js`, test only) | 11 / 11 |
| Real n8n | `website-real-n8n.test.js`: website function → real webhook with header auth → Grist; wrong secret and test URL; Grist down; simultaneous same-phone pairs. Run on the OpenRouter-configured **selected** workflow and on the **proposed** (race guard) one, credentials re-mapped by role | 5 / 5 on both. Race, 8 pairs this run: selected 1 pair produced two leads (no guard, known F-RACE-01), proposed 0 (the guard did not need to fire in this run; the earlier 40-pair run with the guard fired and gave 0 duplicates; without it 7 of 60 pairs duplicated) |

## Not run / not verifiable here
* Live Vercel deployment (the function ran under Node with its handler signature, not on Vercel), live n8n, live Grist, real Meta/WhatsApp, real SMTP, a real AI provider: **not tested.**
* The selected workflow was run in real n8n only through a copy whose credential references were re-mapped **by role** to scratch credentials (`remap-credentials-for-scratch.js`, test only), because its real credential ids exist only in the clinic's instance. Importing the file itself into the clinic's n8n was not done.
* No real OpenRouter request was ever made: the AI provider is a mock in every suite, including real n8n (`external AI enabled in real n8n` checks that one masked request reaches the fake provider).
* Credential values and what `OpenRouter API` / `Header Auth account 2` really contain: not seen (F-GRIST-CRED).
* The real clinic slug and the live `LEADS` table: not seen.
* A real stalled n8n (the timeout path was simulated); two browsers racing through real n8n (the race was driven through the function); Lighthouse/accessibility audit of the changed form; `flowhq` end-to-end browser tests (`npm run test:e2e*`); no lint step exists in the website or CRM projects.
* `n8n/production/tests/real/*` need an n8n installation, Node ≥ 24, libfaketime and (optionally) Mailpit; `run-tests.js` does not need them.
