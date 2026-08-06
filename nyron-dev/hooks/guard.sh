#!/bin/sh
# guard.sh <источник> <команда…> — запустить команду хука (или шаг скилла) так,
# чтобы её падение стало машинным событием в будке, а не тишиной (STOVP-41).
#
#   sh guard.sh version-check sh /путь/version-check.sh
#
# Что делает:
#   • stdout команды идёт наружу как раньше, байт в байт — на нём держится
#     весь смысл хуков (code-policy отдаёт политику в сессию);
#   • stderr перехватывается и вместе с кодом возврата уходит в будку —
#     в чат человека поломка инструмента не лезет;
#   • наружу guard всегда отдаёт 0: сломанный хук не имеет права уронить или
#     задержать старт сессии (мягкая деградация, как в version-check.sh).
SRC="${1:-unknown}"
[ $# -gt 0 ] && shift

ERR=$(mktemp 2>/dev/null) || ERR=""
if [ -n "$ERR" ]; then
  "$@" 2>"$ERR"
  code=$?
  msg=$(head -c 2000 "$ERR" 2>/dev/null | tr '\n' ' ')
  rm -f "$ERR"
else
  "$@"
  code=$?
  msg=""
fi

if [ "$code" -ne 0 ] || [ -n "$msg" ]; then
  sh "$(cd "$(dirname "$0")" && pwd)/error-report.sh" "$SRC" "exit=$code${msg:+ | }$msg"
fi

exit 0
