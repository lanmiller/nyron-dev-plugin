#!/usr/bin/env bash
# Тест надзирателя (этап 2 морды; включая правки по ревью Sol 09.08).
# Модель подменена стабом — не жжёт подписку, проверяется детерминированный
# слой:
#   T1. Молчун → waiting_silent + заглушка (wave=watchdog-inferred, blocking);
#       null/примитив/дубль ключа в ответе модели НЕ валят тик (первый
#       вердикт выигрывает); свежая сессия = working БЕЗУСЛОВНО (даже против
#       waiting_decision от модели); чужой cwd и выдуманные сессии — мимо.
#   T2. Повторный тик → заглушка не дублируется.
#   T3. Перефразированный моделью вопрос → ДУБЛЯ НЕТ (фингерпринт — сессия).
#   T4. Мусор от модели → kind=error, состояния прошлого тика целы.
#   T5. Фолбэк-модель спасает тик, спасение видно в канале ошибок.
#   T6. Отменённая человеком заглушка НЕ пересоздаётся, пока сессия молчит.
#   T7. Снапшот: сессия, пропавшая из вердиктов, уходит из watch_states.
#   T8. hub_status отдаёт watch.
set -uo pipefail

PLUGIN="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
HUB="$PLUGIN/hub"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export NYRON_HUB_DIR="$ROOT/.nyron-hub"
export CLAUDE_PROJECTS_DIR="$ROOT/projects"
export WATCHDOG_FRESH_MIN=2
mkdir -p "$NYRON_HUB_DIR"
PROJ="$ROOT/work"; mkdir -p "$PROJ"; PROJ=$(cd "$PROJ" && pwd -P)
TDIR="$CLAUDE_PROJECTS_DIR/$(echo "$PROJ" | tr '/.' '--')"
mkdir -p "$TDIR"
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

mkline() { # <text> [cwd] — строка транскрипта (assistant)
  if [ -n "${2:-}" ]; then
    printf '{"type":"assistant","cwd":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$2" "$1"
  else
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$1"
  fi
}

# s-silent: старый хвост с вопросом; s-fresh: свежак; s-foreign: чужой cwd
{ mkline "Разобрал тикет."; mkline "Какую ветку брать за базу: main или fix/dev1?"; } > "$TDIR/s-silent.jsonl"
touch -t "$(date -v-30M +%Y%m%d%H%M)" "$TDIR/s-silent.jsonl"
{ mkline "Пишу код дальше"; } > "$TDIR/s-fresh.jsonl"
{ mkline "Чужая сессия" "/other/place"; } > "$TDIR/s-foreign.jsonl"
touch -t "$(date -v-30M +%Y%m%d%H%M)" "$TDIR/s-foreign.jsonl"

mkstub() { # <файл> <json-массив>
  { echo 'cat > /dev/null'; printf "echo '%s'\n" "$2"; } > "$1"; chmod +x "$1"
}
STUB_MAIN="$ROOT/stub-main.sh"
mkstub "$STUB_MAIN" '[null, 7,
 {"key":"s-silent","state":"waiting_silent","reason":"кончается вопросом","question":"Какую ветку брать за базу: main или fix/dev1?"},
 {"key":"s-silent","state":"dead","reason":"дубль — должен проиграть"},
 {"key":"s-fresh","state":"waiting_decision","reason":"модель врёт — свежесть обязана перекрыть"},
 {"key":"s-foreign","state":"waiting_silent","reason":"чужой проект","question":"не должно появиться"},
 {"key":"ghost","state":"dead","reason":"выдумка"}]'
STUB_RE="$ROOT/stub-re.sh"
mkstub "$STUB_RE" '[{"key":"s-silent","state":"waiting_silent","reason":"тот же вопрос иначе","question":"База для ветки — main или фикс?"}]'
STUB_ONLY="$ROOT/stub-only.sh"
mkstub "$STUB_ONLY" '[{"key":"s-silent","state":"waiting_silent","reason":"один в вердиктах","question":"Какую ветку брать за базу: main или fix/dev1?"}]'
STUB_TRASH="$ROOT/stub-trash.sh"
printf 'cat > /dev/null\necho "я не json ["\n' > "$STUB_TRASH"; chmod +x "$STUB_TRASH"

call() {
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | node "$HUB/server.mjs" 2>/dev/null | tail -1
}
val() { echo "$1" | jq -r '.result.content[0].text' | jq -r "$2"; }
tick() { ( cd "$PROJ" && WATCHDOG_MODEL_CMD="sh $1" WATCHDOG_FALLBACK_MODEL_CMD="${2:+sh $2}" node "$HUB/watchdog.mjs" ); }
wstate() { sqlite3 "$NYRON_HUB_DIR/hub.db" "SELECT state FROM watch_states WHERE key='$1'"; }
inferred_live() { val "$(call hub_asks "{\"session\":\"$1\"}")" '[.asks[] | select(.wave=="watchdog-inferred")] | length'; }

echo "== T1: злой ответ модели + оверрайды =="
tick "$STUB_MAIN" >/dev/null 2>&1 || bad "тик упал на null/примитивах"
[ "$(wstate s-silent)" = "waiting_silent" ] && ok "молчун распознан; дубль ключа проиграл первому" || bad "s-silent=$(wstate s-silent)"
[ "$(wstate s-fresh)" = "working" ] && ok "свежесть перекрыла даже waiting_decision" || bad "s-fresh=$(wstate s-fresh)"
[ -z "$(wstate s-foreign)" ] && ok "чужой cwd отфильтрован" || bad "s-foreign попал: $(wstate s-foreign)"
[ -z "$(wstate ghost)" ] && ok "выдумка модели мимо" || bad "ghost записан"
Q=$(val "$(call hub_asks '{"status":"open"}')" '.asks[] | select(.session=="s-silent") | .question')
U=$(val "$(call hub_asks '{"status":"open"}')" '.asks[] | select(.session=="s-silent") | .urgency')
[ "$Q" = "Какую ветку брать за базу: main или fix/dev1?" ] && [ "$U" = "blocking" ] && ok "заглушка создана (blocking)" || bad "заглушка: q=$Q u=$U"
[ "$(inferred_live s-foreign)" = "0" ] && ok "заглушки за чужого нет" || bad "чужая заглушка"

echo "== T2: повторный тик — без дублей =="
tick "$STUB_MAIN" >/dev/null 2>&1
[ "$(inferred_live s-silent)" = "1" ] && ok "заглушка одна" || bad "заглушек: $(inferred_live s-silent)"

echo "== T3: перефразировка — дубля нет (фингерпринт = сессия) =="
tick "$STUB_RE" >/dev/null 2>&1
[ "$(inferred_live s-silent)" = "1" ] && ok "перефразированный вопрос не размножил заглушку" || bad "после перефраза: $(inferred_live s-silent)"

echo "== T4: мусор — ошибка видима, состояния целы =="
tick "$STUB_TRASH" >/dev/null 2>&1
call hub_read '{"kind":"error"}' | jq -r '.result.content[0].text' | grep -q 'watchdog' && ok "слепота в канале ошибок" || bad "ошибки нет"
[ "$(wstate s-silent)" = "waiting_silent" ] && ok "состояния не испорчены" || bad "после мусора: $(wstate s-silent)"

echo "== T5: фолбэк спасает тик =="
tick "$STUB_TRASH" "$STUB_MAIN" >/dev/null 2>&1
[ "$(wstate s-silent)" = "waiting_silent" ] && ok "фолбэк отработал" || bad "фолбэк: $(wstate s-silent)"
call hub_read '{"kind":"error"}' | jq -r '.result.content[0].text' | grep -q 'спасён фолбэком' && ok "спасение видно" || bad "маркера нет"

echo "== T6: отменённая заглушка не пересоздаётся =="
AID=$(val "$(call hub_asks '{"session":"s-silent"}')" '.asks[] | select(.wave=="watchdog-inferred") | .id')
# активность МЕЖДУ созданием заглушки и отменой: отмена должна победить
touch -t "$(date -v-5M +%Y%m%d%H%M)" "$TDIR/s-silent.jsonl"
call hub_ask_cancel "{\"ask_id\":\"$AID\",\"by\":\"cto\",\"reason\":\"видел, неактуально\"}" >/dev/null
tick "$STUB_MAIN" >/dev/null 2>&1
[ "$(inferred_live s-silent)" = "0" ] && ok "отмена новее активности — тишина (момент отмены, не создания)" || bad "пересоздана: $(inferred_live s-silent)"

echo "== T7: снапшот выкидывает пропавших =="
tick "$STUB_ONLY" >/dev/null 2>&1
[ "$(wstate s-silent)" = "waiting_silent" ] && ok "наблюдаемая осталась" || bad "s-silent пропал"
[ -z "$(wstate s-fresh)" ] && ok "пропавшая из вердиктов ушла из watch" || bad "s-fresh завис: $(wstate s-fresh)"

echo "== T8: hub_status отдаёт watch =="
WS=$(val "$(call hub_status '{}')" '.watch | length')
[ "$WS" -ge 1 ] && ok "watch в статусе ($WS)" || bad "watch: $WS"

echo "== T9: сессии ушли совсем → watch пустеет =="
rm -f "$TDIR"/*.jsonl
tick "$STUB_ONLY" >/dev/null 2>&1
WE=$(sqlite3 "$NYRON_HUB_DIR/hub.db" "SELECT COUNT(*) FROM watch_states")
[ "$WE" = "0" ] && ok "пустой снапшот записан — призраков нет" || bad "осталось строк: $WE"

echo
[ "$fail" = 0 ] && echo "ВСЕ ТЕСТЫ ЗЕЛЁНЫЕ" || { echo "ЕСТЬ КРАСНЫЕ"; exit 1; }
