#!/usr/bin/env bash
# STEP 60. Recreates ONLY the n8n container so it reads the new .env (AI limit 12, FLOWHQ_BOOKING_API_URL). Volumes are reattached by name; V4 stays the
# active workflow and starts again on boot. Webhooks are unavailable for about a minute: Meta and Cal.com retry a refused delivery.
#   CONFIRM=yes ./scripts/4d/60-recreate-n8n.sh
. "$(dirname "$0")/common.sh"; need_confirm
[ "$(getenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)" = 12 ] && [ -n "$(getenv FLOWHQ_BOOKING_API_URL)" ] || { say "run step 20 first"; exit 1; }
before="$(docker inspect -f '{{slice .Id 0 12}} {{.State.StartedAt}}' "$(cid n8n)")"
say "n8n before: $before"
docker compose "${F[@]}" up -d --no-deps n8n 2>&1 | tail -3
wait_healthy n8n && ok "n8n healthy again" || { bad "n8n did not return healthy: run 90-rollback.sh"; exit 1; }
say "n8n after:  $(docker inspect -f '{{slice .Id 0 12}} {{.State.StartedAt}}' "$(cid n8n)")"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)" = 12 ] && ok "n8n sees FLOWHQ_AI_MAX_REPLIES_PER_HOUR=12" || bad "AI limit not 12 in n8n"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_BOOKING_API_URL)" = "http://flowhq:8787" ] && ok "n8n sees FLOWHQ_BOOKING_API_URL=http://flowhq:8787" || bad "booking URL not set in n8n"
docker exec "$(cid n8n)" sh -c 'wget -qO- -T 5 http://flowhq:8787/api/health' | grep -q '"ok":true' && ok "n8n reaches FLOW HQ on the private network" || bad "n8n cannot reach flowhq:8787"
only_active "$V4_ID" && ok "V4 is still the one active workflow" || bad "active set changed: $(active_ids | grep '|1$' | tr '\n' ' ')"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public /healthz 200" || bad "public /healthz not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/rest/login")" = 404 ] && ok "editor API still not public (404)" || bad "/rest/login is not 404"
[ "$FAILS" = 0 ] || exit 1
say "grist / flowhq / caddy were not recreated by this step."
say "NEXT: the supervised test window (docs/n8n-4d-cutover.md section 6), then ./scripts/4d/70-swap.sh"
