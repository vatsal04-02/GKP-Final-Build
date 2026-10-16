# W2 — WhatsApp Inbound (standalone workflow)

Meta WhatsApp Cloud API → n8n → the clinic's Grist CRM (lead, conversation, message).
**Not merged into the master, sends nothing to WhatsApp.** Its one link to another workflow (added with W13, section 13): after a
message is stored it starts **W13 – AI receptionist** for that message, without waiting. Off until you set `W2 – Config` > `ai_workflow_id`.

> **Status: built and simulated, NOT production-ready.** All checks below ran in a simulator with a fake Grist. It has not run in your n8n or received a real Meta message. Do not treat it as production-ready until the manual tests in section 8 pass in your n8n.

| File | What it is |
|---|---|
| `W2-WhatsApp-Inbound.json` | **The workflow to import.** |
| `build-w2.js` | Rebuilds that JSON from `code/*.js`: `node n8n/w2/build-w2.js` |
| `code/*.js` | The 18 Code nodes' sources, one file each. `normalize-phone.js` gets W12's function pasted in at build time. |
| `w2.test.js` | 31 check groups + 15 mutation tests: `node n8n/w2/w2.test.js` |
| `fixtures/*.sample.json` | Three FAKE Meta payloads (text, image, delivery receipt) to paste or `curl`. |

Files outside `n8n/w2/` that changed: `n8n/tests/n8n-sim.js` (test simulator: added Respond to Webhook, Loop Over Items and HTTP error-output support; backward compatible) and `n8n/tests/run-all.js` (lists the W2 test). **No workflow file was touched**: not the master (`n8n/merged/`), not anything in `n8n/workflows/`.

---

## 1. At a glance

| | |
|---|---|
| **Nodes** | 61 = 53 working nodes + 8 section notes. The 53: 2 webhooks, 1 manual trigger, 2 Set, 19 Code, 12 IF, 3 Respond to Webhook, 1 Loop Over Items, 12 HTTP (Grist), 1 Execute Workflow (W13, section 13). |
| **Trigger paths** | `GET /webhook/whatsapp-inbound` (Meta verification) · `POST /webhook/whatsapp-inbound` (Meta events) · `W2 – Manual Test` (editor button). Test URLs use `/webhook-test/…`. |
| **Credentials** | Only the existing Grist **Header Auth account 2** (id `9J6XxrIQoFDcQZ0Y`), by reference. No Meta token, no Telegram, nothing new. |
| **Placeholder you must fill** | `W2 – Verify Config` → `meta_verify_token` = `PASTE_META_WEBHOOK_VERIFY_TOKEN`. Choose any string, paste the same one into Meta (section 9). |
| **Check before use** | `W2 – Config`: `leads_table` (LEADS), `message_direction_in` (In), `message_status_in` (Received), `unread_mode` (count). See section 3. |
| **Grist tables** | Agency Registry `REGISTRY_DOC_ID_PLACEHOLDER`: `Clinics` (read). Clinic CRM (from the registry): `LEADS` (read, create), `Conversations` (read, create, update), `Messages` (read, create), `Run_Log` (create). Nothing is deleted. |

## 2. How it works

```
 GET  /whatsapp-inbound ─> Verify Config ─> Check Verify Token ─> Verify OK? ─ yes ─> Respond Challenge (200, plain text)
 (Meta handshake)                                                          └─ no ──> Respond Forbidden (403 / 400)

 POST /whatsapp-inbound ─┐
 Manual Test ─> Test Cases┘─> Config ─> Parse Meta Event ─> Webhook Source? ─ yes ─> Respond (200, or 400 for garbage) ─┐
                                              (never throws)                └─ no (manual test: no answer) ─────────────┤
                                                                                                                         v
                                          Valid Event? (a patient message) ─ no ─> end (status / ignored / invalid)
                                                       └─ yes ─> Split Messages ─> Loop Over Messages (ONE at a time) ─┐
   ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   v
 Clinics (registry) ─> Resolve Clinic ─> Clinic Found? ─ no ─> Clinic Rejected ──────────────────────────────> next message
   ─ yes ─> Normalize Phone ─> Phone Valid? ─ no ─┐
   ─ yes ─> Check Duplicate Message ─> Read Duplicate ─> Duplicate? ─ yes ─┤
   ─ no ──> Find Lead ─> Read Lead ─> Lead Exists? ─ yes ───────────────┐  │
                                          └ no ─> Recent Leads ─> Build New Lead ─> Create Lead ─> Recheck Lead ─> Read Created Lead ─> Lead Resolved? ─ no ─┤
                                                                                                                          └ yes ─> Lead Ready <──────────────┘
   Lead Ready ─> Find Conversation ─> Read Conversation ─> Conversation Exists? ─ yes ─┐
                                                    └ no ─> Create Conversation ─> Recheck Conversation ─> Read Created Conversation ─> Conversation Resolved? ─ no ─┤
                                                                                                                                 └ yes ─> Conversation Ready <──────┘
   Conversation Ready ─> Add Message ─> Message Saved ─> Update Conversation ─> Prepare Staff Alert ─┐
                                                                                                      v
   (every "no" above, every Grist error output, every skip)  ───────────────────────────────>  Build Run Log ─> Can Log? ─ yes ─> Run Log ─> next message
                                                                                                                  └ no ──────────────────> next message
```

## 3. Where I did NOT follow your spec to the letter (read this first)

| Your spec | What W2 does | Why, and the one-line change |
|---|---|---|
| Table `Leads` | Table **`LEADS`** | Your live W1, W3, W4, W5 and W6 all use `LEADS` / `Lead_id`. Changing it is one value: `W2 – Config` → `leads_table`. |
| `Direction = Inbound` | **`In`** | `grist/schema.md`: `Messages.Direction` is a Choice of `In` / `Out` (W12 writes `Out`), and the access rule "nobody edits Messages where Direction = In" relies on it. Writing `Inbound` would put an off-list value in a Choice column. Change: `message_direction_in`. |
| `Unread = true` | **Integer count: +1 per new message** | `schema.md`: `Conversations.Unread` is an **Integer**. A boolean in an Integer column shows as an invalid cell. Your own rule "do not increment unread again" is exactly what the duplicate check guarantees. If your column is a Toggle, set `unread_mode` to `flag` and it writes `true`. |
| `Status = Received` | **`Received`** (as asked) | It is **not** in the schema's Status choices (queued, needs_template, sent, delivered, read, failed). Grist stores it anyway; add `Received` to the Choice column so it shows normally, or change `message_status_in`. |
| `Outcome = failure / success` | **`failed` / `ok`** (and `skipped`) | Those are the existing Run_Log choices (W1 to W6 use them). |
| Filter the registry by `WA_Phone_Number_ID` | The registry is read whole and matched **in code, as text** | If that column holds the id as a number, a Grist filter on text silently matches nothing. The registry has one row per clinic, so reading it is cheap. `Active` accepts `true` or `"TRUE"`, as you said. |
| `messages[0]` only | **Every message** in the payload, one at a time | Meta can batch several messages in one webhook. Taking only the first would drop the rest. One-at-a-time also keeps Lead_ids unique inside a batch. |
| Staff alert | **Payload only, `decision.send = false`** | As you asked: nothing is sent and W12 is not called. Even if wired to W12 by mistake, nothing goes out. |

## 4. Strategies

- **Deduplication.** Before anything is written, `Messages` is searched for the same `WA_Message_ID`. Found = stop: no message, no lead, no conversation change, `Unread` untouched, Run_Log `skipped`. Duplicates inside one payload are handled the same way. Meta is still answered 200 (it was answered before processing started).
- **Leads.** Found by the normalized phone (`+91XXXXXXXXXX`, the same function as W12). If none: create `Lead_id` `L-YYYYMMDD-NNNN` (IST date, next free number, same rule as W1), `Name` = profile name or `WhatsApp Lead`, `Phone`, `Source` WhatsApp, `Status` New, `Created_At` now, `Enquiry` = the text (only when the patient wrote text). **Race guard:** after creating, W2 looks again; if parallel messages from the same new patient created two rows, every run uses the **lowest row id**, and the Run_Log note names the extra row. W2 never deletes.
- **Conversations.** Found by phone (oldest row wins). If none: create `Phone` + `Lead`, same race guard. Then updated: `Lead`, `Last_Inbound_At` (never moves backwards, so out-of-order delivery is safe) and `Unread` +1. `Automation_Paused` and `Assigned_To` are never touched.
- **Messages.** Exactly one row per unique `WA_Message_ID`: `Conversation` (row id), `Direction` In, `Body` (text, button/list reply title, or `[WhatsApp <type> received]` plus the caption), `Sent_By` Patient, `WA_Message_ID`, `Status` Received, `Created_At` = Meta's timestamp. `Template` and `Send` are not written. The message is written **before** the conversation counter, so there is never an unread flag without a message.
- **Errors.** Every Grist node has an error output that goes to one `Build Run Log` node, so any failure becomes **one** Run_Log row (`failed`, stage, trimmed error, bearer tokens removed, phone numbers masked). No node retries; a failing Run_Log write ends quietly. An unknown or inactive clinic has no CRM to log into, so it only appears in the execution.
- **Answering Meta.** The 200 goes out right after parsing, before any Grist call (project rule 6). Garbage that is not a Meta body gets 400; every Meta-shaped payload (even one with nothing to store) gets 200 so Meta does not retry.
- **Non-text and odd input.** Images, audio, stickers, locations, reactions and unknown types never crash. Control characters are removed, text is cut at 2000 characters. Non-Indian numbers are skipped and logged (`skipped`), because rule 7 stores only `+91…`.

## 5. Import and setup

1. n8n → Workflows → Import from file → `W2-WhatsApp-Inbound.json`. It arrives **inactive**; the Grist nodes already point at "Header Auth account 2".
2. `W2 – Verify Config` → set `meta_verify_token` to a string you choose (long and random).
3. Check `W2 – Config` (section 3). `registry_doc_id` is `REGISTRY_DOC_ID_PLACEHOLDER`; the clinic CRM id comes from the registry, nothing is hard-coded per clinic.
4. In Grist: add `Received` to the `Messages.Status` choices (optional, cosmetic).
5. Do the manual tests (section 8) **before** activating.

## 6. Grist columns W2 reads and writes

| Table | Read | Written |
|---|---|---|
| `Clinics` (registry) | `WA_Phone_Number_ID`, `Active`, `Grist_Doc_ID`, `Clinic_Slug`, `Clinic_Name` | — |
| `LEADS` | `Phone`, `Lead_id`, `Created_At` | new row: `Lead_id`, `Created_At`, `Name`, `Phone`, `Source`, `Status`, `Enquiry` |
| `Conversations` | `Phone`, `Unread`, `Last_Inbound_At` | new row: `Phone`, `Lead` · update: `Lead`, `Last_Inbound_At`, `Unread` |
| `Messages` | `WA_Message_ID` | new row: `Conversation`, `Direction`, `Body`, `Sent_By`, `WA_Message_ID`, `Status`, `Created_At` |
| `Run_Log` | — | `Workflow` (`W2-WhatsApp-Inbound`), `Record`, `Outcome`, `Error`, `At` |

## 7. Staff alert (isolated)

For a brand-new lead, `W2 – Prepare Staff Alert` builds the payload W12 expects (`audience: staff`, `template: new_lead_staff_alert`, `template_params`, `message_text`, `wa_phone_number_id`, `grist_base_url`, `doc_id`, `lead_row_id`, `lead_phone`, `source_workflow`) and leaves it in that node's output. `decision` is `{send: false, to: null, …}` on purpose. **After the merge**, add a guard node (owner phone from Settings, TEST_MODE / TEST_PHONE, quiet hours, exactly like W3) that fills `decision`, then a "Call W12" node. That is the only planned integration point; nothing else changes. Only the run that created the lowest lead row prepares an alert, so a race cannot alert twice.

## 8. Manual test procedure (fake data only, no Meta needed)

**Prepare (once).** In the demo-clinic CRM add one lead: `Phone` `+919000000011`, `Name` `W2 Test Existing`. Check the demo clinic row in the registry has `Active` TRUE and `WA_Phone_Number_ID` `123456789012345` (the value in the `Test Cases` node; change it there if yours differs).

**Run.** Open the workflow → click **Execute workflow** on `W2 – Manual Test`. Nothing is sent anywhere; webhooks are not answered. Then look at the Grist tables and at the `W2 – Build Run Log` / `W2 – Clinic Rejected` outputs.

| Case (item in `Test Cases`) | Expected |
|---|---|
| `existing-patient` | No new lead. 1 new Messages row (Direction In, Status Received). Conversation created or updated, `Unread` +1. Run_Log `ok`. |
| `new-patient` (`+919000000012`) | New lead (Source WhatsApp, Status New, `Lead_id` `L-YYYYMMDD-NNNN`) + conversation + message. Run_Log `ok`. `Prepare Staff Alert` shows the payload, `decision.send` false. |
| `duplicate-message-first` / `-second` | Stored once. The second: nothing created, `Unread` not counted again, Run_Log `skipped` "duplicate WA_Message_ID". |
| `unknown-phone-number-id` | Stops at `W2 – Clinic Rejected` ("unknown phone_number_id"). Nothing written. |
| `invalid-payload` | `W2 – Parse Meta Event` shows `kind: invalid`. Nothing else runs. |
| `non-text-image` | No crash. Body `[WhatsApp image received]: photo of my knee`. |
| `status-event` | A delivery receipt: ignored, nothing written. |

Run it a second time: the ids are new each time, so `new-patient` is now an existing patient (no second lead) and every message is stored again. To run one case, set `ONLY` at the top of `W2 – Test Cases`; to test your own Meta body, paste it into `PASTED_PAYLOAD` there.

**Delete afterwards, by hand in Grist:** the test lead `+919000000012`, its conversation, and the test Messages / Run_Log rows. W2 never deletes.

**Test the webhooks with curl** (click **Listen for test event** on the node first; use the `/webhook-test/` URL):

```
# Meta handshake: expect the body 12345 and HTTP 200
curl -i "https://<your-n8n-host>/webhook-test/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=<your token>&hub.challenge=12345"
# wrong token: expect HTTP 403
curl -i "https://<your-n8n-host>/webhook-test/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345"
# a Meta POST: edit phone_number_id in the file to your clinic's first, and use a NEW message id every time
curl -i -X POST "https://<your-n8n-host>/webhook-test/whatsapp-inbound" -H "Content-Type: application/json" --data @n8n/w2/fixtures/meta-inbound-text.sample.json
```

## 9. Meta webhook configuration

1. Finish section 8, then **Activate** W2 (Meta only calls the production URL `/webhook/whatsapp-inbound`).
2. Your n8n must be reachable from the internet over HTTPS (your Tailscale Funnel address: `https://<TS_HOSTNAME>/webhook/whatsapp-inbound`).
3. Meta for Developers → your app → WhatsApp → **Configuration** → Webhook → Edit.
4. Callback URL: the production URL above. Verify token: the **same string** you put in `W2 – Verify Config`. Click **Verify and save**. Meta sends the GET; n8n echoes the challenge.
5. Under Webhook fields, subscribe to **messages**.
6. Send a WhatsApp message from your own phone to the clinic's WhatsApp number. Check n8n → Executions (open the run) and the Grist Inbox.

## 10. Limitations (not done on purpose, or not possible here)

- **POST signatures are not verified.** Meta signs every POST (`X-Hub-Signature-256`, with your App Secret). W2 does not check it, so anyone who knows the URL and a valid `phone_number_id` could post a fake message. This is the first thing to add before real use; it needs the App Secret and the raw request body, which I could not test without a real n8n.
- **A Grist outage loses that message.** Because Meta is answered first, Meta does not retry. The failure is written to Run_Log when Grist is reachable, but the message text is not kept.
- **No opt-out handling.** A patient replying STOP is stored as a message; W2 does not set `Opted_Out`.
- **Races leave a spare row.** Parallel messages from one new patient can create an extra lead/conversation row; every run uses the lowest id and names the spare, but staff must delete it. Two parallel runs for *different* new patients can still pick the same `Lead_id` (same limit as W1).
- **Media is not downloaded.** Only a text placeholder is stored.
- **Non-Indian numbers are skipped.**
- **Patient data sits in n8n's execution history** (message text, phone). Consider execution-data pruning.
- **Not run in a real n8n or against Meta.** The simulator is not n8n. Things the simulator cannot prove: how your n8n version parses `hub.mode` (W2 handles both `hub.mode` and a nested `hub`), the Respond to Webhook options, and Loop Over Items behaviour. The manual tests are there to check exactly that.

## 11. Validation that ran

`node n8n/w2/w2.test.js` — **29 check groups pass**, and **13 mutations are caught** (each safety rule switched off once: duplicate check, active-clinic check, both race guards, Unread counted twice, phone normalisation, `Last_Inbound_At` moving back, answering Meta after processing, verify token unchecked, placeholder token accepted, overwritten conversation flags, failures not logged, status events creating messages).

- JSON parses; 58 unique node ids and names; every connection points at an existing node and a valid output; **no dangling nodes** (only the 3 triggers have no input); every working node is reachable.
- Every working node name starts with `W2 –`. No Execute Workflow node, no reference to a node outside W2, no call to Meta, no `errorWorkflow` setting, no link to W1, W3 to W12 or the master.
- Credentials: only `Header Auth account 2` (12 Grist nodes). No missing credential references. The one placeholder is the verify token.
- No secrets: no Meta/Telegram/API-key patterns; the token is only in the placeholder Set node, never in a Code node, never in the check output or any response. Test fixtures contain only made-up numbers (`91900000001x`, `15550000000`).
- Behaviour (simulated): existing and new patient, number formats, two messages from one new patient, two new patients in one payload, duplicates (also inside one payload), unknown / inactive clinic, `Active` as `"TRUE"` / `true`, malformed and status payloads, non-text messages, non-Indian numbers, a Grist failure at each of the 11 Grist calls (one failed Run_Log row each, no retry), a failing Run_Log write, a failure on the 2nd message of a batch, both race guards, the manual-test branch (twice, with fresh ids) and the sample payloads.
- Repo: `node n8n/tests/run-all.js` — all 17 test files pass. `git status` shows no change to any workflow file.

## 12. Merging later

Nothing here has to change to merge: copy the 50 working nodes into the master canvas (names already start with `W2 –`, which is the master's naming rule), keep the two webhooks on `whatsapp-inbound` (GET and POST), connect the staff-alert payload to a guard + W12 call as in section 7, and drop `W2 – Manual Test` / `W2 – Test Cases` if you do not want them in production. Re-run `n8n/merged/validate-merged.js` and a new simulated pass at that point.

## 13. Hand-off to W13 (AI receptionist)

Added with W13 (`n8n/w13/`). Three nodes after `W2 – Prepare Staff Alert`:

- `W2 – AI Wanted?`: only a message that was **stored** (not a duplicate, not a failure), **not** from the manual test's fake data, and only when `W2 – Config` > `ai_workflow_id` holds a real workflow id. The shipped placeholder `PASTE_W13_WORKFLOW_ID` keeps the hand-off off, so W2 behaves exactly as before.
- `W2 – Hand To AI`: Execute Workflow, one run per message, **"wait for sub-workflow" off**. Meta already has its 200; W2 does not wait for the AI and goes on to the next message.
- `W2 – AI Handed`: if starting W13 failed (wrong id, W13 not saved), the message is still stored, Run_Log stays `ok` and its Error column says `AI hand-off failed: …`.

To switch it on: import and save W13, copy its id from the URL (`…/workflow/<id>`), paste it into `W2 – Config` > `ai_workflow_id`, save W2. Then the clinic decides in its Grist Settings (`ai_mode`, see `n8n/w13/README.md`).

