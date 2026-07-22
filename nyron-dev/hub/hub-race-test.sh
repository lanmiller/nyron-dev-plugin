#!/usr/bin/env bash
# Тест будки v2 по DoD DEV-627. Red до переезда на SQLite, green после.
#
# Проверяет через MCP-протокол (stdio), как реальные сессии:
#   T1. Гонки записи: 2 параллельных писателя × 100 сообщений — все 200
#       доставлены читателю, без потерь и дублей.
#   T2. Эхо: отправитель НЕ видит свои сообщения в hub_read (inbox/outbox).
#   T3. Курсор переживает «смерть» консьюмера: новый процесс с тем же именем
#       дочитывает с того же места — ничего не потеряно и не перечитано.
#   T4. Локи: второй захват того же файла другим агентом отбивается; TTL/unlock
#       освобождает.
#   T5. Якорь не сломан: hub-anchor-test.sh зелёный.
set -uo pipefail

HUBDIR_ROOT=$(mktemp -d); export NYRON_HUB_DIR="$HUBDIR_ROOT/.nyron-hub"
PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SERVER="$PLUGIN/hub/server.mjs"
fail=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; fail=1; }

# MCP-вызов одной командой: init + tools/call, вернуть text-результат
call() { # <name> <json-args>
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | node "$SERVER" 2>/dev/null | tail -1
}

echo "== T1: 2 писателя × 100 параллельно =="
w() { for i in $(seq 1 100); do
       call hub_post "{\"from\":\"$1\",\"to\":\"all\",\"text\":\"$1-msg-$i\"}" >/dev/null
     done; }
w writer-A & w writer-B & wait
GOT=$(call hub_read '{"agent":"reader","limit":500}')
CA=$(grep -o 'writer-A-msg-' <<<"$GOT" | wc -l | tr -d ' ')
CB=$(grep -o 'writer-B-msg-' <<<"$GOT" | wc -l | tr -d ' ')
[ "$CA" = 100 ] && [ "$CB" = 100 ] && ok "200/200 доставлено (A=$CA B=$CB)" \
  || bad "потери/дубли: A=$CA B=$CB (ожидалось по 100)"

echo "== T2: эхо отправителю не приходит =="
call hub_post '{"from":"echo-guy","to":"all","text":"echo-check-marker"}' >/dev/null
SELF=$(call hub_read '{"agent":"echo-guy","limit":500}')
grep -q 'echo-check-marker' <<<"$SELF" && bad "отправитель видит своё сообщение" \
  || ok "своё сообщение отфильтровано"

echo "== T3: курсор переживает смерть консьюмера =="
call hub_post '{"from":"w3","to":"all","text":"cursor-1"}' >/dev/null
R1=$(call hub_read '{"agent":"phoenix","limit":500}')          # первый процесс прочёл
call hub_post '{"from":"w3","to":"all","text":"cursor-2"}' >/dev/null
R2=$(call hub_read '{"agent":"phoenix","limit":500}')          # «новый процесс», то же имя
grep -q 'cursor-2' <<<"$R2" && ! grep -q 'cursor-1' <<<"$R2" \
  && ok "дочитал только новое (cursor-2), без перечитки" \
  || bad "курсор потерялся: R2=$(head -c150 <<<"$R2")"

echo "== T4: конфликт лока =="
call hub_lock '{"agent":"lk-A","paths":["src/x.js"],"ttl_min":5}' >/dev/null
L2=$(call hub_lock '{"agent":"lk-B","paths":["src/x.js"],"ttl_min":5}')
grep -qi 'занят\|conflict\|busy\|lk-A' <<<"$L2" && ok "второй захват отбит" \
  || bad "конфликт лока не отбился: $(head -c150 <<<"$L2")"
call hub_unlock '{"agent":"lk-A"}' >/dev/null
L3=$(call hub_lock '{"agent":"lk-B","paths":["src/x.js"],"ttl_min":5}')
grep -qi 'занят\|conflict\|busy' <<<"$L3" && bad "после unlock лок не взялся" \
  || ok "после unlock взялся"

echo "== T5: якорь =="
env -u NYRON_HUB_DIR bash "$PLUGIN/hub/hub-anchor-test.sh" "$PLUGIN" >/dev/null 2>&1 && ok "hub-anchor-test зелёный" || bad "hub-anchor-test упал"

rm -rf "$HUBDIR_ROOT"
echo; [ $fail -eq 0 ] && echo "ВСЁ ЗЕЛЁНОЕ" || echo "ЕСТЬ ПАДЕНИЯ"
exit $fail
