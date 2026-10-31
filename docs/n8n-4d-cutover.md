# n8n cutover: replace the deployed V4 workflow by 4D (NOT DONE: needs approvals below)

Candidate: `n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4d.json` = 4C + V4's AI retry/backoff. Inactive, own id. CI green; real-n8n staging journey 12/12 (`STAGING_WORKFLOW=FlowHQ_Clinic_Automation_production_candidate4d.json`, AI and WhatsApp stubbed).

## State at 31 Oct 2026
- Production FLOW HQ `2eb3ac2` (code of `main`), booking tables provisioned in `demo-clinic`, `booking_enabled` OFF, Schedule module enabled by the table probe.
- n8n runs ONE active workflow, V4 (raw export kept outside git, sha256 `eece039d…`). Its own CRM gateway (`FLOWHQ_CRM_BOOKING_URL` / `FLOWHQ_CRM_API_TOKEN`) is not configured, so it books nothing through FLOW HQ today.
- V4 has no conversation-pause check, no W1 race guard, no W15 follow-ups, no separate `Reminder_Consent`. 4D has all of them.

## Reply permission vs reminder consent (design, already in 4C/4D)
- Inbound message = permission to REPLY inside the 24 h window (`Consent_WhatsApp`, set by W2 when `FLOWHQ_W2_IMPLIED_CONSENT=true`). Keep it `true`: setting it `false` would stop the AI answering new patients.
- Reminders (W5/W15) need an explicit `Reminder_Consent` = Yes recorded by staff with evidence. Unknown stays Unknown; opt-out always wins; the AI cannot record consent. Nothing is migrated without the registration form.

## Steps (each needs the owner's go-ahead; stop at the first failed check)
1. Fresh backup (`~/backups/...`, encrypted; verify checksums). V4 stays in n8n, inactive copy kept.
2. `.env` (server only, never git): `FLOWHQ_AI_MAX_REPLIES_PER_HOUR=12`, `FLOWHQ_BOOKING_API_URL=http://flowhq:8787`; keep `FLOWHQ_WA_SEND_MODE=allowlist` and the allowlist.
3. Issue the booking token: `docker compose exec flowhq node dist/tools/booking-token.mjs n8n-whatsapp demo-clinic --days 90 --write`, `docker compose restart flowhq`; put the token ONCE into the n8n credential `FlowHQ Booking API` (Header Auth `Authorization: Bearer <token>`).
4. Recreate n8n (env changes only apply on recreate): `docker compose up -d --no-deps n8n` (brief webhook gap; Meta retries).
5. Import 4D as a NEW inactive workflow (`n8n import:workflow`; its id differs from V4's, so nothing is overwritten); re-link credentials by role (WhatsApp, OpenRouter, Grist, FlowHQ Booking API, SMTP/Telegram as in V4).
6. Test with the authorized number only (`FLOWHQ_WA_SEND_MODE=allowlist`, `TEST_MODE=true`): inbound, real-model reply, availability, book (explicit YES), reschedule, cancel, duplicate delivery, opt-out STOP, pause.
7. Swap: deactivate V4, activate 4D (same webhook paths; only one can be active). Roll back = deactivate 4D, activate V4.
8. Staff turn booking on in Schedule (admin): staff-managed first, one controlled booking, then AI booking.
9. Reminders only for patients with a recorded explicit Reminder_Consent. Marketing stays off.

## Needed from the owner
- Go-ahead for steps 2-5 and 7 (production n8n changes).
- Confirmation that `+919322146560` is the authorized test number; Meta/OpenRouter credentials are already inside n8n.
- Who built V4 and whether anything in it must be kept.
- The real registration form (for consent wording review).
