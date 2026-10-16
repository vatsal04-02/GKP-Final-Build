# Clinic Autopilot — Starter Kit (Option B)

n8n + Grist + Caddy on one Hetzner server. Follow the steps in order.
**Tonight's goal:** both apps live on HTTPS and you can log in from your phone. About 2 hours.

> **No domain, no budget?** Start with **NO-DOMAIN MODE** right below (laptop + Tailscale, ₹0, ~45 min).
> Have a domain but no server? Use **FREE MODE**. Move to the server steps when the first clinic is about to go live.

---

## NO-DOMAIN MODE — laptop + Tailscale (₹0, easiest)

No domain, no server, no Google login setup. n8n gets a permanent public HTTPS address for
webhooks; Grist stays private to your team's own devices.

1. **Docker** on your laptop (Docker Desktop on Windows/Mac with WSL 2 on Windows; Docker Engine on Linux).
2. **Tailscale** (free): install it on your laptop and sign in. Install the Tailscale app on your
   phone and teammates' devices with the same account or invite them to your tailnet.
3. In the Tailscale admin console: **DNS → enable MagicDNS** and **HTTPS certificates**.
   The first `tailscale funnel` command will ask you to allow Funnel in your policy, so just click the link it prints.
4. Find your laptop's name: `tailscale status` → e.g. `vatsal-laptop.tail1234.ts.net`.
5. **Start it:**
   ```bash
   cp .env.example .env
   # set TS_HOSTNAME=vatsal-laptop.tail1234.ts.net and GRIST_ADMIN_EMAIL
   # on Docker Desktop, if Grist formulas show errors: GRIST_SANDBOX_FLAVOR=unsandboxed
   ./scripts/gen-secrets.sh                       # Windows: run in WSL or Git Bash
   docker compose -f docker-compose.nodomain.yml up -d
   tailscale funnel --bg 5678                      # n8n  -> public  https://<TS_HOSTNAME>
   tailscale serve  --bg --https=8443 8484         # Grist -> private https://<TS_HOSTNAME>:8443
   ```
6. **Check:**
   - `https://<TS_HOSTNAME>` opens n8n from your phone **on mobile data with Tailscale off**, so it's public. Create the owner account and turn on 2FA.
   - `https://<TS_HOSTNAME>:8443` opens Grist from your phone **with Tailscale on**, so it's private.
7. **WhatsApp for the demo:** in your Meta developer app use the free **test number** (it can message up
   to 5 phone numbers you verify). The webhook URL is `https://<TS_HOSTNAME>/webhook/wa`. No business verification is needed yet.

**Limits:** works only while the laptop is awake and online. Grist is single-user (everyone on your tailnet
is admin), so **never** run `tailscale funnel` on 8484. Before a real clinic goes live, move to a server
(steps below) where Grist gets Google login and a proper URL.

---

## FREE MODE — laptop + Cloudflare Tunnel (₹0, for building and demos)

Same apps, same workflows, same Grist template. Only the hosting differs, so nothing is wasted
when you move to a server later (copy the Docker volumes or re-import workflows + Grist docs).

1. **Docker** on your laptop: Docker Desktop (Windows/Mac) or Docker Engine (Linux). On Windows, turn on WSL 2.
2. **Cloudflare (free plan):** add your agency domain to Cloudflare and switch its nameservers at your registrar.
   Re-create your website's existing DNS records in Cloudflare first, so the site doesn't go down.
3. **Tunnel:** Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel (Cloudflared) → copy the token.
   Add two public hostnames on the tunnel:
   - `n8n.youragency.in` → `http://n8n:5678`
   - `crm.youragency.in` → `http://grist:8484`
4. **Google sign-in:** same as Step 6 below (redirect URI `https://crm.youragency.in/oauth2/callback`).
5. **Start it:**
   ```bash
   cp .env.example .env
   # fill domains, emails, Google id/secret, CLOUDFLARE_TUNNEL_TOKEN
   # on Docker Desktop also set GRIST_SANDBOX_FLAVOR=unsandboxed if Grist formulas error
   ./scripts/gen-secrets.sh          # on Windows run this inside WSL or Git Bash
   docker compose -f docker-compose.local.yml up -d
   ```
6. Open `https://n8n.youragency.in` and `https://crm.youragency.in` from your phone → done.

**Limits:** it only works while the laptop is on and online. Meta and Cal.com webhooks fail while it sleeps.
Good for weeks 1–3 (building + demos), **not** for a live clinic.

**When the first clinic signs:** move to an always-on server. Free/cheap options, in order:
Azure for Students ($100 credit, no card), Oracle Cloud Always Free (if you can get capacity),
or Hetzner CX23 (~₹500/mo) paid from the clinic's setup fee. Then follow the server steps below.

---

## TONIGHT (Day 0)

### Step 1 — Accounts (15 min)
- [ ] **Hetzner Cloud** account (needs a card). Verification can take a little while.
- [ ] **GitHub**: create a *private* repo `clinic-autopilot` and push this folder to it.
- [ ] **Google Cloud** project named `agency-crm-login` (for Grist sign-in; free).
- [ ] A password manager (Bitwarden is free) — every secret goes here.

### Step 2 — SSH key (5 min, on your laptop)
```bash
ssh-keygen -t ed25519 -C "you@youragency.in"
cat ~/.ssh/id_ed25519.pub     # copy this line
```

### Step 3 — Create the server (10 min)
Hetzner Console → Add Server:
- Location: Nuremberg/Falkenstein/Helsinki (CX plans are EU-only; ~150 ms from India is fine)
- Image: **Ubuntu 24.04** · Type: **CX23** (2 vCPU, 4 GB)
- SSH key: paste the line from Step 2 · Backups: **on**
- Note the server's IPv4 address.

### Step 4 — DNS (5 min, at your domain registrar)
Two A records → server IPv4:
- `n8n.youragency.in`
- `crm.youragency.in`

### Step 5 — Harden the server + install Docker (15 min)
```bash
scp scripts/setup-server.sh root@<SERVER_IP>:/root/
ssh root@<SERVER_IP> "bash /root/setup-server.sh"
# then, in a NEW terminal, confirm this works before closing the old one:
ssh deploy@<SERVER_IP>
```

### Step 6 — Google sign-in for Grist (15 min)
Google Cloud Console → *APIs & Services*:
1. **OAuth consent screen**: External, app name "YourAgency CRM", your support email. Scopes: `openid`, `email`, `profile` only.
2. While the app is in *Testing*, only listed **test users** can log in — add your team's Gmails now (and later each clinic's staff), or click **Publish app** (basic scopes don't need Google review).
3. **Credentials → Create OAuth client ID → Web application**
   - Authorised redirect URI: `https://crm.youragency.in/oauth2/callback`
4. Copy the Client ID and Client Secret.

### Step 7 — Start the stack (10 min, on the server as `deploy`)
```bash
git clone git@github.com:<you>/clinic-autopilot.git && cd clinic-autopilot
cp .env.example .env
nano .env                       # domains, emails, Google client id/secret
./scripts/gen-secrets.sh        # fills N8N_ENCRYPTION_KEY + GRIST_SESSION_SECRET
docker compose up -d
docker compose logs -f caddy    # wait for "certificate obtained" for both domains, then Ctrl+C
```
Save `N8N_ENCRYPTION_KEY` in your password manager **now**.

### Step 8 — First logins (10 min)
- [ ] `https://n8n.youragency.in` → create the owner account → Settings → turn on **2FA**
- [ ] `https://crm.youragency.in` → sign in with Google using `GRIST_ADMIN_EMAIL`
- [ ] Both open fine on your phone

### Step 9 — Safety nets (10 min)
- [ ] UptimeRobot (free): monitor `https://n8n.youragency.in/healthz` and `https://crm.youragency.in`
- [ ] Telegram: create a bot with @BotFather and a group "agency-alerts" (used by the n8n error workflow)

**Done tonight when:** both URLs load with a padlock, you're logged in to both, and backups are on.

---

## THIS WEEK — split the team

| Who | Task | Done when |
|---|---|---|
| Person A (infra / n8n) | Error workflow → Telegram. W0 nightly backup. Cal.com account + 2 event types. W1 website-lead workflow (use Claude Code with `CLAUDE.md`) | A test form submission creates a Lead in Grist and pings Telegram |
| Person B (Grist) | Build "Clinic CRM Template" from `grist/schema.md`: tables, 5 pages, access rules. Then copy it to "Demo Physio" and add 2 weeks of fake data | Reports page shows real-looking charts |
| Person C (sales prep) | Meta Business Manager + Meta developer app for the agency (verification takes days — start now). List 40–50 physio clinics from Google Maps in a sheet | Meta app exists; clinic list ready |

Monday onwards (clinic hours): Person C starts the mystery-shop — WhatsApp 20 clinics with a genuine-sounding enquiry and log reply times.

## Weeks 2–4
Follow the "Option B: Low-Code Clinic CRM Build Guide" doc, section 8: demo clinic → WhatsApp + AI → first paying clinic.

---

## Using Claude Code on this repo
Open the repo in Claude Code. Example first prompt:
> Read CLAUDE.md and grist/schema.md. Plan workflow W1 (website lead intake) for n8n as importable JSON:
> webhook → normalise phone → find lead in Grist by Phone → add or update → staff WhatsApp alert (stub for now) → Run_Log.
> List the nodes and the Grist API calls. Wait for my approval before writing the file.

## Files
| File | Purpose |
|---|---|
| `docker-compose.yml` | Caddy + n8n + Grist |
| `Caddyfile` | HTTPS for both domains |
| `.env.example` | All settings; copy to `.env` |
| `scripts/setup-server.sh` | One-time server hardening + Docker |
| `scripts/gen-secrets.sh` | Generates the two secrets |
| `grist/schema.md` | Exact tables, columns, pages, access rules |
| `n8n/snippets/normalize-phone.js` | Phone normaliser for n8n Code nodes (+ test) |
| `CLAUDE.md` | Rules Claude Code follows in this repo |

## Updating later
```bash
docker compose pull && docker compose up -d     # after pinning versions in .env
```
