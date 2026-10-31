#!/usr/bin/env bash
# Runs 97-ai-booking-api-test.js against PRODUCTION: one synthetic appointment through the central booking API (the same calls n8n makes), then cancelled.
# It refuses (and writes nothing) while the AI booking switch is OFF. The service token is read from the private file and passed on stdin, never on a command line.
#   CONFIRM=yes ./scripts/4d/97-ai-booking-api-test.sh
. "$(dirname "$0")/common.sh"; need_confirm
[ -s "$SECRETS/booking-token" ] || { say "no booking token file in $SECRETS"; exit 1; }
{ cat "$SECRETS/booking-token"; echo; cat "$(dirname "$0")/97-ai-booking-api-test.js"; } | docker exec -i "$(cid flowhq)" node -e '
const t = require("fs").readFileSync(0, "utf8"); const i = t.indexOf("\n"); global.TOKEN = t.slice(0, i).trim();
new Function("require", "TOKEN", t.slice(i + 1))(require, global.TOKEN);'
