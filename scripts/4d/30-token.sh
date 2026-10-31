#!/usr/bin/env bash
# STEP 30. Issues the booking API token for n8n, with ALL SIX scopes W13 needs and nothing else
# (config:read availability:read appointments:read appointments:create appointments:update appointments:cancel), 90 days, for clinic $CLINIC.
# The token is shown by FLOW HQ once; this script captures it straight into $SECRETS/booking-token (mode 600) without printing it. FLOW HQ stores only a hash.
# Then it restarts FLOW HQ (tokens load at start) and proves the token with READ-ONLY calls from inside n8n's network. No appointment is created.
#   CONFIRM=yes ./scripts/4d/30-token.sh
. "$(dirname "$0")/common.sh"; need_confirm
umask 077; mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
[ ! -s "$SECRETS/booking-token" ] || { say "$SECRETS/booking-token already exists: use ./scripts/4d/90-rollback.sh (revokes it) or delete the file first"; exit 1; }
raw="$(docker exec "$(cid flowhq)" node dist/tools/booking-token.mjs "$TOKEN_ID" "$CLINIC" --days 90 --write 2>"$SECRETS/.err" || true)"
tok="$(printf '%s\n' "$raw" | grep -E '^  [a-z0-9-]{3,40}\.[A-Za-z0-9_-]{40,}$' | head -1 | sed 's/^  //')"
if [ -z "$tok" ]; then say "no token was issued: $(tr '\n' ' ' < "$SECRETS/.err" | cut -c1-300)"; shred_file "$SECRETS/.err"; exit 1; fi
printf '%s\n' "$tok" > "$SECRETS/booking-token"; chmod 600 "$SECRETS/booking-token"; shred_file "$SECRETS/.err"; unset raw tok
say "token $TOKEN_ID issued for $CLINIC (90 days) and saved in $SECRETS/booking-token (not printed). FLOW HQ stores a hash only."
say "restarting FLOW HQ so it loads the token (about 40 s)"; docker compose "${F[@]}" restart flowhq >/dev/null; wait_healthy flowhq && ok "FLOW HQ healthy" || { bad "FLOW HQ did not return healthy: run 90-rollback.sh"; exit 1; }
say "read-only proof from inside n8n's network (private address, no writes):"
[ "$(fhq_status /api/booking/config)" = 200 ] && ok "GET /api/booking/config -> 200 (scope config:read)" || bad "config not 200"
[ "$(fhq_status "/api/booking/availability?date=$(date -d '+1 day' +%F)")" = 200 ] && ok "GET availability -> 200 (scope availability:read)" || bad "availability not 200"
[ "$(fhq_status '/api/booking/appointments/none-0?patient_phone=%2B910000000000')" = 404 ] && ok "GET appointment (unknown) -> 404 (scope appointments:read; phone ownership enforced)" || bad "appointment read not 404"
c="$(fhq_get /api/booking/config)"; echo "$c" | grep -q '"booking_enabled":false' && ok "config says booking_enabled=false (the switch is still OFF)" || bad "config booking_enabled is not false: $(echo "$c" | cut -c1-200)"
echo "$c" | grep -q '"shifts":{"morning"' && ok "config.shifts is the object shape the 4D workflow expects" || say "  (shifts shape: $(echo "$c" | grep -o '"shifts":.\{0,60\}'))"
[ "$FAILS" = 0 ] || exit 1
say "NEXT: ./scripts/4d/40-credentials.sh"
