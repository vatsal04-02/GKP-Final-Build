#!/usr/bin/env bash
# ROLLBACK of the 4D cutover. Touches only: the active-workflow flags (4D off, V4 on), the n8n container (recreated once so it reads the restored .env and the
# restored active set), the booking token (revoked), .env (restored from the copy step 20 saved). Never touches Grist data, any volume, any backup, the credentials
# or FLOW HQ's code. Safe to run more than once, and from any point of the cutover.
#   CONFIRM=yes ./scripts/4d/90-rollback.sh
. "$(dirname "$0")/common.sh"; need_confirm
say "1/5 workflows: 4D off, V4 on"
if has_state "$D4_ID" 1; then docker exec "$(cid n8n)" n8n unpublish:workflow --id="$D4_ID" 2>&1 | tail -1; fi
if ! has_state "$V4_ID" 1; then docker exec "$(cid n8n)" n8n publish:workflow --id="$V4_ID" 2>&1 | tail -1; fi
say "2/5 .env back to the copy saved before step 20"
pre="$(ls -1t .env.pre-4d-* 2>/dev/null | head -1 || true)"
if [ -n "$pre" ]; then cp -p "$pre" .env && chmod 600 .env && say "   restored from $pre"; else say "   no .env.pre-4d-* copy: .env left as it is"; fi
say "3/5 recreate n8n once (reads the restored .env, loads the restored active set)"
docker compose "${F[@]}" up -d --no-deps n8n >/dev/null; wait_healthy n8n && ok "n8n healthy" || bad "n8n not healthy: restore the volume from the backup (scripts/restore.sh <archive>)"
say "4/5 revoke the booking token (FLOW HQ then answers 401 to it) and restart FLOW HQ"
if docker exec "$(cid flowhq)" node dist/tools/booking-token.mjs revoke "$TOKEN_ID" 2>&1 | tail -1; then docker compose "${F[@]}" restart flowhq >/dev/null; wait_healthy flowhq && ok "FLOW HQ healthy" || bad "FLOW HQ not healthy: use gkp-final-build-flowhq:rollback-* (docs/runbooks.md section 5)"; fi
shred_file "$SECRETS/booking-token"
say "5/5 verify the baseline"
only_active "$V4_ID" && ok "V4 is the one active workflow again" || bad "active set: $(active_ids | grep '|1$' | tr '\n' ' ')"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public /healthz 200" || bad "/healthz"
v="$(curl -s -m 10 "$PUBLIC_N8N/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" || true)"; echo "$v" | grep -qi 'verification failed' && ok "whatsapp-inbound webhook is live (V4)" || bad "whatsapp-inbound: $(echo "$v" | cut -c1-80)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/rest/login")" = 404 ] && ok "editor API not public" || bad "/rest/login"
say "booking_enabled is untouched by this script: if staff had switched booking ON, turn it OFF in Schedule (admin) now."
say "If WEBSITE lead intake was re-pointed to the new secret, set Vercel N8N_WEBHOOK_SECRET back to what V4 expects (or leave the website form on the test URL)."
say; [ "$FAILS" = 0 ] && say "ROLLBACK DONE (V4 live, 4D inactive, token revoked, .env restored)" || { say "ROLLBACK INCOMPLETE ($FAILS check(s) failed)"; exit 1; }
