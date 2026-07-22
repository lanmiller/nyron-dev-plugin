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
case "$MODE" in
  hubdir|reanimator) : ;;   # имя агента не нужно
  *) [ -n "$MODE" ] && [ -n "$ME" ] || {
       echo "usage: $0 watch|alive <agent-name> | hubdir | reanimator [минут]" >&2; exit 2; } ;;
esac

# Якорь будки — КОРЕНЬ ПРОЕКТА (каталог с .claude/nyron-dev.md). Лестница
# ОБЯЗАНА совпадать с hub/hub-dir.mjs — иначе вотчеры разъедутся с сервером
# и будут ждать событий в файле, куда никто не пишет (баг прогона 21.07).
resolve_hub() {
  if [ -n "${NYRON_HUB_DIR:-}" ]; then echo "$NYRON_HUB_DIR"; return; fi
  local dir="$PWD" common
  while :; do
    if [ -f "$dir/.claude/nyron-dev.md" ]; then echo "$dir/.nyron-hub"; return; fi
    [ "$dir" = "/" ] && break
    dir=$(dirname "$dir")
  done
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ] && [ "$(basename "$common")" = ".git" ]; then
    echo "$(dirname "$common")/.nyron-hub"
  else
    echo "$PWD/.nyron-hub"
  fi
}

HUB=$(resolve_hub); DB="$HUB/hub.db"
WDIR="$HUB/.watchers"; PIDF="$WDIR/$ME.pid"
mkdir -p "$WDIR"

# ---------- чтение будки через sqlite3 CLI ----------
# Хранилище переехало с messages.jsonl на SQLite (DEV-627). База может ещё не
# существовать (сервер не стартовал) — тогда ведём себя как при пустой шине.
SQLITE=/usr/bin/sqlite3

db_max()   { # наибольший seq сейчас (0 если базы/строк нет)
  [ -f "$DB" ] || { echo 0; return; }
  local v; v=$("$SQLITE" "$DB" 'SELECT COALESCE(MAX(seq),0) FROM messages;' 2>/dev/null || echo 0)
  echo "${v:-0}"
}
db_new()   { # число ЧУЖИХ сообщений с seq > $1 (эхо-фильтр по sender != ME)
  [ -f "$DB" ] || { echo 0; return; }
  local v; v=$("$SQLITE" "$DB" "SELECT COUNT(*) FROM messages WHERE seq > $1 AND sender != '$ME';" 2>/dev/null || echo 0)
  echo "${v:-0}"
}
db_tail()  { # последние 5 чужих сообщений с seq > $1
  [ -f "$DB" ] || return
  "$SQLITE" -separator ' | ' "$DB" \
    "SELECT ts,sender,text FROM messages WHERE seq > $1 AND sender != '$ME' ORDER BY seq DESC LIMIT 5;" 2>/dev/null || true
}
db_total() { # всего сообщений (для реаниматора; свои пинги считаются активностью)
  [ -f "$DB" ] || { echo 0; return; }
  local v; v=$("$SQLITE" "$DB" 'SELECT COUNT(*) FROM messages;' 2>/dev/null || echo 0)
  echo "${v:-0}"
}

case "$MODE" in
  hubdir)
    # диагностика: в какую будку смотрит ЭТА сессия. Расходится с соседней —
    # значит сессии в разных будках, координация не работает.
    echo "$HUB" ;;
  alive)
    [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && exit 0 || exit 1 ;;
  watch)
    echo $$ > "$PIDF"
    trap 'rm -f "$PIDF"' EXIT
    base=$(db_max)   # база = текущий хвост; пришедшее ДО старта не будит
    while true; do
      if [ "$(db_new "$base")" -gt 0 ]; then
        echo "HUB-EVENT для $ME:"; db_tail "$base"
        exit 0
      fi
      sleep 15
    done ;;
  reanimator)
    MIN="${2:-40}"   # для reanimator второй аргумент = минуты (имя не нужно)
    case "$MIN" in (*[!0-9]*) MIN="${3:-40}";; esac
    echo $$ > "$WDIR/reanimator.pid"
    trap 'rm -f "$WDIR/reanimator.pid"' EXIT
    prev=$(db_total); last_change=$(date +%s)
    while true; do
      sleep 60
      cur=$(db_total)
      # активность (в т.ч. собственный пинг) сдвигает окно тишины
      [ "$cur" != "$prev" ] && { prev=$cur; last_change=$(date +%s); }
      now=$(date +%s)
      if [ -f "$DB" ] && [ $((now - last_change)) -gt $((MIN * 60)) ]; then
        # RESUME-пинг прямо в базу (zero-token); single-writer SQLite, спинлок не нужен
        "$SQLITE" "$DB" \
          "INSERT INTO messages(id,ts,sender,recipient,ticket,wave,text) VALUES('$(date +%s)-rean','$(date -u '+%Y-%m-%dT%H:%M:%SZ')','reanimator','all',NULL,NULL,'RESUME-пинг: будка молчала ${MIN}+ мин (лимиты/разрыв?) — всем сессиям проверить свои волны и продолжить по брифам');" 2>/dev/null || true
        echo "REANIMATOR: пинг отправлен ($(date '+%H:%M'))"
      fi
    done ;;
  *) echo "usage: $0 watch|alive <agent-name> | hubdir | reanimator [минут]" >&2; exit 2 ;;
esac
