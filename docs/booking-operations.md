# Booking: operating rules (roles, the AI switch, deployment)

## The AI switch is an AI switch
`Booking_Config.booking_enabled` (shown as "WhatsApp AI booking" on the Schedule page; **admins only** can change it) controls only what the WhatsApp assistant may do.
It is OFF by default and OFF whenever the booking configuration is missing or invalid. It never limits staff.

| Action | AI (service token) when OFF | Staff when OFF |
|---|---|---|
| See free times | none offered (`ai_booking.available:false`) | calendar and slot picker work |
| Create | refused, 403 `ai_booking_disabled` | allowed |
| Reschedule | refused, 403 `ai_booking_disabled` | allowed |
| Cancel | **allowed** (with the patient's phone as proof; subject to `cancel_min_notice_minutes`) | allowed |
| Look up | allowed with ownership proof (phone) | allowed |
| Change status (check in, complete, no-show) | not available to the AI | allowed |

AI reschedule/cancel are kept separate from staff permissions on purpose: the AI path needs a token scope AND the patient's phone; staff need a signed-in session and a role.
If you would rather the AI also be unable to cancel while OFF, that is a one-line change in `BookingService.cancel` (decision for the owner). Verified by `tests/booking-staff.test.ts` and `tests/booking-service.test.ts`.

## Who may do what (enforced inside the booking service, tested in `tests/booking-permissions.test.ts`)
| | Admin | Front-desk staff | A doctor's own login |
|---|---|---|---|
| View calendar, appointments, doctors, settings | yes | yes | yes |
| Create / move / cancel / change status | yes | yes | **only their own doctor's** |
| Add or switch off leave, closures, blocked time | yes | yes | no |
| Doctors, weekly hours, overrides | yes | no | no |
| Booking settings (slot length, notice, ...), shifts | yes | no | no |
| AI booking ON/OFF | yes | no | no |
| Full audit log | yes | no (they see each appointment's own history) | no |
The role comes from the signed-in session on the server, never from the request. An unknown role is treated as plain staff. A refused action is itself written to the audit log.
A doctor's login is bound to its doctor by the stable **`doctorId`** (the `Doctors.Doctor_ID`) in `users.json`, not by name; a login that cannot be resolved to exactly one doctor can view but not change anything (`docs/booking-decisions.md` section 4).

## Audit
Every create (including replays and refusals), move, cancel, status change, setting change (with before / after, e.g. the AI switch), doctor, hours and block change is written to `Booking_Audit` with who (staff email, or `token:<id>`), what, the record and the outcome. **Never logged:** patient names, phone numbers, free text, idempotency keys, tokens or secrets.
Every booking mutation is audited through a **durable outbox** (section "Audit outbox" below): the intent is saved to disk BEFORE anything changes, so if the audit log cannot be saved the change is refused (503 `audit_unavailable`, nothing written). A saved, verified appointment is never reported as failed because of audit: if only the later steps fail, the entry stays on disk and is finished by recovery. Failures are never silent: counted, shown to admins (banner + History tab), and logged as counts only.

## Deployment requirements
1. **Exactly ONE FLOW HQ backend process may handle booking writes.** The lock that stops two bookings for one slot is an in-process Mutex. It cannot see another process. Do not scale `flowhq` (`--scale`, `deploy.replicas`, PM2/cluster mode, a second host, a blue/green overlap that serves writes from both). The post-write check detects and undoes a collision after the fact (the later row loses), but the tests prove only that safety net, **not multi-instance safety**. Before ever running more than one instance, stop and design distributed locking (for example a lock row with a compare-and-set in Grist, or a single writer service).
   Other writers also bypass the lock: Cal.com / W4 inserting rows, and W13 `booking_mode=direct` (must be off).
2. **Trust the reverse proxy for rate limits.** Production runs behind Caddy (`flowhq/deploy/Caddyfile`), so rate limits (sign-in, bad service tokens) key on the address Caddy appends to `X-Forwarded-For` (the last entry); anything a client typed before it is ignored. Default `FLOWHQ_TRUST_PROXY=true`. **If FLOW HQ is ever reachable without a proxy, set `FLOWHQ_TRUST_PROXY=false`** (the header is then ignored and the socket address is used), otherwise a caller could fake the header.
   Caddy must keep replacing (not forwarding) a client-supplied `X-Forwarded-For`; do not add `trusted_proxies` for the public internet.
3. **n8n should call the API over the private Docker network** (`http://flowhq:8787/api/booking/...`), not the public domain. All n8n calls then share the container's address for rate limiting; only FAILED token attempts are counted, so a healthy n8n cannot lock itself out, but a misconfigured n8n retrying a bad token for 20 requests would be blocked for 15 minutes.
4. Service tokens live only in `config/booking-tokens.json` (hashes; git-ignored) and in n8n credentials. They are never sent to the browser (tested). Rotate by adding a new token, switching n8n, then `"revoked": true` on the old one.
5. Nothing in Slices 1-3 has been provisioned or deployed. Provisioning (`npm run provision-booking`, additive, dry run by default) runs against a COPY first.

## Audit outbox: how it works, and the runbook (Slice 4A)
**Flow.** (1) write-ahead **intent** (fsynced) with a new `Audit_ID`; if that cannot be saved the request is refused before any write; (2) the Grist write stores the same `Audit_ID` on the row; (3) after the read-back the **outcome** is saved; (4) a flusher inserts one `Booking_Audit` row per operation, skipping any `Audit_ID` already there, reads it back, and records `flushed`. After a crash the row itself says whether the operation was applied (it carries the id or it does not): an intent with no outcome is resolved to `ok / recovered` or `aborted / not_applied` by that lookup. Nothing in the file, the logs or the alerts contains a patient name, phone, free text, idempotency key or secret.

**Prerequisite (provisioning order).** The `Audit_ID` columns (`Appointments`, `Booking_Audit`, `Booking_Config`, `Doctors`, `Doctor_Schedules`, `Closures_Blocks`) must exist BEFORE this version runs: run `npm run provision-booking` (additive, dry run first, against a COPY first). Without them Grist refuses every booking write (fails closed, nothing reported booked).

**Where it lives and what it needs.**
- Directory `config/audit-outbox/<workspace-slug>/` (`FLOWHQ_AUDIT_OUTBOX_DIR`) on the existing **`flowhq_config` Docker volume** (`flowhq/deploy/docker-compose.flowhq.yml` mounts it at `/app/flowhq/config`). The image sets `FLOWHQ_AUDIT_REQUIRE_VOLUME=true`: on Linux the process **refuses to start the outbox on the container's own (overlay) layer**, because that is lost when the container is recreated. Never run without that volume.
- Files: `outbox.jsonl` (append-only log), `outbox.meta.json` (creation time + a volume id), `outbox.lock` (single-writer lock with a 5 s heartbeat; a lock older than 20 s is stale and is taken over; a start waits up to 30 s for a recent lock to clear, which covers a container being replaced).
- Permissions: directory `0700`, files `0600`, owned by the container user `node` (the Dockerfile `chown`s `config`). Verified on the real image and a real volume.
- Compose: `stop_grace_period: 30s` so SIGTERM lets FLOW HQ finish and release the lock (`index.ts` handles SIGTERM / SIGINT).
- Only ONE FLOW HQ process may use an outbox; a second one is refused (this also guards the single-process rule on a shared volume, though it does not make multi-host safe).

**Health and alerts** (`GET /schedule/overview` and the Schedule page, admins only; `audit_health`): level `ok` / `amber` / `red`, waiting entries, open intents, oldest age, write failures, refused changes, unreadable lines, lock, volume, break-glass. Amber: 20 waiting, or oldest older than 5 min, or unreadable lines. Red: 100 waiting, oldest older than 30 min, ANY change refused because the log could not be saved, lock lost, not on a persistent volume, outbox not open, break-glass on. Server log lines (counts only): `AUDIT OUTBOX`, `AUDIT WRITE FAILED`. Watch for them in the existing log monitoring.

**Disk full / read-only volume.** New mutations are REFUSED (503 `audit_unavailable`) with nothing written; reads and availability keep working; the Schedule page shows red. An outcome / flush that cannot be written keeps its entry in memory and retries; nothing is ever dropped to make room. A full disk can leave one torn last line: it is sealed and skipped on the next start (counted as one unreadable line, amber). **If the disk is full at start, the outbox cannot open (it cannot seal the tail) and bookings stay refused until space is freed.** Fix: free space on the volume, restart or wait for the retry.
**Break-glass (emergency only).** If the clinic must keep booking while the volume is unusable: set `FLOWHQ_AUDIT_BREAKGLASS=true`, restart. Mutations then run with the intent held in memory only (lost if the process dies); the page shows a permanent red banner and each use is logged. Remove it as soon as the volume is repaired. Off by default.
**Corruption.** An unreadable line (a torn last line, or garbage) is skipped and counted, never fatal; every other record loads. Check with `npm run audit-outbox -- verify <dir>` (read-only, exit 1 if any line is unreadable). `npm run audit-outbox -- status <dir>` shows counts, lock age, volume id and whether the directory is on a persistent volume; neither prints entry content.
**Backup and restore.** Include the `flowhq_config` volume in the host's regular snapshot and take one before every upgrade (the log is small). Restoring an older copy is safe: flushing is idempotent by `Audit_ID`, so already-written rows are never duplicated (tested). Entries made after the backup that were still unflushed are lost; entries already in `Booking_Audit` are unaffected. An intent with no outcome and no matching row is finalised as `aborted`.
**Forced termination** (`docker kill`, power loss, OOM): everything fsynced before the kill is kept; the next start waits for the stale lock (about 20 s), reloads the log, resolves half-finished operations by `Audit_ID`, and flushes. Verified with a real child process killed with SIGKILL and with `docker kill` on the real image.
**Verifying persistence yourself (any time, safe: uses a `selftest` sub-directory, never the real outbox).**
```
docker compose exec flowhq node dist/tools/audit-outbox.mjs canary write
docker compose exec flowhq node dist/tools/audit-outbox.mjs selftest write --require-volume
docker compose up -d --force-recreate flowhq            # a NEW container on the same volume
docker compose exec flowhq node dist/tools/audit-outbox.mjs canary check
docker compose exec flowhq node dist/tools/audit-outbox.mjs selftest read --require-volume
docker compose exec flowhq node dist/tools/audit-outbox.mjs status config/audit-outbox     # mount must not be "/ (overlay)"
```
**Recovery runbook.** *Red banner, bookings refused:* check the volume (`status`), free disk, check permissions, restart. *Grist down:* nothing to do; entries wait and flush when it returns (bookings that already passed verification are safe). *Volume lost / replaced:* bookings already in Grist are unaffected; only entries that had not been written to `Booking_Audit` are gone: the last alert's "waiting" count says how many. Restore the latest volume snapshot if available. *Two instances by mistake:* the second refuses booking writes; stop it. *Stale lock after a crash:* automatic after 20 s; never delete `outbox.lock` by hand while a process is running.