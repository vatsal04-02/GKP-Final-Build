# Production deployment record: FLOW HQ 2eb3ac2 (31 October 2026)

Scope: the FLOW HQ container and the Caddy configuration only. n8n and Grist were not recreated or modified. Booking is not provisioned and `booking_enabled` is off. No message was sent to any patient. No secret is recorded here.

## What changed on the server
| Item | Before | After |
|---|---|---|
| FLOW HQ image | `e7345dd59a88` (built 28 Oct; kept as tag `gkp-final-build-flowhq:rollback-20261031`) | built from `2eb3ac2` (`6eebc4f5b417`), tag `latest` |
| `docker-compose.yml` | Oct 28, hand-edited (Grist OIDC fix) | `2eb3ac2` (the OIDC line is now in git) |
| FLOW HQ overlay | no Caddy mount | same, plus a stop grace period and an audit-outbox comment |
| `Caddyfile` | hardened (editor on the admin domain, `ADMIN_ALLOW_CIDR` only) | the same, plus `/api/booking/*` answered 404 on the FLOW HQ domain |
| `.env`, `flowhq/.env`, `flowhq/config/users.json` | | untouched |
| Volumes | `gkp-final-build_{caddy_config,caddy_data,flowhq_config,grist_data,n8n_data}` | the same five |

n8n, Grist and Caddy containers: same IDs, start times and image IDs before and after the swap. Caddy was reloaded gracefully (not recreated). n8n's container still has the old environment: the new `FLOWHQ_BOOKING_API_URL` (empty by default) takes effect the next time n8n is recreated, which is part of the activation phase, not this one.

## Backups (on the server, encrypted with `BACKUP_PASSPHRASE`; never delete)
`~/backups/pre-deploy-20261031-210947/`: `gkp-pre-deploy-*.tar.gz.enc` (n8n, Grist, FLOW HQ volumes and the env files; the same layout as `scripts/backup.sh`), `caddy-volumes-*.tar.gz.enc`, `app-dir-*.tar.gz.enc`, `state-*.tar.gz.enc`, `SHA256SUMS`, `rollback-files/` (plain copies of the compose files, Caddyfile and Dockerfile; no secrets in them), `backup.log`. An off-server copy was verified against `SHA256SUMS` (4/4).
Restore rehearsal (all five volumes into scratch volumes with a plain alpine container, no production credentials, scratch volumes deleted afterwards): n8n integrity `ok`, 9 workflows (1 active), 9 credentials; five Grist documents `ok`; the main clinic document held 2 Appointments, 4 LEADS, 2 Patients; 4 TLS certificates in the Caddy data.

## Rollback (FLOW HQ only; data volumes are never touched)
```bash
bash ~/backups/ROLLBACK-flowhq-2eb3ac2.sh
```
It does: stop the new `flowhq`; `docker tag gkp-final-build-flowhq:rollback-20261031 gkp-final-build-flowhq:latest`; restore `docker-compose.yml`, `flowhq/deploy/docker-compose.flowhq.yml` and (in place) `Caddyfile` from `rollback-files/`; `docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --no-deps --no-build flowhq`; validate and reload Caddy; print the health. The deployment script ran it automatically if FLOW HQ had not been healthy within 150 s (it was healthy after 35 s, so it was not needed).
Full data restore, only if data itself is damaged: `docs/runbooks.md` section 3 and `scripts/restore.sh <archive> --with-config`.

## Verification (31 Oct 2026, 21:30 to 21:45 IST)
| Check | Result |
|---|---|
| `https://app…/api/health` | 200, `audit_outbox: ok`, 1 active workspace |
| New build served (index bundle, CSS, Schedule / Bookings / Dashboard / Register chunks) | all 200 |
| Signed-out API (`/api/me`, schedule, bookings) | 401; a fake login is rejected with 401 (not 5xx) |
| `/api/booking/*` on the public FLOW HQ domain | 404 from Caddy (GET and POST); inside Docker it answers 401 (token required) |
| n8n domain | `/healthz` 200; `/`, `/rest/login`, `/webhook-test/x` 404; `/webhook/whatsapp-inbound` reaches n8n (403 "Verification failed" to a GET with no verify token) |
| n8n editor | 403 from a non-admin address (the VPS itself); reachable from the authorized admin IP |
| Grist | answers (302 to sign-in); FLOW HQ reads it; record counts identical before and after |
| n8n | healthy, 0 restarts, not recreated |
| HTTPS | Let's Encrypt certificates on all four hosts (to 25 Jan 2027); HTTP redirects 308 to HTTPS; HSTS set |
| Not verifiable by the agent | a signed-in staff login, and the Schedule and Bookings pages with real data: they need a staff password (see the report) |

Expected log noise: the new build logs "Table not found" for `Doctors`, `Booking_Config`, `Reminder_Consent` and the other booking tables, because booking is deliberately not provisioned. The Schedule page reports its tables as not ready; nothing writes.
