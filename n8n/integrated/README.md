# Clinic Autopilot master with the AI receptionist integrated

> **Which file is the master now.** `clinic-autopilot-master-ai.json` is the **complete workflow** (323 nodes: W1–W13, W7–W10,
> the AI receptionist with **prompt v2.2**), made from your latest export "ai updated workflow clinic final v1". It is the same file as
> `ai-updated-workflow-clinic.w13-v2.2.json`. Its changes and tests are in **`W13-PROMPT-V2.1.md`** (section 11).
> Sections 1–5 below describe the first integration stage (246 nodes), which is now kept as `clinic-autopilot-master-ai.stage1.json`.

This is your live master, "1 clinic total workflow" (W1, W2, W3, W4, W5, W6, W11, W12), with the AI receptionist built in as
**SECTION W13**. It uses the OpenRouter implementation from "W13 DEMO". The Anthropic W13 is **not** used.

It is one workflow with one execution path, and **W12 is the only WhatsApp sender**.

> **Status:** built from your export and tested in the simulator, with a fake Grist, a fake Meta and a fake OpenRouter that reads the real prompt.
> - It has not run in your n8n yet.
> - It is saved **inactive**.
> - Nothing here turns a clinic's `ai_mode` to `auto`.

| File | What it is |
|---|---|
| `clinic-autopilot-master-ai.stage1.json` | The integrated master of this first stage (246 nodes), **public copy**. The Meta verify token, the Cal.com secret and your allowlisted number are placeholders. (It was `clinic-autopilot-master-ai.json` until W13 prompt v2.1; that name is now the complete workflow, section 11.) |
| *your private import file* | The same workflow with your own values kept exactly as exported. It was sent to you directly and is never committed. |
| `source/master-export.redacted.json` | Your export of the master, redacted the same way. The build starts from it. |
| `build-integrated.js` | Builds the stage-1 master from an export: `node n8n/integrated/build-integrated.js --in <export> [--keep-private]` (writes `clinic-autopilot-master-ai.stage1.json`) |
| `validate-integrated.js` | 11 check groups proving that only the intended changes were made. Add `--private` for your import file. |
| `integrated.test.js` | 18 end-to-end check groups and 10 mutation tests (each integration point broken once). |
| `existing-modules.test.js` | The 25 existing W1/W3/W4/W5/W6/W11/W12 scenarios, run unchanged on the stage-1 master. |

## 1. End-to-end path

```
Patient ─► Meta ─► W2 – Webhook Inbound (POST /webhook/whatsapp-inbound, unchanged)
   W2 – Respond (200 to Meta, first) ─► parse ─► loop, one message at a time:
   clinic ─► phone ─► duplicate? ─► lead ─► conversation ─► Add Message ─► Update Conversation ─► Prepare Staff Alert   (all unchanged)
   ─► W2 – AI Wanted?  (only when the message was STORED: run_outcome ok, message row id > 0, not test data)
        yes ─► W2 – AI Job (the identifiers below) ─► W2 – Start AI Receptionist (THIS workflow, w13_job = true, no waiting)
               ─► W2 – AI Handed ─► W2 – Build Run Log ─► Run Log  (unchanged)
        no  ─► W2 – Build Run Log ─► Run Log (unchanged)

New execution of this workflow (one per message):
   W12 – When called by another workflow ─► W12 – AI Job?  (w13_job or w13_retry = true)
   ─► SECTION W13:
      Config ─► Start ─► Agency Registry ─► Settings, Knowledge, the Messages row, Conversation, Lead, last 40 messages, Booked appointments
      ─► Build Context: safety gates (already handled · STOP · ai_mode off · opted out · paused · Needs_Human · staff answered ·
                        newer message · night (deferred) · media · rate limit)
      ─► Claim (Messages.AI_Status = processing) ─► OpenRouter: Provider Request ─► Ask Model ─► Provider Answer
      ─► Plan: the JSON decision is validated (schema, triage, confidence tiers 0.65 / 0.80 / 0.85, complaint/payment/medical/human → person, fact check of
               prices / times / links / phone numbers against Knowledge and the real free slots)
      ─► appointment writes first (direct booking / WhatsApp-booked cancel; if one fails → hand-off)
      ─► W13 – Call W12 ─► THIS workflow again (wait) ─► W12 – AI Job? (no) ─► W12 (allowlist, quiet hours, 24 h window, TEST_MODE) ─► Meta
      ─► Record Sends ─► Grist: Messages (Intent, AI_Action, AI_Status, AI_Reply, AI_Reason, Needs_Human) · Conversations (Last_Intent,
         Needs_Human, Handoff_Reason) · LEADS (Lead_Stage, AI_Summary, Likely_Service, Contacted, First_Response_At, Next_Action_At,
         Opted_Out) · Run_Log

W13 – Every Morning (08:05, instance time zone like W6's 10:00) ─► messages deferred overnight ─► the same path (w13_retry = true)
W3 / W5 / W6 ─► "Call 'W12 - WhatsApp send'" ─► W12 – When called ─► W12 – AI Job? (no) ─► W12   (unchanged)
```

Other modules connect through Grist, the source of truth:
- A WhatsApp booking (`direct` mode) is a Booked Appointments row, so **W5** sends its reminders.
- In `link` mode the patient books on Cal.com and **W4** writes the booking.
- A real AI answer sets the lead to Contacted, so **W3** stops escalating it. A hand-off leaves the lead as New, so W3 keeps chasing staff.
- "Ask me later" sets Next_Action_At, which keeps **W6** from marking the lead Lost.

## 2. What changed (validate-integrated.js proves there is nothing else)

**Modified nodes (2):** `W12 – Prepare request` and `W12 – Read reply`. Only their pasted `wa-send.js` block changed (A-01): free-text messages inside the 24 h window, and the `human_handoff_alert` template. Templates behave exactly as before.

**Added nodes (51):**
- `W12 – AI Job?`: the IF right after W12's trigger. A workflow can have only one Execute Workflow Trigger, so W12 and the AI share it.
- `W2 – AI Wanted?`, `W2 – AI Job`, `W2 – Start AI Receptionist` and `W2 – AI Handed`.
- 44 SECTION W13 nodes. They are the OpenRouter demo's nodes, identical apart from their position, and `W13 – Config` > `w12_workflow_id` = `{{ $workflow.id }}`.
- The demo's own trigger, Manual Test, Test Messages, Run Each Test and Test Report are **not** included (one Manual Trigger per workflow). Do dry runs with the standalone W13 DEMO, kept inactive.
- 2 notes: `Section W13` and `W2 – Section G AI`.

**Rewired outputs (2):**
- `W12 – When called by another workflow` used to go to `W12 – Config`. It now goes to `W12 – AI Job?`, whose true branch goes to `W13 – Config` and false branch to `W12 – Config`.
- `W2 – Prepare Staff Alert` used to go to `W2 – Build Run Log`. It now goes to `W2 – AI Wanted?`:
  - true: `W2 – AI Job` → `W2 – Start AI Receptionist` → `W2 – AI Handed` → `W2 – Build Run Log`
  - false: `W2 – Build Run Log`

The other 193 nodes and 152 connections are byte-identical to your export, including: the webhooks and their ids, the Meta verify step, parsing, duplicate handling, lead and conversation logic, message storage, Build Run Log, Run Log, all Grist credentials, W1, W3–W6, W11 and the rest of W12.

**The payload from W2 to the AI** (`W2 – AI Job`), checked against the code of `W13 – Start`:

```json
{ "w13_job": true, "dry_run": false, "w13_retry": false,
  "wa_phone_number_id": "<Meta phone_number_id>", "clinic_slug": "<from the Agency Registry>",
  "message_row_id": <Messages row id W2 just created>, "wa_message_id": "<wamid…>", "msg_type": "text",
  "patient_phone": "+91XXXXXXXXXX", "sender_name": "<WhatsApp profile name>", "text": "<the message>" }
```
- **Configuration** (registry doc, leads table, model, thresholds) comes from `W13 – Config`, the one place to change it. Any config value sent in the payload would be overwritten there.
- **The text** that W13 answers is read from the stored Messages row, not from `text`, so a caller cannot make the AI answer something other than what W2 stored.

## 3. Import (keep it inactive)

1. **Grist:** the AI columns and the Knowledge table from `grist/schema.md` must exist. They do if the W13 DEMO already worked for you.
2. **Import your private file as a NEW workflow** (Workflows > Import from File). It arrives **inactive**, and your current master keeps running untouched.
   - On `W13 – Ask Model`, pick your **OpenRouter API** credential.
   - Save.
3. **Check, then switch over yourself:**
   - Deactivate the old master, activate the new one. Same webhook paths, so Meta, Cal.com and the website form keep their URLs.
   - Nothing inside refers to a workflow id: every call is `{{ $workflow.id }}`.
4. Keep the standalone **W13 DEMO inactive**. It's only for dry runs (Manual Test), and the integrated master already does its job. Never have both running the 08:05 retry.
5. The AI only acts for a clinic whose Settings has `ai_mode`:
   - missing = off;
   - `draft` = decide and write the CRM, send nothing to the patient;
   - `auto` = send through W12.
   TEST_MODE and the W12 allowlist still apply. That choice is yours.

## 4. Test results

`node n8n/tests/run-all.js` (28 files, all pass). For the integrated master:

| # | Test | Result |
|---|---|---|
| 0 | the build reproduces the committed file; Meta GET verification (right token 200 + challenge, wrong 403, no AI) | pass |
| 1 | normal patient message: Meta 200 first, ONE AI job (not awaited), reply via W12, Messages / Conversation / Run_Log (W2 + W13) | pass |
| 2 | service question, new patient: lead created by W2, services only from Knowledge, Contacted | pass |
| 3 | availability: only real free evening slots; an invented time is replaced | pass |
| 4 | booking: link mode (Cal.com link for that day), direct mode (Appointments row, lead Booked), taken slot (real alternatives) | pass |
| 5 | cancellation: Cal.com cancel link of that booking | pass |
| 6 | unknown question → hand-off: holding reply + `human_handoff_alert`, both via W12; Needs_Human; a new patient message is answered again | pass |
| 7 | duplicate inbound: stored once, one AI job, one reply; two messages in one webhook = one job each | pass |
| 8 | invalid payload (400), delivery receipt, unknown clinic, bad number: no AI job, nothing sent | pass |
| 9 | AI failure (timeout, 429, malformed, schema-breaking): hand-off, nothing invented sent | pass |
| 10 | W12 failure (Meta 131047, Meta unreachable): failed + Needs_Human + Run_Log failed; W2 unaffected | pass |
| 11 | Grist failure: save fails or no row id (no AI job), claim fails (no AI), Settings unreadable (no AI), final write fails (AI execution errors → W11; W2 Run_Log ok) | pass |
| 12 | STOP: Opted_Out, nothing sent, next message not answered | pass |
| 13 | low confidence (0.55), medical, payment: hand-off, the AI text never sent | pass |
| 14 | gates: ai_mode off, draft, TEST_MODE → TEST_PHONE, paused, media, rate limit, made-up price / link | pass |
| 15 | night: deferred at 22:00 (no AI call), answered by W13 – Every Morning at 08:05 | pass |
| 16 | W3 / W5 / W6 items still go straight to W12 (no AI) | pass |
| — | 10 mutations (router off / all-AI, unstored message, waiting, Run_Log item, row id, w13_job, retry routing, A-01 removed, sends bypassing W12) | all caught |
| — | existing W1/W3/W4/W5/W6/W11/W12 scenarios on the integrated master | 25 / 25 pass |

## 5. Known limits

- **Simulator only.** Real OpenRouter, Meta and Grist behaviour comes in your first runs: use `ai_mode = draft` and TEST_MODE on.
- **Instance time zone.** `W13 – Every Morning` uses the instance time zone, as W6's "10:00" already does (the master has no time-zone setting).
- **Pre-existing unconnected node.** `W2 – Test Cases` was already unconnected in your export and is left as is: W2's manual-test trigger was removed when W2 joined the master.
- **Not covered by the AI layer:** W2 still does not verify Meta's `X-Hub-Signature-256`. (W6's day-2 follow-up gating is done for your live workflow by `apply-ai-os.js`, section 6.)

## 6. AI OS improvements A1–A6 on your live workflow ("ai workflow clinic")

Your live workflow had moved on from the stage-1 master (now `clinic-autopilot-master-ai.stage1.json`): it was re-imported, `W13 – Plan` was edited, credentials were picked. So A1–A6 are
applied to **your export** of it, not rebuilt:

| File | What it is |
|---|---|
| `source/ai-workflow-clinic.export.redacted.json` | Your export of "ai workflow clinic", redacted (verify token, Cal.com secret, allowlisted number → placeholders). |
| `apply-ai-os.js` | Applies A1–A6: `node n8n/integrated/apply-ai-os.js --in <export> [--out <file>] [--keep-private]`. Every node it edits is fingerprinted first; if one was changed in n8n since the export, it stops and writes nothing. |
| `ai-workflow-clinic.ai-os.json` | The result, **public copy**, saved inactive. Your private import file was sent to you directly and is never committed. |
| `validate-ai-os.js` | 11 check groups comparing the result with the export (add `--private --orig <export> --patched <file>` for your own pair). |
| `ai-os.test.js` | 14 end-to-end check groups for A1–A6, before / after comparisons with the original, and 13 mutation tests. |
| `ai-os-regression.test.js` | `integrated.test.js` and `existing-modules.test.js`, unchanged, on the patched workflow AND on the original. |

**What changes (and nothing else, proven by `validate-ai-os.js`):**

| | Node | Change |
|---|---|---|
| A1–A4, A2 | `W13 – Start`, `W13 – Build Context`, `W13 – Plan`, `W13 – Plan Ready`, `W13 – Record Sends` | Code from the rebuilt OpenRouter W13 (`n8n/snippets/ai-receptionist.js`): your live `no_reply` rule (A1), the triage fields + emergency gate (A3), confidence tiers (A4), the decision trace (A2). Ids, positions and settings unchanged. |
| A4 | `W13 – Config` | `min_confidence` 0.7 → 0.65; new `confidence_auto` = 0.8, `confidence_write` = 0.85. Model, provider and every other value unchanged. |
| A5 | `W6 – Plan follow-ups` | The day-2 follow-up skips Needs_Human, Lead_Stage cold, Last_Intent not_interested / opt_out, a future Next_Action_At, and a patient message in the last 48 h. No-show rebook and Mark Lost unchanged. |
| A6 | `W3 – Find due`, `W3 – Build Message` | Hot → warm / unknown → cold, then oldest first; skips conversations with Automation_Paused or Assigned_To; the staff message carries AI_Summary (else Enquiry) and the stage. Template unchanged. |
| A6 | **new** `W3 – Conversations` | Grist read of Conversations (credential of `W3 – Leads`), between `W3 – Leads` and `W3 – Find due`. On error it continues and nothing is skipped. |

- **Connections:** only `W3 – Leads → W3 – Find due` became `W3 – Leads → W3 – Conversations → W3 – Find due`.
- **Credentials and schema:** no credential changed or added, and no Grist table or column added. Every column read is already in `grist/schema.md`.
- **Senders:** W12 is still the only node that calls Meta, and the patient hand-off reply wording is unchanged.

**How A3 and A6 meet:** when the AI hands a lead to staff and the `human_handoff_alert` is delivered, W13 sets LEADS > Escalated, so W3 does not
alert again. If the alert failed, Escalated stays off and W3 escalates as before (the safety net).

**Import:** as in section 3. Import the private file as a new workflow (inactive) and check `W13 – Ask Model`'s credential. Then switch over
yourself. Before trusting the tiers, watch a few days of Run_Log (`gate=… model …ms tok …`) with `ai_mode = draft`.

## 7. AI context for W3, W4, W5 and W6 ("ai updated workflow clinic")

The full change, test and security report is in **`AI-CONTEXT-REPORT.md`**. In short:
- **No new model call.** One shared deterministic module, `n8n/snippets/lead-context.js`, reads what W13 and staff already write to the CRM. It can only hold back or reorder a step that W3, W5 or W6 already allow.
- **W4:** a verified Cal.com cancellation also sets the lead's `Next_Action_At` (a rebook signal).

| File | What it is |
|---|---|
| `source/ai-updated-workflow-clinic.export.redacted.json` | Your export, redacted for this public repository. |
| `apply-ai-context.js` | `node n8n/integrated/apply-ai-context.js --in <export> [--out <file>] [--keep-private]`. Fingerprint-checked; it changes 5 node codes, adds `W5 – Conversations` and reroutes 1 connection. |
| `ai-updated-workflow-clinic.ai-context.json` | The result, public copy, inactive. Your import file (your values kept exactly) was sent to you directly. |
| `validate-ai-context.js` | 13 check groups, before vs after: credentials / webhooks / secrets / schema changed = 0. |
| `system.test.js` | 83 checks over W1–W13 plus cross-cutting safety, PASS / FAIL with the reason for each. |
| `ai-context-mutations.test.js` | Breaks each new rule once (15 breakages); the system test must catch every one. |
| `ai-context-regression.test.js` | The existing suites before vs after; only the 2 intended A5 / A6 differences are allowed. |
| `redact.js` | The redaction used for public copies. |

## 8. W13 Needs_Human gate fix

A ticked `Needs_Human` used to skip every later patient message until staff unticked it.
- **Now:** it keeps the AI away from the handed-off message only (and anything older). A new patient message is handled again, and is handed off again if needed. Details are in `n8n/w13/README.md`; the results are in `HANDOFF-GATE-REPORT.md`.
- `apply-handoff-gate.js` applies the fix to the workflow from section 7. It is fingerprint-checked and changes only the 4 W13 nodes that hold the decision module.
- `validate-handoff-gate.js` proves nothing else changed.
- `handoff-gate.test.js` covers the 7 requested cases.
- `handoff-gate-regression.test.js` runs every existing suite on the result.
- Since W7–W10 rebuilt the shared module, `apply-handoff-gate.js` checks its result against pinned fingerprints (the W13 build of commit 8be1676) instead of the current W13 build, so it still reproduces that file exactly.

## 9. W7, W8, W9 and W10: the four reserved sections, built

The full change report, architecture, settings, test results and the manual steps are in **`W7-W10-REPORT.md`**.

| File | What it is |
|---|---|
| `apply-w7-w10.js` | `node n8n/integrated/apply-w7-w10.js --in <workflow after section 8> [--out <file>] [--keep-private]`. Fingerprint-checked; adds the 4 sections (75 nodes), swaps the pasted snippet block in 2 W12 and 4 W13 Code nodes, rewrites 5 sticky notes. Nothing removed, no existing connection changed. |
| `ai-updated-workflow-clinic.w7-w10.json` | The result, public copy, inactive. Your import file (your values kept exactly) is sent to you directly, never committed. |
| `validate-w7-w10.js` | 12 check groups, before vs after: secrets / webhooks / credentials changed = 0, W12 the only sender, pasted code = `n8n/snippets/`, canvas. |
| `w7-w10.test.js` | 34 end-to-end checks: every requested W7 / W8 / W9 / W10 case, plus failures, two clinics and AI use. |
| `w7-w10-mutations.test.js` | Breaks 23 safety rules once each (claims, guards, review gating, AI checks, ownership, W12); the test must catch every one. |
| `w7-w10-regression.test.js` | Every existing suite (W1–W6, W11, W12, W13, Needs_Human gate, A1–A6) on the result. |
| `../w7-w10/sections.js`, `../w7-w10/code/` | The node builder and the Code-node sources; the helpers are pasted verbatim from `n8n/snippets/clinic-modules.js`, `send-guard.js`, `normalize-phone.js`. |

## 10. TEMPORARY: quiet hours off for testing (`DISABLE_QUIET_HOURS_FOR_TEST`)

`apply-quiet-hours-switch.js` pastes one switch into the 7 nodes that apply quiet hours in W12, W13 and W7–W10, and flips it later (`--value false`). Details, the node list and the tests are in `QUIET-HOURS-SWITCH.md`. The test file is `ai-updated-workflow-clinic.quiet-hours-test.json`, with the switch ON. Switch it off when testing is done.

## 11. W13 receptionist prompt v2.1 / v2.2: the complete master

The changes, the guards, the test results and the steps before import are in **`W13-PROMPT-V2.1.md`**.

| File | What it is |
|---|---|
| `clinic-autopilot-master-ai.json` | **The master**: your export "ai updated workflow clinic final v1" (323 nodes) with W13 prompt v2.2 (v2.1 + routine questions answered from the knowledge base) in place of the old W13 code. Public copy (redacted), saved inactive. |
| `ai-updated-workflow-clinic.w13-v2.2.json` | The same file under its release name (byte-identical, checked by `validate-w13-prompt.js`). |
| `source/ai-updated-workflow-clinic.final-v1.redacted.json` | Your export, redacted for this public repository. Both files above are made from it. |
| `apply-w13-prompt.js` | `node n8n/integrated/apply-w13-prompt.js --in <export> [--out <file>] [--keep-private]`. Fingerprint-checked; swaps only the pasted `ai-receptionist.js` block in the 4 W13 Code nodes that hold it. Default output: the master. |
| `validate-w13-prompt.js` | 8 check groups, before vs after: 0 nodes added / removed, connections identical, only the 4 blocks changed, quiet-hours switch, model and secrets unchanged, release copy identical. Add `--private --orig <export> --patched <file>` for your own pair. |
| `../snippets/ai-prompt.test.js` | 8 groups: the prompt rules, Hindi / Hinglish prices and times, booking claims, full replies, safety routes, injection and malformed answers, routine questions answered from the knowledge base. |
| `../w13/eval-prompt.js` | 26 made-up patient messages against the real model, checked by W13's own code. Needs your OpenRouter key; **not run here**. |
| *your private import file* | The same master with your own values kept exactly as exported. Sent to you directly, never committed. |
