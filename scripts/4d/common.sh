#!/usr/bin/env bash
# Shared helpers for the 4D cutover scripts (docs/n8n-4d-cutover.md). Source this; do not run it.
# Every script that CHANGES production calls need_confirm first: it refuses unless the owner's approval was given (CONFIRM=yes).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
F=(-f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml)
V4_ID=VaZ0abHwRICrx6C0                       # the workflow that is active today (SINGLE-MODEL V4 CRM BOOKING CANDIDATE)
D4_ID=F4dRetryd0c49396                       # the 4D candidate (its id is fixed in n8n/final/workflows/...candidate4d.json)
D4_FILE=n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4d.json
E4_ID=F4eNoQuietHrs001                       # the 4E candidate = 4D + no quiet hours for staff alerts and replies (n8n/final/tools/patch-4e-no-quiet-hours.js)
E4_FILE=n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidate4e.json
CLINIC=demo-clinic                          # Clinic_Slug of the production clinic in the Agency Registry
TOKEN_ID=n8n-whatsapp
SECRETS="$HOME/.4d-secrets"                  # mode 700; secrets live here only for the duration of the cutover, then are shredded
PUBLIC_N8N="https://$(grep -E '^N8N_DOMAIN=' .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//')"
PUBLIC_APP="https://$(grep -E '^FLOWHQ_DOMAIN=' .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//')"

cid() { docker compose "${F[@]}" ps -q "$1"; }
say() { printf '%s\n' "$*"; }
ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
FAILS=0
need_confirm() { [ "${CONFIRM:-}" = "yes" ] || { say "This step CHANGES production. Run it only after the owner's approval, as:  CONFIRM=yes $0"; exit 3; }; }
getenv() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | sed 's/[[:space:]]*$//' || true; }
healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(cid "$1")" 2>/dev/null)" = "healthy" ]; }
wait_healthy() { for _ in $(seq 1 40); do healthy "$1" && return 0; sleep 5; done; return 1; }
# "id|1" per workflow (1 = active), read through n8n's own export into a temp file inside the container (a read; nothing changes)
active_ids() { docker exec "$(cid n8n)" sh -c 'n8n export:workflow --all --output=/tmp/wf-ids.json >/dev/null 2>&1 && node -e "for (const w of JSON.parse(require(\"fs\").readFileSync(\"/tmp/wf-ids.json\",\"utf8\"))) console.log(w.id+\"|\"+(w.active?1:0))"; rm -f /tmp/wf-ids.json'; }
# NOTE: never `active_ids | grep -q`: grep -q exits early, the upstream docker exec then dies of SIGPIPE and `set -o pipefail` turns a true match into a failure.
# So the answer is captured first.
has_state() { local a; a="$(active_ids)"; printf '%s\n' "$a" | grep -qx "$1|$2"; }
is_active() { has_state "$1" 1; }
only_active() { local a; a="$(active_ids)"; [ "$(printf '%s\n' "$a" | grep -c '|1$')" = 1 ] && printf '%s\n' "$a" | grep -qx "$1|1"; }
# GET from inside the n8n container (the private Docker network); the token is read from stdin, never put on a command line
fhq_get() { docker exec -i "$(cid n8n)" sh -c 'read T; wget -qO- -T 10 --header="Authorization: Bearer $T" "http://flowhq:8787$1"' _ "$1" < "$SECRETS/booking-token"; }
fhq_status() { docker exec -i "$(cid n8n)" sh -c 'read T; wget -qO /dev/null -T 10 --server-response --header="Authorization: Bearer $T" "http://flowhq:8787$1" 2>&1 | awk "/HTTP\\//{print \$2; exit}"' _ "$1" < "$SECRETS/booking-token"; }
shred_file() { [ -f "$1" ] && { shred -u "$1" 2>/dev/null || rm -f "$1"; }; return 0; }
