#!/usr/bin/env bash
# STEP 10. Fresh encrypted backup before the cutover: all volumes + env files (scripts/backup.sh: n8n, Grist and FLOW HQ are stopped for about a minute),
# an encrypted export of every n8n workflow (V4 included), and a rollback tag on the running FLOW HQ image. Verifies the workflow export decrypts.
#   CONFIRM=yes ./scripts/4d/10-backup.sh
. "$(dirname "$0")/common.sh"; need_confirm
pass="$(getenv BACKUP_PASSPHRASE)"; [ -n "$pass" ] && [ "$pass" != CHANGE_ME ] || { say "BACKUP_PASSPHRASE is not set in .env"; exit 2; }
stamp="$(date +%Y%m%d-%H%M%S)"; out="$HOME/backups/4d-cutover-$stamp"; umask 077; mkdir -p "$out"
say "1/4 workflow export (read) -> encrypted file"
docker exec "$(cid n8n)" sh -c 'n8n export:workflow --all --output=/tmp/wf-all.json >/dev/null 2>&1; ls -l /tmp/wf-all.json | awk "{print \"   exported \"\$5\" bytes\"}"'
docker cp "$(cid n8n):/tmp/wf-all.json" "$out/wf-all.json" >/dev/null; docker exec "$(cid n8n)" rm -f /tmp/wf-all.json
BP="$pass" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BP -in "$out/wf-all.json" -out "$out/n8n-workflows.json.enc"
a="$(sha256sum < "$out/wf-all.json" | cut -d' ' -f1)"; b="$(BP="$pass" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BP -in "$out/n8n-workflows.json.enc" | sha256sum | cut -d' ' -f1)"
[ "$a" = "$b" ] && say "   the encrypted export decrypts to the identical file" || { say "   ENCRYPTED EXPORT MISMATCH: stop"; shred_file "$out/wf-all.json"; exit 1; }
shred_file "$out/wf-all.json"
say "2/4 tag the running FLOW HQ image for rollback"; docker tag "$(docker inspect -f '{{.Image}}' "$(cid flowhq)")" "gkp-final-build-flowhq:rollback-4d-$(date +%Y%m%d)" && docker image ls gkp-final-build-flowhq --format '   {{.Repository}}:{{.Tag}} {{.ID}}' | head -5
say "3/4 full volume + env backup (scripts/backup.sh)"; BACKUP_DIR="$out" ./scripts/backup.sh | sed 's/^/   /'
say "4/4 checksums"; (cd "$out" && sha256sum *.enc > SHA256SUMS && cat SHA256SUMS | sed 's/^/   /' && sha256sum -c SHA256SUMS >/dev/null && say "   all checksums verify")
chmod 600 "$out"/*; say "BACKUP DONE: $out   (copy it off the server: scp -r deploy@<server>:backups/4d-cutover-$stamp .)"
