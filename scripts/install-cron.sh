#!/usr/bin/env bash
# Schedules the encrypted backup every night at 02:30 (server time is Asia/Kolkata after setup-server.sh) for the user running this.
# Safe to run twice. Remove it with: crontab -e
set -euo pipefail
cd "$(dirname "$0")/.."
here="$(pwd)"
mkdir -p backups
line="30 2 * * * cd $here && ./scripts/backup.sh >> $here/backups/backup.log 2>&1 # gkp-backup"
( crontab -l 2>/dev/null | grep -v '# gkp-backup' || true; echo "$line" ) | crontab -
echo "Scheduled: $line"
echo "Reminder: the archives stay on this server's disk. Copy them off it regularly (docs/DEPLOY_HOSTINGER.md, step 9)."
