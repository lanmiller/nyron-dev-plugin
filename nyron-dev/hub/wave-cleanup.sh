#!/bin/sh
# wave-cleanup.sh — вторая половина жизненного цикла волны: уборка worktree и
# веток после закрытия пачки (STOVP-37). Диспетчер зовёт на закрытии пачки/волны,
# вывод кладёт в отчёт волны. Создание worktree и его удаление — парные шаги;
# уборка держится не на добросовестности сессий, а на этом прогоне.
#
# Использование:
#   wave-cleanup.sh [--apply] [--archive] [--no-fetch] [--root <путь>]
#                   [--closed DEV-1,DEV-2] [--protect a,b] [репо ...]
#
#   (без ключей)   — режим отчёта: НИЧЕГО не меняет, печатает вердикты
#                    MERGED / STALE / ЦЕННОЕ и что удалил бы
#   --apply        — удаляет ТОЛЬКО безопасное: чистый worktree + влитая ветка
#                    (worktree remove → worktree prune → branch -d, только -d).
#                    Незакоммиченное и невлитое НЕ удаляется — уходит в отчёт.
#   --archive      — ставит архив-тег archive/<ветка>-<дата> на ЦЕННОЕ
#                    (коммиты не потеряются, если ветку потом снесут руками)
#   --no-fetch     — не делать git fetch --prune (офлайн / ускорение)
#   --root <путь>  — корень проекта (по умолчанию cwd)
#   --closed       — номера закрытых тикетов через запятую: сверка
#                    «тикет закрыт ↔ ветки влиты». В Jira скрипт НЕ ходит —
#                    список номеров даёт диспетчер.
#   --protect      — дополнительные защищённые ветки через запятую
#   репо ...       — git-репо (путь от корня или абсолютный); без аргументов —
#                    известный список (переопределяется env NYRON_WAVE_REPOS)
#
# Защищённые зоны (не трогаются НИКОГДА, даже с --apply):
#   main, master, prod2, nyron, develop и catalog/** (правки каталога — только
#   по согласованию с методологом).
#
# Протокол аудита (перенесён из STOVP-36): fetch --prune → git cherry (ловит
# rebase/squash, в отличие от branch --merged) → rev-list --left-right --count
# (ЯВНО: left = ahead ветки, right = behind от базы) → worktree-инвентарь.
#
# Коды возврата: 0 — чисто; 1 — есть остатки/расхождения (строки в отчёт волны);
# 2 — ошибка использования или окружения.
set -u

PLUGIN_ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARGV="$*"

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

# Техническая ошибка (не вердикт: у остатков exit 1) уходит машинным событием
# в будку — STOVP-41, чтобы разбор процесса видел поломки инструмента.
report_fail() {
  [ "$1" -lt 2 ] && return 0
  [ -f "$PLUGIN_ROOT/hooks/error-report.sh" ] &&
    sh "$PLUGIN_ROOT/hooks/error-report.sh" "hub:wave-cleanup" "exit=$1 | $ARGV"
  return 0
}
trap 'report_fail $?' EXIT

APPLY=0; ARCHIVE=0; FETCH=1; ROOT=""; CLOSED=""; EXTRA_PROTECT=""; REPOS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)    APPLY=1 ;;
    --archive)  ARCHIVE=1 ;;
    --no-fetch) FETCH=0 ;;
    --root)     shift; ROOT="${1:-}" ;;
    --closed)   shift; CLOSED="${1:-}" ;;
    --protect)  shift; EXTRA_PROTECT="${1:-}" ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "wave-cleanup: неизвестный ключ $1" >&2; usage >&2; exit 2 ;;
    *)          REPOS="$REPOS $1" ;;
  esac
  shift || break
done

[ -n "$ROOT" ] || ROOT=$(pwd)
[ -d "$ROOT" ] || { echo "wave-cleanup: нет каталога корня: $ROOT" >&2; exit 2; }
DEFAULT_REPOS=". ai-evolve-back ai-evolve-front n8n ai-evolve-docs-test canvas-mcp-server"
[ -n "$REPOS" ] || REPOS="${NYRON_WAVE_REPOS:-$DEFAULT_REPOS}"
REPOS=$(printf '%s' "$REPOS" | tr ',' ' ')
TODAY=$(date +%Y-%m-%d)

TMP=$(mktemp -d) || { echo "wave-cleanup: mktemp не сработал" >&2; exit 2; }
trap 'rm -rf "$TMP"; report_fail $?' EXIT

WT_SEEN=0; WT_DEL=0; BR_DEL=0; LEFT=0; MISM=0; VALU=0

is_protected() { # <ветка>
  case "$1" in
    main|master|prod2|nyron|develop|HEAD) return 0 ;;
    catalog/*) return 0 ;;
  esac
  for _p in $(printf '%s' "$EXTRA_PROTECT" | tr ',' ' '); do
    [ "$1" = "$_p" ] && return 0
  done
  return 1
}

base_ref() { # <репо> → origin/main | origin/master | main | master
  for _b in origin/main origin/master main master; do
    git -C "$1" rev-parse --verify -q "$_b" >/dev/null 2>&1 && { echo "$_b"; return 0; }
  done
  return 1
}

verdict() { # <репо> <ref> <база> → "MERGED|STALE|VALUABLE|UNKNOWN <кол-во своих коммитов>"
  # ahead = коммиты ветки, которых нет в базе по sha; git cherry поверх этого
  # ловит вливание через squash/rebase (патч в базе есть, sha другой).
  _ahead=$(git -C "$1" rev-list --count "$3..$2" 2>/dev/null) || { echo "UNKNOWN 0"; return; }
  [ -n "$_ahead" ] || { echo "UNKNOWN 0"; return; }
  if [ "$_ahead" -eq 0 ]; then
    if [ "$(git -C "$1" rev-parse "$2" 2>/dev/null)" = "$(git -C "$1" rev-parse "$3" 2>/dev/null)" ]
    then echo "STALE 0"       # пустышка: ветка стоит ровно на базе, своего нет
    else echo "MERGED 0"; fi  # влито обычным мержем
    return
  fi
  _plus=$(git -C "$1" cherry "$3" "$2" 2>/dev/null | grep -c '^+')
  if [ "$_plus" -gt 0 ]; then echo "VALUABLE $_plus"
  else                        echo "MERGED $_ahead"; fi  # squash/rebase-мерж
}

ahead_behind() { # <репо> <ref> <база> → "ahead behind" (left=ahead — не перепутать)
  git -C "$1" rev-list --left-right --count "$2...$3" 2>/dev/null | tr '\t' ' '
}

short() { # <путь> → путь от корня проекта (чтобы отчёт читался в комменте Jira)
  case "$1" in
    "$ROOT"/*) printf '%s' "${1#"$ROOT"/}" ;;
    *)         printf '%s' "$1" ;;
  esac
}

leftover() { # <метка> <текст>
  printf '  [%s] %s\n' "$1" "$2"
  printf '%s | %s\n' "$1" "$2" >> "$TMP/left"
  LEFT=$((LEFT + 1))
}

archive_tag() { # <репо> <ветка>
  [ "$ARCHIVE" -eq 1 ] || return 0
  _tag="archive/$(printf '%s' "$2" | tr '/' '-')-$TODAY"
  git -C "$1" rev-parse --verify -q "refs/tags/$_tag" >/dev/null 2>&1 && return 0
  if git -C "$1" tag "$_tag" "$2" >/dev/null 2>&1; then
    printf '        архив-тег: %s\n' "$_tag"
  fi
}

drop_branch() { # <репо> <ветка> <человекочитаемое-имя-репо>
  if [ "$APPLY" -eq 0 ]; then
    printf '        → удалил бы ветку %s\n' "$2"
    return 0
  fi
  if git -C "$1" branch -d "$2" >/dev/null 2>&1; then
    printf '        ветка %s удалена (-d)\n' "$2"
    BR_DEL=$((BR_DEL + 1))
  else
    leftover "ОСТАТОК" "$3: ветка $2 — git отказал в -d (обычно squash/rebase-мерж); снести руками после архив-тега: git -C <репо> tag archive/$(printf '%s' "$2" | tr '/' '-')-$TODAY $2"
  fi
}

echo "== wave-cleanup ($([ "$APPLY" -eq 1 ] && echo 'РЕЖИМ --apply: удаляем безопасное' || echo 'режим отчёта: ничего не меняем')) =="
echo "   корень: $ROOT"

for rel in $REPOS; do
  case "$rel" in
    /*) repo=$rel ;;
    .)  repo=$ROOT ;;
    *)  repo="$ROOT/$rel" ;;
  esac
  [ -d "$repo" ] || continue
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || continue
  if ! base=$(base_ref "$repo"); then
    printf '\n== %s — базовой ветки (origin/main|main) нет, пропуск\n' "$rel"
    continue
  fi
  if [ "$FETCH" -eq 1 ] && git -C "$repo" remote | grep -q .; then
    git -C "$repo" fetch --prune --quiet >/dev/null 2>&1 || true
  fi
  printf '\n== %s  (база %s)\n' "$rel" "$base"

  : > "$TMP/wtb"
  git -C "$repo" worktree list --porcelain > "$TMP/wt" 2>/dev/null || : > "$TMP/wt"
  printf '\n' >> "$TMP/wt"
  main_wt=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)
  p=""; b=""; prunable=0
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)          p=${line#worktree }; b=""; prunable=0; continue ;;
      "branch refs/heads/"*) b=${line#branch refs/heads/}; continue ;;
      "prunable"*)           prunable=1; continue ;;
      "")                    ;;
      *)                     continue ;;
    esac

    [ -n "$p" ] || continue
    [ "$p" = "$main_wt" ] && { p=""; continue; }
    WT_SEEN=$((WT_SEEN + 1))
    [ -n "$b" ] && echo "$b" >> "$TMP/wtb"

    if [ "$prunable" -eq 1 ] || [ ! -d "$p" ]; then
      printf '  [STALE] worktree %s — каталога нет, битая привязка\n' "$(short "$p")"
      [ "$APPLY" -eq 1 ] && git -C "$repo" worktree prune >/dev/null 2>&1
      p=""; continue
    fi
    if [ -z "$b" ]; then
      leftover "ЦЕННОЕ" "$rel: worktree $(short "$p") — detached HEAD, ветки нет: разобрать руками"
      p=""; continue
    fi
    if is_protected "$b"; then
      printf '  [ЗАЩИЩЕНО] worktree %s ветка %s — не трогаем\n' "$(short "$p")" "$b"
      p=""; continue
    fi

    dirty=$(git -C "$p" status --porcelain 2>/dev/null | grep -c .)
    set -- $(verdict "$repo" "$b" "$base"); v=$1; n=$2
    if [ "$dirty" -gt 0 ]; then
      leftover "ЦЕННОЕ" "$rel: worktree $(short "$p") (ветка $b) — незакоммиченных файлов: $dirty, НЕ удалён"
      archive_tag "$repo" "$b"
      p=""; continue
    fi
    case "$v" in
      VALUABLE)
        leftover "ЦЕННОЕ" "$rel: ветка $b (worktree $(short "$p")) — невлитых коммитов: $n, ahead/behind: $(ahead_behind "$repo" "$b" "$base"), НЕ удалено"
        archive_tag "$repo" "$b"
        p=""; continue ;;
      UNKNOWN)
        leftover "ОСТАТОК" "$rel: ветка $b (worktree $(short "$p")) — вердикт не вычислен"
        p=""; continue ;;
    esac

    printf '  [%s] worktree %s ветка %s — чисто, влито\n' "$v" "$(short "$p")" "$b"
    if [ "$APPLY" -eq 0 ]; then
      printf '        → удалил бы worktree и ветку\n'
      p=""; continue
    fi
    if git -C "$repo" worktree remove "$p" >/dev/null 2>&1; then
      printf '        worktree удалён\n'
      WT_DEL=$((WT_DEL + 1))
      git -C "$repo" worktree prune >/dev/null 2>&1
      drop_branch "$repo" "$b" "$rel"
    else
      leftover "ОСТАТОК" "$rel: worktree $(short "$p") — git worktree remove отказал (без --force не сносим)"
    fi
    p=""
  done < "$TMP/wt"

  cur=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
  git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads > "$TMP/heads" 2>/dev/null || : > "$TMP/heads"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    [ "$b" = "$cur" ] && continue
    grep -qx "$b" "$TMP/wtb" 2>/dev/null && continue
    is_protected "$b" && { printf '  [ЗАЩИЩЕНО] ветка %s — не трогаем\n' "$b"; continue; }
    set -- $(verdict "$repo" "$b" "$base"); v=$1; n=$2
    case "$v" in
      VALUABLE)
        VALU=$((VALU + 1))
        printf '  [ЦЕННОЕ] ветка %s без worktree — невлитых коммитов: %s (ahead/behind: %s), не трогаем\n' \
          "$b" "$n" "$(ahead_behind "$repo" "$b" "$base")"
        archive_tag "$repo" "$b" ;;
      UNKNOWN)
        leftover "ОСТАТОК" "$rel: ветка $b — вердикт не вычислен" ;;
      *)
        printf '  [%s] ветка %s без worktree — влито\n' "$v" "$b"
        drop_branch "$repo" "$b" "$rel" ;;
    esac
  done < "$TMP/heads"

  [ -n "$CLOSED" ] || continue
  printf '  -- сверка «тикет закрыт ↔ ветки влиты»\n'
  git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads refs/remotes > "$TMP/allrefs" 2>/dev/null || : > "$TMP/allrefs"
  for t in $(printf '%s' "$CLOSED" | tr ',' ' '); do
    num=${t##*-}
    found=0
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      case "$r" in */HEAD|HEAD) continue ;; esac
      printf '%s\n' "$r" | grep -qiE "(^|[^0-9a-zA-Z])($t|$num)([^0-9]|\$)" || continue
      found=1
      set -- $(verdict "$repo" "$r" "$base"); v=$1; n=$2
      case "$v" in
        VALUABLE)
          MISM=$((MISM + 1))
          leftover "РАСХОЖДЕНИЕ" "$rel: тикет $t закрыт, а ветка $r НЕ влита — невлитых коммитов: $n (ahead/behind: $(ahead_behind "$repo" "$r" "$base"))" ;;
        UNKNOWN)
          leftover "ОСТАТОК" "$rel: тикет $t, ветка $r — вердикт не вычислен" ;;
        *)
          printf '     %s: ветка %s влита\n' "$t" "$r" ;;
      esac
    done < "$TMP/allrefs"
    [ "$found" -eq 0 ] && printf '     %s: веток не найдено (влито и удалено либо ветки не было)\n' "$t"
  done
done

echo
echo "== ИТОГ =="
printf '   worktree осмотрено: %s, удалено: %s; веток удалено: %s\n' "$WT_SEEN" "$WT_DEL" "$BR_DEL"
printf '   ценных веток без worktree (не трогаем): %s\n' "$VALU"
if [ "$LEFT" -gt 0 ]; then
  printf '   остатки и расхождения — В ОТЧЁТ ВОЛНЫ (%s):\n' "$LEFT"
  sed 's/^/     - /' "$TMP/left"
  [ "$MISM" -gt 0 ] && printf '   ВНИМАНИЕ: расхождений «тикет закрыт ↔ ветка не влита»: %s\n' "$MISM"
  exit 1
fi
echo "   остатков нет: worktree чист, ветки закрытых тикетов убраны"
exit 0
