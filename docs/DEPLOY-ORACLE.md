# Deploy on an Oracle Cloud Always Free server

This puts the whole stack (Caddy for HTTPS, n8n, Grist, FLOW HQ) on one free Oracle server. It uses the files already in the repo, plus `scripts/oracle-setup.sh` and `flowhq/deploy/Caddyfile`.

**You need:** an Oracle Cloud account (a card is needed to verify it; Always Free resources are not charged), a Google account for Grist sign-in, and about 90 minutes.

## What to know first

- **Pick the ARM server** ("Ampere A1", shape `VM.Standard.A1.Flex`, 2 OCPU and 12 GB is plenty). The small AMD server (`E2.1.Micro`, 1 GB) can run it only barely; builds are slow and may fail. The setup script adds swap for it.
- **ARM capacity can be "out of capacity"** in some regions. Retry later or at another hour. The home region cannot be changed after sign-up.
- **Idle servers can be reclaimed.** Oracle may stop Always Free servers that sit nearly idle for 7 days. A clinic stack with real traffic is usually fine. Upgrading the account to "Pay As You Go" (still free within the Always Free limits) removes the risk.
- **The Grist formula sandbox (gvisor) may not run on ARM.** If Grist formulas error after start, set `GRIST_SANDBOX_FLAVOR=unsandboxed` in `.env`. That is acceptable only because you trust everyone who edits the documents.
- **Patient data:** this app stores patient records. Have the privacy and hosting position reviewed before real patients are entered (see `flowhq/README.md`, section L).

## 1. Create the server

1. Oracle Cloud console, **Compute, Instances, Create instance**.
2. **Image:** Canonical Ubuntu 24.04 (the aarch64 build when you choose ARM). **Shape:** Ampere, 2 OCPU, 12 GB.
3. **Networking:** keep the defaults (new virtual cloud network, public subnet, assign a public IPv4).
4. **SSH keys:** choose **Generate a key pair** and download the private key (or paste your own public key). Keep the file safe.
5. Create. When it is running, copy the **public IP**.
6. Make the IP permanent: **Networking, Reserved public IPs**, create one and attach it to the instance's VNIC. Otherwise the IP can change when the server is stopped.

## 2. Log in and prepare the server

From your computer (PowerShell; use the key file you downloaded):

```powershell
ssh -i C:\path\to\ssh-key.key ubuntu@<PUBLIC_IP>
```

On the server:

```bash
git clone --branch feat/ui-polish https://github.com/vatsal04-02/GKP-Final-Build.git
cd GKP-Final-Build
bash scripts/oracle-setup.sh
exit        # log out and back in once so the docker group applies
```

If the repository is private, GitHub asks for a username and a personal access token (read-only, "Contents: read") instead of a password. Once the branch is merged into `main`, use `--branch main`.

## 3. Open ports 80 and 443 in Oracle's cloud firewall

The script opened them on the server; Oracle has a second firewall outside it.

**Networking, Virtual cloud networks, your VCN, Security Lists, Default Security List, Add ingress rules** (two rules):

| Source CIDR | Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Port 22 (SSH) is already open.

## 4. Choose three web addresses

Caddy gets a free HTTPS certificate for each, so each must point at the server's IP. You need three: one each for n8n, Grist and FLOW HQ.

- **Free, no domain (DuckDNS, recommended):** sign in at duckdns.org, create three names (for example `gkp-n8n`, `gkp-grist`, `gkp-hq`) and set each to the server's public IP. Your addresses are `gkp-n8n.duckdns.org` and so on.
- **Free, no sign-up (sslip.io):** the IP is part of the name, for example `n8n.129-146-10-20.sslip.io`, `grist.129-146-10-20.sslip.io`, `hq.129-146-10-20.sslip.io`. It works at once but the certificate service sometimes limits shared domains, so DuckDNS is more reliable.
- **Your own domain:** add three A records pointing at the IP.

Check from your computer before going on: `nslookup gkp-hq.duckdns.org` must show the server IP.

## 5. Google sign-in for Grist

Grist requires it in this stack (`docker-compose.yml`).

1. Google Cloud Console, **APIs and Services, Credentials, Create credentials, OAuth client ID**, type **Web application**.
2. **Authorised redirect URI:** `https://<your-grist-address>/oauth2/callback`
3. Copy the client ID and client secret.

## 6. Fill in the settings (on the server)

```bash
cd ~/GKP-Final-Build
cp .env.example .env
nano .env
```

Set these (leave the rest as they are):

```
N8N_DOMAIN=gkp-n8n.duckdns.org
GRIST_DOMAIN=gkp-grist.duckdns.org
FLOWHQ_DOMAIN=gkp-hq.duckdns.org
ACME_EMAIL=you@example.com
GRIST_ADMIN_EMAIL=you@gmail.com         # the Google account you will sign in with
GRIST_TEAM_NAME=gkp                      # lowercase, no spaces
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GRIST_SANDBOX_FLAVOR=gvisor              # change to unsandboxed only if formulas fail (see "What to know first")
```

Then make the two random secrets and **save N8N_ENCRYPTION_KEY in your password manager** (without it, every credential stored in n8n becomes unreadable):

```bash
bash scripts/gen-secrets.sh
```

## 7. Start n8n and Grist first

```bash
docker compose up -d
docker compose ps         # n8n, grist, caddy should be "running"
```

Open `https://<your-grist-address>`, sign in with Google. Then:

1. **Bring your data across.** On your laptop's Grist, open each document (the Agency Registry and the clinic document) and choose **Download, Grist (.grist)**. On the server's Grist, **Add new, Import document** and pick each file. This keeps tables, columns and rows.
2. Note the new **Agency Registry document id** (the part of its URL after `/doc/`). It differs from your laptop's.
3. **Profile settings, API, Create API key.** Keep it for the next step.
4. If you use the n8n workflows: open `https://<your-n8n-address>`, create the owner account, import the files from `n8n/workflows/` and re-enter credentials (`docs/INSTALL.md`, section 4). Webhook addresses at Meta and Cal.com must be changed to the new n8n address.

## 8. Configure FLOW HQ

On the server:

```bash
cp flowhq/.env.example flowhq/.env
nano flowhq/.env
```

Fill in `GRIST_API_KEY` (step 7.3), `GRIST_REGISTRY_DOC_ID` (step 7.2) and `FLOWHQ_SESSION_SECRET` (`openssl rand -base64 48`). Leave `FLOWHQ_DEMO=false`. Then `chmod 600 flowhq/.env`.

The sign-in users file is not in git. Copy it from your computer (PowerShell, from the repo folder):

```powershell
scp -i C:\path\to\ssh-key.key flowhq\config\users.json ubuntu@<PUBLIC_IP>:GKP-Final-Build/flowhq/config/users.json
```

To make a new password instead, run `npm run hash-password -- "a long password"` in the `flowhq` folder on your computer and paste the result into `users.json`.

`flowhq/config/clinic.json` (letterhead, doctors, invoice rules) is already in git.

## 9. Start everything with FLOW HQ

```bash
docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --build
docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml ps
```

The first build takes a few minutes. Then open `https://<your-flowhq-address>` and sign in. Check `https://<your-flowhq-address>/api/health`: it must say `"demo":false` and a workspace count above 0.

If the Clinic Records tables are missing in the server's Grist (they are included when you import the clinic document from your laptop), create them as described in `flowhq/README.md`, section L.

## 10. Run it every day

**Update after you push changes:**

```bash
cd ~/GKP-Final-Build && git pull
docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --build
```

**Logs:** `docker compose logs -f flowhq` (or `n8n`, `grist`, `caddy`).

**Backups:** the data lives in Docker volumes (`grist_data`, `n8n_data`, `flowhq_config`, `caddy_data`). Take a copy at least weekly, and keep one off the server:

```bash
mkdir -p ~/backups
for v in grist_data n8n_data flowhq_config; do
  docker run --rm -v gkp-final-build_$v:/d -v ~/backups:/b alpine tar czf /b/$v-$(date +%F).tgz -C /d .
done
```

(The volume name starts with the folder name in lower case; `docker volume ls` shows it.) Download the files with `scp`. Also export the Grist documents (Download, .grist) now and then.

**If a site shows a certificate error:** the address does not point at the server yet (step 4) or ports 80/443 are not open (step 3). `docker compose logs caddy` says which.
