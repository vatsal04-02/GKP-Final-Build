# Slice 4: revised plan

> **Approved with decisions D1-D7 (recorded at the top of `docs/booking-decisions.md`; they override this plan where they differ: notably D2, the website checkbox is NOT approved and no consent migration happens before the registration form is reviewed; D1, consent grants are explicit per user). Progress: **4A (audit outbox) built and tested; 4B, 4C, 4D not started** (each needs your review of the previous one).**

Original status (when the plan was written): **plan only.** No code, schema, workflow, production data or setting was changed to produce it. Nothing is deployed, provisioned or switched on, `booking_enabled` stays OFF,
and no message is sent to any real patient at any step. Implementation starts only after you approve this plan (ideally sub-slice by sub-slice, see section 8).

## 0. What the workflow audit found (read-only; it changes the plan)

I could only audit the copies in this repository, **not what is deployed**. The deployed n8n must be compared with them first (step 4C-0: a read-only export from the live n8n, credentials stripped, diffed against the files below; I will not connect to production myself).
There are two workflow families in the repo, and they behave differently:

| | Older `n8n/workflows/W*.json` | **Deployment candidate** `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json` (named in `docs/INSTALL.md` step 5) |
|---|---|---|
| W5 reminders | resolve the patient only via `Appointments.Lead`; `if (!lead) continue;` **silently skips** a booking with no lead | same silent skip, plus a `nextBestAction` hold (patient asked to cancel / reschedule); candidate fields come only from the Lead |
| W12 consent | **none** | **central consent gate**: a business-initiated TEMPLATE to a patient needs `LEADS.Consent_WhatsApp === true` on the lead found by phone and no `Opted_Out`; **no lead, unreadable lead or no consent = "blocked, not sent"**. Exempt: free text inside the 24 h window and TEST_MODE sends |
| W2 inbound | does not record consent | a lead created by an inbound WhatsApp message gets `Consent_WhatsApp = true`, `Consent_Source = whatsapp-inbound` (switchable with `FLOWHQ_W2_IMPLIED_CONSENT`, **default true**) |
| W1 website form | n/a | records `Consent_WhatsApp`, `Consent_Source = website-form`, `Consent_At`, `Consent_Version` |

What this means (and corrects my Slice 3 note, which said no consent check existed in W5 / W12):
1. In the **candidate**, W5 reminders already pass through W12's lead-consent gate. The gap is the opposite one: a **booking with no Lead can never be reminded** (W5 skips it, and W12 would block it anyway).
2. The only consent the system holds today is **generic**: `whatsapp-inbound` is implied by the patient starting a chat; `website-form` is the website tick-box. The draft form wording (`docs/PRIVACY_DRAFT.md`, version `DRAFT-2026-10-v1`, not approved) says "message you on WhatsApp about **this request and your care**": it does **not** clearly say appointment / treatment reminders and explains withdrawal only in the separate privacy notice. By your rule A, none of this is clear reminder consent. **Consequence: once reminder consent is explicit, almost every existing lead would be Unknown for reminders, so reminders to them stop until consent is recorded or evidenced.** That is a deliberate, large behaviour change; section 9 (R1) asks you to confirm it.
3. **There is no purpose classification anywhere.** W12 decides on `audience` and `message_type` only; `decideSend` knows `transactional | marketing` only for the pause rule. So a reminder-consent rule cannot be added "to every template" without also blocking replies and booking confirmations. Today `booking_confirmation` (sent by W4 for Cal.com bookings) goes through the same lead-consent gate as marketing templates.
4. The **registration form is not in the repository** (searched; only the website consent draft exists). Section 3 depends on you supplying the actual wording.
5. Who sends a booking confirmation for a booking made in the CRM (staff or AI)? **Nobody today**: W4 handles only Cal.com webhooks; the AI replies in free text inside the chat. Not changed by this plan; flagged in R7.

## 1. Message purposes (the rule must not be applied to every message)

A purpose is a property of the **template** (single source of truth in `wa-send.js`'s `WA_TEMPLATES`), not something each caller can choose or downgrade. Free text is always `reply`.

| Purpose | Messages | Rule |
|---|---|---|
| `reply` | free text inside the 24 h window to a patient who wrote first (W13 / W10) | no consent rule (window, quiet hours, opt-out, TEST_MODE as today). **Never blocked by reminder consent** |
| `booking_transaction` | `booking_confirmation` (and later cancel / reschedule confirmations) | the patient's own booking request; **not** governed by reminder consent. Sent unless opted out. Basis rule in D3 |
| `appointment_reminder` | `reminder_24h`, `reminder_2h` (W5) | reminder consent = Yes (section 3) AND not opted out AND appointment Confirmed (not Pending) |
| `followup_reminder` | `followup_reminder` (W15) | reminder consent = Yes AND not opted out |
| `engagement` | `followup_day2`, `noshow_rebook` (W6), `outcome_check` (W7), `review_request` (W8) | **unchanged**: today's `Consent_WhatsApp` + opt-out + pause rules |
| `staff_alert` | `new_lead_staff_alert`, `lead_escalation`, `human_handoff_alert`, `weekly_owner_report` | not patient-facing: unchanged |
Fail-safe default: a template with no purpose is treated as `engagement` (today's rule), so nothing is loosened by accident and nothing new is blocked until it is classified.

---

## 4A. Durable audit outbox with write-ahead recovery  (build FIRST: every later mutation uses it)

**Goal:** audit survives restarts, is never duplicated, is visible, and a booking can never be reported failed after it was saved.

**Mechanism: write-ahead intent, mutation, outcome, idempotent flush.**
1. **Intent (before the mutation).** Under the booking lock, after validation, the service appends `{t:'intent', audit_id, seq, at, actor, source, action, record, op}` to the outbox and **fsyncs**. `audit_id` is a UUID made now. **If the intent cannot be persisted (disk full, read-only volume, lock lost), the mutation is rejected BEFORE anything is written** (`503 audit_unavailable`, nothing changed, the admin banner turns red). Staff and AI both get a clear "booking is paused: the audit log cannot be saved".
2. **Mutation.** The same single Grist write that creates / changes the appointment also stores the `audit_id` (new column `Appointments.Audit_ID` = the last operation's id). So the row itself proves whether the operation was applied.
3. **Verify, then outcome.** After the existing read-back verification the service appends `{t:'outcome', audit_id, at, outcome, reason}` (fsync). If this append fails the response is **still the success it is** (the appointment is saved and verified); the pending intent is kept in memory and on disk, the admin banner shows it, and recovery finalises it. A saved appointment is never reported as failed because of audit.
4. **Flush to Grist, idempotently.** A single background flusher converts completed pairs into one `Booking_Audit` row carrying `Audit_ID` (new column), skipping any `Audit_ID` already present, then **verifies by read-back**, then appends `{t:'flushed', audit_id}`. A crash between insert and `flushed` just means the next pass sees the id already present and marks it flushed: **no duplicates**.
5. **Recovery on start (and whenever Grist returns).** For every intent with no outcome, the service looks the operation up by `Audit_ID` on the target row (create: a row with that `Audit_ID`; reschedule / cancel / status: the row's `Audit_ID` equals it): found = write outcome `ok` (also verifying fields), not found = outcome `aborted`. If Grist is unreachable the entry stays pending and visible, never guessed. An outcome without `flushed` is flushed.
6. **Other mutations** (settings incl. the AI switch, doctors, hours, blocks, consent): same intent / outcome, with `Audit_ID` also stored on their rows (`Booking_Config`, `Doctors`, `Doctor_Schedules`, `Closures_Blocks`, `Reminder_Consent`).
7. **Refusals and lookups.** A refused attempt (no mutation) writes a single outcome-only entry through the same file; if the outbox is unwritable it simply returns its original error (never masks it).
8. **No sensitive data:** entries hold only ids, action, outcome, reason code and non-personal detail (the same fields as today). No name, phone, free text, idempotency key or secret in the file, the logs or the alerts. The recovery lookup uses `audit_id`, not the idempotency key. The existing PII scan test is extended to the outbox file and every log line.

**Storage, volume, permissions.** Append-only JSON-lines `audit-outbox.jsonl` in a directory on the existing persistent `flowhq_config` Docker volume (already writable for workspace profiles): `FLOWHQ_AUDIT_OUTBOX_DIR`, default `config/audit-outbox/`. Directory `0700`, files `0600`, owned by the container's `node` user (the Dockerfile already `chown`s `config`). Not stored in Grist (a Grist outage is the failure it must survive) and not in the container's writable layer (lost on rebuild).
- **Single-writer guard:** a lock file (`outbox.lock`, pid + start time) taken at startup. A second FLOW HQ process on the same volume **refuses booking writes** with a clear error. This also gives a runtime defence for the documented single-process rule on a shared volume (it does not make multi-host safe).
- **Disk full / read-only:** intent append fails, so new mutations are rejected before writing (step 1); outcome / flush failures keep the pending entries in memory and retry; alarm red. **Nothing is ever dropped to make room.** A size warning at 5 MB; a flushed-entry compaction (atomic rewrite via temp file + fsync + rename) keeps the file small; unflushed entries are never compacted away.
- **Partial last line** (crash mid-append) is detected, ignored with a warning, never crashes startup; the preceding records are intact.
- **Backup and recovery (written as a runbook in `docs/booking-operations.md`):** include the volume in the host's daily snapshot and before every upgrade; the file is small. Restoring an older copy is safe because flushing is idempotent (`Audit_ID`), but any intent that has no outcome and no matching row is finalised as `aborted` by recovery. Manual commands (admin, on the server): `npm run audit-outbox -- status | flush | verify` (status never prints content). Runbook for "Grist down for hours", "disk full", "volume lost" (audit rows already in Grist are unaffected; only unflushed ones are lost, and the pending count in the last alert says how many).
- **Admin visibility:** Schedule page banner and `GET /schedule/overview`: waiting count, oldest age, last error. Amber after 5 min or 20 waiting, red after 30 min or 100 or any rejected-for-audit event; plus a `FLOWHQ AUDIT OUTBOX` error log line (counts only) that existing log alerting can watch.
- **Break-glass (documented, deliberate):** if the audit volume is unusable and staff must still book (for example the clinic is open and the disk is full), an admin on the server can set `FLOWHQ_AUDIT_BREAKGLASS=true` and restart. Mutations are then allowed with the intent held **in memory only** (not restart-safe), a permanent red banner and a log line per mutation show it, and the setting must be removed after the volume is fixed. Off by default; using it is itself logged. Without it the service stays fail-closed (D6).
- **Also fixed here:** the unrelated "history entries lost at restart" limit from Slice 3 disappears.
**Files (new):** `src/server/booking/outbox.ts`, `recovery.ts`, `tools/audit-outbox.ts`; **edits:** `service.ts` (intent / outcome around every mutation), `staff-service.ts`, `schema.ts` (+`Audit_ID` columns), overview + Schedule banner, docs.
**Tests:** restart keeps pending entries; crash points (after intent, after Grist write, after outcome, after flush insert) each recover with exactly one audit row; flush twice = one row; intent failure rejects and writes nothing; outcome failure still returns success; Grist down keeps entries and alarms; truncated last line; disk-full simulation; compaction never drops unflushed; no PII / key / secret anywhere (file + logs); second-process lock; concurrency (20 parallel mutations, one outbox).
**Risk:** every mutation now depends on a local disk write (new failure mode, deliberately fail-closed). Mitigation: the volume check at startup, a health line, and the runbook. Sequential fsyncs add roughly a millisecond per mutation.

## 4B. Consent schema and permissions (CRM side; depends on 4A for audit)

**Design change from my earlier note:** consent is stored per **person (normalised phone)** in its own table with an append-only history, not as fields on each appointment. Reasons: it needs change history and evidence; one person has many appointments; the same logic must serve leads, register patients and people with neither; a snapshot on each appointment would drift.

**New tables (additive, provisioned like the others; created empty = everyone is Unknown):**
- `Reminder_Consent` (one row per phone): `Consent_ID`, `Phone` (`+91XXXXXXXXXX`), `Patient_ID` (link, optional), **`Reminder_Consent`** (`Yes` / `No` / `Unknown`), **`Reminder_Consent_At`**, **`Reminder_Consent_Source`**, `Evidence_Ref`, `Evidence_Date` (signature date), `Form_Version`, `Recorded_By`, `Previous_Value`, `Updated_At`, `Audit_ID`.
- `Reminder_Consent_Log` (append-only, never edited): every change as a new row: `Log_ID`, `Consent_ID`, `Phone`, `Value`, `Previous_Value`, `At`, `Source`, `Evidence_Ref`, `Evidence_Date`, `Form_Version`, `Actor`, `Note`, `Audit_ID`. The full history, including who and when.
- `Reminder_Consent_Source` choices: `Signed registration form`, `Told staff in person`, `Told staff by phone`, `Patient replied on WhatsApp (reviewed by staff)`, `Patient withdrew`, `Admin correction`, `Imported with evidence`. (A patient's WhatsApp "YES" counts only after a person records it; see AI rule.)

**Rules enforced in the booking service (not the UI):**
- `Yes` needs a source, an evidence reference and (for a signed form) the signature date and an approved `Form_Version`. Without them the server refuses. `Unknown` is the only state with no evidence. **No code path writes Yes except an explicit consent action by a permitted person.** Creating or changing appointments never touches consent. Property test: across every create / reschedule / cancel / status / import path, Unknown is never turned into Yes.
- Effective state for a phone: any `No`, or an `Opted_Out` lead with that phone, wins over everything (a withdrawal is never overridden by an older Yes).
- Every change writes the history row, keeps `Previous_Value`, and goes through the 4A outbox (audit detail = consent id, from, to, source; **no phone**).

**Permissions** (extends `permissions.ts`; enforced inside the service like the others):
| | Admin | Front desk | Doctor login |
|---|---|---|---|
| View consent state | yes | yes | yes (own patients' appointments) |
| Record Yes (with evidence) | yes | **only if explicitly granted** | **only if explicitly granted** |
| Record No / withdrawal | yes | yes (always allowed: it can only suppress) | yes (same reason) |
| Correct or revoke a recorded Yes / change evidence | yes | no | no |
| AI / n8n service tokens | **never** (no scope exists; the create API already rejects unknown fields, so a consent field is refused; tested) | | |
"Explicitly granted" = a per-user list in `users.json` (`"grants": ["consent:write"]`, default none; admins always). Decision D1 asks whether front desk should get it by default.

**UI:** consent selector and evidence fields on the appointment drawer and the booking form (default "Not asked" = Unknown); a person's consent history (who, when, from, to, source, evidence ref); a "reminders: will / won't be sent, and why" line using the same effective rule W5 will use; a Consent tab or report listing Unknown / No / Yes counts. Never shows consent as Yes unless recorded.

**Existing register patients and leads: migration (no bulk Yes, ever).**
1. **Inspect first.** You supply the actual registration form (scan or text); I check it against your criteria (clear affirmative WhatsApp **appointment / treatment reminder** clause, identifies the clinic, explains withdrawal, separate from general consent) and record the verdict per form version in `docs/` (approved / ambiguous). Until then nothing is migrated. The website draft wording is ambiguous by these criteria (section 0).
2. **Dry-run report, no writes:** counts of register patients and leads by consent source and version (for example how many leads are `whatsapp-inbound` only), and how many currently receive W5 reminders that would stop. This is the impact figure for R1.
3. **Evidence-backed import only:** a tool (`npm run import-consent`, dry run by default, never touches `LEADS.Consent_WhatsApp`) accepts rows with phone, form version (must be an approved one), signature date and evidence reference (for example the register serial / scan id); each valid row is created as `Yes`, source `Signed registration form` or `Imported with evidence`. A row without evidence or on an unapproved / ambiguous form is **rejected into an "unknown" report, not imported**. Ambiguity means Unknown.
4. Legacy lead consent: `whatsapp-inbound` is **not** converted. `website-form` is converted only for a `Consent_Version` you approve in step 1, and only through the same evidence-backed import.
**Files (new):** `booking/consent.ts` (rules, pure + tested), `consent-routes`, `tools/import-consent.ts`, UI components; edits to `schema.ts`, `permissions.ts`, `staff-service.ts`, `users` loader (`grants`), `grist/booking-schema.md`.
**Tests:** matrix of who can record Yes / No / correct; evidence required; Unknown never becomes Yes (property); No beats Yes; Opted_Out beats Yes; history append-only with previous value; audit has no phone; AI token cannot send or set consent; import dry run writes nothing, rejects ambiguous / evidence-less rows, is idempotent.
**Risk:** a new person-level table to keep consistent with `LEADS`; phone is the key (normalisation already shared); two people sharing a number are treated as one (documented; staff can add a note).

## 4C. Reminder workflow compatibility (n8n side; SEPARATE approval; depends on 4B being in place)

**Step 0 (read-only):** compare the deployed workflows with the candidate file (export from the live n8n with credentials stripped, supplied by you or approved for me to request). All changes below are made to the repository copies, tested, and given to you as a reviewed import; **I do not edit live workflows.**
**Changes (repository copies, test-first; inline workflow code moved into `n8n/snippets/` with `*.test.js`, as the other workflows do, per CLAUDE.md rule 10):**
1. `wa-send.js`: add `purpose` to every `WA_TEMPLATES` entry and return it from `waPrepare` (default `engagement`). Free text = `reply`.
2. **W12 consent gate becomes purpose-based** (replacing the single "template to patient" rule): `reply` / `staff_alert` unchanged; `engagement` = today's rule exactly; `booking_transaction` = D3 rule; `appointment_reminder` / `followup_reminder` = the reminder rule below. A blocked send records its reason in the result and `Run_Log` (already the pattern), never a silent drop. TEST_MODE behaviour unchanged.
3. **Reminder rule (one shared snippet, used by W5, W12 and W15 so they cannot disagree):** suppress if opted out (any lead with that phone) or `Reminder_Consent` effective = `No` or `Unknown`/blank; else allow. Lead-linked legacy rows keep today's path **only where the lead's consent has approved reminder evidence** (4B step 4); otherwise they are Unknown and suppressed (R1).
4. **W5:** (a) skip `Appt_Stage = 'Pending confirmation'` (blank stage = every legacy row, unchanged; `Status` untouched); (b) resolve the contact: Lead if linked (today's path), else `Patient_Phone` / `Patient_Name`, else the register patient via `Patient_ID`: **no Lead is ever created**; (c) apply the reminder rule; (d) **never skip silently**: every in-window appointment that is not reminded writes its reason (`pending_confirmation`, `no_contact`, `invalid_phone`, `consent_unknown`, `consent_no`, `opted_out`, `nba_hold`) to a new `Appointments.Reminder_Note` (last decision, visible to staff in the Schedule page) and one summary `Run_Log` line per run / day (not one line per 15-minute pass); (e) the `R24_Sent` / `R2_Sent` check-and-set, windows, quiet hours, TEST_MODE, send guard and `nextBestAction` hold are unchanged.
5. **W15:** classify as `followup_reminder`; take consent from the shared rule; resolve a patient with no Lead from `Patients.Phone` (today it holds "no lead with this phone"); keep `booking_link` handling per `docs/booking-integration-gaps.md`.
6. **W4 / `booking_transaction`:** `booking_confirmation` is no longer governed by reminder consent (D3).
7. **W13 / W6:** the Cal.com link work in `docs/booking-integration-gaps.md` (W13 must not use direct mode) is separate and still required before AI booking.
**Tests (node, in the repo's existing harness) before any import:** the full matrix: Pending / Confirmed / blank stage; consent Yes / No / Unknown / blank; opted out; lead-linked legacy row with and without approved evidence (byte-identical output for evidenced legacy rows); no-lead with Patient_Phone; no-lead with only Patient_ID; invalid / missing phone; already-sent flag; reschedule clears flags; quiet hours; TEST_MODE redirect; **replies and booking confirmations are never blocked by reminder consent**; unknown template defaults to `engagement`; skip reasons recorded exactly once; the existing `wa-send`, `followup-reminder`, W4 / W6 / W12 suites still pass unchanged.
**Risk:** this is the change that alters real patient messaging. Mitigation: dry-run mode first (W5 computes decisions and writes `Reminder_Note` / Run_Log but sends nothing), staging with synthetic patients and a test phone only, owner sign-off on the R1 impact report, one-click rollback (re-import the previous workflow JSON; the CRM tables are additive and inert).

## 4D. Doctors and calendar (original Slice 4 scope; independent, build last)
Weekly calendar view (Mon-Sat by doctor, with leave and blocks), a per-doctor view (their appointments, their hours, upcoming leave), print / export of a day's list, clearer temporary-schedule (override) editing and a calendar of leave. Reuses the existing service and API; **no schema change and no workflow change**, so it can proceed in parallel or last. Tests: view-only additions plus the existing permission matrix.

## 5. Dependencies and order
```
4A outbox  ──►  4B consent schema + permissions  ──►  4C workflow compatibility (n8n, separate approval)
    │                                                         ▲
    └──────────────────────────────────────────────────────────┘ (4C depends on 4B's table and on the shared rule snippet)
4D calendar is independent (can run any time after 4A).
```
- 4B writes consent changes that must be durably audited: **4A first**.
- 4C reads `Reminder_Consent` and `Appointments.Reminder_Note` and needs the provisioned columns: **4B first**.
- Nothing depends on 4D. AI booking go-live additionally still needs the W13 / W6 / W15 link work and `docs/calcom-cutover.md`.

## 6. Provisioning changes (all additive, dry-run by default, run against a COPY first; nothing touched in production)
`Appointments`: `+Audit_ID`, `+Reminder_Note`. `Booking_Audit`: `+Audit_ID`. `Booking_Config`, `Doctors`, `Doctor_Schedules`, `Closures_Blocks`: `+Audit_ID`. New tables: `Reminder_Consent`, `Reminder_Consent_Log`. `grist/booking-schema.md` and its sync test are updated with each.

## 7. Migration and delivery risks
| # | Risk | Mitigation |
|---|---|---|
| R1 | **Existing reminders stop** for leads whose only consent is generic (`whatsapp-inbound`, draft website wording) | dry-run impact report before any change; you approve; evidence-backed re-consent drive (staff record consent at visits); consent shown in the UI so staff can fix it |
| R2 | The deployed workflows differ from the repo copies | step 4C-0 export and diff before editing; changes shipped as a reviewed import, never edited live |
| R3 | The outbox adds a local-disk dependency to every mutation | fail-closed by design, startup check, runbook, alarms; volume backup |
| R4 | Two people on one phone / a number that changed | consent keyed by phone with a note field; a changed number starts as Unknown (never inherits) |
| R5 | Evidence quality (form scans, register serials) is manual | import rejects evidence-less rows; ambiguity = Unknown; nothing bulk-converted |
| R6 | A purpose misclassification blocks or lets through the wrong message | purpose lives with the template; default is today's rule; the full matrix test; dry-run before live |
| R7 | CRM-made bookings have no confirmation sender | out of scope; flagged so a confirmation flow (purpose `booking_transaction`) can be a later, separate decision |
| R8 | More Grist tables / columns | additive provisioning tested on a copy, idempotent, never alters existing columns |
| R9 | n8n tests cover repo snippets, not the live engine | stage 4 of the test plan in `docs/booking-decisions.md` (real n8n, synthetic patient, test phone) |

## 8. Gates, approval points and what will NOT happen
- Approve this plan, then **approve each sub-slice before it starts** (4A, 4B, 4C, 4D). I stop after each with a report.
- 4C changes only repository copies and tests; importing anything into a live n8n, provisioning production, enabling AI booking, changing live settings, bulk-changing any consent, and messaging any real patient all stay behind your explicit approval, and the staged test plan (`docs/booking-decisions.md` section 5, synthetic patients and an authorised test phone only) must pass first.

## 9. Decisions I need from you
- **D1** Should front-desk staff be able to record consent by default, or only users you explicitly grant (recommended: explicit grant for everyone but admins)?
- **D2** Please supply the actual **registration form** (and, for any signed-form evidence, how a form is referenced: register serial, scan id). Also: is the website tick-box wording final, and which `Consent_Version`s, if any, do you approve as reminder evidence?
- **D3** Booking confirmations: allowed when the patient asked for the booking (WhatsApp AI, or staff recorded the patient's request) and not opted out, **independently of reminder consent**? Meta's WhatsApp opt-in rules for business-initiated templates may still apply; confirm with the clinic's WhatsApp provider.
- **D4** Confirm R1: reminders to people whose only consent is "they messaged us first" or the current website draft will be suppressed until explicit reminder consent is recorded.
- **D5** Approve a read-only export of the deployed n8n workflows (credentials stripped) for the diff in 4C-0.
- **D6** Audit outbox: approve the `flowhq_config` volume location and the "reject mutations when the audit log cannot be saved" policy (the fail-closed default), including a documented break-glass procedure.
- **D7** Order: 4A, 4B, 4C, with 4D in parallel or last?
