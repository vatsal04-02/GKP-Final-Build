#!/usr/bin/env bash
# Switches the EXTERNAL AI provider on or off (FLOWHQ_AI_EXTERNAL_ENABLED in the server .env, then n8n is recreated to read it).
#   CONFIRM=yes ./scripts/4d/95-ai-external.sh on      supervised-test mode: refuses unless every safety interlock holds
#   CONFIRM=yes ./scripts/4d/95-ai-external.sh off     rollback: nothing is sent to the AI provider any more
# "on" REFUSES unless: send mode is `allowlist`; the allowlist contains ONLY the authorized test number(s) (ALLOW_ONLY, default 919322146560);
# Grist Settings TEST_MODE is TRUE (every outgoing message is then redirected to TEST_PHONE); ai_mode is not `off`; 4D is the one active workflow.
# With those, the 4D allowlist gate (W13 - Build Context) keeps every other number's message away from the provider and the send step cannot reach a patient.
# A no-downtime encrypted backup of the clinic and registry Grist documents and a copy of .env are taken first.
. "$(dirname "$0")/common.sh"; need_confirm
mode="${1:-}"; [ "$mode" = on ] || [ "$mode" = off ] || { say "usage: CONFIRM=yes $0 on|off"; exit 2; }
set_kv() { local k="$1" v="$2"; if grep -qE "^$k=" .env; then sed -i -E "s|^$k=.*|$k=$v|" .env; else printf '%s=%s\n' "$k" "$v" >> .env; fi; }
FL="$(cid flowhq)"

if [ "$mode" = on ]; then
  ONLY="${ALLOW_ONLY:-919322146560}"
  [ "$(getenv FLOWHQ_WA_SEND_MODE)" = allowlist ] || { say "REFUSED: FLOWHQ_WA_SEND_MODE is not allowlist"; exit 1; }
  extra="$(getenv FLOWHQ_WA_ALLOWLIST | tr ',;' '\n\n' | sed 's/[^0-9]//g' | grep . | grep -vxF -e "$ONLY" || true)"
  [ -z "$extra" ] || { say "REFUSED: the allowlist contains a number other than the authorized test number"; exit 1; }
  [ -n "$(getenv FLOWHQ_WA_ALLOWLIST)" ] || { say "REFUSED: the allowlist is empty"; exit 1; }
  only_active "$D4_ID" || { say "REFUSED: 4D is not the one active workflow"; exit 1; }
  st="$(docker exec -i -e SLUG="$CLINIC" "$FL" node - <<'EOF'
const h={Authorization:"Bearer "+process.env.GRIST_API_KEY},b=process.env.GRIST_BASE_URL;
(async()=>{const reg=await (await fetch(b+"/api/docs/"+process.env.GRIST_REGISTRY_DOC_ID+"/tables/Clinics/records",{headers:h})).json(); const id=reg.records.find(r=>r.fields.Clinic_Slug===process.env.SLUG).fields.Grist_Doc_ID;
const s=(await (await fetch(b+"/api/docs/"+id+"/tables/Settings/records",{headers:h})).json()).records; const v=k=>String((s.find(r=>r.fields.Key===k)||{fields:{}}).fields.Value||"").trim();
console.log("TEST_MODE="+v("TEST_MODE").toLowerCase()+" ai_mode="+v("ai_mode").toLowerCase()+" TEST_PHONE_digits="+v("TEST_PHONE").replace(/\D/g,""));})()
EOF
)"; say "   Grist settings: ${st/TEST_PHONE_digits=*/TEST_PHONE ok}"
  echo "$st" | grep -q 'TEST_MODE=true' || { say "REFUSED: Settings TEST_MODE is not TRUE"; exit 1; }
  echo "$st" | grep -qE 'ai_mode=(auto|draft)' || { say "REFUSED: Settings ai_mode is off"; exit 1; }
  echo "$st" | grep -q "TEST_PHONE_digits=.*$ONLY\$" || { say "REFUSED: TEST_PHONE is not the authorized test number"; exit 1; }
  ok "all interlocks hold: allowlist = the authorized number only, TEST_MODE on, send mode allowlist"
fi

umask 077; stamp="$(date +%Y%m%d-%H%M%S)"; BK="$HOME/backups/pre-ai-$stamp"; mkdir -p "$BK/plain"; export BP="$(getenv BACKUP_PASSPHRASE)"
say "no-downtime backup (clinic + registry documents through Grist's download API, encrypted, verified) and .env copy"
DL='const h={Authorization:"Bearer "+process.env.GRIST_API_KEY},b=process.env.GRIST_BASE_URL;(async()=>{let id=process.env.GRIST_REGISTRY_DOC_ID;if(process.env.WHICH==="clinic"){const reg=await (await fetch(b+"/api/docs/"+id+"/tables/Clinics/records",{headers:h})).json();id=reg.records.find(r=>r.fields.Clinic_Slug==="demo-clinic").fields.Grist_Doc_ID}const r=await fetch(b+"/api/docs/"+id+"/download",{headers:h});if(!r.ok){console.error("download "+r.status);process.exit(1)}process.stdout.write(Buffer.from(await r.arrayBuffer()))})().catch(e=>{console.error(e.message);process.exit(1)})'
docker exec -e WHICH=clinic "$FL" node -e "$DL" > "$BK/plain/clinic.grist" || { say "STOP: clinic backup failed"; exit 1; }
docker exec -e WHICH=registry "$FL" node -e "$DL" > "$BK/plain/registry.grist" || { say "STOP: registry backup failed"; exit 1; }
for f in clinic registry; do
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BP -in "$BK/plain/$f.grist" -out "$BK/$f-grist.enc" || { say "STOP: encryption failed"; exit 1; }
  a="$(sha256sum < "$BK/plain/$f.grist" | cut -d' ' -f1)"; b="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BP -in "$BK/$f-grist.enc" | sha256sum | cut -d' ' -f1)"
  [ "$a" = "$b" ] && say "   $f-grist.enc decrypts to the identical file" || { say "STOP: encrypted $f copy does not match"; exit 1; }
done
shred -u "$BK"/plain/*.grist; rmdir "$BK/plain"; cp -p .env "$BK/env.copy"; (cd "$BK" && sha256sum * > SHA256SUMS); chmod 600 "$BK"/*; say "   backup: $BK"
cp -p .env ".env.pre-ai-$stamp"

if [ "$mode" = on ]; then set_kv FLOWHQ_AI_EXTERNAL_ENABLED true; else set_kv FLOWHQ_AI_EXTERNAL_ENABLED false; fi
chmod 600 .env; docker compose "${F[@]}" config -q || { say "compose invalid: restoring .env"; cp -p ".env.pre-ai-$stamp" .env; exit 1; }
say "recreating ONLY n8n so it reads the change"; docker compose "${F[@]}" up -d --no-deps n8n 2>&1 | tail -2
wait_healthy n8n && ok "n8n healthy" || { bad "n8n not healthy: restoring .env and recreating"; cp -p ".env.pre-ai-$stamp" .env; docker compose "${F[@]}" up -d --no-deps n8n >/dev/null; exit 1; }
sleep 5
want=false; [ "$mode" = on ] && want=true
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_AI_EXTERNAL_ENABLED)" = "$want" ] && ok "n8n sees FLOWHQ_AI_EXTERNAL_ENABLED=$want" || bad "n8n does not see the new value"
only_active "$D4_ID" && ok "4D is still the one active workflow" || bad "active set changed"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)" = 12 ] && ok "AI reply limit still 12/hour" || bad "AI limit changed"
[ "$(docker exec "$(cid n8n)" printenv FLOWHQ_WA_SEND_MODE)" = allowlist ] && ok "send mode still allowlist" || bad "send mode changed"
if [ "$mode" = on ]; then c="$(docker exec "$(cid n8n)" sh -c 'wget -q -O /dev/null -T 10 --server-response https://openrouter.ai/api/v1/models 2>&1 | awk "/HTTP\\//{print \$2; exit}"')"; [ "$c" = 200 ] && ok "n8n can reach the AI provider (openrouter.ai answered 200; the API key itself is only proven by the first real reply)" || bad "cannot reach openrouter.ai from n8n (got '$c')"; fi
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_N8N/healthz")" = 200 ] && ok "public webhooks healthy" || bad "/healthz"
[ "$FAILS" = 0 ] || exit 1
[ "$mode" = on ] && say "EXTERNAL AI IS ON for the authorized test number only. To roll back: CONFIRM=yes $0 off" || say "EXTERNAL AI IS OFF."
