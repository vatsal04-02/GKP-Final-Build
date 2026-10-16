#!/usr/bin/env bash
# Is the stack alive? Exit 0 = everything answered, 1 = something did not. Prints no secret.
#   scripts/healthcheck.sh                 public webhook host + containers
#   scripts/healthcheck.sh --url http://127.0.0.1:5678    check one n8n URL (staging / local)
set -uo pipefail
cd "$(dirname "$0")/.."
url=""
[ "${1:-}" = "--url" ] && url="${2:-}"
get() { local v; v="$(printenv "$1" || true)"; if [ -z "$v" ] && [ -f .env ]; then v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' || true)"; fi; printf '%s' "$v"; }
bad=0
check() { if "$@" >/dev/null 2>&1; then echo "  ok   $LABEL"; else echo "  FAIL $LABEL"; bad=1; fi; }
if [ -z "$url" ]; then
  d="$(get N8N_DOMAIN)"; [ -n "$d" ] && url="https://$d"
fi
if [ -n "$url" ]; then
  LABEL="n8n answers $url/healthz"; check curl -fsS --max-time 10 "$url/healthz"
  LABEL="the n8n editor is NOT public ($url/rest/login)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/rest/login" || echo 000)"
  if [ "$code" = "404" ] || [ "$code" = "403" ] || [ "$code" = "000" ]; then echo "  ok   $LABEL (HTTP $code)"; else echo "  FAIL $LABEL (HTTP $code: the editor API answers on the public host)"; bad=1; fi
  LABEL="test webhooks are NOT public ($url/webhook-test/x)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$url/webhook-test/x" || echo 000)"
  if [ "$code" = "404" ] || [ "$code" = "403" ] || [ "$code" = "000" ]; then echo "  ok   $LABEL (HTTP $code)"; else echo "  FAIL $LABEL (HTTP $code)"; bad=1; fi
fi
if command -v docker >/dev/null 2>&1 && docker compose -f ops/docker-compose.production.yml --env-file .env ps >/dev/null 2>&1; then
  for s in n8n grist caddy; do
    LABEL="container $s is running and healthy"
    st="$(docker compose -f ops/docker-compose.production.yml --env-file .env ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$s" '$1==s {print $2" "$3}')"
    case "$st" in "running healthy"|"running ") echo "  ok   $LABEL";; *) echo "  FAIL $LABEL (${st:-not found})"; bad=1;; esac
  done
fi
[ "$bad" = "0" ] && echo "healthy" || echo "NOT healthy"
exit "$bad"
