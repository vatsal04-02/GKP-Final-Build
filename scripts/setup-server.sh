#!/usr/bin/env bash
# One-time hardening + Docker install for a fresh Hetzner Ubuntu 24.04 server.
# Run as root right after creating the server (you logged in with your SSH key):
#   bash setup-server.sh
# What it does: updates packages, creates a 'deploy' user with your SSH key,
# turns off password + root SSH login, enables the firewall (22/80/443 only),
# fail2ban and automatic security updates, and installs Docker.
set -euo pipefail

DEPLOY_USER="deploy"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root."; exit 1; fi

# Safety check: refuse to lock SSH down unless root already has a key installed.
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "No SSH key in /root/.ssh/authorized_keys. Add your key in Hetzner first, or you will be locked out."
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
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh || systemctl reload sshd

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

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"

echo
echo "All done. Open a NEW terminal and check you can log in BEFORE closing this one:"
echo "  ssh $DEPLOY_USER@$(curl -s -4 ifconfig.me || echo '<server-ip>')"
echo "Note: Docker publishes ports directly; only Caddy publishes 80/443 in docker-compose.yml."
