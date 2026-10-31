#!/usr/bin/env bash
# STEP 76. 4E -> 4F (UPI payments: the QR image, screenshot intake, the website payments webhook, the payment notifier).
# Imports 4F as a NEW inactive workflow, then swaps 4E off / 4F on and recreates n8n ONCE (the same recreate also loads any .env / compose change made beforehand, for example
# FLOWHQ_PAYMENT_OCR_WEBSITE). 4E stays in n8n, inactive, as the rollback. If a check fails afterwards the script switches back to 4E by itself.
# Payments stay CLOSED to patients until an admin records the payee authorization and the fee in FLOW HQ > Schedule > Payments: this script does not open them.
# Grist data, volumes, credentials and FLOW HQ are not touched.
#   CONFIRM=yes ./scripts/4d/76-update-to-4f.sh
. "$(dirname "$0")/common.sh"; need_confirm
grep -q "\"id\": \"$F4_ID\"" "$F4_FILE" && grep -q '"active": false' "$F4_FILE" || { say "$F4_FILE is not the expected inactive 4F file"; exit 2; }
only_active "$E4_ID" || { say "4E is not the one active workflow: stop"; exit 1; }
ts="$(date +%Y%m%d-%H%M%S)"; cp -p .env ".env.pre-4f-$ts" && chmod 600 ".env.pre-4f-$ts" && say "saved .env as .env.pre-4f-$ts"
docker cp "$F4_FILE" "$(cid n8n):/tmp/4f.json" >/dev/null
docker exec "$(cid n8n)" n8n import:workflow --input=/tmp/4f.json 2>&1 | tail -2
docker exec "$(cid n8n)" rm -f /tmp/4f.json
has_state "$F4_ID" 0 && ok "4F imported, inactive" || { bad "4F is not present as inactive"; exit 1; }
only_active "$E4_ID" && ok "4E is still the one active workflow" || { bad "active set changed during the import"; exit 1; }
back() { say "$1: switching back to 4E"; docker exec "$(cid n8n)" n8n unpublish:workflow --id="$F4_ID" 2>&1 | tail -1 || true; docker exec "$(cid n8n)" n8n publish:workflow --id="$E4_ID" 2>&1 | tail -1; docker compose "${F[@]}" up -d --no-deps n8n >/dev/null; wait_healthy n8n && say "back on 4E, n8n healthy" || say "n8n not healthy: see docs/runbooks.md"; }
say "unpublish 4E, publish 4F, recreate n8n once"
docker exec "$(cid n8n)" n8n unpublish:workflow --id="$E4_ID" 2>&1 | tail -1
docker exec "$(cid n8n)" n8n publish:workflow --id="$F4_ID" 2>&1 | tail -1
docker compose "${F[@]}" up -d --no-deps n8n >/dev/null
wait_healthy n8n || { back "n8n is not healthy"; exit 2; }
sleep 8
only_active "$F4_ID" && ok "4F is the ONE active workflow; 4E is inactive" || bad "active set is $(active_ids | grep '|1$' | tr '\n' ' ')"
docker logs --since 2m "$(cid n8n)" 2>&1 | grep -iE 'could not be activated|conflict' | head -3 | grep . && bad "n8n reported an activation problem" || ok "no activation errors in the n8n log"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public /healthz 200" || bad "/healthz not 200"
v="$(curl -s -m 10 "$PUBLIC_N8N/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" || true)"; echo "$v" | grep -qi 'verification failed' && ok "whatsapp-inbound webhook is live and refuses a wrong verify token" || bad "whatsapp-inbound answered: $(echo "$v" | cut -c1-80)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{}' "$PUBLIC_N8N/webhook/website-lead")" = 403 ] && ok "website-lead refuses a request without the secret (403)" || bad "website-lead did not answer 403 to an unauthenticated POST"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'content-type: application/json' -d '{"action":"config"}' "$PUBLIC_N8N/webhook/site-payments")" = 403 ] && ok "site-payments refuses a request without the secret (403)" || bad "site-payments did not answer 403 to an unauthenticated POST"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/rest/login")" = 404 ] && ok "editor API not public" || bad "/rest/login not 404"
if [ "$FAILS" != 0 ]; then back "CHECKS FAILED"; exit 2; fi
say "4F IS LIVE (payments still closed to patients). Rollback by hand: n8n unpublish:workflow --id=$F4_ID ; n8n publish:workflow --id=$E4_ID ; docker compose ... up -d --no-deps n8n"
