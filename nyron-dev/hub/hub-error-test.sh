#!/usr/bin/env bash
# Тест машинного канала ошибок будки (DoD STOVP-41). Red до канала, green после.
#
#   T1. Падение хука пишется в будку: время, машина, источник, текст ошибки —
#       при этом штатный stdout хука доезжает байт в байт, а наружу exit 0.
#   T2. hub_read(kind='error') отдаёт событие; чтение без фильтра ведёт себя
#       как раньше (ошибок не видит, обычные сообщения видит).
#   T3. Будка недоступна (каталога нет) — хук отрабатывает штатно, репортёр
#       молчит, задержка меньше секунды.
set -uo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SERVER="$PLUGIN/hub/server.mjs"
GUARD="$PLUGIN/hooks/guard.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export NYRON_HUB_DIR="$ROOT/.nyron-hub"
mkdir -p "$NYRON_HUB_DIR"
DB="$NYRON_HUB_DIR/hub.db"
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

call() { # <name> <json-args> — MCP-вызов, как из сессии
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | node "$SERVER" 2>/dev/null | tail -1
}

# намеренно падающий хук: пишет штатный вывод и валится с кодом 7
BROKEN="$ROOT/broken-hook.sh"
cat > "$BROKEN" <<'SH'
echo "ШТАТНЫЙ-ВЫВОД-ХУКА"
echo "boom: файл политики не найден" >&2
exit 7
SH

echo "== T1: падение хука → запись в будке, вывод не пострадал =="
OUT=$(sh "$GUARD" test-hook sh "$BROKEN" 2>"$ROOT/guard.err"); code=$?
[ "$code" = 0 ] && ok "наружу exit 0 (сессия не падает)" || bad "guard вернул $code"
[ "$OUT" = "ШТАТНЫЙ-ВЫВОД-ХУКА" ] && ok "stdout хука прошёл как раньше" \
  || bad "stdout изменился: '$OUT'"
[ -s "$ROOT/guard.err" ] && bad "guard насорил в stderr: $(cat "$ROOT/guard.err")" \
  || ok "stderr чистый (чат человека не пачкается)"
ROW=$(/usr/bin/sqlite3 -separator ' | ' "$DB" \
  "SELECT ts,host,sender,kind,text FROM messages WHERE kind='error';" 2>/dev/null)
echo "     строка будки: $ROW"
grep -q 'test-hook' <<<"$ROW" && grep -q 'exit=7' <<<"$ROW" && grep -q 'boom' <<<"$ROW" \
  && [ "$(cut -d'|' -f2 <<<"$ROW" | tr -d ' ')" != "" ] \
  && ok "есть время, машина, источник и текст ошибки" \
  || bad "запись неполная: $ROW"

echo "== T2: чтение с фильтром и без =="
call hub_post '{"from":"wave-1","to":"all","text":"обычное-сообщение"}' >/dev/null
ERRS=$(call hub_read '{"kind":"error"}')
grep -q 'test-hook' <<<"$ERRS" && ok "hub_read kind=error отдаёт событие" \
  || bad "фильтр ошибок пуст: $(head -c150 <<<"$ERRS")"
grep -q 'обычное-сообщение' <<<"$ERRS" && bad "в фильтр ошибок попал обычный трафик" \
  || ok "обычных сообщений в фильтре нет"
PLAIN=$(call hub_read '{"agent":"reader"}')
grep -q 'обычное-сообщение' <<<"$PLAIN" && ok "чтение без фильтра работает как раньше" \
  || bad "обычное чтение сломано: $(head -c150 <<<"$PLAIN")"
grep -q 'test-hook' <<<"$PLAIN" && bad "ошибка примешалась в обычное чтение" \
  || ok "ошибки в обычное чтение не лезут"
STATUS=$(call hub_status '{}')
grep -q 'test-hook' <<<"$STATUS" && bad "ошибка вылезла в hub_status" \
  || ok "hub_status без машинных ошибок"

echo "== T3: будки нет → штатная работа, молчание, без задержки =="
S=$(date +%s)
OUT2=$(NYRON_HUB_DIR="$ROOT/нет-такой-будки" sh "$GUARD" test-hook sh "$BROKEN" 2>"$ROOT/g2.err"); code=$?
E=$(( $(date +%s) - S ))
[ "$code" = 0 ] && [ "$OUT2" = "ШТАТНЫЙ-ВЫВОД-ХУКА" ] && ok "хук отработал штатно (exit 0, вывод на месте)" \
  || bad "без будки хук сломался: code=$code out='$OUT2'"
[ -s "$ROOT/g2.err" ] && bad "репортёр напечатал: $(cat "$ROOT/g2.err")" || ok "репортёр молчит"
[ -d "$ROOT/нет-такой-будки" ] && bad "репортёр создал каталог будки в чужом проекте" \
  || ok "чужой проект не засорён"
[ "$E" -le 1 ] && ok "задержка ${E} сек (< 1 сек)" || bad "задержка ${E} сек"

echo
[ $fail -eq 0 ] && echo "ВСЁ ЗЕЛЁНОЕ" || echo "ЕСТЬ ПАДЕНИЯ"
exit $fail
