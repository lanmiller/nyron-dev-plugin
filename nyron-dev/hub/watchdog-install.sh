#!/bin/sh
# watchdog-install.sh <корень-проекта> [интервал-сек] — поставить/обновить
# launchd-агент надзирателя на macOS (переживает перезагрузку, в отличие от
# любой живой сессии). Снять: watchdog-install.sh --remove <корень-проекта>.
set -eu

REMOVE=0
if [ "${1:-}" = "--remove" ]; then REMOVE=1; shift; fi
ROOT="${1:?usage: watchdog-install.sh [--remove] <project-root> [interval-sec]}"
ROOT=$(cd "$ROOT" && pwd -P) || { echo "нет каталога: $1" >&2; exit 1; }
INTERVAL="${2:-300}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# метка уникальна на проект — несколько проектов = несколько агентов
SLUG=$(printf '%s' "$ROOT" | /usr/bin/shasum | cut -c1-8)
LABEL="com.nyron.watchdog.$SLUG"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$LABEL.log"

if [ "$REMOVE" = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "снят: $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node не найден в PATH" >&2; exit 1; }
# launchd не наследует PATH шелла: claude может жить в ~/.local/bin и т.п. —
# кладём каталоги ОБОИХ бинарников (ревью Sol 09.08)
CLAUDE_BIN="$(command -v claude || true)"
EXTRA_PATH="$(dirname "$NODE_BIN")${CLAUDE_BIN:+:$(dirname "$CLAUDE_BIN")}"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string>
    <string>$HERE/watchdog-run.sh</string>
    <string>$ROOT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$EXTRA_PATH:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "поставлен: $LABEL, каждые ${INTERVAL}с, лог: $LOG"
