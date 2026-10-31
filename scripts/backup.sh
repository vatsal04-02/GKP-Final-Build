#!/usr/bin/env bash
# Encrypted backup of everything that cannot be re-created: n8n's data (database, workflows, saved credentials), all Grist
# documents, FlowHQ's saved settings, and the .env files (which hold the keys that make the rest readable).
#   ./scripts/backup.sh
# n8n, Grist and FlowHQ are stopped for about 20 seconds so the copy is consistent, then started again.
# The archive is AES-256 encrypted with BACKUP_PASSPHRASE (set it in .env and ALSO keep it somewhere that is not this server).
# Output: BACKUP_DIR (default ./backups)/gkp-YYYYmmdd-HHMMSS.tar.gz.enc ; archives older than BACKUP_KEEP_DAYS (default 14) are deleted.
# COPY THE ARCHIVES OFF THE SERVER: a backup on the same disk does not survive losing the server (see docs/DEPLOY_HOSTINGER.md).
# Restore with ./scripts/restore.sh <archive>.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env here."; exit 1; }
get() { local v; v="$(printenv "$1" || true)"; if [ -z "$v" ]; then v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//' || true)"; fi; printf '%s' "$v"; }

pass="$(get BACKUP_PASSPHRASE)"; dir="$(get BACKUP_DIR)"; keep="$(get BACKUP_KEEP_DAYS)"
dir="${dir:-./backups}"; keep="${keep:-14}"
if [ -z "$pass" ] || [ "$pass" = "CHANGE_ME" ]; then echo "BACKUP_PASSPHRASE is not set in .env: refusing to write an unencrypted backup" >&2; exit 2; fi

files=(-f docker-compose.yml)
[ -f flowhq/.env ] && [ -f flowhq/config/users.json ] && files+=(-f flowhq/deploy/docker-compose.flowhq.yml)
dc() { docker compose "${files[@]}" "$@"; }

umask 077
mkdir -p "$dir"
stamp="$(date +%Y%m%d-%H%M%S)"
work="$(mktemp -d)"
stopped=0
restart() { if [ "$stopped" = 1 ]; then dc start n8n grist >/dev/null 2>&1 || true; dc start flowhq >/dev/null 2>&1 || true; echo "services started again"; stopped=0; fi; }
trap 'restart; rm -rf "$work"' EXIT

# service:path-inside-its-container (the named Docker volumes are read through --volumes-from, so no volume names are needed)
targets=("n8n:/home/node/.n8n" "grist:/persist")
[ -n "$(dc ps -aq flowhq 2>/dev/null)" ] && targets+=("flowhq:/app/flowhq/config")

dc stop n8n grist >/dev/null; dc stop flowhq >/dev/null 2>&1 || true; stopped=1
echo "services stopped for the copy"
for t in "${targets[@]}"; do
  svc="${t%%:*}"; path="${t#*:}"; cid="$(dc ps -aq "$svc")"
  [ -n "$cid" ] || { echo "service $svc has no container: is the stack running?" >&2; exit 1; }
  docker run --rm --volumes-from "$cid:ro" -v "$work":/out alpine sh -c "tar czf /out/$svc.tgz -C '$path' ."
  echo "  copied $svc"
done
mkdir -p "$work/config"
cp .env "$work/config/env"
[ -f flowhq/.env ] && cp flowhq/.env "$work/config/flowhq.env"
[ -f flowhq/config/users.json ] && cp flowhq/config/users.json "$work/config/users.json"
restart

out="$dir/gkp-$stamp.tar.gz.enc"
if ! tar czf - -C "$work" . | BP="$pass" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BP -out "$out"; then
  rm -f "$out"; echo "encryption failed" >&2; exit 1
fi
[ -s "$out" ] || { echo "encryption failed (empty archive)" >&2; exit 1; }
find "$dir" -name 'gkp-*.tar.gz.enc' -mtime +"$keep" -delete
echo "backup written: $out ($(du -h "$out" | cut -f1))"
echo "now copy it off the server, e.g. from your PC:  scp deploy@<server-ip>:$(pwd)/${out#./} ."
