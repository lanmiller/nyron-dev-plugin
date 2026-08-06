#!/bin/sh
# SessionStart-хук: сессия сама замечает, что плагин устарел (STOVP-39).
# Раньше о новой версии узнавали случайно — человек работал неделями на
# старых скиллах и не знал об этом.
#
# Сравнение локальное и мгновенное: версия установленного плагина (рядом с
# хуком, ${CLAUDE_PLUGIN_ROOT}) против версии в маркетплейс-клоне (рабочее
# дерево + origin/main). Сеть на критическом пути не трогаем: git fetch
# уходит в фон отдельным процессом с таймаутом, его результат увидит
# СЛЕДУЮЩАЯ сессия — старт не ждёт сети никогда.
#
# Любая осечка (нет клона, нет git, нет файла, мусор вместо версии) =
# молчание и exit 0: хук не роняет сессию и ничего не задерживает.

CLONE="${NYRON_MARKETPLACE_DIR:-$HOME/.claude/plugins/marketplaces/nyron-dev-marketplace-v2}"
MANIFEST="nyron-dev/.claude-plugin/plugin.json"

# "version": "0.8.16" → 0.8.16 (первое совпадение; jq не требуется)
ver() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }

# ok A → пусто/мусор отсекаем: сравниваем только числа с точками
ok() { case "$1" in '' | *[!0-9.]*) return 1 ;; *) return 0 ;; esac; }

# newer A B → 0, если A > B. Покомпонентно числами: строкой 0.8.9 > 0.8.16 — враньё
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, A, "."); nb = split(b, B, "."); n = (na > nb ? na : nb)
    for (i = 1; i <= n; i++) { if (A[i] + 0 > B[i] + 0) exit 0; if (A[i] + 0 < B[i] + 0) exit 1 }
    exit 1
  }'
}

ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
INSTALLED=$(ver 2>/dev/null <"$ROOT/.claude-plugin/plugin.json")
ok "$INSTALLED" || exit 0
[ -d "$CLONE" ] || exit 0

LATEST=$(ver 2>/dev/null <"$CLONE/$MANIFEST")

if [ -d "$CLONE/.git" ] && command -v git >/dev/null 2>&1; then
  # уже подтянутое прошлым фоновым fetch — оно свежее рабочего дерева клона
  ORIGIN=$(git -C "$CLONE" show origin/main:"$MANIFEST" 2>/dev/null | ver)
  if ok "$ORIGIN" && newer "$ORIGIN" "$LATEST"; then LATEST="$ORIGIN"; fi

  # фоновый fetch — полностью отцеплен, вывод в /dev/null, не чаще раза в час
  if ! find "$CLONE/.git/FETCH_HEAD" -mmin -60 2>/dev/null | grep -q .; then
    (
      GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=15 \
        GIT_SSH_COMMAND='ssh -oBatchMode=yes -oConnectTimeout=5' \
        git -C "$CLONE" fetch --quiet origin main &
      f=$!
      (sleep 30; kill "$f") 2>/dev/null &
      w=$!
      wait "$f"
      kill "$w" 2>/dev/null
    ) >/dev/null 2>&1 </dev/null &
  fi
fi

ok "$LATEST" || exit 0
newer "$LATEST" "$INSTALLED" || exit 0

cat <<TXT
<nyron-dev-обновление>
Плагин nyron-dev устарел ($INSTALLED → $LATEST) — обнови: claude plugin update nyron-dev (затем перезапусти Claude Code).
Скажи это пользователю первым же ответом — он работает на старых скиллах.
</nyron-dev-обновление>
TXT
