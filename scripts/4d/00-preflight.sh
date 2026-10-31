#!/usr/bin/env bash
# READ-ONLY. Checks that production is in the state the 4D cutover expects. Safe to run any time; changes nothing.
#   ./scripts/4d/00-preflight.sh
. "$(dirname "$0")/common.sh"
say "4D cutover preflight ($(date '+%F %T %Z'))"
docker compose "${F[@]}" config -q 2>/dev/null && ok "compose files are valid" || bad "docker compose config failed"
for s in flowhq n8n grist caddy; do if [ "$s" = caddy ]; then [ -n "$(cid caddy)" ] && ok "caddy is running" || bad "caddy is not running"; else healthy "$s" && ok "$s is healthy" || bad "$s is not healthy"; fi; done
h="$(docker exec "$(cid flowhq)" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "$h" | grep -q '"audit_outbox":"ok"' && ok "FLOW HQ health ok, audit outbox ok" || bad "FLOW HQ health / audit outbox: $h"
[ -f "$D4_FILE" ] && grep -q "\"id\": \"$D4_ID\"" "$D4_FILE" && grep -q '"active": false' "$D4_FILE" && ok "4D file present, inactive, id $D4_ID" || bad "4D file missing or has another id / is active"
# the Grist side: booking tables exist, booking_enabled is still off
g="$(docker exec -e SLUG="$CLINIC" "$(cid flowhq)" node -e '
const h={Authorization:"Bearer "+process.env.GRIST_API_KEY},b=process.env.GRIST_BASE_URL;
(async()=>{const reg=await (await fetch(b+"/api/docs/"+process.env.GRIST_REGISTRY_DOC_ID+"/tables/Clinics/records",{headers:h})).json(); const id=reg.records.find(r=>r.fields.Clinic_Slug===process.env.SLUG).fields.Grist_Doc_ID;
const t=(await (await fetch(b+"/api/docs/"+id+"/tables",{headers:h})).json()).tables.map(x=>x.id);
const need=["Doctors","Doctor_Schedules","Booking_Config","Closures_Blocks","Reminder_Consent","Reminder_Consent_Log","Booking_Audit","Send_Ledger"]; console.log("missing="+need.filter(x=>!t.includes(x)).join(",")+";");
const bc=(await (await fetch(b+"/api/docs/"+id+"/tables/Booking_Config/records",{headers:h})).json()).records; console.log("booking_enabled="+((bc.find(r=>r.fields.Key==="booking_enabled")||{fields:{}}).fields.Value));})().catch(e=>console.log("ERR "+e.message))' 2>/dev/null | tr '\n' ' ')"
echo "$g" | grep -q 'missing=;' && ok "all booking tables (and Send_Ledger) exist in $CLINIC" || bad "tables: $g"
echo "$g" | grep -q 'booking_enabled=off' && ok "booking_enabled is OFF" || bad "booking_enabled is not off: $g"
# n8n: V4 is the only active workflow, 4D is not imported yet (or is imported inactive)
a="$(active_ids || true)"
echo "$a" | grep -qx "$V4_ID|1" && ok "V4 is active" || bad "V4 is not active"
[ "$(echo "$a" | grep -c '|1$')" = 1 ] && ok "exactly one active workflow" || bad "active workflows: $(echo "$a" | grep '|1$' | tr '\n' ' ')"
echo "$a" | grep -qx "$D4_ID|1" && bad "4D is already ACTIVE" || ok "4D is not active (imported: $(echo "$a" | grep -c "^$D4_ID|"))"
say "  environment (non-secret values):"
for k in FLOWHQ_AI_MAX_REPLIES_PER_HOUR FLOWHQ_BOOKING_API_URL FLOWHQ_WA_SEND_MODE FLOWHQ_AI_EXTERNAL_ENABLED FLOWHQ_W2_IMPLIED_CONSENT FLOWHQ_W1_REQUIRE_CONSENT; do printf '    %-34s .env=%-22s running n8n=%s\n' "$k" "$(getenv $k)" "$(docker exec "$(cid n8n)" printenv $k 2>/dev/null || echo '<unset>')"; done
[ "$(getenv FLOWHQ_WA_SEND_MODE)" = allowlist ] && ok "WhatsApp send mode is allowlist" || bad "FLOWHQ_WA_SEND_MODE is '$(getenv FLOWHQ_WA_SEND_MODE)' (must be allowlist during the cutover)"
[ -n "$(getenv FLOWHQ_WA_ALLOWLIST)" ] && ok "the allowlist is set ($(getenv FLOWHQ_WA_ALLOWLIST | tr ',' '\n' | grep -c .) number(s))" || bad "FLOWHQ_WA_ALLOWLIST is empty"
[ "$(getenv FLOWHQ_AI_EXTERNAL_ENABLED)" = false ] && ok "external AI is OFF (stays off until the supervised test)" || bad "FLOWHQ_AI_EXTERNAL_ENABLED is '$(getenv FLOWHQ_AI_EXTERNAL_ENABLED)'"
ls -d "$HOME"/backups/pre-deploy-* >/dev/null 2>&1 && ok "an earlier encrypted backup exists" || bad "no backup under ~/backups"
cred="$(docker exec "$(cid n8n)" sh -c 'n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1; node -e "for(const c of JSON.parse(require(\"fs\").readFileSync(\"/tmp/c.json\",\"utf8\"))) console.log(c.name)"; rm -f /tmp/c.json' | tr '\n' ',')"
say "  credentials in n8n (names only): $cred"
for c in "Header Auth account 2" "WhatsApp Cloud API" "OpenRouter API"; do echo "$cred" | grep -q "$c" && ok "credential '$c' exists" || bad "credential '$c' is missing"; done
echo "$cred" | grep -q "FlowHQ W1 Webhook Auth" && say "  note: 'FlowHQ W1 Webhook Auth' already exists" || say "  to create at step 40: FlowHQ W1 Webhook Auth"
echo "$cred" | grep -q "FlowHQ Booking API" && say "  note: 'FlowHQ Booking API' already exists" || say "  to create at step 40: FlowHQ Booking API"
[ -f "$SECRETS/booking-token" ] && say "  note: a booking token file already exists in $SECRETS" || say "  no booking token issued yet"
say; [ "$FAILS" = 0 ] && say "PREFLIGHT PASSED" || { say "PREFLIGHT FAILED ($FAILS)"; exit 1; }
