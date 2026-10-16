# W7, W8, W9 and W10: change and test report

**Base file.** No workflow file was attached to the request. I built on the last file I delivered to you: your workflow after the
Needs_Human gate fix (`ai-updated-workflow-clinic.handoff-gate`, commit 8be1676). The patcher fingerprints every node it touches. If
that workflow was edited in n8n since, it stops and writes nothing; re-export it and send it, and I will re-run the patcher on it.

**Status:** built and tested in the simulator (fake Grist, fake Meta, fake OpenRouter). It has not run in your n8n yet. It is saved
**inactive**, and W7, W8 and the W9 owner copy are **off per clinic** until you switch them on in Settings.

## A. The workflow

| File | What |
|---|---|
| `ai-updated-workflow-clinic.w7-w10.PRIVATE.json` | **Import this one.** Sent to you directly, never committed. Every value of yours kept exactly. |
| `n8n/integrated/ai-updated-workflow-clinic.w7-w10.json` | Public copy (repo). Identical except 3 values are placeholders: Meta verify token, Cal.com secret, allowlisted number. |
| `n8n/integrated/apply-w7-w10.js` | The patcher: `node n8n/integrated/apply-w7-w10.js --in <your workflow> --out <file> --keep-private` |

## B. Exact change report

| # | Item | Result |
|---|---|---|
| 1 | Nodes added | **75**, all in the four reserved sections: W7 18, W8 20, W9 20, W10 17 (list below) |
| 2 | Nodes modified | **11**. Code only: `W12 – Prepare request` and `W12 – Read reply` (the pasted wa-send.js block); `W13 – Build Context`, `Plan`, `Plan Ready` and `Record Sends` (the pasted ai-receptionist.js block). Text and size only: the stickies `Section W7`, `W8`, `W9`, `W10` and `Section 00` |
| 3 | Nodes deleted | **0** |
| 4 | Connections added | 72 links from 70 new nodes. All of them are inside the new sections; none goes to or from an existing section |
| 5 | Connections changed | **0** |
| 6 | Secrets changed | **0** (the 58 existing Config values are byte-identical; table below) |
| 7 | Webhooks changed | **0** (all 15 webhook, trigger and respond nodes are byte-identical). The 4 new triggers are schedules, not webhooks |
| 8 | Credentials changed | **0**. The new nodes only reference credentials you already have: "Header Auth account 2" (Grist, same id as W6) and "OpenRouter API" (W9 – Ask Model, same id as W13) |
| 9 | Existing behaviour changed? | W1, W2, W3, W4, W5, W6, W11: **no**. W12 and W13: two small additions each (below) |
| 10 | Grist schema changed? | **One new column: `Appointments.Outcome_Sent`** (DateTime). You add it by hand. No new table. New Settings rows, optional (D) |
| 11 | New fields / config | See D |
| 12 | Tests passed | All of them; numbers in E |
| 13 | Tests failed | None. "Real connections" was not run: the sandbox cannot reach your n8n, Grist or Meta |
| 14 | Remaining blockers | See F |

**Nodes added**

| Section | Nodes |
|---|---|
| W7 | Every hour · Config · Clinics · Split clinics · Settings · Add settings · Appointments · Leads · Conversations · Plan · Decide send · Send? · Build Message · Claim Outcome_Sent · Restore · Call 'W12 - WhatsApp send' · Prepare log · Write Run_Log |
| W8 | Every hour · Config · Clinics · Split clinics · Settings · Add settings · Appointments · Leads · Conversations · Plan · Review? · Write warning · Decide send · Send? · Build Message · Claim Review_Sent · Restore · Call 'W12 - WhatsApp send' · Prepare log · Write Run_Log |
| W9 | Monday 09:00 · Config · Clinics · Split clinics · Settings · Add settings · Leads · Appointments · Conversations · Messages · Run_Log · Metrics · Ask Model · Report · Save report · Owner message · Owner send? · Call 'W12 - WhatsApp send' · Owner log · Write owner log |
| W10 | Every minute · Config · Clinics · Split clinics · Pending · Collect · Settings · Conversation · Lead · Check · Send? · Claim row · Restore · Call 'W12 - WhatsApp send' · Record · Not sent · Grist write |

**What changes in W12 and W13 (the only existing behaviour that changes)**
- **W12**
  - It knows 3 more templates: `outcome_check`, `review_request` and `weekly_owner_report`.
  - A message that already has its own inbox row is not logged a second time. Only W10 sends such messages (`inbox_row_id`).
  - Everything else is identical: sender, allowlist, quiet hours, 24 h window, Meta node. All 26 W12 checks pass.
- **W13**
  - **Answers to the W7 check-in.** `outcome_better` gets a short thank-you. `outcome_same` goes to a person. `outcome_worse` goes to a person at HIGH priority, flagged medical, with no advice by message; this is enforced twice in code. These intents are recognised only when the conversation shows the check-in question.
  - **Staff gate.** For 24 h after a staff member writes to a patient, the AI does not answer that patient. STOP and emergency words still work.
  - Messages written by the workflow (`W<number>…` in Sent_By) never count as staff.
  - Every other gate and its order is unchanged; `validate-w7-w10.js` checks all 14.
- **One side effect.** A Messages row typed by staff with Direction Out also keeps the AI out for 24 h, even if Send was never ticked.

**Existing values preserved** (your private file, before vs after; values are not printed)

| Value | After | Placeholder? |
|---|---|---|
| Meta webhook verify token (W2 – Verify Config) | identical | no |
| Cal.com webhook secret (W4 – Config) | identical | no |
| W12 allowlist numbers, send_mode, Graph API version | identical | no |
| W12 – Test input (manual test number) | identical | no |
| OpenRouter model (W13 – Config) | identical | no |
| Agency Registry doc id (W1, W3, W5, W6, W13 Config) | identical | no |
| Credentials "Header Auth account 2" (61 nodes), "Header Auth account", "Telegram account", "WhatsApp Cloud API", "OpenRouter API": ids and names | identical | no |
| Webhooks: /website-lead, /cal, /cal-w4-test, /whatsapp-inbound (verify + inbound); paths and webhook ids | identical | no |
| W11 Telegram node, W12 – Meta send, W13 – Ask Model | identical | no |
| Workflow id, name, settings, versionId | identical | no |

The new Config nodes copy your Grist base URL and registry doc id from `W6 – Config` and the model from `W13 – Config`. No new node
contains a key, a token or a placeholder. Redacting your private file gives exactly the public copy, so the 3 secret values above
are the only difference between them.

## C. Architecture

Every section has its own schedule. Each run:
1. reads the Agency Registry (active clinics only, never a hard-coded clinic);
2. reads that clinic's Settings and rows;
3. decides **in code**;
4. sends only through `Call 'W12 - WhatsApp send'` (this workflow, one W12 run per message);
5. writes Run_Log.

A failed step stops that run only, and W11 (this workflow's own Error Trigger) alerts with the step name. The other sections are
separate runs and are not affected.

**W7 – outcome check-in** (hourly at :20)
- **Who:** a Completed visit that ended 20–72 h ago with Outcome_Sent empty. One per patient, the newest visit only.
- **Skipped when:**
  - a check-in went to this patient in the last 7 days;
  - a future visit is already Booked;
  - a person owns the conversation (Needs_Human or Assigned_To);
  - the patient said not interested or STOP.
- **Guards:** valid phone, Opted_Out, Automation_Paused, quiet hours, TEST_MODE (sends to TEST_PHONE).
- **Claim before the send:** Outcome_Sent is written before W12 is called. If that write fails, nothing is sent. One attempt per visit; a failed attempt is logged and not retried, so a bad template can never message a patient repeatedly.
- **Message:** "How are you feeling now? Just reply here: better, the same or worse. If you would like another appointment, tell us…". Template outside the 24 h window, the same words as free text inside it.
- **The answer** comes through W2 to the existing W13 call (no extra AI call):
  - better: thank-you;
  - same or worse: a person;
  - urgent words: URGENT hand-off before the AI;
  - "book me again": the normal booking path, with real free times or the Cal.com link only (nothing is booked by the AI);
  - "a person please": human_request.
  - The answer is recorded in `Messages.Intent` and `Conversations.Last_Intent`.

**W8 – review request** (hourly at :35)
- **Who:** a Completed visit that ended 3 h – 7 days ago with Review_Sent empty. One request per patient per 90 days.
- **Same text for everyone.** There is no filter on mood, outcome or complaints, because Google's review policy forbids review gating. No incentive, no "5 stars", no pressure.
- **Same guards** as W7, with a claim on Review_Sent before the send.
- **The link** comes only from Settings > review_link and must start with https://.
  - If it is missing, nothing is sent and nothing is flagged.
  - At 10:xx IST, a Run_Log warning (Outcome skipped) says how many requests are waiting.
- **Deterministic:** no AI.

**W9 – weekly report** (Monday 09:00, for the week Monday–Sunday just ended, IST)
- **Numbers by code** (`W9 – Metrics`), from LEADS, Appointments, Conversations, Messages and Run_Log:
  - new leads by source, contacted, booked, still New, median first reply, hot / warm / cold, opted out;
  - appointments completed, no-show, cancelled, rescheduled, past ones still Booked, booked for the next 7 days;
  - AI replied / handed off / deferred / failed, check-in answers, conversations waiting for a person, staff replies;
  - reminders, follow-ups, rebooks, check-ins and review requests sent;
  - failures.
- **One OpenRouter call per clinic.** It uses W13's model and the same credential, and receives only the numbers (no names, no phones). It writes only the summary, observations and recommendations.
- **Every AI line is checked.** A line that quotes a number not in the data, a number word, a % or ₹ is dropped. If the AI is down or its answer is not valid JSON, the report is written from the numbers alone.
- **Sections 2–6 are always written by code.** Section 7 is labelled "AI suggestions, not facts".
- **Saved** in Run_Log (Workflow `W9-weekly-report`, Record = the report).
- **Optional owner copy:** the headline and the first action, as template `weekly_owner_report` to owner_phone through W12, at most once per week.

**W10 – staff reply** (every minute)
- **What it picks up:** Messages rows with Direction Out and Send ticked. Nothing else.
- **Checks:**
  - not already sent;
  - Body not empty and Template empty;
  - a conversation exists and the phone is valid;
  - not Opted_Out;
  - the patient's last message is under 24 h old (otherwise WhatsApp allows only templates: needs_template);
  - TEST_MODE sends to TEST_PHONE;
  - in quiet hours the row waits, still ticked, and goes at 08:00.
- **Claim first:** Send is unticked and Status set to queued before W12 is called. Then:
  - Status sent and WA_Message_ID;
  - or failed / needs_template, with the reason in AI_Reason;
  - Conversations.Unread = 0;
  - a Run_Log row.
- **Ownership:** Needs_Human, Assigned_To and Automation_Paused are never changed. W13 stays out of the conversation for 24 h.
- **Automation_Paused does not block a staff reply.** It pauses automated messages, which is how staff take a conversation over (the existing send guard already treats it that way). If you want a paused conversation to block staff replies too, it is a one-line change in `cmStaffReplyCheck`; say so.

**AI use.** W7 adds no AI call: the answers go to the existing W13 call. W8 and W10 are deterministic. W9 makes one call per clinic
per week, checked line by line. No second provider was added.

**Shared code.** The logic lives in `n8n/snippets/clinic-modules.js` (pure functions, 21 unit tests) and is pasted verbatim into the
Code nodes; the validator fails if a pasted copy drifts. The node sources are in `n8n/w7-w10/`.

## D. Configuration

| Where | What | Needed for |
|---|---|---|
| Grist, every clinic doc | **Add column `Appointments.Outcome_Sent`** (DateTime, Asia/Kolkata) | W7 (without it W7 sends nothing and W11 alerts) |
| Settings (per clinic) | `outcome_checkin` = `on` | W7 (missing = off) |
| Settings (per clinic) | `review_requests` = `on` and `review_link` = your https review page | W8 (missing = off; no link = nothing sent + warning) |
| Settings (per clinic) | `weekly_report_whatsapp` = `on` (uses the existing `owner_phone`) | W9 owner copy (missing = off; the report is saved in Run_Log anyway) |
| WhatsApp Manager (each clinic's number) | Templates `outcome_check`, `review_request`, `weekly_owner_report`, exact wording in `n8n/whatsapp-templates.md` | W7, W8, W9 owner copy |
| Staff routine | Mark each visit **Completed** or **No-show** in Appointments | W6, W7, W8, W9 |
| W7 – Config (defaults) | after_hours 20, max_hours 72, min_days_between 7, max_per_run 30 | change if wanted |
| W8 – Config (defaults) | after_hours 3, max_days 7, min_days_between 90, max_per_run 30, config_warning_hour 10 | change if wanted |
| W9 – Config | openrouter_model (copied from W13), read_limit 5000 | — |
| W10 – Config | max_per_run 20 (per clinic per minute) | — |

No new credential, secret or webhook is needed.

## E. Test results

All 43 test files pass (`node n8n/tests/run-all.js`). The W7–W10 results were identical on your private file and on the public copy.

| Suite | Result |
|---|---|
| `w7-w10.test.js`: the 28 requested cases (W7 1–7, W8 1–6, W9 1–7, W10 1–8) + 6 extra | **33 PASS**, 1 not runnable here (real connections) |
| `w7-w10-mutations.test.js`: 23 safety rules broken one at a time | **23 / 23 caught** |
| `validate-w7-w10.js` (public and private) | **12 / 12** check groups |
| `w7-w10-regression.test.js`, every existing suite on the new file: <ul><li>W2→W13→W12 (18 groups + mutations)</li><li>25 W1/W3/W4/W5/W6/W11/W12 scenarios</li><li>the 83-check system test + 15 mutations</li><li>Needs_Human gate (9)</li><li>A1–A6</li></ul> | **all pass**; A1–A6 12 / 14 with the same 2 intended differences as before |
| Unit tests: `clinic-modules` 21, `ai-outcome-staff` 9, `wa-send` 92, W12 26, W13 17 + 17 | all pass |

| # | Case | Result | Evidence |
|---|---|---|---|
| W7.1 | completed appointment -> check-in | PASS | ended 22 h ago: template `outcome_check` via W12, Outcome_Sent set, inbox row + Run_Log ok; 10 h ago / No-show: nothing; wrote in the last 24 h: the same text as free text |
| W7.2 | duplicate run | PASS | same hour, next hour, 3 h later: one message; another visit 2 days after a check-in: none |
| W7.3 | opt-out | PASS | nothing sent, flag not set; also nothing for Automation_Paused, an invalid phone (even in TEST_MODE) or outcome_checkin off |
| W7.4 | quiet hours | PASS | 22:20 IST nothing, flag untouched; 08:20 next morning sent once |
| W7.5 | TEST_MODE | PASS | sent to TEST_PHONE, logged in the patient's conversation; TEST_MODE missing = ON; no TEST_PHONE = nothing |
| W7.6 | wants another appointment | PASS | `book_appointment`, lead hot, the Cal.com booking link from Settings, no appointment invented; "better" recorded + thank-you; "same" -> person |
| W7.7 | urgent / high-risk answer | PASS | chest pain: URGENT hand-off, no AI call; "worse": HIGH medical hand-off, also when the model tries to answer with advice; patient gets only the holding reply |
| W8.1 | completed appointment -> review request | PASS | `review_request` with the Settings link via W12; Review_Sent; same text for an unhappy patient (no gating) |
| W8.2 | duplicate | PASS | not resent; asked 30 days ago for another visit: nothing (90-day limit) |
| W8.3 | missing review URL | PASS | nothing sent or flagged; one Run_Log warning a day; non-https link = missing; no link invented |
| W8.4 | opt-out | PASS | nothing sent, flag untouched; review_requests off: nothing |
| W8.5 | quiet hours | PASS | 21:35 nothing; 08:35 sent once |
| W8.6 | TEST_MODE | PASS | TEST_PHONE only |
| W9.1 | lead counts | PASS | 5 new (WhatsApp 3, Website 2), contacted 4, booked 2, still New 1, median first reply 8 min, stages, opted out 1; leads outside the week not counted |
| W9.2 | appointment counts | PASS | 8 in the week, completed 3, 1 past still Booked, 1 booked ahead |
| W9.3 | cancellations | PASS | cancelled 2, rescheduled 1 |
| W9.4 | no-shows | PASS | 1 (report, headline, AI data) |
| W9.5 | hand-off counts | PASS | 8 patient messages, AI replied 4, handed off 2, waiting 2, staff replies 1, follow-ups from Run_Log, issues |
| W9.6 | AI summary matches the numbers | PASS | one OpenRouter call, numbers only; summary kept word for word; sections 2–6 identical with and without AI |
| W9.7 | AI cannot invent metrics | PASS | "12 new leads", "40%", "Twenty", "₹ 40000", "30 extra": all 5 lines dropped; AI down / not JSON: report from the numbers, reason in Run_Log |
| W9.8 | owner copy (extra) | PASS | via W12 when switched on; not resent on a re-run; W9 changes no CRM row |
| W10.1 | staff reply sends | PASS | the row's text, word for word, as WhatsApp free text |
| W10.2 | marked correctly | PASS | Status sent, WA_Message_ID, Send unticked, Unread 0, Run_Log ok, no second inbox row |
| W10.3 | duplicate blocked | PASS | next minute nothing; re-ticked sent row not resent; failed claim: nothing sent |
| W10.4 | invalid recipient | PASS | bad phone / no conversation / empty: failed + reason; 30 h old: needs_template; Run_Log failed |
| W10.5 | opt-out | PASS | not sent, reason on the row |
| W10.6 | human ownership | PASS | Needs_Human / Assigned_To / Automation_Paused unchanged; the patient's next message: no AI call, no reply |
| W10.7 | through W12 only | PASS | the Meta call came from a W12 run started by W10; only W12 nodes contain the Meta URL |
| W10.8 | send failure logged | PASS | Meta 131026: failed + Meta's reason, no retry loop, Run_Log failed; 131047: needs_template |
| W10.9 | quiet hours, TEST_MODE (extra) | PASS | 22:00 waits, 08:01 sent; TEST_MODE to TEST_PHONE |
| X.1 | failure visible, no double send | PASS | Outcome_Sent column missing: claim fails, nothing sent, W11 alert names "W7 – Claim Outcome_Sent"; same for W8 |
| X.2 | every clinic separately | PASS | two clinics: each from its own WhatsApp number, flags and logs in its own doc; the inactive one skipped |
| X.3 | AI use | PASS | W7 / W8 / W10: 0 model calls; W9: one, same credential, TLS checked |
| X.4 | real connections | NOT RUN | needs your n8n, Grist and Meta |

## F. What you need to do

1. **Import:**
   - Import `ai-updated-workflow-clinic.w7-w10.PRIVATE.json` and open it. The credentials resolve by the same ids.
   - Deactivate the previous version.
   - Save, then activate.
   - It was built on the file I delivered last (see the top). If you changed the workflow in n8n since, send me a fresh export instead.
2. **Grist:** add `Appointments.Outcome_Sent` (DateTime) in every clinic doc (and the template doc).
3. **Templates:**
   - Submit `outcome_check`, `review_request` and, if you want the owner copy, `weekly_owner_report`, with the wording in `n8n/whatsapp-templates.md`.
   - Until Meta approves them, keep the matching Settings switch off.
4. **Settings per clinic:**
   - `review_link` (https), `outcome_checkin` = on, `review_requests` = on, `weekly_report_whatsapp` = on (optional).
   - Test with TEST_MODE = true first.
5. **Staff:** mark visits Completed / No-show (W7, W8 and W9 depend on it), and write replies in the Inbox as described in `grist/schema.md` (Messages).
6. **Test in your n8n** (the sandbox cannot):
   - With TEST_MODE on, mark a test visit Completed with End about 21 h ago and run W7. Answer the check-in from the test phone.
   - Add a staff reply row and tick Send.
   - Run W9 from the editor.
   - W12 is still `send_mode = allowlist`, so only allowlisted numbers receive anything.
7. **Things to know:**
   - **W10 every minute.** About 1,440 runs a day per instance. Your docker-compose already prunes run history after 14 days.
   - **W9 – Ask Model checks TLS certificates.** `W13 – Ask Model` has certificate checks switched off (`allowUnauthorizedCerts`), unchanged. If W9's AI call fails with a certificate error in your setup, the report is still saved from the numbers, and that error points to a TLS problem on the server worth fixing.
   - **`human_handoff_alert` wording.** It still says "the AI has stopped replying" (see the note in `n8n/whatsapp-templates.md`).
   - **One attempt per visit.** A failed check-in or review request is logged (Run_Log, Outcome failed) and not retried, by design.
8. **Security note.** While running the regression suites on your private file, one existing test (`merged.flow.test.js`, a check meant for the public copy) printed your Cal.com webhook secret in its failure message.
   - That output stayed in this sandbox session's log. It was not written to any file, commit or external service.
   - The runner now uses the redacted copy for that suite and never prints assertion details.
   - Whether to rotate the secret is your call; nothing was changed.

**Correction to an earlier report.** `AI-CONTEXT-REPORT.md` said "W11 is not wired". That was wrong. With Settings > Error workflow
empty, n8n runs the failed workflow's own Error Trigger, so W11 fires on a failed production run of this workflow. The report is
corrected.
