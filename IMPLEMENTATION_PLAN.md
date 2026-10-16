# Geeta Krishna Physiotherapy CRM: what was built, and what is verified

Working branch: `claude/adoring-darwin-9py5im`, which contains `claude/vibrant-ptolemy-9nynv9` (the real FlowHQ implementation) merged in. `main` has no FlowHQ code (its history holds only an orphan zip commit). Work is done in place in `flowhq/`; nothing under `n8n/`, `docker-compose*.yml`, `Caddyfile` or `grist/schema.md` was changed.

## Architecture (as found)
React 18 + Vite + Tailwind + TanStack Query front end → one Hono "BFF" Node process → Grist REST with a server-side API key. n8n (W1–W13) is a separate writer to the same Grist doc and is **not** in the CRM page data path. Clinic lookup goes through the Agency Registry doc. Auth = scrypt users, signed cookie, CSRF header, roles `admin`/`staff`.
Consequence: the new patient/prescription/invoice operations live in the BFF (which already holds the Grist key and enforces auth), so **no n8n workflow, webhook or credential was touched**.

## What changed
| Area | Change |
|---|---|
| Theme | Existing CSS tokens re-pointed to the clinic palette (light default, dark kept); GK monogram brand (`src/core/brand.ts`); orange only on primary buttons. Two deliberate deviations for WCAG AA: button fill `#C93F08` (white text 5.0:1; `#F4510B` is 3.5:1) and secondary text `#5F6A65` (`#78817C` is 3.7:1 on cream). |
| Data | Additive tables in the **existing clinic doc** (not a separate doc: smaller change, no registry edit): `Patients, Prescriptions, Rx_Images, Invoices, Invoice_Lines, Payments, Visits, Audit_Log`. Spec: `grist/clinic-records-schema.md`. Created by `npm run provision-records` (dry run by default, additive only). |
| API | `src/server/records/` (service + routes) mounted under `/api/w/:ws`, behind the existing auth/CSRF/workspace checks. `GristClient` gained attachments + schema calls; existing methods untouched. |
| UI | `src/web/clinical/`: register + patient record, prescriptions, invoices/payments, attendance, A4 print views. Registered through the existing module registry/routing; modules appear only if the clinic doc has all the tables. |
| Naming | The physiotherapy profile now calls leads **Enquiries** (leads ≠ patients). Two existing tests were pointed at the generic `clinic` profile accordingly. |
| Guard test | `web-words.test.ts` still bans industry words everywhere except `src/web/clinical/`. The "only `/api` network calls" rule still covers every file. |

Files edited outside the new code: `core/domain.ts` (module keys), `core/registry.ts`, `core/industries/index.ts`, `server/grist.ts` (additive), `server/app.ts` (mount + error extras), `server/index.ts`, `server/config.ts`, `adapters/types.ts` + `adapters/autopilot/index.ts` (records hook), `web/App.tsx`, `Shell.tsx`, `primitives.tsx`, `lib/api.ts`, `lib/theme.tsx`, `lib/icons.ts`, `styles.css`, `tailwind.config.js`, `index.html`, `deploy/docker-compose.flowhq.yml` (mount clinic.json), `.env.example`, `README.md` (section L).

## Verification status (what was actually run)
| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` (vitest) | see the final verification pass below |
| `npm run build` | OK |
| `node n8n/tests/run-all.js` | **47 / 47 pass**, unchanged |
| Real browser (Chromium), `npm run test:e2e:clinical`, FlowHQ demo server | register → duplicate warning → refresh → search → prescription + photo → save → refresh → reopen → version 2 → print view → invoice (double-click = 1 invoice) → overpayment refused → payment → balance → register totals → attendance; no console errors on any existing page. |
| Print | Prescription (with photo) = **1 A4 page**; invoice = 1 A4 page; both rendered to PDF in Chromium; no nav/sidebar/buttons in print. |
| Phone width (390 px) | no sideways page scroll on any clinical page |

**Not verified:** the live n8n, WhatsApp, Cal.com, and the clinic's own production Grist and users. The vitest suites and the browser run use the in-memory Grist fake (it rejects unknown columns but is not Grist). The browser run (UI) was **not** repeated against a real Grist. The existing Playwright suite (`npm run test:e2e`) was not run.

## Real Grist (grist-core built from source, temporary local instance, synthetic data): 27/27 checks pass
Run through the real `provision-records` tool and the real FlowHQ API (login, CSRF, routes) against a real Grist server:
- provisioning: dry run changes nothing; `--apply` creates all 8 tables; the second `--apply` is a no-op; `Rx_Images.File` is a real `Attachments` column, dates are real `Date` columns
- a patient, prescription and photo saved through FlowHQ: the attachment in Grist is **byte-identical** to the upload; the photo is served back byte-identical to a signed-in user and refused (401) without a session
- two simultaneous submits of one invoice form = one invoice + 2 lines in Grist; totals stored as integer paise (305050 / 100000 / 205050); overpayment refused; final payment → paid; attendance and audit rows written
- **persistence**: a brand-new FlowHQ instance (nothing in memory) shows the same register totals, the patient record (prescription, photo, invoice, 2 payments, visit) and the photo
- no Grist doc id in any response
Setup notes learned: Grist needs `GRIST_IN_SERVICE=true` and a login method (production already has Google login); the FlowHQ API key's Grist user needs edit rights on the clinic doc. Not covered: Grist access rules (ACLs), Google login, upgrades of an existing live doc.

## Decisions made (defaults; easy to change)
Records in the existing clinic doc · both roles can create invoices/payments, only admins void · no tax unless `config/clinic.json` has a real rate · photos in Grist attachments · invoice numbers `GK-<year>-<6 digits>` restarting each year · leads relabelled Enquiries · split clinic hours left alone (Settings holds one window, so W13 could offer 1–4 PM slots; separate fix).

## Known limits / pending
Single FLOW HQ process assumed (locks are in-process). The register loads whole tables per request. No signature capture. No compliance claim: a privacy review is needed before real patient data. Not deployed.


---

## Final verification and hardening pass

### Split opening hours (Mon-Sat 09:00-13:00 and 16:00-20:00, Sunday closed)
- **Settings**: new optional key `open_hours` (`09:00-13:00, 16:00-20:00`; 12-hour forms accepted; up to 4 windows). Absent = the old `open_time`/`close_time` single window, unchanged. Present but unreadable = **no times offered** (never guesses, never falls back to a wider window). `working_days` still decides Sunday.
- **Choke point**: `aiFreeSlots` in `n8n/snippets/ai-receptionist.js`. Offering, booking (direct and link mode) and rescheduling all validate against its output, so a time that is not generated cannot be offered or booked. A slot must start **and end** inside one window; each window restarts its own grid; notice period, existing bookings (any length, including one spanning lunch), capacity and cancelled bookings still apply; dates and hours are India time.
- **Embedded copies**: regenerated with the repo's own generators (W13 x2, stage1, ai-os, w7-w10, quiet-hours-test, master + release copy). Verified against the FlowHQ branch: in all 8 files only the `jsCode` of the 4 W13 Code nodes differs (webhooks, credentials, connections, settings identical); `n8n/workflows/*` untouched. A workflow already at the previous version upgrades to exactly the new master with `apply-w13-prompt.js`.
- **FlowHQ**: Settings has an "Opening hours (with a break)" field validated by the receptionist's own parser.
- **Not covered by this change** (decisions needed): **W3** (staff alerts for new leads) still reads only `open_time`/`close_time`; keep them at 09:00/20:00 (it never offers or books anything). **Cal.com** decides what a patient can pick on the booking link in link mode (set its availability to the same two windows, Sunday off); W4 does not reject out-of-hours Cal.com bookings. The **Knowledge** table must state the hours for the AI to answer "what are your timings".

### What was run, and against what
| Check | Storage | Result |
|---|---|---|
| `npm run typecheck`, `npm run build` | - | clean / OK |
| `npm test` (vitest, 10 files) | in-memory Grist fake | **158 / 158** |
| `node n8n/tests/run-all.js` | n8n simulator + fake Grist | **48 / 48** (47 existing + `ai-split-hours.test.js`) |
| `npm run test:e2e` (existing Playwright suite) | demo (in-memory) | **22 / 22** |
| `npm run test:e2e:clinical` (browser: register, refresh, prescription + photo, print, invoice, double click, payment, attendance) | demo (in-memory) | **25 / 25** |
| same browser flow, FlowHQ in real mode (`demo:false`) | **real Grist**, FlowHQ running as a restricted *editor* service identity with Grist access rules active | **25 / 25** |
| API-level run through the real FlowHQ API (provision, patient, Rx, photo bytes, invoice, simultaneous double submit, payment, new-instance persistence) | **real Grist** | **27 / 27** |
| FlowHQ authorization / abuse checks (sessions, CSRF, other-clinic isolation, roles, cross-record integrity, upload attacks, mass assignment, script injection on 9 pages incl. print) | **real Grist** behind real-mode FlowHQ | **28 / 28** |
| Grist access rules (editor / viewer / anonymous / service identity / owner, 8 tables) | **real Grist** (header-auth identities) | **24 / 24** |
| Provisioning: dry run, apply on a doc with 7 existing tables + a half-made `Patients` table with rows, second apply | **real Grist** | **9 / 9** (existing tables byte-identical in rows and column types; dry run changes nothing) |
| Print stress (3-page prescription with 4 photos, 25-line invoice, voided invoice) and 390 px width on 11 pages | **real Grist** data | pass, after fixing two page-break defects |

Grist used for the "real" rows: `grist-core` built from source (community edition), a throwaway local instance, synthetic data only. Not the clinic's Grist and not the `gristlabs/grist` Docker image.

### Defects found and fixed in this pass
1. Existing e2e assumed a dark default theme (two assertions) - tests made theme-agnostic.
2. Clinical modules were enabled only for the `physiotherapy` industry: a real workspace on the shipped default industry (`clinic`) showed leads as "Patients" and no clinical pages. They now switch on for any industry when the records tables exist (leads become "Enquiries"; an explicit workspace rename still wins).
3. Cold-start race: the first page load after a restart could be served a workspace without the clinical pages. Concurrent requests now share one probe (regression test fails on the old code).
4. Demo mode seeded the records tables into all three demo businesses (existing e2e caught it) - now physio only.
5. Editing a patient re-warned about duplicates on every save when the patient was a known duplicate - now only for changed name/phone.
6. Print: the items table of a long invoice jumped to page 2 leaving page 1 nearly empty; the photos heading was orphaned from its photos - fixed.
7. My own checks were hardened where they could pass vacuously (injection check, bad-decision test paths).

### Remaining blockers / not verified
- **Production Grist**: access rules are not applied anywhere real; the recipe is in `grist/clinic-records-schema.md` and was verified on a local Grist. Apply it, then test one write as a front-desk login. Production uses Google login, whereas the test used header identities (same rules engine, different login).
- **Live n8n**: nothing was imported or run in a live n8n. Updated workflows are repo artifacts; import/patch them (inactive first) and run one real test. Webhook paths, credentials and connections are unchanged.
- **Docker deploy overlay** (`deploy/docker-compose.flowhq.yml` mounts `config/clinic.json`): not run (no Docker daemon here).
- **Privacy / compliance**: no claim; a review is needed before real patient data. Single FlowHQ process assumed (ID locks are in-process). No signature capture. Not deployed.
