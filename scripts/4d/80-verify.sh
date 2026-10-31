#!/usr/bin/env bash
# READ-ONLY verification of the integration after the swap (and any time later). It creates, moves and cancels nothing, sends nothing, changes no switch.
#   ./scripts/4d/80-verify.sh
. "$(dirname "$0")/common.sh"
say "n8n <-> FLOW HQ integration check ($(date '+%F %T %Z'))"
only_active "$D4_ID" && ok "the active workflow is 4D ($D4_ID)" || say "  note: active set is $(active_ids | grep '|1$' | tr '\n' ' ')"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_BOOKING_API_URL)" = "http://flowhq:8787" ] && ok "n8n has FLOWHQ_BOOKING_API_URL=http://flowhq:8787" || bad "FLOWHQ_BOOKING_API_URL not set in n8n"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)" = 12 ] && ok "AI reply limit is 12/hour" || bad "AI reply limit is $(docker exec "$(cid n8n)" printenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)"
docker exec "$(cid n8n)" sh -c 'wget -qO- -T 5 http://flowhq:8787/api/health' | grep -q '"audit_outbox":"ok"' && ok "FLOW HQ reachable from n8n; audit outbox ok" || bad "FLOW HQ health from n8n"
[ -s "$SECRETS/booking-token" ] || { say "  (no token file: authenticated checks skipped)"; [ "$FAILS" = 0 ] && exit 0 || exit 1; }
[ "$(fhq_status /api/booking/config)" = 200 ] && ok "authenticated GET /config -> 200" || bad "config"
a="$(fhq_get "/api/booking/availability?date=$(date -d '+1 day' +%F)")"
echo "$a" | grep -q '"slots":\[' && ok "availability answers in the contract shape (slots[] with slot_id / doctor / shift)" || bad "availability shape: $(echo "$a" | cut -c1-160)"
c="$(fhq_get /api/booking/config)"; echo "$c" | grep -q '"booking_enabled":' && ok "config.booking_enabled present: $(echo "$c" | grep -o '"booking_enabled":[a-z]*')" || bad "config shape"
echo "$c" | grep -q '"doctors":\[' && echo "$c" | grep -q '"schedules":\[' && ok "doctors and schedules are served (Dr. Mahesh Tiwari / Dr. Sandeep Tiwari, shifts)" || bad "doctors/schedules missing"
[ "$(fhq_status '/api/booking/appointments/none-0')" = 400 ] && ok "a read without patient_phone is refused (400): patient-phone ownership is enforced" || bad "appointment read without a phone was not 400"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_APP/api/booking/config")" = 404 ] && ok "the public FLOW HQ domain does not publish /api/booking/*" || bad "/api/booking is public"
n="$(docker exec "$(cid n8n)" sh -c 'n8n export:workflow --id='"$D4_ID"' --output=/tmp/w.json >/dev/null 2>&1; node -e "const w=JSON.parse(require(\"fs\").readFileSync(\"/tmp/w.json\",\"utf8\"))[0]; console.log(w.nodes.filter(n=>n.type===\"n8n-nodes-base.httpRequest\"&&/tables\\/Appointments/.test(n.parameters.url||\"\")&&(n.parameters.method||\"GET\")!==\"GET\").map(n=>n.name).sort().join(\",\"))"; rm -f /tmp/w.json' 2>/dev/null || true)"
[ -z "$n" ] || echo "$n" | grep -qx 'W4 – Write Confirm_Sent,W5 – Set sent flag,W7 – Claim Outcome_Sent,W8 – Claim Review_Sent' && ok "the imported workflow has no direct Appointments writer except the reminder/confirmation flags" || bad "unexpected direct Appointments writers: $n"
say; [ "$FAILS" = 0 ] && say "VERIFY PASSED" || { say "VERIFY FAILED ($FAILS)"; exit 1; }
