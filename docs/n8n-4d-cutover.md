# n8n cutover: replace the deployed V4 workflow by 4D (PREPARED, NOT EXECUTED)

Nothing in this document has been run against production. Every mutating step is a script in `scripts/4d/` that refuses to run without `CONFIRM=yes` (the owner's approval). Read-only checks (`00-preflight.sh`, `80-verify.sh`) can be run any time.

## 1. What 4D is, and what is verified (31 Oct 2026)
`n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4d.json` = **4C + V4's AI retry/backoff + an allowlist gate**, built reproducibly by `n8n/final/tools/build-4d.js`. Inactive, own id `F4dRetryd0c49396` (never the id of a deployed workflow, so an import cannot overwrite V4).

| Check | Result |
|---|---|
| Graph: unique names/ids, no dangling connections, nothing unreachable that 4C did not already have | pass (`4d-integrity.test.js`) |
| Webhooks: exactly V4's four (`POST website-lead`, `POST cal`, `GET`+`POST whatsapp-inbound`), unique webhook ids | pass |
| Credentials by role: website-lead protected by the dedicated `FlowHQ W1 Webhook Auth`; AI credential only on the two model calls; Grist/WhatsApp credentials never on the wrong node; booking credential only on the 2 booking-API nodes | pass |
| **One appointment-writing path:** W13/W12/W15/W2 never write Appointments; the only direct Grist writers are W4 (Cal.com legacy sync, kept for existing Cal.com bookings) and reminder/confirmation **flags** | pass |
| API contract: every request W13 makes (create, get, move, cancel, availability) is validated in 14 journeys against `helpers/booking-contract.js`; FLOW HQ's real routes are tested against the same module (`flowhq/tests/booking-contract.test.ts`, 17 cases) | pass |
| Patient-phone ownership (wrong phone = 404 for get/move/cancel), duplicate prevention (same key replays, same patient+slot = 409, one row), cancel idempotent, reschedule keeps the reference | pass (FLOW HQ vitest) |
| Reminders and consent (explicit `Reminder_Consent`, Pending not reminded, opt-out wins, no Cal.com link) | pass (`4c-consent.test.js`, runs on 4D) |
| Private endpoint `http://flowhq:8787` | n8n container -> FLOW HQ health 200; unauthenticated booking call 401; public domain 404 (31 Oct, read-only) |
| Real n8n 2.43.5 + real Grist + real FLOW HQ, 12-step journey (WhatsApp and AI stubbed) | 12 / 12 |
| FLOW HQ suite / typecheck | 498 passed, 40 skipped / clean |
| n8n suites (reference, authoritative, 4C, 4D) | 0 unexpected failures on Linux CI (5 shell `ops` tests fail only on Windows) |

### Defects found and fixed while preparing the cutover
1. **V4's credential misbinding does not exist in 4D.** Live V4 binds the website-lead webhook and several Grist nodes to the credential `OpenRouter API`. 4D uses the dedicated `FlowHQ W1 Webhook Auth` and Grist credential per role; `4d-integrity` enforces it.
2. **V4's FLOW HQ gateway cannot work with FLOW HQ** (needs `https://`; expects `shifts` as a list and a `shift`/`doctor` shape; sends `date/start/doctor_id` in strict bodies; omits `patient_phone` on get/move/cancel). 4D does not use it; W13 uses the contract-tested central nodes.
3. **Allowlist was enforced only at the send.** With external AI on, a real patient's message would have been sent to the AI provider before W12 blocked the reply. 4D skips (visibly) any number not on `FLOWHQ_WA_ALLOWLIST` while `FLOWHQ_WA_SEND_MODE=allowlist` (`4d-allowlist-gate.test.js`).
4. **The n8n fake API was lenient.** It now enforces the real strict contract in every journey.
5. `.dockerignore` (earlier): the image can no longer pick up host `node_modules` or env files.

### Open findings that are NOT code (need the owner)
- `FLOWHQ_CAL_WEBHOOK_SECRET` is **not set** in n8n: W4 cannot verify Cal.com webhooks, so Cal.com sync is not trustworthy today.
- `FLOWHQ_AI_MAX_REPLIES_PER_HOUR=1000` in production (plan: 12).
- Meta template names/approval status for confirmations and reminders are **unverified** (`docs/n8n-4c-changes.md`).

## 2. Design rules that stay true
- **Replies vs reminders.** An inbound message permits a reply inside the 24 h window (`Consent_WhatsApp`, set by W2 while `FLOWHQ_W2_IMPLIED_CONSENT=true`: keep it `true`). Reminders need an explicit `Reminder_Consent` = Yes recorded by staff with evidence. Unknown stays Unknown, opt-out always wins, the AI cannot record consent, nothing is migrated without the approved registration form.
- **One writer.** Appointments are created, moved and cancelled only by FLOW HQ (staff in the Schedule page, or W13 through the booking API after an explicit YES). Cal.com keeps syncing existing bookings through W4 until `docs/calcom-cutover.md`.
- **Quiet hours** 21:00-08:00 IST, `Opted_Out`, `Automation_Paused`, `TEST_MODE`, send ledger: unchanged.

## 3. Production environment plan (server `.env`, never in git)
| Variable | Now | After step 20 | Note |
|---|---|---|---|
| `FLOWHQ_AI_MAX_REPLIES_PER_HOUR` | 1000 | **12** | approved limit |
| `FLOWHQ_BOOKING_API_URL` | empty | **`http://flowhq:8787`** | private Docker address; the public domain blocks `/api/booking/*` |
| `FLOWHQ_WA_SEND_MODE` | allowlist | allowlist | unchanged until the owner approves live |
| `FLOWHQ_WA_ALLOWLIST` | 1 number | unchanged | |
| `FLOWHQ_W2_IMPLIED_CONSENT` | true | true | reply permission only |
| `FLOWHQ_AI_EXTERNAL_ENABLED` | false | false | switched on only for the supervised test (section 6) |
| `FLOWHQ_CAL_WEBHOOK_SECRET` | empty | set by the owner | needed for W4 |
Optional, have defaults (not passed by compose): `FLOWHQ_AI_RETRY_MAX_ATTEMPTS` (3), `_BASE_SECONDS` (2), `_MAX_WAIT_SECONDS` (20), `FLOWHQ_AI_BASE_URL`, `FLOWHQ_WA_GRAPH_BASE_URL`.

## 4. Token and credential mapping
| n8n credential | id | Header | Value source | Used by |
|---|---|---|---|---|
| FlowHQ Booking API (**new**) | `FhqCredBooking01` | `Authorization` | `Bearer ` + token from `booking-token` (step 30) | `W13 – Booking availability`, `W13 – Booking API` |
| FlowHQ W1 Webhook Auth (**new**) | `FhqCredW1Hook001` | `X-Lead-Secret` | new random secret (step 40) = Vercel `N8N_WEBHOOK_SECRET` | `W1 – Webhook` only |
| Header Auth account 2 | `9J6XxrIQoFDcQZ0Y` | existing | existing (Grist) | all Grist nodes |
| WhatsApp Cloud API | `k01hgCFOtdH5hdiq` | existing | existing | `W12 – Meta send` |
| OpenRouter API | `As1GpZb3W665Na7C` | existing | existing | the two model calls |
| Telegram account / SMTP account | existing | | | alerts |
Token scopes (all six, nothing else): `config:read availability:read appointments:read appointments:create appointments:update appointments:cancel`, 90 days, id `n8n-whatsapp`, clinic `demo-clinic`. FLOW HQ keeps only a hash; the token goes to `~/.4d-secrets/booking-token` (mode 700 dir, 600 file), is never printed, and the secrets directory is shredded when the cutover is done (`shred -u ~/.4d-secrets/*`). Rotate every 90 days (`docs/runbooks.md` section 7).

## 5. Cutover commands (run on the VPS as `deploy`, in `~/GKP-Final-Build`)
**Step 0: put the 4D files on the server** (code of `main`; FLOW HQ itself does not change, so no restart). From your PC, after CI is green on the target commit:
```bash
git archive --format=tar.gz -o gkp-main.tar.gz origin/main && sha256sum gkp-main.tar.gz   # note the hash
scp gkp-main.tar.gz deploy@201.18.202.128:deploy-staging/
# on the server: verify the hash, then add what differs WITHOUT touching .env, flowhq/.env, users.json, node_modules, backups
S=~/deploy-staging/main; rm -rf $S; mkdir -p $S; tar xzf ~/deploy-staging/gkp-main.tar.gz -C $S
diff -rq $S . --exclude=.env --exclude='.env.*' --exclude=users.json --exclude=node_modules --exclude=backups --exclude='*.tar.gz' --exclude='docker-compose.yml.before-oidc-fix' --exclude='hash-password*'   # read the list
tar -C $S -cf - . | tar -C ~/GKP-Final-Build -xf - --no-same-owner --no-same-permissions   # overlay (no deletes)
chmod 755 scripts/*.sh scripts/4d/*.sh
```
Then, each after the owner's go-ahead:
```bash
./scripts/4d/00-preflight.sh                      # read-only: must say PREFLIGHT PASSED
CONFIRM=yes ./scripts/4d/10-backup.sh             # encrypted volumes + workflow export + image tag; ~1 min of downtime for n8n/Grist/FLOW HQ
CONFIRM=yes ./scripts/4d/20-env.sh                # .env: AI limit 12, FLOWHQ_BOOKING_API_URL (copy saved as .env.pre-4d-<stamp>)
CONFIRM=yes ./scripts/4d/30-token.sh              # issues the scoped token, restarts FLOW HQ, proves it with READ-ONLY calls
CONFIRM=yes ./scripts/4d/40-credentials.sh        # creates the two new n8n credentials; prints the owner's Vercel instruction (not the secret)
CONFIRM=yes ./scripts/4d/50-import.sh             # imports 4D INACTIVE; V4 untouched
CONFIRM=yes ./scripts/4d/60-recreate-n8n.sh       # recreates ONLY n8n to read the env; V4 keeps running
./scripts/4d/80-verify.sh                         # read-only integration check
```
The supervised test (section 6) needs 4D active, so the order is: steps 10-60, open the editor (admin IP only) and confirm 4D shows no red credential badge, then run `70-swap.sh` at a quiet time inside 08:00-21:00 IST, then section 6. `70-swap.sh` rolls itself back if its own checks fail.
```bash
CONFIRM=yes ./scripts/4d/70-swap.sh               # V4 off, 4D on (one n8n restart); self-checks; auto-rollback on failure
./scripts/4d/80-verify.sh
```
The website enquiry form is **not connected today** (Vercel has no environment variables and V4's webhook uses the wrong credential): the full diagnosis, the five Vercel variables and the exact commands are in `docs/website-lead-integration.md`; the 4D swap is what fixes the n8n side. Owner action at the swap: set Vercel `N8N_WEBHOOK_SECRET` to `cat ~/.4d-secrets/w1-webhook-secret` (read it yourself; never paste it anywhere) and redeploy the website, **or** leave the form on the n8n test URL until then. Until then website enquiries to the production webhook get 403 (V4 accepted a different header).

## 6. Supervised real-model and real-WhatsApp test (needs the authorized test number)
Preconditions: 4D active, `booking_enabled` OFF, `FLOWHQ_WA_SEND_MODE=allowlist` with ONLY the authorized test number, `TEST_MODE=true` in Grist Settings with `TEST_PHONE` = that number, window 08:00-20:30 IST, staff told. The allowlist gate means other patients' messages are skipped, not sent to the model.
1. Set `FLOWHQ_AI_EXTERNAL_ENABLED=true` in `.env`, `docker compose ... up -d --no-deps n8n`; set Settings `ai_mode = draft` first (AI decides, staff approves), then `auto`.
2. From the test number: greeting; a pricing question (expect the Rs 500 fee); a clinic-hours question; "I want to book tomorrow" (expect real free times from FLOW HQ, doctor and shift named, **no booking yet**).
3. Reply YES: expect ONE appointment in Schedule with the right doctor/shift, booking reference, Audit row; the patient is told "booked" only after read-back. Send YES again / re-deliver: still one appointment.
4. Ask to reschedule then cancel: each asks first; same reference moves; cancel frees the slot; Schedule and `Booking_Audit` show every step.
5. Send `STOP`: opt-out recorded, no further automated message. Send an emergency phrase: hand-off to staff, no AI booking.
6. Staff pause the conversation (Human handling): a new message gets no AI reply.
7. Confirm in n8n/FLOW HQ logs that only the test number reached OpenRouter. Switch `FLOWHQ_AI_EXTERNAL_ENABLED` back to `false` (recreate n8n) if the owner does not approve go-live.
Stop immediately on any wrong or unexpected message: `docs/runbooks.md` section 6 (the "stop the AI" ladder) or `90-rollback.sh`.

## 7. Operational verification matrix (what must pass before patient-facing booking)
| Area | How | Expected |
|---|---|---|
| Staff booking (works with `booking_enabled` OFF) | Schedule > New appointment for a synthetic patient | appears in Day/Week, correct doctor and shift, audit row |
| Doctors and hours | Schedule > Doctors & hours: owner reviews the seeded 2 doctors, Mon-Sat 09:00-13:00 and 16:00-20:00, 30 min, capacity 1, 120 min AI notice | matches the clinic |
| Live availability | `80-verify.sh`; Schedule day view | slots from FLOW HQ only |
| Create + read-back, duplicate prevention | section 6 steps 3 | one row; replay returns the same reference |
| Reschedule / cancel | section 6 step 4 | same reference moves; slot freed; audit |
| Consent | Schedule drawer: record Yes with evidence for one synthetic patient; W5 reminds only that patient; Unknown and Pending are not reminded; STOP wins | Run_Log shows the skip reasons |
| Human hand-off / pause | section 6 steps 5-6 | staff alert, no AI reply |
| Audit recovery | `docs/booking-operations.md` "Audit outbox"; `/api/health` `audit_outbox: ok` | ok / red banner behaviour as rehearsed |
| Rollback | `90-rollback.sh` rehearsed on staging/copy first | V4 live, token revoked |
Reminders go only to patients with a recorded explicit `Reminder_Consent` and only with Meta-approved templates; marketing stays off.

## 8. Rollback (exact)
```bash
CONFIRM=yes ./scripts/4d/90-rollback.sh   # 4D off, V4 on, .env restored, n8n recreated once, token revoked + FLOW HQ restarted, baseline verified
```
Manually, if the script cannot run: in the editor deactivate 4D and activate V4 (applies immediately); `cp -p .env.pre-4d-<stamp> .env && docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --no-deps n8n`; `docker exec <flowhq> node dist/tools/booking-token.mjs revoke n8n-whatsapp && docker compose ... restart flowhq`. Switch `booking_enabled` OFF in Schedule. Data restore only if data itself was damaged: `scripts/restore.sh <archive>` (`docs/runbooks.md` section 3). Backups: `~/backups/4d-cutover-<stamp>/` (and the earlier `pre-deploy-*`, `pre-provision-*`); the raw V4 export stays outside git.

## 9. Approvals and inputs still required from the owner
1. Go-ahead for the production n8n changes (steps 20-70) and for the maintenance window (about 1 min of backup downtime, ~1 min webhook gap at recreate, ~1 min at the swap).
2. Confirmation that `+919322146560` is the authorized test number (the allowlist today).
3. Meta: template names and approval status for booking confirmation and reminders (and the WhatsApp Business messaging limits for the number).
4. The actual **registration form** (consent wording review; no consent migration or backfill before it).
5. `FLOWHQ_CAL_WEBHOOK_SECRET` (the secret configured in Cal.com) so W4 can verify Cal.com events.
6. The Vercel change (`N8N_WEBHOOK_SECRET`) at the swap, done by the owner.
7. Who built V4 and whether anything in it must be kept (nothing else in V4 is lost: its AI retry is in 4D).
8. Review of the seeded doctors/hours in Schedule, and the decision to turn `booking_enabled` ON (staff-managed first; AI booking only after section 6 passes).

## 10. Final checklist
- [ ] CI green on the commit being deployed; tarball hash noted; Step 0 diff reviewed
- [ ] `00-preflight.sh` PASSED; owner approvals 1-3 given
- [ ] `10-backup.sh` done; checksums verify; copy off the server
- [ ] `20-env.sh`, `30-token.sh`, `40-credentials.sh`, `50-import.sh`, `60-recreate-n8n.sh` done; `80-verify.sh` PASSED; 4D shows no red credential badge
- [ ] Quiet window chosen; owner ready for the Vercel change; test number in hand
- [ ] `70-swap.sh` done; `80-verify.sh` PASSED; website-lead 403 without the secret, 200 with it
- [ ] Section 6 supervised test passed, results recorded
- [ ] Section 7 matrix passed; owner approves; `booking_enabled` ON (staff-managed), then one controlled booking, then AI booking
- [ ] Reminders enabled only for patients with recorded Reminder_Consent; marketing off
- [ ] Secrets directory shredded; token rotation date noted (90 days)
