#!/usr/bin/env bash
# STEP 40. Creates the TWO n8n credentials 4D needs that do not exist yet, with stable ids (the 4D workflow already references them):
#   FlowHQ Booking API       (id FhqCredBooking01)  Header Auth  Authorization: Bearer <the token from step 30>
#   FlowHQ W1 Webhook Auth   (id FhqCredW1Hook001)  Header Auth  X-Lead-Secret: <a NEW random secret made here>   <- the website-lead webhook; NEVER an OpenRouter/Grist key
# Existing credentials (Header Auth account 2 = Grist, WhatsApp Cloud API, OpenRouter API, Telegram, SMTP) are untouched; 4D already references them by their real ids.
# Secrets move only through files in $SECRETS (mode 600) and are shredded at the end. Nothing secret is printed.
#   CONFIRM=yes ./scripts/4d/40-credentials.sh
. "$(dirname "$0")/common.sh"; need_confirm
umask 077; [ -s "$SECRETS/booking-token" ] || { say "run step 30 first (no booking token file)"; exit 1; }
[ -s "$SECRETS/w1-webhook-secret" ] || { openssl rand -hex 32 > "$SECRETS/w1-webhook-secret"; chmod 600 "$SECRETS/w1-webhook-secret"; say "generated a new website-webhook secret in $SECRETS/w1-webhook-secret"; }
printf 'FLOWHQ_BOOKING_API_TOKEN=%s\nFLOWHQ_W1_WEBHOOK_SECRET=%s\n' "$(cat "$SECRETS/booking-token")" "$(cat "$SECRETS/w1-webhook-secret")" > "$SECRETS/cred.env"; chmod 600 "$SECRETS/cred.env"
docker run --rm -v "$PWD":/r:ro -v "$SECRETS":/s node:20-alpine node /r/n8n/production/scripts/create-credentials.js --env-file /s/cred.env --only FhqCredBooking01,FhqCredW1Hook001 --out /s/creds.import.json
docker cp "$SECRETS/creds.import.json" "$(cid n8n):/tmp/creds.import.json" >/dev/null
docker exec "$(cid n8n)" n8n import:credentials --input=/tmp/creds.import.json 2>&1 | grep -viE 'data|secret|token|password' || true
docker exec "$(cid n8n)" rm -f /tmp/creds.import.json
shred_file "$SECRETS/creds.import.json"; shred_file "$SECRETS/cred.env"
names="$(docker exec "$(cid n8n)" sh -c 'n8n export:credentials --all --output=/tmp/c.json >/dev/null 2>&1; node -e "for(const c of JSON.parse(require(\"fs\").readFileSync(\"/tmp/c.json\",\"utf8\"))) console.log(c.id+\"|\"+c.name)"; rm -f /tmp/c.json')"
echo "$names" | grep -qx 'FhqCredBooking01|FlowHQ Booking API' && ok "credential FlowHQ Booking API exists" || bad "FlowHQ Booking API missing"
echo "$names" | grep -qx 'FhqCredW1Hook001|FlowHQ W1 Webhook Auth' && ok "credential FlowHQ W1 Webhook Auth exists" || bad "FlowHQ W1 Webhook Auth missing"
[ "$FAILS" = 0 ] || exit 1
say
say "HUMAN STEP (owner): website lead intake will use the new secret once 4D is active (step 70). In Vercel set  N8N_WEBHOOK_SECRET  to the value of $SECRETS/w1-webhook-secret"
say "  (read it yourself on the server: cat $SECRETS/w1-webhook-secret; never paste it into chat or git), keep N8N_WEBHOOK_AUTH_HEADER=X-Lead-Secret, redeploy the website."
say "NEXT: ./scripts/4d/50-import.sh"
