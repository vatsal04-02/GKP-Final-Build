#!/usr/bin/env bash
# STEP 70. THE SWAP: V4 off, 4D on. Both workflows own the same webhook paths, so only one can be active: V4 goes first, then 4D, then ONE n8n restart
# makes n8n load the new active set (publish / unpublish change the database flag; a running n8n picks it up on restart). The webhook gap is about a minute;
# Meta and Cal.com retry a refused delivery. If the checks after the swap fail, this script runs the rollback by itself.
# (The same swap can be done by hand in the editor: deactivate V4, then activate 4D: it applies immediately, no restart.)
#   CONFIRM=yes ./scripts/4d/70-swap.sh
. "$(dirname "$0")/common.sh"; need_confirm
only_active "$V4_ID" || { say "V4 is not the one active workflow: stop"; exit 1; }
is_active "$D4_ID" && { say "4D is already active"; exit 1; }
active_ids | grep -qx "$D4_ID|0" || { say "4D is not imported (step 50)"; exit 1; }
[ -s "$SECRETS/booking-token" ] && [ -s "$SECRETS/w1-webhook-secret" ] || { say "steps 30/40 are not done"; exit 1; }
say "unpublish V4, publish 4D"
docker exec "$(cid n8n)" n8n unpublish:workflow --id="$V4_ID" 2>&1 | tail -2
docker exec "$(cid n8n)" n8n publish:workflow --id="$D4_ID" 2>&1 | tail -2
say "restart n8n to load the new active set"; docker compose "${F[@]}" restart n8n >/dev/null
if ! wait_healthy n8n; then say "n8n is not healthy after the swap: ROLLING BACK"; CONFIRM=yes "$(dirname "$0")/90-rollback.sh"; exit 2; fi
sleep 8
only_active "$D4_ID" && ok "4D is the ONE active workflow; V4 is inactive" || bad "active set is $(active_ids | grep '|1$' | tr '\n' ' ')"
docker logs --since 2m "$(cid n8n)" 2>&1 | grep -iE 'could not be activated|conflict' | head -3 | grep . && bad "n8n reported an activation problem" || ok "no activation errors in the n8n log"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public /healthz 200" || bad "/healthz not 200"
v="$(curl -s -m 10 "$PUBLIC_N8N/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" || true)"; echo "$v" | grep -qi 'verification failed' && ok "whatsapp-inbound webhook is live and refuses a wrong verify token" || bad "whatsapp-inbound answered: $(echo "$v" | cut -c1-80)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{}' "$PUBLIC_N8N/webhook/website-lead")" = 403 ] && ok "website-lead refuses a request without the secret (403)" || bad "website-lead did not answer 403 to an unauthenticated POST"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/rest/login")" = 404 ] && ok "editor API not public" || bad "/rest/login not 404"
if [ "$FAILS" != 0 ]; then say "CHECKS FAILED after the swap: ROLLING BACK"; CONFIRM=yes "$(dirname "$0")/90-rollback.sh"; exit 2; fi
say "SWAP DONE. 4D is live with booking_enabled OFF and external AI OFF: nothing is offered or booked yet."
say "NEXT: ./scripts/4d/80-verify.sh, then the staff-managed booking test (docs/n8n-4d-cutover.md section 7)"
