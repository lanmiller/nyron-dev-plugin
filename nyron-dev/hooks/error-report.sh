#!/bin/sh
# error-report.sh <источник> [текст…] — записать ошибку хука/скилла в будку
# машинным событием (STOVP-41). Источник: имя хука («code-policy») или
# скилла («skill:cross-review»).
#
# Зачем оболочка вокруг error-report.mjs: GUI-приложение (Claude Desktop) не
# имеет homebrew/nvm в PATH — голый `node` не резолвится (та же грабля, что у
# run-hub.sh). Ищем node по известным местам.
#
# Гарантии: ничего не печатает, всегда exit 0, ждёт запись не дольше сторожа
# (3 сек) — сенсор не имеет права стать источником зависаний сессии.
SRC="${1:-unknown}"
[ $# -gt 0 ] && shift
TEXT="$*"

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE=""
for N in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node; do
  if command -v "$N" >/dev/null 2>&1; then NODE="$N"; break; fi
done
[ -n "$NODE" ] || exit 0

# сторож: занятая база (busy_timeout будки — 8 сек) не должна держать хук
(
  "$NODE" "$DIR/error-report.mjs" "$SRC" "$TEXT" &
  p=$!
  (sleep 3; kill "$p") 2>/dev/null &
  w=$!
  wait "$p"
  kill "$w" 2>/dev/null
) >/dev/null 2>&1 </dev/null

exit 0
