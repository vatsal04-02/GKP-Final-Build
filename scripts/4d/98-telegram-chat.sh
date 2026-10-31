#!/usr/bin/env bash
# Finds the Telegram chat id for n8n failure alerts (W11) and sets FLOWHQ_TELEGRAM_CHAT_ID. Uses the bot credential that already exists in n8n ("Telegram account");
# the bot token is decrypted inside the n8n container for the call and is never printed or written anywhere.
# Before running: the person who should receive the alerts opens the bot in Telegram, presses Start and sends it any message
# (for a group: add the bot to the group and send a message there).
#   ./scripts/4d/98-telegram-chat.sh              shows the chats that have written to the bot (changes nothing)
#   CONFIRM=yes ./scripts/4d/98-telegram-chat.sh  sets the id (only if exactly ONE chat wrote), recreates n8n, sends one test alert to that chat
. "$(dirname "$0")/common.sh"
JS="$(mktemp)"; trap 'rm -f "$JS"' EXIT
cat > "$JS" <<'EOF'
const fs = require("fs"); const { execSync } = require("child_process");
execSync("n8n export:credentials --id=NzFVBwmYZTH1K6L8 --decrypted --output=/tmp/tg-cred.json", { stdio: "ignore" });
const c = JSON.parse(fs.readFileSync("/tmp/tg-cred.json", "utf8"))[0]; fs.unlinkSync("/tmp/tg-cred.json");
const tok = c.data.accessToken; const base = (c.data.baseUrl || "https://api.telegram.org").replace(/\/+$/, "");
const send = process.argv[2] === "send" ? process.argv[3] : "";
(async () => {
  if (send) { const r = await (await fetch(`${base}/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: send, text: "GKP alerts: this chat will now receive n8n workflow failure alerts (test message)." }) })).json(); console.log(r.ok ? "TEST SENT" : "TEST FAILED " + r.description); return; }
  const up = await (await fetch(`${base}/bot${tok}/getUpdates?limit=100`)).json();
  const chats = new Map();
  for (const u of up.result || []) { const m = u.message || u.edited_message || (u.my_chat_member && { chat: u.my_chat_member.chat }); if (m && m.chat) chats.set(m.chat.id, `${m.chat.type} | ${m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ")}`); }
  for (const [id, d] of chats) console.log(`CHAT ${id} | ${d}`);
  if (!chats.size) console.log("NO CHAT: nobody has written to the bot yet");
})().catch((e) => console.log("ERR " + e.message));
EOF
runjs() { local c; c="$(cid n8n)"; docker cp "$JS" "$c:/tmp/tg-chat.js" >/dev/null; docker exec "$c" node /tmp/tg-chat.js "$@" </dev/null 2>&1 || true; docker exec "$c" rm -f /tmp/tg-chat.js >/dev/null 2>&1 || true; }
out="$(runjs)"; echo "$out"
n="$(echo "$out" | grep -c '^CHAT ' || true)"
[ "${CONFIRM:-}" = "yes" ] || { say "(nothing changed; to set it: CONFIRM=yes $0)"; exit 0; }
[ "$n" = 1 ] || { say "need exactly ONE chat (found $n): nothing changed"; exit 1; }
id="$(echo "$out" | sed -n 's/^CHAT \(-\{0,1\}[0-9]*\) |.*/\1/p')"
cp -p .env ".env.pre-telegram-$(date +%Y%m%d-%H%M%S)"
if grep -q '^FLOWHQ_TELEGRAM_CHAT_ID=' .env; then sed -i "s|^FLOWHQ_TELEGRAM_CHAT_ID=.*|FLOWHQ_TELEGRAM_CHAT_ID=$id|" .env; else echo "FLOWHQ_TELEGRAM_CHAT_ID=$id" >> .env; fi
chmod 600 .env; say "FLOWHQ_TELEGRAM_CHAT_ID set"
docker compose "${F[@]}" up -d --no-deps n8n >/dev/null; wait_healthy n8n && ok "n8n recreated and healthy" || bad "n8n not healthy"
runjs send "$id"
