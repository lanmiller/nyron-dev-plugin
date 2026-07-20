#!/usr/bin/env bash
# hub-watch.sh — стандартный будка-вотчер nyron-dev (не сочинять свои until-loop'ы).
#
#   hub-watch.sh watch <моё-имя>   # ждать ЧУЖОЕ сообщение; завершается при событии
#                                  # (запускать фоновым run_in_background — завершение будит сессию)
#   hub-watch.sh alive <моё-имя>   # exit 0 = вотчер с этим именем ЖИВ (для чек-листа пробуждения)
#   hub-watch.sh reanimator [минут=40]
#                                  # РЕАНИМАТОР (zero-token, дежурит циклом): будка молчит дольше
#                                  # N минут при активном прогоне → пишет RESUME-пинг прямо в файл
#                                  # будки (спинлок, без MCP/токенов) → пинг будит watch-вотчеры
#                                  # ВСЕХ сессий → у кого есть токены, те едут. Токенов нет —
#                                  # пингует снова через N минут, до победного. Автономная
#                                  # страховка от «упёрлись в 5-час лимиты и всё молча встало» —
#                                  # человек не нужен: shell-вотчеры переживают лимит, реаниматор
#                                  # лишь стучит в живую цепочку пробуждения.
#
# Встроено: фильтр эха (свои "from" игнорируются), pid-маячок в
# .nyron-hub/.watchers/<имя>.pid, база = текущий хвост файла на момент старта
# (сообщения, пришедшие ДО старта, не будят — их читает hub_read по курсору).
set -euo pipefail

MODE="${1:-}"; ME="${2:-}"
[ -n "$MODE" ] && [ -n "$ME" ] || { echo "usage: $0 watch|alive <agent-name>" >&2; exit 2; }

resolve_hub() {
  if [ -n "${NYRON_HUB_DIR:-}" ]; then echo "$NYRON_HUB_DIR"; return; fi
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ] && [ "$(basename "$common")" = ".git" ]; then
    echo "$(dirname "$common")/.nyron-hub"
  else
    echo "$PWD/.nyron-hub"
  fi
}

HUB=$(resolve_hub); MSG="$HUB/messages.jsonl"
WDIR="$HUB/.watchers"; PIDF="$WDIR/$ME.pid"
mkdir -p "$WDIR"

case "$MODE" in
  alive)
    [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && exit 0 || exit 1 ;;
  watch)
    echo $$ > "$PIDF"
    trap 'rm -f "$PIDF"' EXIT
    base=$(grep -c '^' "$MSG" 2>/dev/null || echo 0)
    while true; do
      cur=$(grep -c '^' "$MSG" 2>/dev/null || echo 0)
      if [ "$cur" -gt "$base" ]; then
        # новые строки без своих (фильтр эха) → событие
        if tail -n +"$((base + 1))" "$MSG" | grep -v "\"from\":\"$ME\"" | grep -q .; then
          echo "HUB-EVENT для $ME:"; tail -n +"$((base + 1))" "$MSG" | grep -v "\"from\":\"$ME\"" | tail -5
          exit 0
        fi
        base=$cur   # были только свои посты — перезамер базы, ждём дальше
      fi
      sleep 15
    done ;;
  reanimator)
    MIN="${2:-40}"   # для reanimator второй аргумент = минуты (имя не нужно)
    case "$MIN" in (*[!0-9]*) MIN="${3:-40}";; esac
    echo $$ > "$WDIR/reanimator.pid"
    trap 'rm -f "$WDIR/reanimator.pid"' EXIT
    while true; do
      if [ -f "$MSG" ]; then
        last=$(stat -f %m "$MSG" 2>/dev/null || stat -c %Y "$MSG" 2>/dev/null || echo 0)
        now=$(date +%s)
        if [ $((now - last)) -gt $((MIN * 60)) ]; then
          # RESUME-пинг напрямую в файл (zero-token), под спинлоком сервера
          until mkdir "$HUB/.spinlock" 2>/dev/null; do sleep 1; done
          printf '{"id":"%s-rean","ts":"%s","from":"reanimator","to":"all","ticket":null,"wave":null,"text":"RESUME-пинг: будка молчала %s+ мин (лимиты/разрыв?) — всем сессиям проверить свои волны и продолжить по брифам"}\n' \
            "$(date +%s)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$MIN" >> "$MSG"
          rmdir "$HUB/.spinlock" 2>/dev/null || true
          echo "REANIMATOR: пинг отправлен ($(date '+%H:%M'))"
        fi
      fi
      sleep 60
    done ;;
  *) echo "usage: $0 watch|alive <agent-name> | reanimator [минут]" >&2; exit 2 ;;
esac
