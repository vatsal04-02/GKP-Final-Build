# Cal.com webhook (W4): configured and verified on our side (1 Nov 2026)

## State
- Endpoint: `POST https://n8n.geetakrishnaphysiotherapy.co.in/webhook/cal?clinic=demo-clinic` (in the active workflow, 4E).
- Secret: **created on 1 Nov 2026 and set** as `FLOWHQ_CAL_WEBHOOK_SECRET` in the server `.env` (mode 600) and loaded by n8n. The same value is in `/home/deploy/.4d-secrets/calcom-webhook-secret` (mode 600, owner `deploy`) so the owner can paste it into Cal.com once. It was never printed in chat or committed.
- W4 checks: HMAC-SHA256 of the exact request bytes in header `X-Cal-Signature-256`, secret of 16+ characters, event time within 24 h, known `?clinic=` slug, events `BOOKING_CREATED` / `BOOKING_RESCHEDULED` / `BOOKING_CANCELLED` only, valid Indian mobile on create / reschedule.

## Verified in production with the real secret (synthetic booking `zz-cal-synth-001`, synthetic phone ending 0002)
| Check | Result |
|---|---|
| Unsigned `POST` | 401 `{"status":"unauthorized"}`, nothing written |
| Signature of the wrong value | 401, nothing written |
| Correctly signed `PING` | 200 `ignored` |
| Correctly signed `BOOKING_CREATED` | 200 `action: create`: row in `Appointments` (Dr. Mahesh Tiwari, 2 Nov 11:00), lead created, W4 Run_Log `ok` |
| The same signed event again | 200 `action: skip` ("duplicate booking event"), no second row |
| Correctly signed `BOOKING_CANCELLED` | 200 `action: cancel`: the row is `Cancelled` (kept) |
| Booking confirmation to the patient | attempted, **rejected by Meta: error 132001, template `booking_confirmation` does not exist in `en`** (external, see `docs/activation-status.md`) |

So a signed Cal.com event reaches the CRM and the Schedule. What is NOT done, because it needs the Cal.com account (no credential available): the webhook entry inside Cal.com.

## The one owner step (2 minutes)
1. On the VPS: `cat ~/.4d-secrets/calcom-webhook-secret` (copy the value; do not paste it into chat).
2. Cal.com > Settings > Developer > Webhooks > New: Subscriber URL `https://n8n.geetakrishnaphysiotherapy.co.in/webhook/cal?clinic=demo-clinic`, Secret = that value, events: Booking created, rescheduled, cancelled. Save and press Ping (answer: ignored, HTTP 200).
3. A real booking in Cal.com (test phone) should appear in FLOW HQ > Schedule within seconds.
Retiring Cal.com for new bookings is a separate owner-approved plan: `docs/calcom-cutover.md`.
