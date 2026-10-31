#!/usr/bin/env bash
# One-time setup for a fresh Oracle Cloud (Always Free) Ubuntu server. Run as the default 'ubuntu' user:
#   bash scripts/oracle-setup.sh
# It installs Docker, opens ports 80/443 in the server's own firewall (Oracle's Ubuntu image blocks them by default),
# turns on fail2ban and automatic security updates, and adds swap on small servers.
# SSH stays key-only (Oracle already sets that up). The cloud-side rule (VCN Security List) is separate: see docs/DEPLOY-ORACLE.md step 3.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then echo "Run as the normal user (ubuntu), not root. It uses sudo where needed."; exit 1; fi

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git openssl fail2ban unattended-upgrades iptables-persistent netfilter-persistent

echo "==> Opening ports 80 and 443 in the server firewall (above Oracle's default REJECT rule)"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT
done
sudo netfilter-persistent save

echo "==> fail2ban + automatic security updates"
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sudo sh; fi
sudo usermod -aG docker "$USER"

# the small free AMD server has only 1 GB of memory: add 2 GB of swap so builds do not run out
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && ! swapon --show | grep -q .; then
  echo "==> Low memory (${MEM_MB} MB): adding 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo
echo "Done. Log out and back in once (so the docker group applies), then: docker run --rm hello-world"
echo "Architecture: $(uname -m)  (aarch64 = Ampere ARM, x86_64 = AMD)"
