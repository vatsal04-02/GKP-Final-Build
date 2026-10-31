#!/usr/bin/env bash
# STEP 75. 4D -> 4E (no quiet hours for staff alerts, hand-off alerts, booking confirmations and replies to a patient who wrote in).
# Imports 4E as a NEW inactive workflow, then swaps 4D off / 4E on and recreates n8n ONCE (the same recreate also loads any .env change made beforehand, for example
# FLOWHQ_CAL_WEBHOOK_SECRET or FLOWHQ_TELEGRAM_CHAT_ID). 4D stays in n8n, inactive, as the rollback. If a check fails afterwards the script switches back to 4D by itself.
# Grist data, volumes, credentials and FLOW HQ are not touched.
#   CONFIRM=yes ./scripts/4d/75-update-to-4e.sh
. "$(dirname "$0")/common.sh"; need_confirm
grep -q "\"id\": \"$E4_ID\"" "$E4_FILE" && grep -q '"active": false' "$E4_FILE" || { say "$E4_FILE is not the expected inactive 4E file"; exit 2; }
only_active "$D4_ID" || { say "4D is not the one active workflow: stop"; exit 1; }
ts="$(date +%Y%m%d-%H%M%S)"; cp -p .env ".env.pre-4e-$ts" && chmod 600 ".env.pre-4e-$ts" && say "saved .env as .env.pre-4e-$ts"
docker cp "$E4_FILE" "$(cid n8n):/tmp/4e.json" >/dev/null
docker exec "$(cid n8n)" n8n import:workflow --input=/tmp/4e.json 2>&1 | tail -2
docker exec "$(cid n8n)" rm -f /tmp/4e.json
has_state "$E4_ID" 0 && ok "4E imported, inactive" || { bad "4E is not present as inactive"; exit 1; }
only_active "$D4_ID" && ok "4D is still the one active workflow" || { bad "active set changed during the import"; exit 1; }
back() { say "$1: switching back to 4D"; docker exec "$(cid n8n)" n8n unpublish:workflow --id="$E4_ID" 2>&1 | tail -1 || true; docker exec "$(cid n8n)" n8n publish:workflow --id="$D4_ID" 2>&1 | tail -1; docker compose "${F[@]}" up -d --no-deps n8n >/dev/null; wait_healthy n8n && say "back on 4D, n8n healthy" || say "n8n not healthy: see docs/runbooks.md"; }
say "unpublish 4D, publish 4E, recreate n8n once"
docker exec "$(cid n8n)" n8n unpublish:workflow --id="$D4_ID" 2>&1 | tail -1
docker exec "$(cid n8n)" n8n publish:workflow --id="$E4_ID" 2>&1 | tail -1
docker compose "${F[@]}" up -d --no-deps n8n >/dev/null
wait_healthy n8n || { back "n8n is not healthy"; exit 2; }
sleep 8
only_active "$E4_ID" && ok "4E is the ONE active workflow; 4D is inactive" || bad "active set is $(active_ids | grep '|1$' | tr '\n' ' ')"
docker logs --since 2m "$(cid n8n)" 2>&1 | grep -iE 'could not be activated|conflict' | head -3 | grep . && bad "n8n reported an activation problem" || ok "no activation errors in the n8n log"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public /healthz 200" || bad "/healthz not 200"
v="$(curl -s -m 10 "$PUBLIC_N8N/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" || true)"; echo "$v" | grep -qi 'verification failed' && ok "whatsapp-inbound webhook is live and refuses a wrong verify token" || bad "whatsapp-inbound answered: $(echo "$v" | cut -c1-80)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{}' "$PUBLIC_N8N/webhook/website-lead")" = 403 ] && ok "website-lead refuses a request without the secret (403)" || bad "website-lead did not answer 403 to an unauthenticated POST"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/rest/login")" = 404 ] && ok "editor API not public" || bad "/rest/login not 404"
if [ "$FAILS" != 0 ]; then back "CHECKS FAILED"; exit 2; fi
say "4E IS LIVE. Rollback by hand: n8n unpublish:workflow --id=$E4_ID ; n8n publish:workflow --id=$D4_ID ; docker compose ... up -d --no-deps n8n"
