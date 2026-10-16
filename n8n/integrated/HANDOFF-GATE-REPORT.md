# W13 Needs_Human gate fix: change and test report

## The change

**Before:** `aiGates()` returned `skip` whenever `Conversations.Needs_Human` was ticked. After one hand-off, every later patient message was ignored until someone unticked it.

**After** (in `n8n/snippets/ai-receptionist.js`, `aiContext` + `aiGates`):
- **The hand-off point.** It is the newest patient message that W13 itself marked `Messages.Needs_Human = true` (handed off or failed). W13 has always written that, so **no schema change** is needed.
- **Messages at or before that point** (the handed-off message, re-runs, Meta re-deliveries, the morning retry, older messages) are **skipped, as before**.
- **A message written after that point** goes through **every other gate**, then to the AI:
  - STOP, opted out, paused, already handled / duplicate, staff already answered, newer message, emergency, night, media, rate limit;
  - then confidence tiers, medical / payment / complaint → person, and the fact check.
- **If it needs a person too,** W13 hands off again: a new holding reply and staff alert through W12, `Needs_Human` set again, `Handoff_Reason` = the **new** reason, and that message becomes the new hand-off point.
- **What does not change:**
  - `Needs_Human` is **never unticked by W13**. It stays ticked for staff until they untick it, and W3/W5/W6 keep treating the conversation as person-owned.
  - The old `Handoff_Reason` is **never read** by the gate, the prompt or the decision. Tested: it is not in the request sent to the model, and a normal answer leaves it untouched.
  - `Needs_Human` **ticked by hand** (no hand-off message from W13): the AI stays silent, exactly as before.
- **A note for staff.** When a message after a hand-off reaches the AI, `AI_Reason` says "new patient message after a hand-off: handled by the AI; Needs_Human stays ticked until staff untick it".

**In your workflow:** the shared module is pasted into 4 W13 Code nodes (`Build Context`, `Plan`, `Plan Ready`, `Record Sends`).
- The same 4 text edits are applied to each. Only `W13 – Build Context` runs the changed functions.
- Nothing else changed.

## The 7 requested cases (end to end: Meta webhook → W2 → W13 → W12 → Meta)

Run: `node n8n/integrated/handoff-gate.test.js`. The results were identical on your private file and on the public copy: **9 / 9 PASS** (case 4 has 3 variants).

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Normal question, no hand-off -> AI answers | **PASS** | AI asked once; knowledge-base price sent through W12; AI_Status replied; Needs_Human off |
| 2 | AI hands off -> Needs_Human = true | **PASS** | holding reply + human_handoff_alert via W12; message + conversation Needs_Human = true; Handoff_Reason set; lead Escalated |
| 3 | Patient sends a new normal question -> AI answers | **PASS** | answered (price via W12); the earlier hand-off (Needs_Human, Handoff_Reason) stays for staff; old reason not in the prompt. BEFORE the fix: skipped, AI never asked |
| 4a | Patient sends a new medical question -> AI hands off again | **PASS** | AI asked; its answer is NOT sent; holding reply + NEW staff alert; Needs_Human set again; Handoff_Reason = "medical question…" |
| 4b | Patient sends a new complaint question -> AI hands off again | **PASS** | AI asked; its answer is NOT sent; holding reply + NEW staff alert; Needs_Human set again; Handoff_Reason = "HIGH · Unhappy with the therapist, wants…" |
| 4c | Patient sends a new payment question -> AI hands off again | **PASS** | AI asked; its answer is NOT sent; holding reply + NEW staff alert; Needs_Human set again; Handoff_Reason = "payment issue…" |
| 5 | Human has not replied, patient sends nothing -> AI remains stopped | **PASS** | morning retry, Meta re-delivery and a W13 re-run: 0 AI calls, 0 sends, Needs_Human stays true; Needs_Human ticked by hand: a new message is still skipped |
| 6 | STOP still works | **PASS** | STOP after a hand-off: Opted_Out, nothing sent, no AI call; the next message is not answered |
| 7 | Duplicate messages do not trigger AI twice | **PASS** | the same WhatsApp message twice after a hand-off: stored once, ONE AI call, ONE reply |

Each case also checks that every WhatsApp message came from its own W12 run.

Case 3 was also run on the workflow **before** the fix. There, the new question was skipped and the AI was never asked, which is the bug this fixes.

## Unit tests (`n8n/snippets/ai-handoff-gate.test.js`, 10 groups, all pass)

- A message after the hand-off → AI.
- The handed-off message itself (even with `AI_Status` cleared) → skipped.
- Older, same-second-earlier messages → skipped; same-second-later → AI.
- Needs_Human ticked by hand → skipped. Unticked → AI.
- Two hand-offs → only messages after the newest one go to the AI.
- STOP, opted out, paused, newer message, staff already answered, emergency, media, night, rate limit → unchanged; no "handled by the AI" note when one of them stops the message.
- A night message after a hand-off → answered by the 08:05 retry.
- The old `Handoff_Reason` is not in the prompt.
- A new medical question → handed off again with the new reason.

**Mutation tests** (`w13.test.js`): switching the gate off, and reverting to the old "always skip", are both caught by the suite.

## Regression and security

| Check | Result |
|---|---|
| `validate-handoff-gate.js` (public and private) | 8 / 8 PASS |
| Nodes added / removed | 0 / 0 |
| Nodes modified | 4 (the W13 nodes holding the shared module; code only; equal to the rebuilt W13) |
| Connections changed | 0 |
| **Credentials changed** | **0** |
| **Webhooks changed** | **0** (15 webhook / trigger / respond nodes byte-identical) |
| **Secrets changed** | **0** (58 Config values; W12, W11 and the OpenRouter node byte-identical) |
| WhatsApp senders | W12 only (`W12 – Prepare request`, `W12 – Read reply`) |
| `handoff-gate-regression.test.js` | <ul><li>integrated W2 → W13 → W12: 18 groups + 10 mutations, PASS</li><li>25 W1/W3/W4/W5/W6/W11/W12 scenarios: PASS</li><li>system test: 82 / 83 (real connections not runnable here)</li><li>15 W3–W6 mutations caught</li><li>A1–A6: 12 / 14, with only the 2 differences already explained in `AI-CONTEXT-REPORT.md`</li></ul> |
| `node n8n/tests/run-all.js` | 37 / 37 files pass |

**Existing tests updated, because they encoded the behaviour you asked to change:**
- `w13.test.js` scenario 6 and `integrated.test.js` test 6: "the next message is skipped" became "a new message is answered".
- `w13.test.js` scenario 6 also covers the hand-ticked case.
- The W13 mutation target was updated.
- The two older regression runners mark the historical workflow files (from before this fix) so they are still checked against their own behaviour.

## Things to know

- **The staff alert wording.**
  - Your `human_handoff_alert` template (as written in `n8n/whatsapp-templates.md`) tells staff "The AI has stopped replying to them". It now keeps answering *new* messages.
  - Consider re-submitting the template with, for example: "… Reason: {{4}}. Please answer from the Grist Inbox and untick Needs_Human when done."
  - The template is approved in Meta, so I did not change it.
- **To silence the AI while staff talk to a patient,** tick `Automation_Paused` (unchanged gate).
- **Patients who keep writing.** A patient who keeps writing after a hand-off is handled per message, like any other conversation.
  - Each message that again needs a person sends another holding reply and staff alert.
  - The rate limit does not stop this: past 6 AI replies an hour it turns further messages into hand-offs.
  - If repeated hand-offs within, say, an hour should skip the holding reply and alert, that is a small follow-up change; say if you want it.
- **The 40-message window.** The hand-off point is looked up in the last 40 messages of the conversation (W13's existing history read). If more than 40 messages have gone by since the hand-off without staff unticking `Needs_Human`, the AI falls back to staying silent (the safe default) until they do.
