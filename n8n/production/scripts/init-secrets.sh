#!/usr/bin/env bash
# Creates the data directories and the n8n encryption key file (once). Never overwrites an existing key. Prints no secret.
#   scripts/init-secrets.sh            production   (data/, secrets/n8n_encryption_key)
#   scripts/init-secrets.sh --staging  staging      (data-staging/, secrets/n8n_encryption_key.staging)
set -euo pipefail
cd "$(dirname "$0")/.."
suffix=""; data="data"
if [ "${1:-}" = "--staging" ]; then suffix=".staging"; data="data-staging"; fi
umask 077
mkdir -p secrets "$data/n8n" "$data/grist"
[ "$data" = "data" ] && mkdir -p data/caddy_data data/caddy_config
key="secrets/n8n_encryption_key$suffix"
if [ -s "$key" ]; then
  echo "kept the existing $key (never overwritten: n8n could not read its credentials with a new key)"
else
  openssl rand -hex 32 | tr -d '\n' > "$key"
  chmod 600 "$key"
  echo "created $key (64 hex characters). BACK IT UP NOW, separately from the server: without it every n8n credential is lost."
fi
# the n8n image runs as uid 1000
if [ "$(id -u)" = "0" ]; then chown -R 1000:1000 "$data/n8n"; else echo "note: run  sudo chown -R 1000:1000 $data/n8n  if n8n cannot write its data folder"; fi
chmod 700 secrets
echo "done"
