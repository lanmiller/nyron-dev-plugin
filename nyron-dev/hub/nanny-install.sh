#!/usr/bin/env bash
# nanny-install.sh — ставит няньку вотчеров на расписание launchd.
#
#   nanny-install.sh <корень-проекта> [интервал-секунд]
#
# Нянька работает СНАРУЖИ сессий: ей не нужен ни рестарт волн, ни хук в
# их окружении. Это важно посреди эпика — трогать работающие сессии
# нельзя, а связь поднимать надо (CTO 12.08).
set -euo pipefail
ROOT="${1:-$PWD}"
EVERY="${2:-180}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.nyron.hub-nanny"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/watch-nanny.sh</string>
    <string>$ROOT</string>
  </array>
  <key>StartInterval</key><integer>$EVERY</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "нянька вотчеров: каждые $EVERY с по $ROOT (лог: $LOG)"
