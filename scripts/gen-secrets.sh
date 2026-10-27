#!/usr/bin/env bash
# Fills empty N8N_ENCRYPTION_KEY and GRIST_SESSION_SECRET in .env with random values.
# Run once from the repo root. Then copy N8N_ENCRYPTION_KEY into your password manager:
# if you lose it, every credential saved in n8n becomes unreadable.
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE found. Run: cp .env.example .env"; exit 1; }

fill() {
  local key="$1"
  if grep -qE "^${key}=$" "$ENV_FILE"; then
    local val
    val="$(openssl rand -hex 32)"
    sed -i "s|^${key}=$|${key}=${val}|" "$ENV_FILE"
    echo "Generated ${key}"
  else
    echo "${key} already set, leaving it alone"
  fi
}

fill N8N_ENCRYPTION_KEY
fill GRIST_SESSION_SECRET
chmod 600 "$ENV_FILE"
echo "Done. Save N8N_ENCRYPTION_KEY in your password manager now."
