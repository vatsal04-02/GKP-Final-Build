#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into the running stack. This REPLACES the current n8n data, Grist documents and
# FlowHQ settings with the contents of the archive.
#   ./scripts/restore.sh backups/gkp-20261101-023000.tar.gz.enc            data only
#   ./scripts/restore.sh backups/gkp-....tar.gz.enc --with-config          also put back .env, flowhq/.env and users.json
# Needs BACKUP_PASSPHRASE (env or .env). On a brand-new server: run setup-server.sh, clone the repo, put the archive here, make a
# .env containing at least BACKUP_PASSPHRASE, start the stack once (./scripts/deploy.sh), then restore; use --with-config to
# bring back the original keys (the n8n encryption key must be the one the backup was made with, or saved credentials are unreadable).
set -euo pipefail
cd "$(dirname "$0")/.."
archive="${1:-}"; with_config=0
[ -n "$archive" ] && [ -f "$archive" ] || { echo "usage: $0 <backup.tar.gz.enc> [--with-config]"; exit 1; }
[ "${2:-}" = "--with-config" ] && with_config=1
get() { local v; v="$(printenv "$1" || true)"; if [ -z "$v" ] && [ -f .env ]; then v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//' || true)"; fi; printf '%s' "$v"; }
pass="$(get BACKUP_PASSPHRASE)"
[ -n "$pass" ] && [ "$pass" != "CHANGE_ME" ] || { echo "BACKUP_PASSPHRASE is not set"; exit 2; }

files=(-f docker-compose.yml)
[ -f flowhq/.env ] && [ -f flowhq/config/users.json ] && files+=(-f flowhq/deploy/docker-compose.flowhq.yml)
dc() { docker compose "${files[@]}" "$@"; }

umask 077
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
BP="$pass" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BP -in "$archive" | tar xz -C "$work" \
  || { echo "could not decrypt: wrong BACKUP_PASSPHRASE, or the file is damaged" >&2; exit 1; }
echo "Archive contains: $(cd "$work" && ls *.tgz | tr '\n' ' ')"
echo
echo "This will REPLACE the data of n8n, Grist and FlowHQ on this server with the backup."
read -r -p 'Type  restore  to continue: ' answer
[ "$answer" = "restore" ] || { echo "cancelled"; exit 1; }

dc up -d --no-start >/dev/null
dc stop >/dev/null 2>&1 || true
declare -A paths=( [n8n]=/home/node/.n8n [grist]=/persist [flowhq]=/app/flowhq/config )
for tgz in "$work"/*.tgz; do
  svc="$(basename "$tgz" .tgz)"; path="${paths[$svc]:-}"; [ -n "$path" ] || continue
  cid="$(dc ps -aq "$svc")"; [ -n "$cid" ] || { echo "  skipped $svc (not part of this stack)"; continue; }
  docker run --rm --volumes-from "$cid" -v "$work":/in:ro alpine sh -c "find '$path' -mindepth 1 -delete && tar xzf /in/$svc.tgz -C '$path'"
  echo "  restored $svc"
done
if [ "$with_config" = 1 ]; then
  [ -f "$work/config/env" ] && cp "$work/config/env" .env && chmod 600 .env && echo "  restored .env"
  [ -f "$work/config/flowhq.env" ] && cp "$work/config/flowhq.env" flowhq/.env && chmod 600 flowhq/.env && echo "  restored flowhq/.env"
  [ -f "$work/config/users.json" ] && cp "$work/config/users.json" flowhq/config/users.json && echo "  restored users.json"
fi
echo "Starting everything again..."
./scripts/deploy.sh --skip-dns
