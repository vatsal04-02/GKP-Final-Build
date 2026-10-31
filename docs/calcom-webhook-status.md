# Cal.com webhook (W4): verified state and the one remaining secret (1 Nov 2026)

## What exists
- The active n8n workflow (4D) contains W4 (38 nodes). Its webhook is `POST https://n8n.geetakrishnaphysiotherapy.co.in/webhook/cal?clinic=<Clinic_Slug>` (for this clinic `?clinic=demo-clinic`). The path is public on purpose (Caddy publishes `/webhook/*` only).
- Security design in W4 (`W4 - Verify & parse`): Cal.com must sign the exact request bytes with HMAC-SHA256 using the webhook secret, sent as header **`X-Cal-Signature-256`** (hex, 64 characters); the secret must be at least 16 characters; the event time (`createdAt`) must be within 24 hours (replay window); the `?clinic=` slug must exist in the registry; only `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED` are processed; a valid Indian mobile is required for created/rescheduled events. Wrong or missing signature is answered 401 without an alert.
- Cal.com rows land in `Appointments` with their `Booking_UID`, count against FLOW HQ availability, and appear in the Schedule.

## What was verified in production
| Check | Result |
|---|---|
| Webhook reachable from the internet | yes (`POST` reaches the workflow; `GET` is 404) |
| Unsigned `POST` (`{"triggerEvent":"PING"}`) | HTTP 500 `{"message":"Error in workflow"}`, nothing written |
| `POST` with a made-up signature and a booking body | HTTP 500 `{"message":"Error in workflow"}`, nothing written |
| `FLOWHQ_CAL_WEBHOOK_SECRET` in the n8n container | **not set** (count 0) |
| Reason for the refusal | W4 `Config Guard` stops the run before anything is read or written: "FLOWHQ_CAL_WEBHOOK_SECRET is not set" (fails closed; the failed run is only in the n8n execution list because no Telegram chat id is set). With the secret set, an unsigned or badly signed request is answered 401 instead. |
(The first version of these probes sent malformed JSON and got n8n's own 422 parser error; the table shows the corrected probes, sent from body files.)

**Effect today: a real Cal.com booking webhook would be refused and NOT synced into the CRM.** It is not a data-loss risk for Cal.com itself (Cal.com keeps its booking and the patient is confirmed by Cal.com), but staff would not see that appointment in FLOW HQ Schedule and FLOW HQ could offer the same time to another patient. The website now uses its own enquiry form and the CRM booking service, so this matters only if patients still book through a Cal.com page. The owner should say whether Cal.com is still used at all.

## The exact remaining configuration (OWNER, 5 minutes)
Nothing was generated or stored for you: the secret must be created once and entered in BOTH places.
1. Create a secret (on the server): `openssl rand -hex 32` (64 characters). Keep it out of chat and Git.
2. On the VPS: `cd ~/GKP-Final-Build && nano .env` and add `FLOWHQ_CAL_WEBHOOK_SECRET=<the secret>`.
3. Apply to n8n (workflows stay active): `docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --no-deps n8n`
4. In Cal.com > Settings > Developer > Webhooks: URL `https://n8n.geetakrishnaphysiotherapy.co.in/webhook/cal?clinic=demo-clinic`, Secret = the same value, triggers: Booking created, Booking rescheduled, Booking cancelled. Press Ping/Test (a PING is ignored with HTTP 200 once the secret is correct).
5. Verify: unsigned `POST` should now answer 401 (`curl -s -w ' %{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @body.json 'https://n8n.geetakrishnaphysiotherapy.co.in/webhook/cal?clinic=demo-clinic'`); then make a synthetic booking in Cal.com with a test phone, check that it appears in FLOW HQ > Schedule and `Run_Log`, and cancel it afterwards. Not tested end to end with a real Cal.com signature: that needs the secret.
Retiring Cal.com for new bookings is a separate, owner-approved plan: `docs/calcom-cutover.md`.
