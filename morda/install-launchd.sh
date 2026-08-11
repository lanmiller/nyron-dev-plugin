#!/usr/bin/env bash
# Морда как постоянный сервис (launchd): переживает рестарты копий Claude
# и перезагрузку машины — не зависит от чьей-либо сессии (CTO 10.08:
# «когда плагин работает — морда пашет всегда»).
#
#   bash install-launchd.sh            # собрать и поставить/перезапустить
#   bash install-launchd.sh --remove   # снять сервис
#
# Прод-сборка (node build) — без HMR: после правок кода морды перегнать
# `npm run build` и перезапустить сервис этим же скриптом.
set -euo pipefail

MORDA="$(cd "$(dirname "$0")" && pwd -P)"
LABEL="com.nyron.morda"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "снят: $LABEL"
  exit 0
fi

( cd "$MORDA" && npm run build --silent )

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$MORDA/build/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$MORDA</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>4747</string>
    <key>MORDA_ROOT</key><string>$MORDA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$LABEL.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$LABEL.err.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -s -o /dev/null -w "морда на 4747: HTTP %{http_code}\n" http://127.0.0.1:4747/ --max-time 5 \
  || echo "морда не ответила — смотри $HOME/Library/Logs/$LABEL.err.log"
echo "поставлен: $LABEL (лог: ~/Library/Logs/$LABEL.log)"
