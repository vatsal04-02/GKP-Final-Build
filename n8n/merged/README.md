# Clinic Autopilot: one n8n workflow (W1–W12 merged)

| File | What it is |
|---|---|
| `clinic-autopilot-single-workflow.json` | **The workflow to import.** It has 139 nodes: the 125 exported nodes (118 working nodes plus 7 of your own notes) and 14 section notes. |
| `build-merged.js` | Rebuilds that file from your exports: `node n8n/merged/build-merged.js --in <folder with the W*.json exports>`. It applies the 5 fixes from section 3 and the W13 change A-01 (section 5c); `--no-fixes` builds the merge exactly as exported. |
| `validate-merged.js` | Runs the 15 checks from section 7 plus 2 more (safety guards intact; nothing else changed). Add `--in <exports folder>` to prove that only the 8 changed nodes differ from your exports. |
| `merged.flow.test.js` | Runs the merged file end to end in the simulator, one trigger at a time, with a fake Grist and a fake Meta. |

Run all checks with `node n8n/tests/run-all.js`. It stops on the first failure.

Built from your live exports of 5 Oct 2026:
- W1 Website lead intake
- W3 Speed-to-lead
- W4 Booking sync
- W5 Appointment reminders
- W6 Follow-ups (2)
- W11 Error alert
- W12 WhatsApp send

The files in `n8n/workflows/` are older and were **not** used.

---

## 1. Understanding

| Module | Trigger | What it does today |
|---|---|---|
| **W1** Website leads | `POST /webhook/website-lead` (Header Auth) | Takes a form submission and cleans it, including the phone number. Looks up the clinic in Agency Registry > Clinics by `clinic_slug`. Then finds the LEADS row by phone, updates it if the details changed, or creates a new one (`Lead_id` L-YYYYMMDD-NNNN). Writes Run_Log. The staff alert is a **stub**. |
| **W2** WhatsApp inbound | — | **Not built.** |
| **W3** Speed to lead | Every 10 min | For each active clinic, reads Settings and LEADS. Takes leads with Status `New` that are 30 min to 48 h old and not Escalated, up to 10 per clinic. Runs the guard (TEST_MODE / TEST_PHONE, quiet hours, Escalated as the "sent" flag), builds a message (`hello_world`) and calls W12. If sent, sets `Escalated` and writes Run_Log. |
| **W4** Booking | `POST /webhook/cal?clinic=<slug>` | Checks the Cal.com HMAC signature, finds the clinic, reads Settings. Then creates, reschedules or cancels the Appointments row, and finds or creates the LEADS row. Writes Run_Log. The booking confirmation is a **stub**. There is also an old unconnected webhook, `cal-w4-test`. |
| **W5** Reminders | Every 15 min | Finds Booked appointments due a 24 h reminder (20–24 h before) or a 2 h reminder (45–120 min before). Runs the guard, then "Code in JavaScript" builds the message (`hello_world`) and calls W12. If sent, sets `R24_Sent` / `R2_Sent` and writes Run_Log. |
| **W6** Follow-ups | Cron `0 10 * * *` | Three jobs: no-show rebook (`noshow_rebook`), day-2 follow-up (`hello_world`), and mark Lost (**off**, `mark_lost = false`). Runs the guard as marketing, so Automation_Paused stops it. Calls W12. If sent, sets `Rebook_Sent` / `Followup_Sent` and writes Run_Log. |
| **W7–W10** | — | **Not built.** |
| **W11** Error handler | Error Trigger | Formats a safe alert (phone numbers and tokens masked) and sends it to Telegram. The same failure alerts at most once per 10 min. |
| **W12** WhatsApp engine | Execute Workflow Trigger (passthrough) + Manual test | Takes **one** item from a caller, then: Config (`send_mode = allowlist`, allowlist) → check the caller's decision, the template and its variables, the allowlist and quiet hours → Meta Cloud API → classify the reply (accepted / rejected / uncertain) → log patient messages to the Grist inbox (Conversations + Messages) → return the caller's item plus `sent`, `send_status`, `wa_message_id`, `send_error`, `inbox_logged`. |

## 2. Dependency map (before the merge)

```
              Agency Registry (Clinics)  <- read by W1, W3, W4, W5, W6
              Clinic doc: Settings, LEADS, Appointments, Run_Log, Conversations, Messages

 W1 --writes LEADS--------------------------> (W3 reads New leads, W6 reads open leads)
 W4 --writes Appointments + LEADS----------> (W5 reads Booked, W6 reads No-show)

 W3 --Execute Workflow wJyVEscB9qqKOOx3--+
 W5 --Execute Workflow wJyVEscB9qqKOOx3--+--> W12 ---> Meta WhatsApp Cloud API
 W6 --Execute Workflow wJyVEscB9qqKOOx3--+      \---> Grist Conversations / Messages (inbox)

 W1, W3, W4, W5, W6 --settings.errorWorkflow = bzsRGJqIW1xcM9eQ--> W11 ---> Telegram
 W12 has no error workflow (its failures surface in the caller, which alerts)
 W1 staff alert and W4 confirmation: stubs, not connected to W12
 W2, W7, W8, W9, W10: do not exist
```

The only links in the workflows themselves are W3/W5/W6 → W12 (each sends one item and gets one result back) and W1/W3/W4/W5/W6 → W11 (on error). Everything else happens through Grist data.

## 3. Issues found before merge

**Status of this build:** at your request, **I-01 to I-05 are FIXED** (marked ✅ below; exactly 7 nodes changed, listed in section 5b). Every other issue is **still in the file exactly as exported**; the simulation test asserts I-08 and I-12 so they can't change silently.

| # | Severity | Module · node | Problem | Why it matters | Merge needs a change? | Safest fix |
|---|---|---|---|---|---|---|
| ✅ I-01 | **CRITICAL** | W5 · Code in JavaScript | Replaces the guard's `decision`: `to` is the **patient's** number, `send = item.send !== false`, `test_mode = Boolean(text)`. It also runs in "all items" mode with `$json`, so only the first item comes out. It also hard-codes `grist_base_url` and sets `lead_row_id: null`. | With TEST_MODE on, reminders go to the **real patient**, not TEST_PHONE. Only the W12 allowlist stops them (proved in the test). If you switch W12 to `live`, patients get messages while Settings still says TEST_MODE. | No | **FIXED:** `decision` is now `item.decision` from Decide send (no decision = no send), and the node runs once per item. `grist_base_url` was left as exported. |
| ✅ I-02 | HIGH | W5 · Decide send | `Execute Once` is on (plus `retryOnFail` and `alwaysOutputData`). | Only the **first** due reminder is handled each run. Others wait 15 min, and some will miss the 4 h / 75 min window. | No | **FIXED:** Execute Once removed. `retryOnFail` and `alwaysOutputData` were left as exported. |
| ✅ I-03 | HIGH | W12 · Prepare request | Uses `new Date('2026-10-05T10:00:00+05:30')` instead of `Date.now()`. | W12's own quiet-hours check always thinks it is 10:00. Today only the callers' guards stop night sends. | No | **FIXED:** `Date.now()`. |
| ✅ I-04 | HIGH | W12 · Find conversation, Create conversation, Add message | Use the **WhatsApp Cloud API** credential to call **Grist**. | Your Meta token is sent to Grist, Grist refuses, and inbox logging never works (`inbox_logged = false`). Sending itself still works. | No | **FIXED:** the 3 nodes use **Header Auth account 2**. `W12 – Meta send` still uses the WhatsApp credential. |
| ✅ I-05 | HIGH | W6 · Decide send | Same fixed date as I-03. | W6 has no working quiet-hours check. It runs at 10:00, so there is no risk unless someone starts it by hand at night. | No | **FIXED:** `Date.now()`. |
| I-06 | MEDIUM | W3 · Find due | `// if (!base.open_now) return;` is commented out. | Staff alerts ignore clinic hours and working days. The 21:00–08:00 quiet hours still apply. | No | Remove the `//` when testing is done. |
| I-07 | MEDIUM | W4 · Config | The Cal.com secret sits in plain text in a Set node, and the export shows the **same value as the earlier export** (you said you rotated it). | The rotation may not have been saved, and anyone with the export has the secret. | **Yes:** replaced by a placeholder in this file (public repo). | Paste the current secret after import. Check Cal.com uses the same one. |
| I-08 | MEDIUM | W3 / W5 / W6 · Send?, Sent? | The "false" outputs go nowhere. | A blocked or failed send leaves **no Run_Log row**. The flag stays unset, so it is retried every run. | No | Add a Run_Log "skipped/failed" write on the false outputs. |
| I-09 | MEDIUM | W3, W5, W6 · Build Message / Code in JavaScript | Use Meta's test template `hello_world`. W6 rebook uses `noshow_rebook`. | Good for testing. For live use you need approved templates and the real names (`lead_escalation` / `new_lead_staff_alert`, `reminder_24h`/`reminder_2h`, `followup_day2`). W3's variables are built for `new_lead_staff_alert`. | No | Change the template names after Meta approves them. |
| I-10 | LOW | W4 · Webhook (`cal-w4-test`) | Old test webhook, not connected. You said it had been removed. | Once active it is a public URL that starts an empty run. | No (kept) | Delete the node. |
| I-11 | LOW | W3 / W5 · Clinics | A query parameter with no name and value `=`. | The request ends in `?=`. Harmless today. | No | Delete that row. |
| I-12 | LOW | W1 · Build update, W6 · Plan follow-ups | Read `Lead_ID`, but your column is `Lead_id`. | Run_Log shows `row N` instead of the lead id. | No | Change to `Lead_id`. |
| I-13 | LOW | W1 · Staff alert (stub), W4 · Plan writes | No WhatsApp yet. W4 · Resolve clinic also doesn't pass `wa_phone_number_id`. | No staff alert and no booking confirmation. | No | Wire them to W12 later, the same way as W3. |
| I-14 | LOW | W5 · Find due | Has no `lead_row_id` in its output. | Now that I-04 is fixed and the inbox is written, W5 inbox rows are not linked to the lead. | No | Add `lead_row_id: f.Lead`. |
| I-15 | INFO | W3 · Config `test_phone` | Not used anywhere. It held your own number. | — | **Yes:** placeholder (public repo). | Delete it, or paste the number back. |
| I-16 | INFO | W12 · Read reply / Plan inbox / Add message / Return result | Use `$('…').first()`. | W12 only works when called with **one item per run**. So the merge keeps the Execute Workflow call (mode "each") and does not wire W3/W5/W6 straight into W12's nodes. With straight wires, every item would get the first item's result. | Shaped the merge | Keep the calls in mode "each". |
| I-17 | INFO | W11 (merge effect) | Alerts now show the merged workflow's name. | The module shows in **Step** (e.g. `W4 – Reject`). A W12 failure may raise two alerts (the W12 run and its caller). | Yes (unavoidable) | — |
| I-18 | INFO | W6 · Daily 10:00 | Cron uses n8n's timezone. No export sets a workflow timezone. | 10:00 IST only while `GENERIC_TIMEZONE=Asia/Kolkata` (set in this repo's docker-compose files). | No | — |
| I-19 | INFO | W6 · Config | `mark_lost = false`. | Old leads are **not** marked Lost (as you set it). | No | — |
| I-20 | INFO | Notes stickies | Kept word for word. Some text is out of date: W11 step 4 says "set Error workflow", and W6 says "Messages are a STUB". | Could confuse later. | No | Section notes explain the merged setup. |
| I-21 | INFO | Repo | `grist/schema.md` and `n8n/workflows/*.json` still use `Leads` / `Lead_ID` and have no W12 wiring. | The repo copies no longer match your live system. | No | Sync later. This merge uses only your live exports. |
| I-22 | INFO | W2, W7, W8, W9, W10 | Never built. | — | Yes: empty labelled sections only, no placeholder nodes. | Build later inside their sections. |

## 4. Final single-workflow architecture

```
                         CLINIC AUTOPILOT  (one workflow, one canvas)
  SECTION 00  entry points + rules (sticky)
  ───────────────────────────────────────────────────────────────────────────────────────
  W1  POST /webhook/website-lead ──> clean ─> clinic ─> LEADS find/create/update ─> Run_Log
  W2  (reserved, no nodes)
  W3  every 10 min ──> clinics ─> Settings ─> LEADS ─> due ─> guard ─> Build Message ─┐
  W4  POST /webhook/cal ──> HMAC ─> clinic ─> Appointments/LEADS writes ─> Run_Log    │
      POST /webhook/cal-w4-test (unconnected, as exported)                            │
  W5  every 15 min ──> clinics ─> … ─> guard ─> Code in JavaScript ───────────────────┤
  W6  cron 0 10 * * * ──> clinics ─> … ─> plan ─> guard ─> Build Message ─────────────┤
  W7 / W8 / W9 / W10  (reserved, no nodes)                                            │
                                                                                      │
      each caller: "Wn – Call 'W12 - WhatsApp send'"  (Execute Workflow -> THIS workflow,
      workflowId {{ $workflow.id }}, mode each = one run per item)  <──────────────────┘
                     │ item in                                    ▲ same item + sent, send_status, wa_message_id …
                     ▼                                            │
  W12 When called by another workflow ─> Config (allowlist) ─> Prepare request ─> Call Meta?
        Manual test ─> Test input ─┘          ─> Meta send ─> Read reply ─> Log to inbox?
                                              ─> Find/Create conversation ─> Add message ─> Return result
                                                                    (last node = what the caller gets)
      back in the caller: Sent? ─> flag (Escalated / R24_Sent / R2_Sent / Rebook_Sent / Followup_Sent) ─> Run_Log

  W11 Error Trigger ─> Config ─> Format alert ─> Should send? ─> Telegram
      (n8n starts this section when any production run of this workflow fails;
       Settings > Error workflow stays empty; an error run is never re-triggered)
  SECTION FUTURE  (reserved: W13+, AI receptionist, payments, analytics …)
```

**Why W12 is called, not wired.** n8n connections only go forward and cannot "return" to the caller. W12 also reads `.first()` (I-16). The Execute Workflow node is n8n's only way to run a shared part for one item and hand the result back to the node that asked. It now calls **this same workflow**, so there is still only one workflow and one copy of the Meta logic. Each WhatsApp send shows as its own execution, exactly as with the old W12.

**Why W11 needs no setting.** In n8n, a workflow that contains an Error Trigger and has no "Error workflow" setting is its own error workflow. When a production run fails, n8n starts a new run in "error" mode from the Error Trigger. n8n never starts an error run because an *error run* failed, so there is no loop. The limits are the same as before:
- Runs you start by hand in the editor don't raise alerts.
- If the Telegram node itself fails, nobody is told.

If test step 7 below shows no alert, set Settings > Error workflow to your old **W11 - Error alert** workflow. It still exists and works.

## 5. Merge changes (made only because of the merge)

1. **Node names**:
   - All 125 exported nodes got a module prefix: `Config` → `W3 – Config`. One n8n workflow cannot have two nodes with the same name, and 27 names (Config, Settings, Sent?, Write Run_Log …) appeared in several workflows.
   - 54 references in 32 nodes were renamed to match: `$('Config')` and the `from('Build update')` helper in W1/W4/W12.
   - Table names such as `'Appointments'` were not touched.
2. **Canvas**:
   - Every module was moved as one block into its own section. Positions inside a module are unchanged.
   - 14 section notes were added: 00, W1 … W12, FUTURE. W2 and W7–W10 are labelled "reserved".
3. **W12 calls**: the 3 nodes `W3/W5/W6 – Call 'W12 - WhatsApp send'` changed `workflowId` from `wJyVEscB9qqKOOx3` (old W12) to `{{ $workflow.id }}` (this workflow). Mode `each` and inputs are unchanged.
4. **Settings**:
   - `errorWorkflow` was removed; see section 4.
   - Kept: `executionOrder v1`, `binaryMode separate`, `timeSavedMode fixed`, `availableInMCP false`, and `callerPolicy workflowsFromSameOwner`, which allows the self-call.
   - The file imports as **inactive** and has no workflow id; n8n assigns one.
5. **Public repo**: placeholders replace the Cal.com secret (`W4 – Config`) and your phone number in 3 places (`W3 – Config` test_phone, `W12 – Config` w12_allowlist, `W12 – Test input` decision.to).

### 5b. Fixes you asked for (not merge changes)

Exactly **7 nodes** differ from your exports. Node ids, connections, settings, webhook paths, schedules, Grist ids and tables, TEST_MODE and `w12_send_mode = allowlist` are untouched.

| # | Node | Node id | Change |
|---|---|---|---|
| 1 | `W5 – Code in JavaScript` | `c0e82482-3747-4935-ab4d-03801477ed40` | **I-01.** The `to` / `send` lines and the rebuilt `decision {send, to, reason, test_mode: Boolean(…)}` are replaced by `decision = item.decision \|\| {send: false, …}` (no decision = no send). The recipient now always comes from Decide send (TEST_MODE → TEST_PHONE) and W12 checks it again. Mode changed from "all items" to "once for each item" (needed so every reminder is processed). |
| 2 | `W5 – Decide send` | `b6955746-a854-434e-92dd-a0399575da6c` | **I-02.** `Execute Once` removed. |
| 3 | `W6 – Decide send` | `606eff0a-8f70-40c3-8862-e1a6788b54a8` | **I-05.** `now_ms: new Date('2026-10-05T10:00:00+05:30').getTime()` → `now_ms: Date.now()`. |
| 4 | `W12 – Prepare request` | `9ea2ef1c-1da9-45b5-9646-bd1788b6f9bd` | **I-03.** The same fixed clock → `Date.now()`. |
| 5 | `W12 – Find conversation` | `0033ca1d-9414-42e6-a79d-8e1e11474d04` | **I-04.** Credential: WhatsApp Cloud API → Header Auth account 2 (`9J6XxrIQoFDcQZ0Y`, the one every other Grist node uses). |
| 6 | `W12 – Create conversation` | `e439b820-9da6-456c-b508-36f9a1bd98a2` | **I-04.** Same. |
| 7 | `W12 – Add message` | `dfa54d97-9f21-421e-a028-7ea40292226a` | **I-04.** Same. |

`W12 – Meta send` still uses **WhatsApp Cloud API**, and it is the only node that does.

Quiet hours (21:00–08:00 IST) are enforced again in W3, W5, W6 **and** in W12 itself. So W12 refuses to send at night even when called by hand, and the manual test only works between 08:00 and 21:00 IST.

**Nothing else changed.** `validate-merged.js --in <exports>` compares all 125 nodes with the exports: 117 are identical (ids, types, versions, credentials, retry/once/error settings, parameters) and the 8 listed in 5b and 5c differ only as listed. All connections are identical. The comparison allows only for changes 1, 3 and 5 from this section, the 5b fixes and A-01.

### 5c. A-01: W12 sends the AI receptionist's replies (for W13, `n8n/w13/`)

W13 (the AI receptionist) answers patients through this workflow's W12 section, so W12 needed one capability it did not have:
**free-text replies** inside WhatsApp's 24-hour customer-service window (a patient who just wrote to you may get a normal message,
not only a template). Only the pasted `wa-send.js` block in two Code nodes changes; templates behave exactly as before.

| # | Node | Node id | Change |
|---|---|---|---|
| 4 (again) | `W12 – Prepare request` | `9ea2ef1c-1da9-45b5-9646-bd1788b6f9bd` | **A-01.** `wa-send.js` block replaced by the current `n8n/snippets/wa-send.js`: an item with `message_type: 'text'` sends `text_body` as free text, ONLY if `last_inbound_at` (the patient's last message) is less than 23 h 55 min ago, else `blocked` ("only an approved template may be sent"). Same allowlist, quiet-hours and decision checks as templates. New template `human_handoff_alert` (staff alert for AI hand-offs). |
| 8 | `W12 – Read reply` | `1b70dbe1-3bff-4d49-b6d5-47bacb9c6f4b` | **A-01.** The same block (this node builds the Inbox row): a text message is logged with its text as Body and an empty Template. |

To get A-01 into the master you already imported, either re-import this file, or open those two Code nodes and replace everything
from `const WA_TEMPLATES` down to the end of `function waInboxRow` with the same part of `n8n/snippets/wa-send.js`.

## 6. Final n8n JSON

**`n8n/merged/clinic-autopilot-single-workflow.json`**: one complete workflow, ready to import (n8n > Workflows > Import from File).

## 7. Validation report

Output of `node n8n/merged/validate-merged.js --in <exports>`:

```
PASS  1. JSON syntax is valid and has the n8n workflow shape — 139 nodes, 118 functional
PASS  2. every connection references an existing node — 119 connections
PASS  3. no duplicate node ids or names; every functional node is in a module (W<n> – …)
PASS  4. no broken connections (valid output/input index, main type, no sticky ends, no cross-module wires)
PASS  5. webhook paths preserved and unique — POST website-lead, POST cal-w4-test, POST cal
PASS  6. trigger nodes valid (1 Error Trigger, 1 Execute Workflow Trigger, <=1 Manual Trigger, schedules + webhooks in their modules)
PASS  7. Execute Workflow nodes call THIS workflow (no old workflow ids left in any functional node or setting)
PASS  8. W12 cannot call itself (no Execute Workflow node is reachable from the W12 triggers) — W12 path: 13 nodes
PASS  9. W11 cannot trigger itself (no errorWorkflow setting, no Stop and Error / Execute Workflow on the error path)
PASS 10. independent schedules stay independent (own rule, disjoint node sets) — 10 min (16 nodes), 15 min (18), cron 0 10 (21)
PASS 11. webhook branches stay independent (no node shared with any other trigger)
PASS 12. W12 receives the fields it reads from every caller
PASS 13. W12 returns its result to the calling branch — Call -> W3 – Sent? / W5 – Sent? / W6 – Sent?
PASS 14. credentials referenced correctly — Header Auth account 2 x34, WhatsApp Cloud API x1 (W12 – Meta send only), Header Auth account x1, Telegram account x1
PASS 15. no secret or token values in the file (placeholders only)
PASS 16. the safety guards are intact (real clock everywhere, decision never rebuilt, TEST_MODE / allowlist settings unchanged)
PASS 17. nothing else changed: 117 exported nodes identical; 8 differ ONLY by the 5 fixes + A-01
```
(Checks 16 and 17 are extra. They fail on the as-exported merge and on each fix reverted one by one: I tested that.)

`merged.flow.test.js` passes 25 simulated scenarios (each fix reverted on its own makes it fail):
- **W1:** creates a lead, skips a duplicate, rejects an unknown clinic.
- **W3:** 2 leads become 2 separate W12 runs, and each result returns to its own item (TEST_PHONE, Escalated, Run_Log). An allowlist block returns `sent=false`. Quiet hours hold.
- **W5:**
  - Both due reminders are processed (I-02).
  - With TEST_MODE on, Meta only ever gets TEST_PHONE, even when both patients are allowlisted in W12 (I-01).
  - TEST_MODE off sends to the patient and the allowlist still blocks others. A missing TEST_MODE means ON.
  - Opted_Out and the R24_Sent flag are respected. Nothing is sent at 22:00 or 03:00.
  - The fixed node never turns "no send" into "send".
- **W6:** follow-ups go out through W12 (TEST_PHONE) and set Followup_Sent. The inbox rows are written (I-04), and a second message reuses the conversation. Quiet hours follow the real clock (07:59 / 21:00 / 22:00 / 03:00 blocked, 08:00 / 20:59 send) (I-05).
- **W12 called directly:** the same boundaries hold in W12 itself (I-03). Not allowlisted → blocked. Caller said no → not sent. A patient message is logged to Conversations + Messages with the Grist credential (I-04).
- **W4:** a signed booking is written; the placeholder secret fails safe.
- **W11:** the alert names `W4 – Reject`.
- **W12:** the manual test with the placeholder sends nothing.
- **All 9 triggers:** each runs only its own section.

| Confirm | Status |
|---|---|
| JSON valid | ✅ |
| Nodes valid | ✅ 139 nodes, unique ids and names |
| Connections valid | ✅ 119, none crossing sections |
| Triggers valid | ✅ 2 webhooks + 1 unused test webhook, 3 schedules, 1 Error Trigger, 1 sub-workflow trigger, 1 manual |
| Schedules preserved | ✅ 10 min / 15 min / `0 10 * * *` |
| Webhooks preserved | ✅ `website-lead` (Header Auth), `cal`, `cal-w4-test` |
| Credentials preserved | ✅ by id and name, none added. The 3 W12 inbox nodes now use the Grist credential (fix I-04); `W12 – Meta send` is the only node with the WhatsApp credential. |
| W12 centralized | ✅ the only Meta node in the file is `W12 – Meta send` |
| W11 safe | ✅ no errorWorkflow setting, nothing on the error path can call or raise |
| TEST_MODE preserved | ✅ TEST_MODE logic, TEST_PHONE and `w12_send_mode = allowlist` are unchanged. W5 no longer bypasses TEST_MODE (fix I-01). Nothing in the file turns TEST_MODE off; it lives in Grist Settings. |
| No secrets exposed | ✅ placeholders only, no token patterns |
| Future modules can be added | ✅ reserved sections, naming rule, how to call W12 (SECTION 00 / FUTURE) |

What I could not check here: a real n8n import and a run against your Grist and Meta. The simulator is not n8n. Test steps 1–7 below cover that.

## 8. Test plan (safe order)

**0. Prepare (nothing goes live yet)**
1. Export the old W1, W3, W4, W5, W6, W11 and W12 as a backup.
2. Import `clinic-autopilot-single-workflow.json`. It arrives **inactive**.
3. Fill the placeholders:
   - `W4 – Config` > `cal_webhook_secret`
   - `W12 – Config` > `w12_allowlist` (your number only)
   - `W12 – Test input` > `decision.to` (your number)
4. Keep `w12_send_mode = allowlist`. Keep Settings `TEST_MODE = TRUE` and `TEST_PHONE` = your number.
5. **Save.** Sends call the saved version.
6. Test between 08:00 and 21:00 IST. Quiet hours are enforced in W12 as well, so a send at night is refused on purpose.

**1. W12 first, because everything else depends on it.**
1. Click play on `W12 – Manual test`.
2. Expect `hello_world` on your phone, and `W12 – Return result` showing `sent: true` and a `wa_message_id`.
3. Change the number to one that is not in the allowlist and run again: expect `sent: false`, "not in the W12 allowlist", and nothing sent.

**2. W1.**
1. Deactivate the old **W1**, then activate the merged workflow. It is now the only one using `/webhook/website-lead`.
2. Submit your website form (or `curl` with the header-auth header) using a test name and your own number.
3. Expect a LEADS row (`L-…-0001`) and a Run_Log "ok".
4. Submit the same form again: expect Run_Log "skipped – duplicate submission".

**3. W4.**
1. Deactivate the old **W4** (it uses the same `/webhook/cal`).
2. Book a test slot on the demo-clinic Cal.com event, with your own number.
3. Expect a Booked row in Appointments, the lead set to Booked, and a Run_Log "(created)".
4. Cancel the booking: expect Status Cancelled.

**4. W3.**
1. Deactivate the old **W3**.
2. Make a LEADS row with Status New, created 30+ min ago and under 48 h.
3. Click play on `W3 – Every 10 minutes` between 08:00 and 21:00.
4. Expect `hello_world` on TEST_PHONE, `Escalated` ticked, and a Run_Log row.
5. Executions shows one extra run for the W12 call.

**5. W5.**
1. Deactivate the old **W5**.
2. Make a test appointment (Status Booked) whose lead has your own number, with Start 21 h from now. For a second check, add a second one for another lead (Start 22 h from now); both should be processed.
3. Click play on `W5 – Every 15 minutes`.
4. Expect one `hello_world` per due reminder on **TEST_PHONE** (even if the lead has another number), `R24_Sent` filled, and a Run_Log row each.
5. Run it again: nothing should be sent, because the flags are already set.
6. Check `W12 – Return result` for `inbox_logged`. The patient's number appears in Conversations and the message in Messages.

**6. W6.**
1. Deactivate the old **W6**.
2. Make a LEADS row with Status New, created 2–6 days ago, and Followup_Sent off.
3. Click play on `W6 – Daily 10:00` between 08:00 and 21:00.
4. Expect `hello_world` on TEST_PHONE, Followup_Sent ticked, and a Run_Log row.
5. Run it again: nothing should be sent.
6. Check that `inbox_logged` is true and that Conversations and Messages got a row. This is the first time the real inbox path runs. If it says false, read `inbox_error` (usually a column that is missing or named differently in your Grist). The message itself has already been sent and is not affected.

**7. W11.**
1. With the merged workflow active, send a failing production request: `curl -X POST https://<your-n8n>/webhook/cal?clinic=demo-clinic -d '{}' -H 'Content-Type: application/json'`. The bad signature makes `W4 – Reject` fail.
2. Expect one Telegram alert: "Step: W4 – Reject".
3. Send it again within 10 min: no second alert (throttle).
4. If no alert arrives, see section 4 (use the old W11 as Error workflow).

**8. W2.** Not built. Nothing to test.

**9. Finish.**
1. Deactivate the old **W12**.
2. Leave the old W11 in place as a fallback.
3. Keep all the old workflows (inactive) until the merged one has run cleanly for a few days.
4. **Rollback:** deactivate the merged workflow and reactivate the old ones.
