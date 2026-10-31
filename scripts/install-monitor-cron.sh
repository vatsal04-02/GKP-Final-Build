#!/usr/bin/env bash
# Schedules scripts/monitor.sh every 5 minutes for the user running this (safe to run twice). Remove it with: crontab -e
set -euo pipefail
cd "$(dirname "$0")/.."
here="$(pwd)"
mkdir -p backups
line="*/5 * * * * cd $here && ./scripts/monitor.sh >/dev/null 2>&1 # gkp-monitor"
( crontab -l 2>/dev/null | grep -v '# gkp-monitor' || true; echo "$line" ) | crontab -
echo "Scheduled: $line"
