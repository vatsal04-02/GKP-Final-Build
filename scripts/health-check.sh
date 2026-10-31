#!/usr/bin/env bash
# External health check for the GKP production domains. Read-only: GET requests only, nothing is written anywhere, no secrets are used.
# Run it from ANY machine (an uptime service's "cron + curl", a laptop, the VPS). Exit 0 = everything fine, 1 = something to look at.
#   ./scripts/health-check.sh                # human-readable
#   QUIET=1 ./scripts/health-check.sh        # prints only failures (for cron mail)
# Override the domains with ROOT_DOMAIN=example.in ./scripts/health-check.sh
set -u
D="${ROOT_DOMAIN:-geetakrishnaphysiotherapy.co.in}"
fail=0; T=20
say() { [ -n "${QUIET:-}" ] || echo "$@"; }
bad() { echo "FAIL  $*"; fail=1; }
ok()  { say "ok    $*"; }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$T" "$@" 2>/dev/null || echo 000; }

# 1. public website (Vercel)
c=$(code "https://$D/");               [ "$c" = 200 ] && ok "website $c" || bad "website https://$D/ answered $c (expected 200)"
c=$(code "https://www.$D/");           [ "$c" = 308 ] || [ "$c" = 301 ] || [ "$c" = 200 ] && ok "www $c" || bad "www answered $c"

# 2. FLOW HQ: must be up AND the audit outbox ok (the status code stays 200 on an outbox problem on purpose: read the field)
h=$(curl -s --max-time "$T" "https://app.$D/api/health" 2>/dev/null || true)
case "$h" in
  *'"ok":true'*'"audit_outbox":"ok"'*) ok "FLOW HQ health ok, audit_outbox ok" ;;
  *'"audit_outbox":"amber"'*)          bad "FLOW HQ audit_outbox is AMBER (investigate if it lasts 15 minutes): $h" ;;
  *'"audit_outbox":"red"'*)            bad "FLOW HQ audit_outbox is RED (bookings are refused): $h" ;;
  *)                                   bad "FLOW HQ health unreadable or not ok: ${h:0:200}" ;;
esac

# 3. n8n webhook path
b=$(curl -s --max-time "$T" "https://n8n.$D/healthz" 2>/dev/null || true)
[ "$b" = "ok" ] || echo "$b" | grep -q '"status":"ok"' && ok "n8n /healthz" || bad "n8n healthz answered '${b:0:80}'"

# 4. Grist sign-in page reachable (redirects to the document or the login)
c=$(code "https://crm.$D/");           case "$c" in 200|301|302|303|307|308) ok "Grist $c" ;; *) bad "Grist answered $c" ;; esac

# 5. things that must NOT be public (a change here means a security setting was lost)
c=$(code "https://app.$D/api/booking/config");          [ "$c" = 404 ] && ok "booking API not published (404)" || bad "booking API answered $c on the public domain (expected 404)"
c=$(code "https://n8n.$D/rest/login");                  [ "$c" = 404 ] && ok "n8n /rest not published (404)" || bad "n8n /rest/login answered $c (expected 404)"
c=$(code "https://n8n.$D/webhook-test/x");              [ "$c" = 404 ] && ok "n8n /webhook-test not published (404)" || bad "n8n /webhook-test answered $c (expected 404)"
c=$(code "https://app.$D/api/overview");                [ "$c" = 401 ] && ok "staff API needs a login (401)" || bad "staff API answered $c without a login (expected 401)"

# 6. TLS certificate lifetime on the VPS-served hosts (warn under 14 days)
if command -v openssl >/dev/null 2>&1; then
  for host in "app.$D" "n8n.$D" "crm.$D"; do
    end=$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -n "$end" ] || { bad "no certificate read for $host"; continue; }
    left=$(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
    [ "$left" -ge 14 ] && ok "certificate $host: $left days left" || bad "certificate $host: only $left days left"
  done
fi

[ "$fail" = 0 ] && say "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
