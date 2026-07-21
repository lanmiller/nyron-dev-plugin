#!/usr/bin/env bash
# Тест якоря будки: все сессии одного проекта обязаны получить ОДИН hub-dir,
# даже если работают в независимых саб-репо или их worktree'ах.
set -uo pipefail

PLUGIN="${1:-/Users/stovp/ai-evolve/nyron-dev-plugin/nyron-dev}"
TMPRAW=$(mktemp -d)
trap 'rm -rf "$TMPRAW"' EXIT
TMP=$(cd "$TMPRAW" && pwd -P)   # macOS: /var → /private/var, иначе ложные падения

ROOT="$TMP/umbrella"
mkdir -p "$ROOT/.claude"
printf -- "---\nproject: test\n---\n" > "$ROOT/.claude/nyron-dev.md"
git init -q "$ROOT"
for sub in sub-back sub-docs; do
  git init -q "$ROOT/$sub"
  git -C "$ROOT/$sub" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
done
git -C "$ROOT/sub-docs" worktree add -q "$ROOT/.wt-docs" -b wt

EXPECTED="$ROOT/.nyron-hub"
fail=0
norm() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]) if sys.argv[1] else "")' "$1"; }
check() {
  if [ "$(norm "$2")" = "$EXPECTED" ]; then echo "  ✅ $1"; else
    echo "  ❌ $1"; echo "     ожидали:  $EXPECTED"; echo "     получили: $2"; fail=1; fi
}

echo "== hub-dir.mjs (сервер) =="
for d in "" /sub-back /sub-docs /.wt-docs; do
  got=$(cd "$ROOT$d" && node -e 'import("'"$PLUGIN"'/hub/hub-dir.mjs").then(m=>console.log(m.resolveHubDir()))' 2>/dev/null)
  check "корень$d" "${got:-НЕТ_МОДУЛЯ}"
done

echo "== hub-watch.sh =="
for d in "" /sub-back /sub-docs /.wt-docs; do
  got=$(cd "$ROOT$d" && bash "$PLUGIN/hub/hub-watch.sh" hubdir 2>/dev/null)
  check "корень$d" "${got:-НЕТ_РЕЖИМА}"
done

echo "== NYRON_HUB_DIR перекрывает всё =="
got=$(cd "$ROOT/sub-back" && NYRON_HUB_DIR=/tmp/forced bash "$PLUGIN/hub/hub-watch.sh" hubdir 2>/dev/null)
if [ "$got" = "/tmp/forced" ]; then echo "  ✅ env-оверрайд"; else echo "  ❌ env-оверрайд: $got"; fail=1; fi

echo "== репо без конфига проекта → фолбэк на корень репо =="
got=$(cd "$ROOT/sub-back" && NYRON_HUB_DIR="" bash -c 'cd "'"$ROOT"'/sub-back" && mv "'"$ROOT"'/.claude" "'"$ROOT"'/.claude-off"; bash "'"$PLUGIN"'/hub/hub-watch.sh" hubdir')
mv "$ROOT/.claude-off" "$ROOT/.claude"
if [ "$(norm "$got")" = "$(norm "$ROOT/sub-back/.nyron-hub")" ]; then echo "  ✅ фолбэк git-репо"; else
  echo "  ❌ фолбэк git-репо: $got"; fail=1; fi

echo
if [ $fail -eq 0 ]; then echo "ВСЁ ЗЕЛЁНОЕ"; else echo "ЕСТЬ ПАДЕНИЯ"; fi
exit $fail
