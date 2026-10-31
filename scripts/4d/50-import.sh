#!/usr/bin/env bash
# STEP 50. Imports the 4D workflow as a NEW, INACTIVE workflow (id $D4_ID, which is not any deployed workflow's id, so nothing is overwritten).
# V4 stays active and untouched. Refuses to run if the two new credentials do not exist yet.
#   CONFIRM=yes ./scripts/4d/50-import.sh
. "$(dirname "$0")/common.sh"; need_confirm
grep -q "\"id\": \"$D4_ID\"" "$D4_FILE" && grep -q '"active": false' "$D4_FILE" || { say "$D4_FILE is not the expected inactive 4D file"; exit 2; }
n="$(docker exec "$(cid n8n)" sh -c 'n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1; node -e "for(const c of JSON.parse(require(\"fs\").readFileSync(\"/tmp/c.json\",\"utf8\"))) console.log(c.id)"; rm -f /tmp/c.json')"
for id in FhqCredBooking01 FhqCredW1Hook001 9J6XxrIQoFDcQZ0Y k01hgCFOtdH5hdiq As1GpZb3W665Na7C; do echo "$n" | grep -qx "$id" || { say "credential $id is missing: finish step 40 first"; exit 1; }; done
a0="$(active_ids)"; echo "$a0" | grep -qx "$V4_ID|1" || { say "V4 is not active: stop"; exit 1; }
docker cp "$D4_FILE" "$(cid n8n):/tmp/4d.json" >/dev/null
docker exec "$(cid n8n)" n8n import:workflow --input=/tmp/4d.json 2>&1 | tail -3
docker exec "$(cid n8n)" rm -f /tmp/4d.json
a1="$(active_ids)"
echo "$a1" | grep -qx "$D4_ID|0" && ok "4D imported, INACTIVE" || bad "4D is not present as inactive: $(echo "$a1" | grep "^$D4_ID")"
echo "$a1" | grep -qx "$V4_ID|1" && ok "V4 is still active" || bad "V4 is no longer active"
[ "$(echo "$a1" | grep -c '|1$')" = 1 ] && ok "exactly one workflow is active" || bad "active: $(echo "$a1" | grep '|1$' | tr '\n' ' ')"
[ "$FAILS" = 0 ] || exit 1
say "In the n8n editor (https://$(getenv N8N_ADMIN_DOMAIN), your admin IP only) open the 4D workflow and check there is no red 'credential not found' badge on any node."
say "NEXT: ./scripts/4d/60-recreate-n8n.sh"
