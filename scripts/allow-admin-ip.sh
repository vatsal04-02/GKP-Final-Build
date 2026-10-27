#!/usr/bin/env bash
# Chooses who may open the n8n editor (the N8N_ADMIN_DOMAIN address). Everyone else gets "403 Forbidden".
#   ./scripts/allow-admin-ip.sh                       use the address you are connected from over SSH (easiest)
#   ./scripts/allow-admin-ip.sh 203.0.113.7           one address
#   ./scripts/allow-admin-ip.sh 203.0.113.7 198.51.100.4/32   several
# Home internet addresses change now and then: if the editor suddenly says 403, SSH in and run this again.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env here."; exit 1; }

ips=("$@")
if [ ${#ips[@]} -eq 0 ]; then
  [ -n "${SSH_CLIENT:-}" ] || { echo "Not on an SSH session: pass the address, e.g. ./scripts/allow-admin-ip.sh 203.0.113.7"; exit 1; }
  ips=("${SSH_CLIENT%% *}")
  echo "Using the address you are connected from: ${ips[0]}"
fi

out=()
for ip in "${ips[@]}"; do
  [[ "$ip" == */* ]] || ip="$ip/32"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || { echo "Not an IPv4 address: $ip (IPv6 clients are not supported here)"; exit 1; }
  [ "$ip" != "0.0.0.0/0" ] && [[ "$ip" != 0.* ]] || { echo "Refusing $ip: that would open the editor to the whole internet."; exit 1; }
  out+=("$ip")
done
value="${out[*]}"

if grep -qE '^ADMIN_ALLOW_CIDR=' .env; then sed -i "s|^ADMIN_ALLOW_CIDR=.*|ADMIN_ALLOW_CIDR=${value}|" .env; else echo "ADMIN_ALLOW_CIDR=${value}" >> .env; fi
chmod 600 .env
echo "ADMIN_ALLOW_CIDR=${value}"
docker compose up -d caddy >/dev/null
echo "Done: the n8n editor is now open to ${value} only."
