# W13 — AI receptionist (WhatsApp lead replies)

W13 connects the AI to the existing workflows. With it, a patient's WhatsApp message gets an answer, the CRM is updated and a
person is called in when needed:

```
Patient WhatsApp ─► Meta ─► W2  (answers Meta 200, stores lead / conversation / message, dedupes on WA_Message_ID)
                             │  one run per stored message, W2 does not wait
                             ▼
                            W13 ─ read: clinic (Agency Registry), Settings, Knowledge, the message, its conversation + lead,
                             │        last 40 messages, Booked appointments  ──►  free slots computed in CODE
                             ├─ gates (no AI): already handled · STOP · ai_mode off · opted out · paused · Needs_Human ·
                             │                 staff already answered · newer message · EMERGENCY words (→ URGENT hand-off) ·
                             │                 a staff member wrote in the last 24 h (W10) · night (defer) · media · rate limit
                             ├─ claim: Messages.AI_Status = processing   (no double replies)
                             ├─ Claude Haiku: ONE structured JSON decision (intent, action, reply, confidence, needs_human…)
                             ├─ checks in CODE: schema · triage (urgent / any risk flag → person) · confidence tiers (< 0.65 person,
                             │                 0.65-0.80 informational answers only, appointment writes ≥ 0.85) · negative mood →
                             │                 informational only · no_reply only for thanks / not interested ·
                             │                 complaint/payment/medical/human → person ·
                             │                 fact check (prices, times, links, phone numbers must come from the facts) ·
                             │                 slots must be really free · links filled by code, never typed by the AI
                             ├─ appointment writes first (direct booking / WhatsApp-booked cancel); failure → person
                             ├─ W12 (inside the master workflow): free-text reply in the 24 h window / staff alert template
                             │        (Opted_Out, quiet hours, TEST_MODE → TEST_PHONE, W12 allowlist all still apply)
                             └─ CRM: message row (intent, action, status, reply) · conversation (Last_Intent, Needs_Human) ·
                                     lead (Lead_Stage, AI_Summary, Likely_Service, Contacted, First_Response_At, Next_Action_At) · Run_Log
08:05 IST every day: messages deferred overnight are answered (newest per conversation, last 20 h).
```

> **Status: built and tested in the simulator only.** Every test below ran against the shipped JSON with a fake Grist, a fake
> Meta and a **fake Claude** (no API key is available here). The real Claude has not answered a single message yet. Run the
> manual dry-run test (section 4, step 8) before you switch `ai_mode` on, and keep TEST_MODE on until it looks right.

| File | What it is |
|---|---|
| `W13-AI-Receptionist.json` | **The workflow to import** (52 nodes: 47 working + 5 notes). Claude via the Anthropic API. |
| `W13-AI-Receptionist-Demo-OpenRouter.json` | **DEMO / testing variant**, workflow name "W13 DEMO - AI receptionist (OpenRouter)": the same workflow with only the model provider swapped to OpenRouter (section 6). |
| `build-w13.js` | Rebuilds it from `code/*.js` + the snippets: `node n8n/w13/build-w13.js` (the demo: `--provider openrouter`) |
| `code/*.js` | The 18 Code nodes' own code. Four of them get the shared helpers pasted in at build time. |
| `w13.test.js` | 17 end-to-end check groups + 15 mutation tests: `node n8n/w13/w13.test.js` |
| `w13-openrouter.test.js` | The demo: proves only the provider layer differs, checks the OpenRouter request, the safety cases through OpenRouter, then runs the whole `w13.test.js` suite on the demo file. |
| `knowledge-base.sample.csv` | FAKE demo rows for the new Knowledge table (import into Grist, then replace with the clinic's real facts). |
| `../snippets/ai-receptionist.js` (+ `.test.js`) | All W13 decision logic as pure functions, with 30 unit-test groups. |

Changed outside `n8n/w13/`: `n8n/snippets/wa-send.js` (free text + `human_handoff_alert`), the W12 copies (`n8n/workflows/W12-whatsapp-send.json`,
master change **A-01**, see `n8n/merged/README.md` 5c), W2 (hand-off, see `n8n/w2/README.md` 13), `grist/schema.md`, `n8n/whatsapp-templates.md`,
the simulator (`n8n/tests/n8n-sim.js`: Claude calls, calls into other workflows) and `n8n/tests/run-all.js`.

---

## 1. Architecture assessment (where the AI sits, and why)

| Existing piece | What W13 does with it |
|---|---|
| **W2** (inbound) | Unchanged logic. After it stores a message it starts W13 for that message (fire and forget). Its dedupe on WA_Message_ID is the first idempotency layer. |
| **W12** (the only WhatsApp sender) | W13 sends ONLY through W12, by calling the master workflow (whose W12 section is its only Execute Workflow Trigger). W12 got one new ability (A-01): free text inside the 24 h window. |
| **W4** (Cal.com → Appointments) | Grist stays the source of truth: W13 reads Booked appointments to compute free slots. In the default `link` mode the patient confirms on Cal.com and W4 writes the booking; cancel / reschedule links point at Cal.com, and W4 records the change. |
| **W5** (reminders) | Any Booked row, including W13's `direct` bookings (`Booking_UID wa-…`), gets the normal reminders. |
| **W3** (speed to lead) | A real AI answer sets the lead to **Contacted**, so W3 stops chasing staff. A hand-off leaves the lead New, but once its staff alert is **delivered** W13 sets **Escalated**, so W3 does not alert again; if the alert failed, W3 still escalates. (A6, live workflow: W3 also orders hot → warm → cold, skips conversations with Automation_Paused / Assigned_To, and puts AI_Summary in its staff message.) |
| **W6** (follow-ups) | "I'll think about it" sets **Next_Action_At**; W6's mark-Lost skips leads with a future Next_Action_At, and (A5, live workflow) the day-2 follow-up skips it too. |
| **W11** (errors) | Point W13's error workflow at the master; a failed CRM write after the reply stops W13 with an error, so you get the alert. |

**Why a separate workflow and not inside W2 or the master:** W2 must answer Meta within seconds and stays simple. The master
can have only one Execute Workflow Trigger (W12's), and you asked not to rebuild it. W13 is new, and its only change to
existing logic is A-01.

## 2. The AI decision (what Claude returns)

One request per message to `claude-haiku-4-5` with **structured output** (the JSON schema is enforced by the API, and checked again by W13):

| Field | Values |
|---|---|
| `intent` | greeting, services_info, pricing, location_hours, availability_check, book_appointment, reschedule_appointment, cancel_appointment, appointment_status, follow_up_later, not_interested, thanks_ack, complaint, human_request, payment_issue, medical_question, outcome_better, outcome_same, outcome_worse, other |
| `action` | reply, offer_slots, book_slot, cancel_appointment, reschedule_appointment, schedule_follow_up, handoff, no_reply |
| `needs_human`, `handoff_reason` | true + why, when a person must answer |
| `confidence` | 0–1; below `min_confidence` (0.65) = a person answers; below `confidence_auto` (0.8) only informational answers (greeting, services, prices, location / hours, availability, appointment status, thanks) go out; Grist appointment writes need `confidence_write` (0.85) |
| `sentiment`, `language`, `lead_stage` | positive/neutral/negative · the patient's language · cold/warm/hot |
| `reply` | the WhatsApp text (patient's language, ≤ 3 sentences); links only as `{{BOOKING_LINK}}`, `{{CANCEL_LINK}}`, `{{RESCHEDULE_LINK}}` |
| `booking` | `{date, time, time_window}`: dates copied from the CALENDAR the prompt gives (the AI never computes a date) |
| `appointment_ref`, `follow_up_days`, `kb_refs`, `likely_service`, `lead_summary` | which appointment (A1…), follow-up delay, the knowledge rows used, service title, a 1–2 sentence summary for the CRM |
| `priority`, `risk_flags`, `staff_note` | triage for staff: urgent / high / normal · any of emergency, complaint, payment, medical, legal, abusive, sensitive (any flag = a person answers) · ≤ 200 characters for the hand-off alert (links and numbers are removed in code) |

Before the AI is asked, unambiguous emergency phrases (chest pain, can't breathe, unconscious, fainted, heavy bleeding, suicide…, in
English, Hinglish and Hindi) hand the message to staff as **URGENT**: the patient gets the normal hand-off reply, staff get
`human_handoff_alert` with "URGENT · Possible emergency…". Physio words such as stroke, paralysis, fracture or accident are not on
that list. W12's quiet hours still apply: an emergency written at night is alerted at 08:05.

Every run writes a trace to Run_Log > Record (`| gate=ai openai/gpt-4o-mini 1234ms tok 3100/210`, `fallback` when the AI answer
was unusable), and AI_Reason starts with `[urgent · complaint]`-style tags and `fallback:` where they apply.

The prompt contains ONLY facts W13 computed or read: clinic name, booking mode, the Knowledge rows, a 7-day calendar, the free
start times, the patient's name / CRM status / earlier summary, their upcoming appointments and the last 12 messages.
**No phone numbers** go to the AI. The patient's text is wrapped as data (prompt-injection rule in the system prompt).

**CLAUDE.md rule 8** says the AI only writes summaries and report text and never sends to patients. Your new request (an AI
that replies on WhatsApp) conflicts with it. I kept its intent: the AI never sends anything, never computes numbers, slots or
dates, and every reply passes code checks before W12 sends it. I did not edit CLAUDE.md: please update rule 8 if you agree.

## 3. Test results (simulator: W2 → W13 → master W12, fake Claude reading the real prompt)

`node n8n/tests/run-all.js` runs them all (stops on the first failure). Demo clinic: Mon–Sat 09:00–19:00, 30-min slots,
Asha has a Cal.com appointment tomorrow 10:00, another patient holds tomorrow 17:00. Clock: Tue 06 Oct 11:00 IST.

| # | Patient writes | Sent on WhatsApp (exactly) | CRM |
|---|---|---|---|
| 1 | NEW: "Hi, I want to know about your services." | "Hi! We offer Knee pain physiotherapy and Back pain physiotherapy. Would you like to book a first assessment?" | new lead (WhatsApp, Neha) → Contacted, Lead_Stage warm, First_Response_At, AI_Summary; message `replied` / services_info |
| 2 | EXISTING: "Can I come tomorrow evening?" | "Yes! Tomorrow evening we have 4:00 PM, 4:30 PM, 5:30 PM free. Which one suits you?" (17:00 is taken, so it is not offered) | same lead, Lead_Stage hot, offer_slots |
| 3 | "How much does this cost?" | "The first assessment costs ₹500 (45 minutes). Treatment sessions are ₹800 each." | pricing |
| 4 | "Book me for Saturday at 5." | link mode: "Saturday at 5:00 PM is free. Please confirm your booking here: https://cal.com/demo-physio/assessment?date=2026-10-10&month=2026-10" · direct mode: Appointments row `wa-<message id>`, Sat 17:00–17:30, lead **Booked** · a taken slot: "Sorry, that time is not available. Free times: …" | book_slot |
| 5 | "Cancel my appointment tomorrow." | "No problem. You can cancel your appointment on Wed 07 Oct 10:00 AM with this link: https://cal.com/booking/cal-uid-asha-1?cancel=true" (a WhatsApp-made booking is set to Cancelled directly) | cancel_link, Lead_Stage cold |
| 6 | Unknown: "Do you accept the XYZ health insurance card?" | patient: "Thank you for your message. A member of our team will reply to you shortly." + owner: `human_handoff_alert` (clinic, name, phone, reason) | Needs_Human on message + conversation, Handoff_Reason; lead NOT Contacted; the patient's next message is not answered by the AI |
| 7 | RETURNING after 5 days: "Hi again, is the knee treatment price still the same?" | "Welcome back Asha! Yes, knee physiotherapy is still ₹800 per session, and you can book here: https://cal.com/demo-physio/assessment" | the prompt had the earlier chat + summary; Likely_Service, Lead_Stage hot |

Reliability checks that pass:
- **Duplicates.** The same webhook twice gives one reply. A W13 re-run on a handled message does nothing. The message row is set to `processing` before Claude is asked.
- **AI failure.** Timeout, a 529 overload, a non-JSON answer, an invalid decision and a refusal all lead to a hand-off. No made-up text is ever sent.
- **Hallucination.** An invented price (₹199) or link is never sent: the patient gets the hand-off message, and the details stay in Grist. An invented or taken time is replaced by the real free times. A reply that is a payment issue, or below the confidence threshold, goes to a person.
- **Meta rejects** (131047): status `failed`, Needs_Human, Run_Log `failed`.
- **Wrong W12 id:** status `failed`, nothing sent.
- **Grist failures.**
  - The claim fails: no AI call, nothing sent.
  - Settings can't be read: nothing sent.
  - A booking can't be saved: it is never confirmed to the patient (hand-off).
  - A final CRM write fails: W13 stops with an error, so W11 alerts. W2 is not affected.
- **STOP** sets Opted_Out, and nothing more is sent to that patient.
- **ai_mode missing:** W13 does nothing at all.
- **TEST_MODE:** the reply goes to TEST_PHONE and is logged in the patient's conversation.
- **22:00:** the message is deferred with no AI call; the 08:05 run answers it, with the morning's calendar.
- **Rate limit** of 6 replies an hour: a hand-off.
- **Paused conversation:** skipped.
- **Image:** a hand-off, with no AI call.
- **draft mode:** nothing is sent; the reply waits in AI_Reply.
- **Manual dry run:** 7 cases, 7 Claude calls, nothing written, nothing sent.
- **Mutation tests:** 15 safety rules, each switched off once (fact check, human intents, confidence, slot repair, claim, Needs_Human, quiet hours, STOP, default off, dry run, failed booking, W12 answer, rate limit, claim order, Contacted on hand-off). The behaviour tests catch every one.

## 4. Setup (in this order)

1. **Grist (every clinic doc):** add the columns and the Knowledge table from `grist/schema.md`:
   - **LEADS:** `Lead_Stage`.
   - **Conversations:** `Needs_Human`, `Handoff_Reason`, `Last_Intent`.
   - **Messages:** `Intent`, `AI_Action`, `AI_Confidence`, `AI_Status`, `Needs_Human`, `AI_Reply`, `AI_Reason`. Also add `Received` to the Status choices if W2 is live.
   - **Knowledge:** a new table. Import `knowledge-base.sample.csv` as a starting point and **replace the demo facts with the clinic's real ones**. The AI knows nothing else.
2. **Settings rows:** `open_time`, `close_time`, `working_days` (without them W13 never offers a time), `booking_link`, and `owner_phone` (receives the hand-off alerts). Leave `ai_mode` out for now.
3. **Meta:** create the template `human_handoff_alert` (`n8n/whatsapp-templates.md`).
4. **n8n credential:** Credentials > New > **Header Auth**, name it **Anthropic API**. Set Name to `x-api-key` and Value to your Anthropic key. Never paste the key anywhere else.
5. **Master workflow:** it needs A-01 (`n8n/merged/README.md` 5c). Either re-import `clinic-autopilot-single-workflow.json`, or replace the `wa-send.js` part in `W12 – Prepare request` and `W12 – Read reply`. Copy the master's workflow id from its URL.
6. **Import W13** (`W13-AI-Receptionist.json`):
   - On `W13 – Ask Claude`, pick the **Anthropic API** credential.
   - In `W13 – Config`, set `w12_workflow_id` to the master's id.
   - In Settings, set Error workflow to the master (W11 lives there).
   - Save.
7. **W2:** paste W13's id (from its URL) into `W2 – Config` > `ai_workflow_id`, then save.
8. **Dry run with the real Claude.** Open W13 and click **Execute workflow** on `W13 – Manual Test`.
   - `W13 – Test Report` shows, for each of the 7 cases, the intent, the action, the reply and what it WOULD send. Nothing is written or sent.
   - The cases use `demo-clinic` (WA_Phone_Number_ID `123456789012345`) and the fake W2 test numbers.
9. **Draft mode:** set `ai_mode` = `draft` in the clinic's Settings. Real patient messages are now decided and written to the CRM, but not sent: read `Messages > AI_Reply` for a few days.
10. **Auto mode:** set `ai_mode` = `auto`.
    - With TEST_MODE on, every reply goes to TEST_PHONE, which must also be in W12's allowlist.
    - When you are happy, switch TEST_MODE off for that clinic. This is your decision: nothing here turns TEST_MODE off, and W12 stays `send_mode = allowlist`.

When the AI hands a conversation to a person, `Conversations > Needs_Human` is ticked and the hand-off reason is in `Handoff_Reason`.
- The AI never touches the handed-off message again: re-runs, Meta re-deliveries and the 08:05 retry all skip it.
- A **new** message from the patient after the hand-off is handled by the AI again, through every gate (STOP, opted out, paused, duplicates, night, media, rate limit, confidence, medical / payment / complaint → person).
- If that new message needs a person too, it is handed off again: a new staff alert, `Needs_Human` set again, `Handoff_Reason` = the new reason.
- W13 never unticks `Needs_Human`; staff untick it when the issue is dealt with.
- To keep the AI quiet while staff talk to the patient, tick `Automation_Paused`. A `Needs_Human` ticked by hand, with no hand-off from W13, also keeps the AI silent.
- **Staff replies (W10):** for 24 h after a staff member's message (a Messages row Direction Out whose Sent_By is a person, not `W<n>-…`), the AI does not answer that patient; staff own the conversation. STOP and emergency words still work.

**Answers to W7's check-in.** When the conversation shows the clinic asked "How are you feeling now?", the AI reads the answer as
`outcome_better` (a short thank-you, or no reply), `outcome_same` (a person follows up) or `outcome_worse` (a person, priority at
least HIGH, flagged medical; code forces the hand-off even if the model tries to answer, and never sends advice). Urgent words are
caught before the AI (URGENT hand-off). "Book me again" is an ordinary `book_appointment` (real free times / the Cal.com link only).
The answer is recorded in `Messages.Intent` and `Conversations.Last_Intent`; W9's weekly report counts them.

## 5. Limitations and open points (please decide)

1. **Not tested with the real Claude or a real Meta / Grist.** The simulator proves the wiring and the rules; it cannot prove how well Haiku understands Hinglish. Step 8 is that test.
2. **CLAUDE.md rule 8** conflicts with "the AI replies" (section 2). Update it if you agree; I did not.
3. **The 24-hour window.** Free text works only within 24 h of the patient's last message (minus a 5-min margin); W12 refuses free text after that. With TEST_MODE on, the reply goes to TEST_PHONE, and Meta checks the window for THAT number, so Meta may reject it (131047) unless TEST_PHONE has written to the clinic number in the last 24 h.
4. **W6's day-2 follow-up** now skips Needs_Human, Lead_Stage cold, Last_Intent not_interested / opt_out, a future Next_Action_At and a patient message in the last 48 h. This is done in your live workflow by `n8n/integrated/apply-ai-os.js` (A5); the standalone W6 export in `n8n/workflows/` is unchanged.
5. **No new-lead staff alert when the AI answers.** W2's `new_lead_staff_alert` payload is still only prepared. Staff are alerted on hand-offs, and they see everything else in Grist.
6. **The claim is not atomic.** Grist has no compare-and-set, so two W13 runs started within milliseconds for the SAME message could both pass the check. W2 never does that (one run per new WA_Message_ID); it could only happen if someone re-runs an execution by hand at the same moment.
7. **Booking races.** In `direct` mode, two patients who take the same free slot at the same second can both get it, because capacity is checked when the facts are read. `link` mode (the default) leaves booking to Cal.com.
8. **Meta signature.** W2 still does not verify `X-Hub-Signature-256` (noted in W2's README). Anyone who knows the webhook URL could post a fake "patient message" that the AI then answers. Add the signature check before going live.
9. **Costs.** One Claude call per answered message: about 2,500–4,000 input tokens and 200–400 output tokens (`W13 – Done` > `usage` shows the real numbers). Prompt caching on the rules + clinic facts only starts once that prefix is over 4,096 tokens (Haiku 4.5's minimum), so with a small knowledge base there is no caching benefit. Gates, nights, STOP and handled messages cost nothing.
10. **Memory** is the last 12 messages plus the lead's AI_Summary (updated every turn), so very old details fall out of the prompt on purpose.

## 6. Demo with OpenRouter (temporary, instead of an Anthropic key)

`W13-AI-Receptionist-Demo-OpenRouter.json` ("**W13 DEMO - AI receptionist (OpenRouter)**") is W13 with ONLY the model-provider
layer swapped. Everything else is identical, and `w13-openrouter.test.js` checks this node by node:
- same node ids, gates, checks, hand-offs and CRM writes;
- W12 still does all sending;
- the same decision JSON contract and the same Knowledge, Grist and W2 logic.

| W13 (Anthropic) | W13 DEMO (OpenRouter) |
|---|---|
| `W13 – Ask Claude` (HTTP `https://api.anthropic.com/v1/messages`, credential **Anthropic API**) | `W13 – Provider Request` (Code: the same request, translated) → `W13 – Ask Model` (HTTP `https://openrouter.ai/api/v1/chat/completions`, credential **OpenRouter API**) → `W13 – Provider Answer` (Code: the answer translated back) |
| `W13 – Config` > `anthropic_model` = `claude-haiku-4-5` | `W13 – Config` > `model_provider` = `openrouter`, `openrouter_model` = `openai/gpt-4o-mini` |

**What the translation does** (`n8n/snippets/ai-provider.js`, unit-tested):

- **Request.**
  - The same instructions and facts become one system message: rules, then clinic + Knowledge, then calendar, free slots, patient, appointments and history. The order is kept, so the stable part stays first.
  - The same `<patient_message>`, the same `max_tokens` (1500).
  - The same decision JSON schema goes in as `response_format: {type: json_schema, json_schema: {strict: true}}`.
  - `provider.require_parameters: true` makes OpenRouter use only an endpoint that enforces the schema.
  - Anthropic's `cache_control` marker is dropped; OpenRouter providers cache long prefixes by themselves.
- **Answer.** `choices[0].message.content` becomes the same `{content: [{type: text}], stop_reason}` shape that `W13 – Plan` already reads.
  - `length` maps to "cut off".
  - A refusal or content filter maps to "declined".
  - HTTP errors, timeouts and 429 rate limits become an error.
  - Every one of these failures becomes a **hand-off to a person**, as with Claude.
  - `W13 – Plan` then parses, validates and fact-checks the decision with the unchanged code. Nothing is relaxed.

**Model used for the demo: `openai/gpt-4o-mini`.** It is cheap, supports strict JSON-schema structured outputs, and handles Hindi and Hinglish well.
- Change it in `W13 – Config` > `openrouter_model` (any `vendor/model` id from openrouter.ai/models).
- Before you pick another model, check on its OpenRouter page that **structured_outputs** is listed. If no endpoint supports it, OpenRouter refuses the call (because of `require_parameters`) and every message is handed to a person: safe, but useless.
- `:free` models are not recommended here. Few of them enforce a JSON schema, and they are heavily rate-limited.
- A wrong `model_provider` or an empty or malformed model id stops the run before any call, with a clear error.

**Setup (demo):**
1. In OpenRouter, create an API key (openrouter.ai > Keys) and add a little credit. Never paste the key anywhere except the n8n credential below.
2. In n8n, go to Credentials > New > **Header Auth**:
   - Credential name: **OpenRouter API**
   - Name: `Authorization`
   - Value: `Bearer <your OpenRouter key>` (the word Bearer, a space, then the key).
3. Import `W13-AI-Receptionist-Demo-OpenRouter.json`.
   - On `W13 – Ask Model`, pick the **OpenRouter API** credential.
   - In `W13 – Config`, set `w12_workflow_id` to the master workflow's id.
   - Save. **Do not activate it**: W2 calls it without it being active, and only the 08:05 night-retry needs activation.
4. **Dry run:** click Execute workflow on `W13 – Manual Test`.
   - The model is really called; nothing is written to Grist and nothing is sent.
   - `W13 – Test Report` shows the 7 scenarios. `usage` shows the model OpenRouter actually used and the tokens.
5. To use it with real messages, put **this** workflow's id in W2 – Config > `ai_workflow_id`, keep the clinic's `ai_mode` at `draft` (prepared, not sent) and TEST_MODE on.
   - `auto` still sends only through W12, after every check. That step is yours to decide; nothing here sets it.

**Back to Anthropic later:** put W13's id (the Anthropic workflow) back into W2 – Config > `ai_workflow_id`. No other change is needed: both workflows read the same Grist data and write the same columns.
- Only ever have ONE of the two connected to W2, and at most one active, because both have the 08:05 run.
- The Run_Log and the `AI_Reason` texts say "Claude …" in both workflows. They mean "the model".

