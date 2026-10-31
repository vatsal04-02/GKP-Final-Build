#!/usr/bin/env bash
# One command to start (or update) the backend stack on the server: checks first, then starts, then waits until it is healthy.
#   ./scripts/deploy.sh            check, then start or update everything
#   ./scripts/deploy.sh --check    only run the checks; changes nothing
#   ./scripts/deploy.sh --skip-dns do not insist that the domains already point at this server (not recommended)
# Safe to run again at any time: it is also how you update after `git pull`. See docs/DEPLOY_HOSTINGER.md.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=0; SKIP_DNS=0
for a in "$@"; do case "$a" in --check) CHECK_ONLY=1;; --skip-dns) SKIP_DNS=1;; *) echo "unknown option: $a"; exit 2;; esac; done

bad=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; bad=1; }

[ -f .env ] || { echo "No .env here. Run: cp .env.example .env && ./scripts/gen-secrets.sh, then edit it."; exit 1; }
# Same reader as backup.sh: KEY=value, trailing "# comment" removed
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//' || true; }

echo "1. Settings in .env"
for k in N8N_DOMAIN N8N_ADMIN_DOMAIN GRIST_DOMAIN FLOWHQ_DOMAIN ACME_EMAIL GRIST_ADMIN_EMAIL GRIST_TEAM_NAME GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET N8N_ENCRYPTION_KEY GRIST_SESSION_SECRET BACKUP_PASSPHRASE; do
  v="$(get "$k")"
  if [ -z "$v" ]; then fail "$k is empty"
  elif echo "$v" | grep -qiE 'youragency\.in|^you@|CHANGE_ME|^PASTE_'; then fail "$k still has the placeholder value"
  else ok "$k"; fi
done
[ "$(stat -c %a .env)" = "600" ] && ok ".env is private (chmod 600)" || fail ".env is readable by others: run chmod 600 .env"
[ "$(get FLOWHQ_WA_SEND_MODE)" = "off" ] && ok "WhatsApp sending is OFF (FLOWHQ_WA_SEND_MODE=off)" || warn "FLOWHQ_WA_SEND_MODE is '$(get FLOWHQ_WA_SEND_MODE)': patients can be messaged. Keep it 'off' until the checklist is done."
[ "$(get FLOWHQ_AI_EXTERNAL_ENABLED)" = "true" ] && warn "External AI is ON (FLOWHQ_AI_EXTERNAL_ENABLED=true)" || ok "External AI is off"
extra="$(get N8N_EXTRA_WEBHOOK_PATH)"
[ -z "$extra" ] || warn "N8N_EXTRA_WEBHOOK_PATH=$extra: n8n's test webhooks are reachable from the internet. Empty it after the controlled test."
cidr="$(get ADMIN_ALLOW_CIDR)"
if [ -z "$cidr" ] || [ "$cidr" = "127.0.0.1/32" ]; then warn "ADMIN_ALLOW_CIDR is not set to your IP: nobody can open the n8n editor yet. Run ./scripts/allow-admin-ip.sh"; else ok "n8n editor is limited to: $cidr"; fi

echo "2. FlowHQ files"
files=(-f docker-compose.yml)
if [ -f flowhq/.env ] && [ -f flowhq/config/users.json ] && [ ! -d flowhq/config/users.json ]; then
  files+=(-f flowhq/deploy/docker-compose.flowhq.yml); ok "flowhq/.env and flowhq/config/users.json found: FlowHQ will be started"
  [ "$(stat -c %a flowhq/.env)" = "600" ] || fail "flowhq/.env is readable by others: run chmod 600 flowhq/.env"
  grep -qE '^GRIST_API_KEY=.+' flowhq/.env && ok "GRIST_API_KEY is set" || fail "GRIST_API_KEY is empty in flowhq/.env"
  grep -qE '^FLOWHQ_SESSION_SECRET=.{32,}' flowhq/.env && ok "FLOWHQ_SESSION_SECRET is set" || fail "FLOWHQ_SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)"
else
  if [ -d flowhq/config/users.json ]; then fail "flowhq/config/users.json is a DIRECTORY (Docker made it because the file was missing). Remove it: rmdir flowhq/config/users.json, then create the file"; fi
  warn "FlowHQ is not configured yet (flowhq/.env and flowhq/config/users.json): only n8n and Grist will start"
fi

echo "3. DNS: every address must already point at this server"
my_ip="$(curl -4 -fsS -m 8 https://ifconfig.me 2>/dev/null || curl -4 -fsS -m 8 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$my_ip" ]; then warn "could not look up this server's public IP; skipping the DNS comparison"
else
  for k in N8N_DOMAIN N8N_ADMIN_DOMAIN GRIST_DOMAIN FLOWHQ_DOMAIN; do
    d="$(get "$k")"; [ -n "$d" ] || continue
    got="$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ "$got" = "$my_ip" ]; then ok "$d -> $got"
    elif [ "$SKIP_DNS" = 1 ]; then warn "$d resolves to '${got:-nothing}', this server is $my_ip (--skip-dns)"
    else fail "$d resolves to '${got:-nothing}' but this server is $my_ip: create the DNS A record and wait a few minutes (Let's Encrypt must reach this server)"; fi
  done
fi

echo "4. Docker"
command -v docker >/dev/null || { fail "Docker is not installed (run scripts/setup-server.sh first)"; }
if command -v docker >/dev/null; then
  if docker compose "${files[@]}" config -q 2>/dev/null; then ok "compose files are valid"; else fail "docker compose config failed: run it by hand to see why"; fi
  if docker compose "${files[@]}" run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then ok "Caddyfile is valid"; else fail "Caddyfile did not validate: docker compose ${files[*]} run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile"; fi
  swap="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"; [ "${swap:-0}" -gt 0 ] && ok "swap is on" || warn "no swap: run scripts/setup-server.sh (adds 2 GB) so a memory spike cannot kill n8n"
fi

if [ "$bad" = 1 ]; then echo; echo "Fix the FAIL lines above, then run this again. Nothing was started."; exit 1; fi
[ "$CHECK_ONLY" = 1 ] && { echo; echo "All checks passed. (--check: nothing was started.)"; exit 0; }

echo; echo "Starting (the first run downloads images and builds FlowHQ: a few minutes)..."
docker compose "${files[@]}" up -d --build

echo "Waiting for n8n and Grist to report healthy (up to 3 minutes)..."
healthy() { local cid; cid="$(docker compose "${files[@]}" ps -q "$1")"; [ -n "$cid" ] && [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")" = "healthy" ]; }
for i in $(seq 1 36); do
  if healthy n8n && healthy grist; then break; fi; sleep 5
done
healthy n8n  && ok "n8n is healthy"  || fail "n8n is not healthy yet: docker compose logs --tail 80 n8n"
healthy grist && ok "Grist is healthy" || fail "Grist is not healthy yet: docker compose logs --tail 80 grist"
docker compose "${files[@]}" ps

echo
echo "Addresses:"
echo "  Webhooks (public)   https://$(get N8N_DOMAIN)/healthz   should answer: ok"
echo "  n8n editor          https://$(get N8N_ADMIN_DOMAIN)       (only from $cidr)"
echo "  Grist (CRM)         https://$(get GRIST_DOMAIN)"
[ "${#files[@]}" -gt 2 ] && echo "  FlowHQ (staff app)  https://$(get FLOWHQ_DOMAIN)"
echo
echo "First visit to each address can take a minute while the certificate is issued."
[ "$bad" = 1 ] && exit 1 || exit 0
