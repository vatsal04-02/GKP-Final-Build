# n8n staging results (Slice 4C candidate in a real n8n)

Test: `flowhq/tests/real-grist/staging-n8n.real.test.ts`, run by `flowhq/deploy/staging/run-staging-n8n.ps1` (how and what is real: `docs/staging-environment.md`).
Real: n8n 2.43.5, Grist 1.7.20, the FLOW HQ server process. **Stand-ins: WhatsApp (Meta) and the AI model.** The workflow under test is `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4c.json` with credentials re-pointed by role and the W5 timer replaced by a webhook.
**Last result: 12 of 12 steps pass** (31 Oct 2026). This is evidence about the workflow logic and the integration with the CRM; it is not evidence about WhatsApp or about a real model.

## The 12-step patient journey
| # | Step | What the test asserts, in the real systems |
|---|---|---|
| 0 | setup | the 4C file imports into n8n and activates; the `FlowHQ Booking API` credential exists and is created without printing any secret; the production Grist migration script (`migrate-grist.js`) ran against the real Grist and created `Send_Ledger` |
| 1-2 | WhatsApp message arrives; the AI is consulted | a forged signature is refused (401); a signed message creates the lead, conversation and message in Grist; the redaction layer masks the name and the tag before the model sees it; the clinic answers |
| 3-4 | the patient asks for a time | the free times came from FLOW HQ (the real availability of the real Grist); **nothing is booked**; the reply is code-written: "Shall I book Tue 03 Nov at 10:00 AM with Dr. Mahesh Tiwari? Reply YES to confirm."; no Cal.com text |
| 5-6 | the patient says YES | **exactly one** appointment appears in Grist (`wa-GKA-…`, slot, patient phone, source `WhatsApp AI`, a `w13-…` idempotency key, an `Audit_ID`); the patient is told "booked" only now, with the reference; the lead becomes Booked |
| 7 | staff see and manage it | the week calendar for the doctor lists it; the detail shows the reminder outlook (held: no consent); check-in works |
| 8 | the confirmation was delivered once | exactly one confirmation text to the patient; ledger rows exist; every send went to the patient or the owner and only through the Graph path |
| 9 | reminder eligibility (W5 in the real n8n) | **no consent: no reminder**; consent recorded by an admin but **Pending confirmation: no reminder**; Confirmed + Yes: **exactly one `reminder_24h`**, `R24_Sent` set; a second run sends nothing |
| 10 | reschedule, then cancel on WhatsApp | each is asked first; each is **one** FLOW HQ call; the same booking reference moves; the reminder flag is cleared; the cancel keeps the row (Status Cancelled) |
| 11 | audit preserved | `Booking_Audit` has the create, the move and the cancel (`ok`), unique `Audit_ID`s, actor `token:…`, and **no phone, name or key** |
| 12 | failures and retries | the same WhatsApp message delivered again is answered once; a stray YES books nothing; FLOW HQ killed **between the question and the YES**: the patient gets the clinic's own booking page, never "booked", and staff can see why (`AI_Reason`); a fresh request while it is down is never answered with a time; FLOW HQ returns on the same port: ask again, YES, booked exactly once |
| 13 | n8n unavailable | n8n stopped: the webhook does not answer (Meta would retry); a **staff booking works** meanwhile; n8n restarted: the message delivered twice is answered once |
| 14 | the same YES delivered twice at the same instant | exactly **one** appointment, one confirmation text |

## Findings from building and running it (all fixed or documented)
1. **Real bug found by real Grist, fixed:** blank Int cells come back as `0`, not null, so every seeded schedule row looked invalid and **no doctor had any slot**. Fixed in `booking/mappers.ts` (`intOrBlank`) with a regression test that does not need Docker. The in-memory Grist used by the other 460 tests returns null and hid it. (A buffer of 0 now means "use the clinic's buffer": documented in `grist/booking-schema.md`.)
2. **Reply-rate limit.** W13 hands a patient to a person after 6 automatic replies in an hour (`FLOWHQ_AI_MAX_REPLIES_PER_HOUR`, default 6). With the explicit-YES flow one booking costs **two** replies, so hello + book + move + cancel needs 7. The default is a safety valve and was not weakened; **set it to 12 before switching AI booking on** (`docker-compose.yml` now carries the reminder). The staging journey runs at 40 because it is one compressed conversation.
3. **Empty reply from the model.** `aiPlan` handed off whenever the model's reply text was empty, but for book / cancel / move the system writes the whole reply. Empty is now accepted for those three actions only (every other action still needs text). Unit-tested.
4. **A concurrent duplicate delivery stores two inbound inbox rows** (W2 looks the message id up and then inserts; two simultaneous executions both pass the lookup). Harm is prevented where it matters: one appointment (the booking key is derived from the WhatsApp message id and the slot), one confirmation, one reply. The inbox shows a duplicate inbound row. **Not fixed** (W2 is outside 4C and Grist has no unique constraint); a fix would claim the message id atomically. Listed in `docs/production-readiness.md` as a known limitation.
5. **Test-harness traps** that a future author will hit: vitest sets `NODE_ENV=test`, which makes n8n's CLI write to a different database (credentials silently not imported); the repo's readiness check can pass on the editor's HTML before the workflow is active; the 11:00-IST clock shift must be computed once at start (recomputing freezes the clock and makes patient messages look older than the clinic's replies).
6. **What a real model must do for the YES flow to work:** on a YES it must return `book_slot` with the date and time copied from the question in RECENT CONVERSATION (the prompt says so). If it does not, the system asks again; nothing is booked. This is exactly what the supervised real-model run in the go-live procedure checks.

## Not tested here
Real WhatsApp, the real model, Cal.com's own webhook into W4 (covered by the repo's real-n8n suite, 11/11 on the reference workflow), W6/W7/W8/W15 scheduled sends in a real n8n (covered in the simulator), load.
