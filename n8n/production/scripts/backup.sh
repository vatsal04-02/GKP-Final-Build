#!/usr/bin/env bash
# Encrypted backup of everything that cannot be re-created: n8n data (database + settings), Grist data (all clinic documents), the n8n encryption key, .env.
#   scripts/backup.sh                 stops n8n and Grist for a few seconds (a consistent copy), archives, encrypts, starts them again
#   scripts/backup.sh --online        does not stop anything (SQLite files may be copied mid-write: use only if you accept that)
#   scripts/backup.sh --no-docker     no docker commands (tests, or services already stopped)
# Needs BACKUP_PASSPHRASE (env or .env); BACKUP_DIR (default ./backups); BACKUP_KEEP_DAYS (default 14). The archive is AES-256 encrypted; keep the passphrase OFF the server.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="consistent"; docker_on=1
for a in "$@"; do case "$a" in --online) mode="online";; --no-docker) docker_on=0;; esac; done
get() { local v; v="$(printenv "$1" || true)"; if [ -z "$v" ] && [ -f .env ]; then v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' || true)"; fi; printf '%s' "$v"; }
pass="$(get BACKUP_PASSPHRASE)"; dir="$(get BACKUP_DIR)"; keep="$(get BACKUP_KEEP_DAYS)"
dir="${dir:-./backups}"; keep="${keep:-14}"
if [ -z "$pass" ] || [ "$pass" = "CHANGE_ME" ]; then echo "BACKUP_PASSPHRASE is not set: refusing to write an unencrypted backup" >&2; exit 2; fi
compose=(docker compose -f ops/docker-compose.production.yml --env-file .env)
umask 077
mkdir -p "$dir"
stamp="$(date +%Y%m%d-%H%M%S)"
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
stopped=0
restart() { if [ "$stopped" = "1" ]; then "${compose[@]}" start n8n grist >/dev/null && echo "services started again"; stopped=0; fi; }
trap 'restart; cleanup' EXIT
if [ "$docker_on" = "1" ] && [ "$mode" = "consistent" ]; then "${compose[@]}" stop n8n grist >/dev/null; stopped=1; echo "n8n and Grist stopped for the copy"; fi
if [ "$docker_on" = "1" ]; then ( "${compose[@]}" exec -T n8n n8n export:workflow --all --output=/tmp/workflows-export.json >/dev/null 2>&1 && "${compose[@]}" cp n8n:/tmp/workflows-export.json "$work/workflows-export.json" ) || echo "note: the workflow export was skipped (n8n is stopped or not running); the data folder contains the workflows anyway"; fi
items=()
for p in data/n8n data/grist secrets .env; do [ -e "$p" ] && items+=("$p"); done
if [ "${#items[@]}" -eq 0 ]; then echo "nothing to back up (no data/, secrets/ or .env here)" >&2; exit 3; fi
[ -f "$work/workflows-export.json" ] && cp "$work/workflows-export.json" ./workflows-export.backup.json && items+=(workflows-export.backup.json)
tar -czf "$work/archive.tar.gz" "${items[@]}"
rm -f ./workflows-export.backup.json
out="$dir/flowhq-$stamp.tar.gz.enc"
BACKUP_PASSPHRASE="$pass" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$work/archive.tar.gz" -out "$out" -pass env:BACKUP_PASSPHRASE
chmod 600 "$out"
( cd "$dir" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
restart
find "$dir" -name 'flowhq-*.tar.gz.enc*' -mtime +"$keep" -delete 2>/dev/null || true
echo "backup written: $out ($(wc -c < "$out") bytes) + .sha256. Copy it off the server. Test a restore at least once a quarter (scripts/restore.sh)."
