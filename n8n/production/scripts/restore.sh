#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh.
#   scripts/restore.sh <archive.tar.gz.enc> [--target DIR] [--force] [--no-docker]
# It REFUSES to run while the services are up, and never overwrites existing data: with --force the existing data/, secrets/ and .env are moved to
# <name>.before-restore-<timestamp> first. After restoring, start the stack and run scripts/healthcheck.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
archive="${1:-}"; shift || true
target="."; force=0; docker_on=1
while [ $# -gt 0 ]; do case "$1" in --target) target="$2"; shift;; --force) force=1;; --no-docker) docker_on=0;; esac; shift; done
[ -f "$archive" ] || { echo "usage: scripts/restore.sh <archive.tar.gz.enc> [--target DIR] [--force] [--no-docker]" >&2; exit 2; }
pass="${BACKUP_PASSPHRASE:-}"
[ -n "$pass" ] || { echo "set BACKUP_PASSPHRASE (the passphrase used by backup.sh)" >&2; exit 2; }
if [ -f "$archive.sha256" ]; then ( cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256" >/dev/null ) || { echo "the checksum does not match: the file is damaged or was changed" >&2; exit 3; }; echo "checksum OK"; else echo "warning: no .sha256 next to the archive"; fi
if [ "$docker_on" = "1" ]; then
  running="$(docker compose -f ops/docker-compose.production.yml --env-file .env ps -q 2>/dev/null | wc -l || true)"
  [ "${running:-0}" -eq 0 ] || { echo "the services are running: stop them first (docker compose down)" >&2; exit 4; }
fi
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
BACKUP_PASSPHRASE="$pass" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$archive" -out "$work/archive.tar.gz" -pass env:BACKUP_PASSPHRASE || { echo "could not decrypt: wrong passphrase or a damaged file" >&2; exit 5; }
tar -tzf "$work/archive.tar.gz" >/dev/null || { echo "the archive is damaged" >&2; exit 5; }
mkdir -p "$target"
stamp="$(date +%Y%m%d-%H%M%S)"
for p in data secrets .env; do
  if [ -e "$target/$p" ]; then
    [ "$force" = "1" ] || { echo "$target/$p already exists: nothing was changed. Use --force to move it aside and restore." >&2; exit 6; }
  fi
done
for p in data secrets .env; do [ -e "$target/$p" ] && mv "$target/$p" "$target/$p.before-restore-$stamp"; done
umask 077
tar -xzf "$work/archive.tar.gz" -C "$target"
echo "restored into $target (the previous data, if any, is in *.before-restore-$stamp)."
echo "next: docker compose -f ops/docker-compose.production.yml --env-file .env up -d   then   scripts/healthcheck.sh"
