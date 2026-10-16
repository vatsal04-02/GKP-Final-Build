# AI context for W3, W4, W5 and W6: change, test and security report

**Source of truth:** your export "ai updated workflow clinic" (247 nodes). It is the A1–A6 workflow, re-imported, with your Cal.com
secret, Meta verify token, W3 test phone and W12 manual-test number filled in.

**Principle: a smarter system, not more AI.**
- There is **no new model call**. OpenRouter `openai/gpt-4o-mini` in W13 stays the only AI, still one call per patient message.
- W3, W5 and W6 now read what that AI (and your staff) already write to the CRM, through one shared, deterministic module (`n8n/snippets/lead-context.js`).
- The module can only **hold back or reorder** a step that the workflow's own rules already allow. It never creates a message, a time, a price or a link.
- W4 stays 100 % Cal.com-driven.

**Result:**
- 1 node added, 5 node codes modified, 0 nodes removed, and 1 connection rerouted.
- **Credentials changed: 0. Webhooks changed: 0. Secrets changed: 0. Schema changed: 0.** These counts come from `validate-ai-context.js`, which compares your file with the patched file.
- The system test passes **82 of 83 checks**. The one not run is "real connections" (see section 8).
- All 33 test files in the repository pass, and all 15 deliberate breakages of the new rules are caught.

---

## 1. Change report

| Section | Node | Before | After | Why it is safe |
|---|---|---|---|---|
| W3 | `W3 – Find due` | <ul><li>New, not escalated, waiting 30 min–48 h.</li><li>Skips paused / assigned conversations.</li><li>hot → warm → cold.</li></ul> | <ul><li>Same rule.</li><li>Also holds back opted-out leads, leads that said *not interested* or *stop*, and leads with a **planned next contact** (future `Next_Action_At`).</li><li>Each alert carries a **staff brief** and a `next_best_action`.</li></ul> | <ul><li>The time window and the Escalated flag are unchanged.</li><li>A failed AI hand-off alert is still escalated (the safety net), now with the AI's own staff note.</li></ul> |
| W3 | `W3 – Build Message` | `New lead [hot]: … has submitted an enquiry …` | <ul><li>`message_text` = the brief.</li><li>The template's `enquiry` value = the short brief.</li></ul> | <ul><li>Template (`hello_world`), its keys, the recipient and the decision are unchanged.</li><li>If the brief is missing, the old text is used.</li></ul> |
| W4 | `W4 – Plan appointment` | A verified `BOOKING_CANCELLED` → Appointment Cancelled + Run_Log. | Same, plus the lead's `Next_Action_At` = now, a **rebook signal**: the lead shows in the Grist "Today" list. | <ul><li>Only after the HMAC check.</li><li>Only from Cal.com's own event, never from AI.</li><li>Written **after** the existing writes, so the cancellation never depends on it.</li><li>A booking with no lead → nothing extra.</li></ul> |
| W5 | **new** `W5 – Conversations` | — | <ul><li>Grist read of Conversations, between `W5 – Leads` and `W5 – Find due`.</li><li>Same credential as `W5 – Leads`.</li><li>On error it continues.</li></ul> | If it fails, nothing is held: W5 behaves exactly as before. |
| W5 | `W5 – Find due` | Reminder windows, R24/R2 flags, status Booked. | <ul><li>Same rules.</li><li>The **24-hour reminder only** is held while the patient's WhatsApp *cancel / reschedule* request (under 24 h old) is still waiting for staff (`Needs_Human`).</li><li>The 2-hour reminder always goes.</li></ul> | <ul><li>At most one of the two reminders can ever be held.</li><li>With no conversation data, or if Conversations cannot be read, W5 is identical to before (tested).</li></ul> |
| W6 | `W6 – Plan follow-ups` | <ul><li>Day 2: the A5 holds.</li><li>Rebook: none.</li></ul> | <ul><li>Day 2 and no-show rebook both use the next best action.</li><li>Day 2 adds **Assigned_To**.</li><li>Rebook is held when a person owns the conversation, a call is planned, or the patient **wrote after the missed visit**.</li><li>Day 2 goes **hot leads first**.</li></ul> | <ul><li>Windows, flags, and Opted_Out / Automation_Paused (still in `W6 – Decide send`) are unchanged.</li><li>With no AI data, the result is identical to before (tested).</li></ul> |

**Not changed:**
- W1, W2, W11, W12 and all 44 W13 nodes (byte-identical).
- Every webhook, credential and Config value.
- Every Execute Workflow node.
- The only Meta callers stay `W12 – Prepare request` and `W12 – Read reply`.
- The patched file is saved **inactive** (your export had `active: true`). Switch it on yourself after import.

### Next best action (`lead-context.js`)
The AI *recommends* through the fields it writes. n8n *validates* those fields: known values only, real timestamps, and anything broken is treated as unknown. The deterministic workflow then *executes*, within its own unchanged rules.

| Purpose | Actions (allowed ✓ / held ✗) |
|---|---|
| W3 escalation | <ul><li>staff own it → `wait` ✗</li><li>opted out / not interested / stop → `no_action` ✗</li><li>next contact planned → `wait` ✗</li><li>AI hand-off not delivered → `human_handoff` ✓</li><li>wrote within 60 min → `reply_now` ✓</li><li>hot → `reply_now` ✓</li><li>else → `follow_up` ✓</li></ul> |
| W5 reminder | <ul><li>pending cancel / reschedule request + Needs_Human + under 24 h, 24 h reminder → `human_handoff` ✗</li><li>else → `appointment_reminder` ✓</li></ul> |
| W6 day 2 | <ul><li>Needs_Human → `human_handoff` ✗</li><li>Assigned_To → `wait` ✗</li><li>not interested / stop → `no_action` ✗</li><li>planned → `wait` ✗</li><li>wrote under 48 h → `wait` ✗</li><li>cold → `nurture` ✗</li><li>else → `follow_up` ✓</li></ul> |
| W6 rebook | <ul><li>Needs_Human → `human_handoff` ✗</li><li>Assigned_To → `wait` ✗</li><li>not interested / stop → `no_action` ✗</li><li>planned → `wait` ✗</li><li>wrote after the missed visit → `wait` ✗</li><li>else → `rebook` ✓</li></ul> |

**What the staff brief answers** (W3), in one line of 240 characters at most:
- **WHO:** name and phone.
- **WHAT** they want: the AI summary, or the enquiry, plus the likely service.
- **WHAT happened recently:** last intent and when they last wrote.
- **HOW hot:** stage and waiting time.
- **WHAT next:** the action.

For example:
`New lead [HOT] Lead 32 (+91…) for Demo Physio, waiting 35 min. Wants a knee assessment tomorrow evening (Knee pain physiotherapy). Next: call now, ready to book.`

---

## 2. Workflow map: how AI intelligence flows

```
W1  Website lead      POST /webhook/website-lead (header auth) → honeypot + phone check → Agency Registry → LEADS create / update → Run_Log
                      AI: none. Staff alert: stub (no send).
W2  WhatsApp inbound  GET  /webhook/whatsapp-inbound (verify token) · POST → 200 to Meta first → parse → clinic → lead → conversation
                      (Last_Inbound_At, Unread) → Messages → stored? → ONE AI job (this workflow, not awaited) → Run_Log
W13 AI receptionist   W12 – AI Job? → Config → context (Settings, Knowledge, message, conversation, lead, history, Booked slots)
                      → gates (handled, STOP, ai_mode, opted out, paused, Needs_Human, answered, newer, EMERGENCY, night, media, rate)
                      → claim → OpenRouter openai/gpt-4o-mini (1 call, strict JSON schema) → validation (schema, triage, confidence
                      0.65/0.80/0.85, negative mood, no_reply rule, fact check) → appointment writes → W12 → CRM memory:
                         LEADS: Lead_Stage · AI_Summary · Likely_Service · Next_Action_At · Escalated (only if the alert was delivered)
                         Conversations: Last_Intent · Needs_Human · Handoff_Reason (AI staff note)   Messages: AI_* · Run_Log trace
W3  Speed to lead     every 10 min → LEADS (New) + Conversations → lead-context (memory above + Assigned_To, Automation_Paused,
                      Opted_Out) → hold / order / staff brief → W3 – Decide send → W12 (staff template) → Escalated + Run_Log
W4  Cal.com sync      POST /webhook/cal → HMAC-SHA256 (deterministic) → clinic → Appointments (Cal.com time / status = truth)
                      → LEADS Booked; on cancel: Next_Action_At = now → Run_Log.   No AI, no send (confirmation stub).
W5  Reminders         every 15 min → Appointments (Booked) + LEADS + Conversations → windows 20-24 h / 45-120 min + R24/R2 flags
                      → lead-context (24 h hold only) → W5 – Decide send → W12 → flag + Run_Log
W6  Follow-ups        10:00 → Appointments + LEADS + Conversations → day-2 window / no-show lookback (deterministic)
                      → lead-context (hold / hot first) → W6 – Decide send (opted out, paused, quiet hours) → W12 → flag + Run_Log
W11 Errors            Error Trigger → masked Telegram alert (phones → [number], tokens → [hidden]). Wired: n8n runs this workflow's own Error Trigger (correction, see 7)
W12 Only sender       allowlist · quiet hours 21:00-08:00 · TEST_MODE → TEST_PHONE · 24 h window for free text → Meta → inbox log
```

## 3. AI data flow

```
EVENT                     CONTEXT                          AI INTELLIGENCE              VALIDATION                         DETERMINISTIC ACTION        SEND          LOGGING
patient WhatsApp (W2) ──► CRM + Knowledge + free slots ──► W13: 1 OpenRouter call ──► schema · triage · tiers ·       ──► reply / hand-off /        ──► W12 ──► Meta   Messages AI_* ·
                                                           (JSON decision)             fact check · gates                   booking write                              Run_Log trace
                                                                    │
                                                                    └──► CRM memory: Lead_Stage · AI_Summary · Likely_Service · Next_Action_At · Last_Intent · Needs_Human · Handoff_Reason
                                                                                  │
schedule tick (W3/W5/W6) ──► lead-context.js reads that memory + Assigned_To · Automation_Paused · Last_Inbound_At · Opted_Out
                              ──► next best action (no model call) ──► the workflow's own windows / flags / Decide send ──► W12 ──► Meta ──► flags + Run_Log
Cal.com event (W4) ──► HMAC ──► Appointments (Cal.com truth) ──► LEADS (Booked · Next_Action_At on cancel) ──► read later by W3 / W5 / W6 / W13
AI failure ──► W13 hands off (holding reply + staff alert, "fallback:" in AI_Reason); W3/W5/W6 with missing or broken AI fields ──► exactly the old behaviour
```

---

## 4. Test report

All runs happen in the simulator: a fake Grist that checks columns and choices, a fake Meta, and a fake OpenRouter that reads the real prompt. Made-up phone numbers only; the secrets are test values held in memory.
- **Command:** `node n8n/integrated/system.test.js`, run on the public copy and on your private file. Both gave **identical results: 82 PASS, 1 NOT RUN**.
- **Mutations:** `ai-context-mutations.test.js` breaks each new rule once (15 breakages), and the system test caught all 15.

**W1 website leads**

| # | Test | Result | Why |
|---|---|---|---|
| W1.1 | website lead | PASS | LEADS row (New, +91 phone) + Run_Log ok; no WhatsApp send (W1 staff alert is a stub) |
| W1.2 | duplicate lead | PASS | same form twice: one lead, second logged "skipped" |
| W1.3 | invalid lead (bot / honeypot) | PASS | honeypot filled: no lead, Run_Log skipped |
| W1.4 | invalid lead (bad phone number) | PASS | no lead; Run_Log skipped "invalid phone" (checked in W1 – Resolve clinic) |
| W1.5 | unknown clinic | PASS | stops at W1 – Unknown clinic (a production run then triggers W11, this workflow's own Error Trigger) |

**W2 WhatsApp inbound**

| # | Test | Result | Why |
|---|---|---|---|
| W2.1 | Meta verification | PASS | right token -> 200 + challenge; wrong -> 403 |
| W2.2 | inbound WhatsApp text message | PASS | Meta answered 200 first; message stored; ONE AI job, not awaited |
| W2.3 | duplicate inbound message | PASS | stored once, one AI job, one reply |
| W2.4 | STOP / opt-out | PASS | lead Opted_Out, nothing sent |
| W2.5 | media message | PASS | no AI call; holding reply + staff alert via W12 |
| W2.6 | unknown clinic (phone_number_id) | PASS | no AI job, nothing sent |
| W2.7 | AI hand-off | PASS | holding reply + human_handoff_alert, both through W12; Needs_Human |
| W2.8 | AI response | PASS | knowledge-base prices as free text in the 24 h window |
| W2.9 | W12 send (only sender) | PASS | 2 Meta calls, each from its own W12 run |

**W3 speed to lead**

| # | Test | Result | Why |
|---|---|---|---|
| W3.1 | new lead (no AI data) | PASS | escalated as before; staff message = enquiry + next step |
| W3.2 | hot lead | PASS | first in the run; brief says HOT, what they want, "call now" |
| W3.3 | warm lead | PASS | right after hot (warm / unknown, oldest first) |
| W3.4 | cold lead | PASS | still escalated, last |
| W3.5 | recent patient reply | PASS | escalated with "reply on WhatsApp now" |
| W3.6 | human-owned conversation | PASS | Assigned_To: not escalated (before and after) |
| W3.7 | future Next_Action_At | PASS | next contact already planned: held (the original escalated it) |
| W3.8 | AI_Summary present | PASS | summary + stage in the staff message and the template's enquiry value |
| W3.9 | AI_Summary absent | PASS | falls back to Enquiry |
| W3.10 | follow-up (staff alert) sent | PASS | 6 alerts through W12 (TEST_MODE -> TEST_PHONE, template unchanged); Escalated + Run_Log |
| W3.11 | follow-up skipped (opted out, not interested) | PASS | held now; the original alerted staff about both |
| W3.12 | AI hand-off whose alert failed (safety net) | PASS | still escalated, with the AI's staff note |
| W3.13 | Conversations unreadable | PASS | no error; only the LEADS-based holds apply (opted out, planned next action); conversation-based holds lifted, as before |

**W4 Cal.com**

| # | Test | Result | Why |
|---|---|---|---|
| W4.1 | valid Cal.com webhook (new patient) | PASS | signature verified; Appointments row with Cal.com's own time; new lead Booked; no send, no AI call |
| W4.2 | invalid signature | PASS | rejected at W4 – Reject, nothing written |
| W4.3 | booking for an existing lead | PASS | linked to the lead, lead Booked, Run_Log; the AI fields are not touched |
| W4.4 | cancellation | PASS | Cancelled + Run_Log as before; NEW: lead Next_Action_At = now (rebook signal), never a time from AI |
| W4.5 | reschedule | PASS | old row Rescheduled, new row Booked at Cal.com's time |
| W4.6 | duplicate event | PASS | one row; second logged as skipped |
| W4.7 | unknown clinic | PASS | stops at W4 – Unknown clinic |
| W4.8 | cancellation of a booking with no lead | PASS | no lead write, no error |

**W5 reminders**

| # | Test | Result | Why |
|---|---|---|---|
| W5.1 | due reminder | PASS | 24 h reminder through W12, R24_Sent + Run_Log |
| W5.2 | not-due reminder | PASS | 30 h ahead: nothing |
| W5.3 | duplicate reminder | PASS | next run 15 min later: no second message (flag checked first) |
| W5.4 | cancelled appointment | PASS | no reminder |
| W5.5 | already reminded | PASS | R24_Sent already set: skipped |
| W5.6 | quiet hours | PASS | 22:00 IST: nothing sent, no flag |
| W5.7 | human-handled conversation | PASS | pending WhatsApp cancel request: 24 h reminder held (the original sent it); the 2 h reminder still goes; a complaint (Needs_Human) still gets its reminder |
| W5.8 | AI context present | PASS | hot lead with summary: reminder exactly as before (AI context never adds or changes a reminder) |
| W5.9 | AI context absent | PASS | no conversations: identical to the original (5 reminders) |
| W5.10 | Conversations unreadable | PASS | no error; every due reminder goes, as before |

**W6 follow-ups / no-show**

| # | Test | Result | Why |
|---|---|---|---|
| W6.1 | day-2 follow-up | PASS | sent through W12 (TEST_MODE), Followup_Sent |
| W6.2 | no-show | PASS | noshow_rebook through W12, Rebook_Sent |
| W6.3 | recently replied patient | PASS | day-2 held (wrote 10 h ago); rebook held because the patient wrote AFTER the missed visit (the original sent it) |
| W6.4 | human-owned conversation | PASS | Needs_Human / Assigned_To: no day-2, no rebook (the original sent the Assigned_To day-2 and the Needs_Human rebook) |
| W6.5 | opted-out patient | PASS | stopped by W6 – Decide send, as before |
| W6.6 | future next action | PASS | held |
| W6.7 | automation paused | PASS | stopped by W6 – Decide send, as before |
| W6.8 | AI summary present (hot first) | PASS | only 1 follow-up allowed: the hot lead gets it (the original picked the oldest) |
| W6.9 | AI summary absent | PASS | no AI data: identical to the original (7 follow-ups, 3 rebooks) |

**W11 errors**

| # | Test | Result | Why |
|---|---|---|---|
| W11.1 | simulated workflow failure | PASS | bad Cal.com signature stops the execution at W4 – Reject |
| W11.2 | error alert | PASS | Telegram alert names the workflow and the failing step |
| W11.3 | no patient data / secrets in the alert | PASS | phone -> [number], token / bearer / api key -> [hidden] |

**W12 sender**

| # | Test | Result | Why |
|---|---|---|---|
| W12.1 | text send (24 h window open) | PASS | free text accepted |
| W12.2 | template send | PASS | template sent |
| W12.3 | allowlist | PASS | number not on the allowlist: blocked, Meta never called |
| W12.4 | quiet hours | PASS | 22:00 IST: blocked |
| W12.5 | 24-hour window | PASS | free text 30 h after the last message: refused before Meta (outside the 24-hour WhatsApp window: only an approved templa) |
| W12.6 | failed Meta send | PASS | sent = false with Meta's error, no crash |
| W12.7 | successful Meta send | PASS | sent = true, wamid returned |

**W13 AI receptionist**

| # | Test | Result | Why |
|---|---|---|---|
| W13.1 | normal enquiry | PASS | replied from the knowledge base |
| W13.2 | service question | PASS | only services that are in Knowledge |
| W13.3 | price question | PASS | exact KB prices |
| W13.4 | availability | PASS | real free slots only (17:00 taken) |
| W13.5 | booking intent | PASS | booking link for that day (link mode) |
| W13.6 | cancellation | PASS | cancel link of THAT booking |
| W13.7 | unknown question | PASS | hand-off, nothing invented |
| W13.8 | human hand-off (asks for a person) | PASS | holding reply + staff alert |
| W13.9 | low confidence | PASS | person answers; the AI text is never sent |
| W13.10 | negative sentiment | PASS | non-informational + negative -> person |
| W13.11 | emergency keyword | PASS | URGENT hand-off without an AI call |
| W13.12 | STOP | PASS | opted out, nothing sent |
| W13.14 | AI provider failure | PASS | timeout -> hand-off, marked fallback |
| W13.13 | duplicate | PASS | one AI call, one reply |
| W13.15 | Grist failure | PASS | claim fails -> no AI call, nothing sent |

**Cross-cutting safety**

| # | Test | Result | Why |
|---|---|---|---|
| X.1 | AI context only holds back: W3 / W5 / W6 sends after ⊆ before, 120 random CRM states | PASS | 120 comparisons: never a send the original would not have made |
| X.2 | broken AI fields fall back to the original behaviour | PASS | unreadable stage / dates / toggles are treated as unknown, never guessed |
| X.3 | no new model call anywhere outside W13 | PASS | W3, W4, W5, W6 runs: 0 AI calls |
| X.4 | real connections | NOT RUN | NOT RUN: this sandbox cannot reach your n8n / Grist (Tailscale) and the export holds only credential references, no keys; real tests must be run in your n8n (see the README checklist) |

---

## 5. Regression report (before = your export, after = patched)

| | Count | Detail |
|---|---|---|
| Nodes added | 1 | `W5 – Conversations` |
| Nodes modified | 5 | `W3 – Find due`, `W3 – Build Message`, `W4 – Plan appointment`, `W5 – Find due`, `W6 – Plan follow-ups` (code only) |
| Nodes removed | 0 | 242 other nodes byte-identical |
| Connections added | 2 | `W5 – Leads → W5 – Conversations`, `W5 – Conversations → W5 – Find due` |
| Connections removed | 1 | `W5 – Leads → W5 – Find due` (now routed through the new node) |
| Connections modified otherwise | 0 | 243 of 244 identical |
| Credentials changed | **0** | 5 references, same set; the new node reuses `W5 – Leads`' Grist credential |
| Webhooks changed | **0** | `website-lead`, `cal`, `cal-w4-test`, `whatsapp-inbound` (GET + POST): every webhook / trigger node byte-identical |
| Secrets changed | **0** | 58 Config values in 11 Set nodes byte-identical; the W12 test input, W11 Telegram, Meta and OpenRouter nodes too |
| Schema changed | **0** | no table / column added; every column read exists in `grist/schema.md` |
| AI | unchanged | 44 W13 nodes identical; OpenRouter `openai/gpt-4o-mini`; 1 model call per message; 0 in W3/W4/W5/W6 |

**Existing suites, unchanged, run before and after** (`ai-context-regression.test.js`):

| Suite | Before (your export) | After (patched) |
|---|---|---|
| `integrated.test.js`: W2 → W13 → W12, 18 groups + 10 mutations | PASS | PASS |
| `existing-modules.test.js`: 25 W1/W3/W4/W5/W6/W11/W12 scenarios | PASS | PASS |
| `ai-os.test.js`: A1–A6, 14 groups | PASS | 12 PASS, **2 intended changes** |

The 2 intended changes:
1. A5 kept the no-show rebook for a Needs_Human lead; now that rebook waits while a person owns the conversation.
2. The A6 staff text is replaced by the staff brief.

The runner fails if any other group differs.

On your **private** files, one existing check (`existing-modules`: "file as committed: the Cal.com secret is a placeholder") fails before *and* after. It exists to check the public copy, and your file now holds the real secret. The private and public patched files differ only in the redacted values; this is verified by redacting the private one and comparing it byte for byte.

## 6. Security preservation (verified from the before / after files, `validate-ai-context.js --private`)

```
Secrets changed:     0
Webhooks changed:    0
Credentials changed: 0
```

- The delivered import file keeps your Cal.com secret, Meta verify token, allowlist and test numbers **exactly** as you exported them; it contains no placeholders.
- This repository is public, so the copies committed here are redacted (`n8n/integrated/redact.js`). Your import file was sent to you directly and is never committed.
- No secret was printed: every audit output masked long digit runs and secret fields.

## 7. What could not safely be implemented, and findings (reported, not changed)

**Not implemented:**

| Item | Why |
|---|---|
| **Real-connection tests** (X.4) | This sandbox cannot reach your n8n / Grist (Tailscale). The export holds only credential *references*, so no real Meta / OpenRouter / Grist call is possible from here. |
| A model-generated "next best action" field | It would need a new Grist column (a schema change) and a prompt change. The deterministic next best action, built from the AI's existing fields, gives the same benefit with no new call. |
| W4 booking confirmation (still a stub) | Sending it is a new patient-facing message that needs an approved `booking_confirmation` template. W4 is unchanged there. |
| AI text in patient reminders / follow-ups | `AI_Summary` is staff-only. Patient templates (W5 / W6) are unchanged, so internal notes can never reach a patient. |

**Findings:**

| Finding | Detail |
|---|---|
| ~~⚠ W11 is not wired~~ (**corrected 8 Oct, W7-W10 report**) | This finding was wrong. With `settings.errorWorkflow` empty, n8n runs the failed workflow's OWN Error Trigger, so W11 does fire on a failed production run of this workflow (Section 00 says so too: "Settings > Error workflow stays EMPTY"). Nothing to change. |
| ⚠ `W13 – Ask Model` → `allowUnauthorizedCerts: true` | TLS certificate checks are off for the OpenRouter call. Recommended: switch it off. Not changed (security configuration). |
| ⚠ W2 does not verify Meta's `X-Hub-Signature-256` | Anyone who knows the URL can post a fake inbound message. |
| `W4 – Webhook` (path `cal-w4-test`) | Unconnected, but it registers a live URL when the workflow is active. Harmless, since it does nothing, but it can be deleted. |
| `W5 – Clinics` | Sends an empty query parameter (`?=`). Harmless today. |
| Templates | W3, W5 and W6 day-2 still send `hello_world`. The staff brief is ready for `new_lead_staff_alert` (its `enquiry` value). |
| Night emergencies | W12's quiet hours (unchanged) hold every send 21:00–08:00, so an URGENT alert written at night goes out at 08:05. |
| W5 edge case | If a patient asks on WhatsApp to reschedule, then reschedules on Cal.com themselves within 24 h, and staff have not unticked Needs_Human, the new appointment's 24 h reminder is held. The 2 h reminder still goes. |
| Telegram chat id | The W11 chat id has been in this public repo since 5 Oct (the merged W1–W12 workflow). It is not a credential (the bot token stays in n8n). Say if you want it redacted in the public copies; the git history would still contain it. |

## 8. Import (your call; nothing was activated)

1. **Import the private file as a new workflow.** It arrives inactive. Your current workflow keeps running.
2. **Check that the credentials resolved.** It uses the same credential ids on the same n8n instance.
3. **Check the switch-over checklist**, for example with a staff member's test lead:
   - W3 alert text;
   - a cancelled Cal.com booking shows a due `Next_Action_At`;
   - a held 24 h reminder.
4. **Switch over yourself.** Deactivate the old workflow and activate the new one. The webhook paths are the same.
5. **Roll back** by activating the old workflow again; nothing in Grist needs undoing.
