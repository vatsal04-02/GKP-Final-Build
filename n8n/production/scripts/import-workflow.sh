#!/usr/bin/env bash
# Imports clinic-autopilot-production.json into the running n8n container. The workflow stays INACTIVE (it is exported inactive and has its own id,
# FhqClinicProd001, so it cannot overwrite another workflow). Activate it by hand in the editor, or later: n8n publish:workflow --id=FhqClinicProd001 and restart n8n.
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:-clinic-autopilot-production.json}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
node scripts/preflight.js --workflow-only "$file"
c=(docker compose -f ops/docker-compose.production.yml --env-file .env)
"${c[@]}" cp "$file" n8n:/tmp/flowhq-workflow.json
"${c[@]}" exec -T n8n n8n import:workflow --input=/tmp/flowhq-workflow.json
"${c[@]}" exec -T n8n rm -f /tmp/flowhq-workflow.json
echo "imported (inactive). Next: credentials (scripts/create-credentials.js), scripts/migrate-grist.js, then the staging tests in DEPLOYMENT.md"
