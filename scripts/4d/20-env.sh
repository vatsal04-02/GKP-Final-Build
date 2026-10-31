#!/usr/bin/env bash
# STEP 20. The two environment changes, in the server's .env ONLY (never in git): AI reply limit 12, and the private booking API address.
# Everything else in .env is left exactly as it is. A copy of .env is kept as .env.pre-4d-<stamp> (mode 600) for the rollback.
# The running n8n does not see the change until it is recreated (step 60).
#   CONFIRM=yes ./scripts/4d/20-env.sh
. "$(dirname "$0")/common.sh"; need_confirm
umask 077; stamp="$(date +%Y%m%d-%H%M%S)"; cp -p .env ".env.pre-4d-$stamp"; chmod 600 ".env.pre-4d-$stamp"; say "saved .env.pre-4d-$stamp"
set_kv() { local k="$1" v="$2"; if grep -qE "^$k=" .env; then sed -i -E "s|^$k=.*|$k=$v|" .env; else printf '%s=%s\n' "$k" "$v" >> .env; fi; }
set_kv FLOWHQ_AI_MAX_REPLIES_PER_HOUR 12
set_kv FLOWHQ_BOOKING_API_URL http://flowhq:8787       # the PRIVATE Docker address of FLOW HQ: the public address blocks /api/booking/*
chmod 600 .env
[ "$(getenv FLOWHQ_AI_MAX_REPLIES_PER_HOUR)" = 12 ] && [ "$(getenv FLOWHQ_BOOKING_API_URL)" = "http://flowhq:8787" ] && say "FLOWHQ_AI_MAX_REPLIES_PER_HOUR=12, FLOWHQ_BOOKING_API_URL=http://flowhq:8787" || { say "the values did not stick: restoring"; cp -p ".env.pre-4d-$stamp" .env; exit 1; }
docker compose "${F[@]}" config -q && say "compose still valid" || { say "compose invalid: restoring"; cp -p ".env.pre-4d-$stamp" .env; exit 1; }
say "unchanged on purpose: FLOWHQ_WA_SEND_MODE=$(getenv FLOWHQ_WA_SEND_MODE), FLOWHQ_W2_IMPLIED_CONSENT=$(getenv FLOWHQ_W2_IMPLIED_CONSENT) (replies), FLOWHQ_AI_EXTERNAL_ENABLED=$(getenv FLOWHQ_AI_EXTERNAL_ENABLED)"
