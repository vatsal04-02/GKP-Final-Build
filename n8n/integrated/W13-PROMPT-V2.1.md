# W13 receptionist prompt v2.1 and v2.2

**What it is.** A new system prompt for the W13 AI receptionist, plus stricter Hindi / Hinglish fact checks in W13's code. It is applied to
your latest export, "ai updated workflow clinic final v1", and the result is the master: `clinic-autopilot-master-ai.json` (323 nodes),
also saved as `ai-updated-workflow-clinic.w13-v2.2.json`. The master now carries **v2.2**: v2.1 plus routine questions answered directly (next section).

**What it does not change**
- Nodes: 0 added and 0 removed.
- Connections: none changed.
- Credentials, webhooks and Config values: none changed.
- The model id, `anthropic/claude-sonnet-5.5`: unchanged. It is still one model call per message.
- The decision schema, intents, actions, confidence thresholds (0.65 / 0.80 / 0.85), the gate order and the quiet-hours rule: unchanged.
- The Grist schema and patient data: untouched.
- W12 is still the only WhatsApp sender, and W10 still sends the staff replies.

`validate-w13-prompt.js` proves all of this against your export.

## v2.2: routine questions answered directly (latest)

**Changed: the prompt text only** (`AI_RULES` in `n8n/snippets/ai-receptionist.js`), in two places:
- **A new "Routine questions" section**, right after "Facts":
  ```
  Routine questions
  - Services, prices and opening hours (intent "services_info", "pricing", "location_hours") are routine. If the KNOWLEDGE BASE answers the question, answer it yourself: action "reply", needs_human false, handoff_reason "", no risk flags, kb_refs = the K-number of every entry your reply uses. An entry that states the answer = confidence 0.9 or more. Never hand off only because someone asks about a service, a price or the hours.
  - Opening hours: exactly as the KNOWLEDGE BASE states them, never worked out from AVAILABILITY (free appointment times only). Asking what something costs is pricing, not a payment issue.
  - Not in the KNOWLEDGE BASE: follow Facts (one short question or a hand-off), never guess. If the message also needs a person (an emergency, a medical question, a complaint, a payment or refund problem, a request for a person), the hand-off rules below win.
  ```
- **`kb_refs` is defined exactly:** `kb_refs = the K-numbers you used, written like "K3" (empty list if none).` The knowledge base reaches the model as `[K3] (pricing) First assessment: ...`, where the number is the Knowledge row id.

**Not changed:**
- The W13 Plan code (`aiPlan`, `aiRoute`), the confidence thresholds (0.65 / 0.80 / 0.85) and the fact checks.
- The medical, emergency, human-request, complaint and payment hand-off rules.
- The gates, W12 (the only sender), the schema, the model, nodes and connections.

**Why the existing Plan sends these answers as they are:**
- `services_info`, `pricing` and `location_hours` with `reply` are already "informational", so they go out from confidence 0.65 after the fact check.
- Every price and time in the reply must still be in the knowledge base.
- The Plan code does not read `kb_refs`.

**Opening hours come only from a Knowledge entry** (category `hours`). The CLINIC facts do not list hours, and AVAILABILITY lists free start times only. A clinic without an hours entry gets the earlier behaviour: one question, or a hand-off.

**Tests**
- `ai-prompt.test.js` group 8: the decision the new rule asks for goes through the unchanged Plan for services, prices and hours, in English, Hindi and Hinglish (8 cases).
  - Each one ends as one patient reply, with no staff alert and `Needs_Human` off.
  - The K-numbers the model sees match the `kb_refs` format; an inactive entry is never shown.
  - A payment flag, `needs_human` true, confidence 0.6, or an invented price or opening time still hands off.
- `eval-prompt.js` (live model, **not run here**):
  - E2, G2 and H2 now also require `reply`, `needs_human` false, no flags and the right `kb_refs`.
  - New cases: E14 (services, K1 + K2) and E15 (Saturday opening time, K4). That makes 26 cases.

**Tooling**
- `apply-w13-prompt.js` also accepts a workflow that already has v2.1, for example a re-export after importing it. The result is identical to upgrading from your original export.
- `apply-quiet-hours-switch.js` knows the v2.2 versions of `W13 – Build Context` and `W13 – Plan Ready`.
- The release copy is now `ai-updated-workflow-clinic.w13-v2.2.json`.

**Cost:** the prompt grew from 8,258 to 9,192 characters, about 230 more input tokens per message. The test's length cap went from 9,000 to 10,000 characters.

**Results:** the same as section 4 below, re-run on v2.2. All 47 test files pass, and `ai-prompt.test.js` now has 8 / 8 groups. The six regression suites and the quiet-hours suites are identical to your unpatched export, with the switch on and off.

## 1. Changes (v2.1)

**Prompt (`AI_RULES` in `n8n/snippets/ai-receptionist.js`)**
- **Who it is.** The clinic's automated assistant, not a doctor. It says so honestly if asked.
- **Tone.** Warm and calm, like a front-desk person. It acknowledges pain or worry in a few words. No sales pressure.
- **Facts.** Only CLINIC, KNOWLEDGE BASE, CALENDAR, AVAILABILITY, PATIENT, APPOINTMENTS and RECENT CONVERSATION. It never invents services, prices, staff, slots or policies. It never mentions the knowledge base or its own confidence.
- **Numbers.** Always digits 0-9, also in Hindi and Hinglish. Times are written as AVAILABILITY lists them or with AM/PM, never in words ("saadhe paanch").
- **Health.** No diagnosis, exercises, medicines or promised results.
  - A condition mentioned while asking about services, prices or booking ("back pain hai, kal aa sakta hoon?") is answered from the facts.
  - Real medical questions are handed off.
- **Emergencies.** A listed set of warning signs → urgent hand-off. The earlier draft's sentence "the team is alerted at once" is **not** in the prompt, because the workflow does not guarantee it (section 5).
- **Language.** The patient's language and script: English, Devanagari Hindi or Latin-letter Hinglish. Always "aap". Replies are WhatsApp-short, with at most one emoji and no repeated greeting.
- **Missing information.** Ask one clear question, and never for something the CRM already has.
- **Confidence.** Explained in bands: 0.9 or more = the facts answer it; 0.7–0.9 = very likely right; below 0.7 = unsure.
- **Staff fields.** `staff_note` and `lead_summary` are in English for the staff.

**Fact-check guards (code, the same file).** These are the checks that decide what is actually sent:
- **Prices.**
  - Hindi rupee words are recognised as whole words: रुपये, रुपए, रु. — but not inside words like रुकिए.
  - Hinglish rupaye and rupaiye are recognised too.
  - A comma no longer counts as an empty price ("Fee rupees, 500 rupees" used to be a false alarm).
- **Times.**
  - "बजे" is read like "baje".
  - सुबह / subah means AM. शाम / shaam, रात / raat and दोपहर / dopahar mean PM. An unqualified "5 baje" keeps both readings, as before.
- **Refused, so the message goes to a person:**
  - Devanagari digits (०-९).
  - Times written in words (साढ़े, सवा, पौने, बजकर, saadhe, sawa, paune).
- **Booking claims in link mode** are caught only in their completed forms (बुक कर दिया, कन्फर्म हो गई, book ho gaya). A correct "कृपया यहाँ कन्फर्म करें" + link is no longer replaced.

**Tooling**
- `apply-quiet-hours-switch.js`: the two W13 nodes accept the old, the v2.1 or the v2.2 fingerprint, so the switch can still be turned off after the upgrade.
- `apply-w13-prompt.js` writes `active = false`, like every other patcher here.
- The first-stage build moved to `clinic-autopilot-master-ai.stage1.json`. Its build script and tests follow it.

## 2. Files

| File | What it is |
|---|---|
| `n8n/snippets/ai-receptionist.js` | The prompt and guards above (the one source for all W13 copies). |
| `n8n/snippets/ai-prompt.test.js` | New, 8 groups:<br>• prompt rules<br>• prices<br>• times and AM/PM<br>• booking claims<br>• full replies through `aiPlan`<br>• safety routes<br>• injection and malformed answers<br>• routine questions answered from the knowledge base (v2.2) |
| `n8n/integrated/apply-w13-prompt.js` | New. Fingerprinted patcher: it swaps the pasted block in `W13 – Build Context`, `W13 – Plan`, `W13 – Plan Ready` and `W13 – Record Sends` and keeps the quiet-hours switch lines after it. If a node was edited in n8n, it writes nothing. |
| `n8n/integrated/validate-w13-prompt.js` | New, 8 check groups (7 for a private pair). In `run-all.js`. |
| `n8n/integrated/clinic-autopilot-master-ai.json` | **The master** (public copy, redacted, inactive). |
| `n8n/integrated/ai-updated-workflow-clinic.w13-v2.2.json` | The same file under its release name. |
| `n8n/integrated/source/ai-updated-workflow-clinic.final-v1.redacted.json` | Your export, redacted: the Meta verify token and the allowlisted number are placeholders. Credential ids and the registry doc id are kept, as in the earlier committed exports. |
| `n8n/w13/eval-prompt.js` | New. The live-model check (section 6). |
| Regenerated by the repo's own scripts (each differs only in the 4 W13 code blocks) | • `n8n/w13/W13-AI-Receptionist.json`<br>• `W13-AI-Receptionist-Demo-OpenRouter.json`<br>• `clinic-autopilot-master-ai.stage1.json`<br>• `ai-workflow-clinic.ai-os.json`<br>• `ai-updated-workflow-clinic.w7-w10.json`<br>• `ai-updated-workflow-clinic.quiet-hours-test.json` |

**Make or check it yourself**
```bash
node n8n/integrated/apply-w13-prompt.js --in n8n/integrated/source/ai-updated-workflow-clinic.final-v1.redacted.json
node n8n/integrated/validate-w13-prompt.js
# your own file (keeps your values; never commit the result):
node n8n/integrated/apply-w13-prompt.js --in <your export.json> --out <private.json> --keep-private
node n8n/integrated/validate-w13-prompt.js --orig <your export.json> --patched <private.json> --private
```

**The old W13 code is gone from the master.**
- Each of the 4 nodes now holds the current block exactly once, and the old block 0 times.
- There is no other W13 in the file: every call is `{{ $workflow.id }}`.
- If a separate, older W13 workflow still exists in your n8n, nothing in the master calls it. Keep it inactive.

## 3. Master: before and after

| | Old `clinic-autopilot-master-ai.json` (now `.stage1.json`) | New master |
|---|---|---|
| Nodes | 246 (W1–W6, W11–W13) | 323. Added 77: W7 18, W8 20, W9 20, W10 17, `W3 – Conversations`, `W5 – Conversations`. Removed 0. |
| Connections | 200 sources / 243 edges | 272 / 317 (76 edges added, 2 rerouted for W3 and W5 – Conversations) |
| Against your export | — | **only the 4 W13 Code nodes differ**; connections identical |
| Node ids and positions | — | your export's (n8n assigned new ones when you re-imported) |
| Credential references | 5 distinct | 5 distinct, identical to your export. The OpenRouter header-auth reference is your own and is used by `W13 – Ask Model` and `W9 – Ask Model`. |
| Webhooks | 5 | the same 5 paths |
| Model | `openai/gpt-4o-mini` | `anthropic/claude-sonnet-5.5`, as in your export; model calls: `W13 – Ask Model`, `W9 – Ask Model` |
| WhatsApp sender | W12 only | W12 only |
| Quiet-hours test switch | none | in 7 nodes, **true**, as exported |
| `active` | false | false (your export had true) |

Every difference except the 4 W13 blocks was already in your export: W7–W10, A1–A6, the AI context, the Needs_Human gate, the switch and your own edits in n8n.

## 4. Test results (run in this repository, simulator only)

| Test | Result |
|---|---|
| `node n8n/tests/run-all.js` | **47 / 47 files pass** |
| `node n8n/snippets/ai-prompt.test.js` | 8 / 8 groups (v2.2) |
| W13 end to end (`w13.test.js`, `w13-openrouter.test.js`) | 17 + 17 groups |
| `validate-w13-prompt.js`, public master | 8 / 8 groups |
| `validate-w13-prompt.js`, your private file vs your upload | 7 / 7 groups |
| Whole-system suite on the master, switch ON / OFF | 81 / 83 and 82 / 83. **The same as your export.**<br>• ON fails W12.4: quiet hours are off, as intended.<br>• X.4 (real connections) cannot run here. |
| W7–W10 suite on the master, switch ON / OFF | 30 / 34 and 33 / 34. **The same as your export.**<br>• ON fails W7.4, W8.5 and W10.9: quiet hours.<br>• X.4 cannot run here. |
| Six suites, master vs your export, switch ON and OFF: system, W7–W10, integrated, existing modules, Needs_Human gate, A1–A6 | **identical failure lists** (see the note below) |
| `quiet-hours-switch.test.js` on the master | the 15 behaviour groups (U.1, A–H) pass, ON and OFF. R.1 / R.2 fail identically on your export (same note); X.1 cannot run here. |
| FLOW HQ `tsc --noEmit` / `vitest run` | clean / 82 / 82 |

**Note on the A1–A6 suite.** On your export, with or without v2.1, three of its checks fail, so R.1 / R.2 fail too.
- A5 and A6 are the two intended differences already listed in `AI-CONTEXT-REPORT.md`.
- A2 fails because the test expects the old model id `openai/gpt-4o-mini` in the Run_Log line, and your export uses `anthropic/claude-sonnet-5.5`.

None of the three is caused by v2.1.

**Not tested here:** anything with the real model, Meta, Grist or your n8n.

## 5. Emergency alerts: what is and is not guaranteed

The prompt cannot send an alert; W13's code does.

**What is tested in the simulator:**
- **Emergency words the code recognises** ("chest pain", "saans nahi", "सीने में दर्द"...): an URGENT hand-off with no AI call. The holding reply and the `human_handoff_alert` go out through W12.
- **Emergencies only the model recognises:** the same hand-off.

**What is not guaranteed today.** v2.1 changes none of this:
- **G1.** With quiet hours on, an emergency at night is deferred. The staff alert goes out with the 08:05 run, about 9 hours later.
- **G2.** A failed staff alert (template rejected, no owner phone) is recorded only in AI_Reason. The Run_Log outcome stays `ok`.
- **G3.** Messages from opted-out or paused patients are skipped, emergencies included.

The fixes are proposed separately and **not applied**:
- G1: urgent staff alerts pass quiet hours. This touches W12.
- G2: failed alerts are logged as failed.
- G3: a staff-only alert for emergencies. This is a policy decision.

## 6. Before you import (manual, in n8n)

1. **Use your private file.** It holds your values. Import it as a **new** workflow; it arrives inactive. Check the OpenRouter credential on `W13 – Ask Model` and `W9 – Ask Model`.
2. **`W4 – Config > cal_webhook_secret`.**
   - Your export holds the public placeholder text, not your secret.
   - W4 treats only values starting with `REPLACE_` as unset, so it would sign with the placeholder and reject every real Cal.com webhook.
   - Re-enter your real secret.
3. **`W3 – Config > test_phone`** is a placeholder in your export. Enter your test number.
4. **The quiet-hours switch is ON (true)**, as exported: patients get messages at night. Before going live, turn it off:
   `node n8n/integrated/apply-quiet-hours-switch.js --in <file> --value false --keep-private`
5. **`W13 – Ask Model` has `allowUnauthorizedCerts: true`.** It is the only HTTP node with certificate checks off. Turn it off; this is a separate one-line change.
6. **Check the model live, on fake data only:**
   ```bash
   OPENROUTER_API_KEY=... node n8n/w13/eval-prompt.js
   OPENROUTER_API_KEY=... node n8n/w13/eval-prompt.js --effort low
   ```
   It runs 26 made-up patient messages. It sends only the demo clinic's fake data, and no WhatsApp or Grist. Compare the cut-off answers and latency between the two runs.
   - Sonnet 5.5 always thinks, and its thinking counts toward W13's `max_tokens: 1500` and the 45 s timeout. A cut-off answer becomes a safe but needless hand-off.
   - If you see cut-offs, the fix is `reasoning: {effort: "low"}` and about 4000 `max_tokens` in `ai-provider.js`. That is a separate change.
7. **Start each clinic on `ai_mode = draft` with TEST_MODE on**, and read Run_Log for a few days.

## 7. Known limits

- **Plain replies are checked against any free or opening time, not per day.** So "कल 5 बजे" passes when 17:00 is free on another day; English "tomorrow at 5 PM" behaves the same. Slot offers and bookings are checked per day.
- **The knowledge base must write numbers with digits 0-9.** Devanagari digits there would make correct replies fail the check, which is a safe but needless hand-off.
- **Some texts are written by code and stay in English:** corrected slot offers, booking-claim replacements, cancel / move confirmations, and the hand-off message from Settings.
- **Cost:** the prompt is about 2,000 tokens plus the clinic facts, uncached through OpenRouter, on every message.
