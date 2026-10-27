#!/usr/bin/env bash
# One-time hardening + Docker install for a fresh Ubuntu 24.04 VPS (Hostinger, Hetzner, OVH, ...).
# Run as root right after creating the server (you logged in with your SSH key):
#   scp scripts/setup-server.sh root@<server-ip>:/root/   (from your PC)   then on the server:   bash setup-server.sh
# What it does: updates packages, creates a 'deploy' user with your SSH key,
# turns off password + root SSH login, enables the firewall (22/80/443 only),
# fail2ban and automatic security updates, adds 2 GB of swap, sets the clinic's
# timezone (Asia/Kolkata) and installs Docker. Safe to run twice.
set -euo pipefail

DEPLOY_USER="deploy"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root."; exit 1; fi
. /etc/os-release
case "${ID}:${VERSION_ID}" in ubuntu:22.04|ubuntu:24.04) ;; *) echo "This script is written for Ubuntu 22.04/24.04 (found ${PRETTY_NAME}). Reinstall the OS from your host's panel."; exit 1;; esac

# Safety check: refuse to lock SSH down unless root already has a key installed.
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "No SSH key in /root/.ssh/authorized_keys. Add your SSH key in your host's panel first (or paste it into /root/.ssh/authorized_keys), or you will be locked out."
  exit 1
fi

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ufw fail2ban unattended-upgrades ca-certificates curl git openssl

echo "==> Creating user '$DEPLOY_USER'"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
  echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-$DEPLOY_USER
  chmod 440 /etc/sudoers.d/90-$DEPLOY_USER
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /home/$DEPLOY_USER/.ssh
install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys /home/$DEPLOY_USER/.ssh/authorized_keys

echo "==> Hardening SSH (key-only, no root login)"
rm -f /etc/ssh/sshd_config.d/99-hardening.conf
# 00- so it is read FIRST: sshd keeps the first value it sees, and cloud images ship files (e.g. 50-cloud-init.conf) that allow passwords
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh || systemctl reload sshd
eff="$(sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) ' | tr '\n' ' ')"
echo "    effective SSH settings: $eff"
case "$eff" in *"passwordauthentication no"*"permitrootlogin no"*|*"permitrootlogin no"*"passwordauthentication no"*) ;; *) echo "WARNING: SSH still allows passwords or root login. Check /etc/ssh/sshd_config.d/ and /etc/ssh/sshd_config before closing this session."; ;; esac

echo "==> Firewall: allow 22, 80, 443 only"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> fail2ban + automatic security updates"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Swap (2 GB): a memory spike slows the server down instead of killing n8n"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

echo "==> Timezone: Asia/Kolkata (the clinic's messaging hours and the daily report follow it)"
timedatectl set-timezone Asia/Kolkata || true

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"

echo
echo "All done. Open a NEW terminal and check you can log in BEFORE closing this one:"
echo "  ssh $DEPLOY_USER@$(curl -s -4 ifconfig.me || echo '<server-ip>')"
echo "Note: Docker publishes ports directly, around the firewall; only Caddy publishes 80/443 in docker-compose.yml."
echo "Next: log in as $DEPLOY_USER and follow docs/DEPLOY_HOSTINGER.md from step 3."
