# Missed-call capture — status: NOT IMPLEMENTED in the production workflow

The uploaded workflow has **no telephony input**: no webhook for calls, no provider, no event store. Website leads (W1) and WhatsApp messages (W2) are not missed-call capture and must not be sold as that. The production export therefore contains no missed-call node and says so on its entry-point note.

## What exists elsewhere in this repository (separate, not merged here)

* `products/missed-call-capture-n8n/` (in the working copy that holds the earlier work; untracked there): a standalone n8n workflow + SQLite event store that accepts **signed** call events (`/webhook/flowhq-mcc/generic`, Twilio-style `/twilio`), de-duplicates them and stores them. Tested in a Linux sandbox against a real n8n 2.43.5 with synthetic events. It does **not** detect calls by itself: a phone system has to send it events. For an ordinary iPhone SIM there is no free, verified route (`docs/IPHONE.md`, `docs/TELEPHONY.md` in that product).
* `n8n/integrated/apply-missed-call-capture.js` and the demo workflow add a missed-call *section* (lead + conversation + staff alert + acknowledgement) driven by such an event; it is part of the demo build only and was not carried into production because no provider exists to feed it.

## What would have to be true before it is added to production

1. A telephony provider (Twilio / Exotel / Knowlarity / a cloud PBX) that reports missed calls by webhook for the clinic's number, with a signature scheme the workflow can verify on the raw body (same pattern as W2 / W4).
2. A decision on what the person is told ("we missed your call, tap to chat") — that is a **business-initiated** message and needs an approved template and consent (a caller has not opted in to WhatsApp).
3. A Grist event row (`Messages` with `Intent = missed_call`, `WA_Message_ID = call-<provider id>` as the idempotency key: see `grist/schema.md`).
4. Tests with the real provider's sample payloads and signatures.

Until then: the capability is **disabled and unavailable**, not "partially there".
