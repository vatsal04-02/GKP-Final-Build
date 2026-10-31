#!/usr/bin/env bash
# Local uptime monitor, run by cron every 5 minutes (scripts/install-monitor-cron.sh). Read-only: it runs scripts/health-check.sh and
#   * logs every state change to backups/monitor.log,
#   * after 2 failed checks in a row (about 10 minutes) sends ONE Telegram alert, and ONE message when everything is fine again.
# Telegram: the bot credential that already exists in n8n ("Telegram account", decrypted inside the n8n container for the call, never printed) and
# FLOWHQ_TELEGRAM_CHAT_ID from .env. Without a chat id it only logs (set the id with scripts/4d/98-telegram-chat.sh).
# Limit: it runs ON the VPS, so it cannot report that the VPS itself is down. Add an external monitor as well (docs/monitoring-and-alerts.md).
cd "$(dirname "$0")/.." || exit 1
mkdir -p backups
STATE=backups/.monitor-state; LOG=backups/monitor.log
prev_state=up; prev_fails=0
[ -f "$STATE" ] && read -r prev_state prev_fails < "$STATE"
out="$(QUIET=1 ./scripts/health-check.sh 2>&1)"; rc=$?
stamp="$(date '+%Y-%m-%d %H:%M:%S')"

telegram() {
  local chat c; chat="$(grep -E '^FLOWHQ_TELEGRAM_CHAT_ID=' .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//;s/[[:space:]]*$//')"
  [ -n "$chat" ] || return 0
  c="$(docker ps -q --filter name=n8n-1 | head -1)"; [ -n "$c" ] || return 0
  printf '%s' "$1" | docker exec -i -e CHAT="$chat" "$c" sh -c 'cat > /tmp/mon-msg.txt; n8n export:credentials --id=NzFVBwmYZTH1K6L8 --decrypted --output=/tmp/mon-cred.json >/dev/null 2>&1; node -e "
const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"/tmp/mon-cred.json\",\"utf8\"))[0];fs.unlinkSync(\"/tmp/mon-cred.json\");
const t=c.data.accessToken;const b=(c.data.baseUrl||\"https://api.telegram.org\").replace(/\/+$/,\"\");
fetch(b+\"/bot\"+t+\"/sendMessage\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({chat_id:process.env.CHAT,text:fs.readFileSync(\"/tmp/mon-msg.txt\",\"utf8\")})}).then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"; rm -f /tmp/mon-msg.txt /tmp/mon-cred.json' >/dev/null 2>&1
}

if [ "$rc" = 0 ]; then
  [ "$prev_state" = down ] && { echo "$stamp RECOVERED" >> "$LOG"; telegram "GKP monitor: everything is healthy again ($stamp)."; }
  echo "up 0" > "$STATE"
else
  fails=$((prev_fails + 1))
  if [ "$fails" = 1 ]; then echo "$stamp FAIL (1st): $(echo "$out" | tr '\n' ' ' | cut -c1-300)" >> "$LOG"; fi
  if [ "$fails" = 2 ] && [ "$prev_state" != down ]; then
    echo "$stamp DOWN: $(echo "$out" | tr '\n' ' ' | cut -c1-300)" >> "$LOG"
    telegram "GKP monitor ALERT ($stamp): $(echo "$out" | head -5 | cut -c1-160 | tr '\n' ';')"
    echo "down $fails" > "$STATE"
  elif [ "$fails" -ge 2 ]; then echo "down $fails" > "$STATE"
  else echo "$prev_state $fails" > "$STATE"; fi
fi
exit 0
