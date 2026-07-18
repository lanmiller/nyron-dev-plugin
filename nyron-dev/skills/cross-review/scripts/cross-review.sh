#!/usr/bin/env bash
# cross-review.sh — кросс-ревью ветки другой моделью (GPT через codex CLI).
# Клод писал — GPT проверяет. Работает на ChatGPT-подписке, API-ключ не нужен.
#
# Использование:
#   cross-review.sh -C <repo-dir> [-b <base=main>] [-m <model>] [-t <файл-контекста>]
#
#   -C  каталог git-репо (worktree ветки, HEAD = проверяемая ветка)
#   -b  базовая ветка диффа (default: main)
#   -m  модель codex (default: из конфига проекта reviewer.model, иначе дефолт codex)
#   -t  файл с контекстом задачи (тикет: JTBD, DoD, «Как тестировать»)
#
# Выход: вердикт ревьюера в stdout. Первая строка строго
# «ВЕРДИКТ: ПРИНЯТО» или «ВЕРДИКТ: ДОРАБОТКА». Exit code 0 в обоих случаях;
# ненулевой — техническая ошибка (нет codex, нет диффа и т.п.).
set -euo pipefail

REPO="" BASE="main" MODEL="" TICKET_FILE=""
while getopts "C:b:m:t:" opt; do
  case $opt in
    C) REPO=$OPTARG ;;
    b) BASE=$OPTARG ;;
    m) MODEL=$OPTARG ;;
    t) TICKET_FILE=$OPTARG ;;
    *) echo "usage: $0 -C <repo> [-b base] [-m model] [-t ticket-file]" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || { echo "ошибка: -C <repo-dir> обязателен" >&2; exit 2; }
command -v codex >/dev/null || { echo "ошибка: codex CLI не установлен (npm i -g @openai/codex)" >&2; exit 3; }
git -C "$REPO" rev-parse --git-dir >/dev/null || exit 3

MERGE_BASE=$(git -C "$REPO" merge-base "origin/$BASE" HEAD 2>/dev/null || git -C "$REPO" merge-base "$BASE" HEAD)
COMMITS=$(git -C "$REPO" log --oneline "$MERGE_BASE"..HEAD)
[ -n "$COMMITS" ] || { echo "ошибка: нет коммитов относительно $BASE" >&2; exit 4; }

STAT=$(git -C "$REPO" diff --stat "$MERGE_BASE"..HEAD)
DIFF=$(git -C "$REPO" diff "$MERGE_BASE"..HEAD)
# страховка от гигантских диффов: >300KB — ревьюеру уходит стат + просьба
# смотреть файлы самому (codex умеет читать репо в read-only песочнице)
if [ "${#DIFF}" -gt 300000 ]; then
  DIFF="(дифф >300KB, в промт не влез — смотри изменённые файлы прямо в репо; список выше в --stat)"
fi

TICKET_CTX=""
[ -n "$TICKET_FILE" ] && [ -f "$TICKET_FILE" ] && TICKET_CTX=$(cat "$TICKET_FILE")

PROMPT_FILE=$(mktemp)
trap 'rm -f "$PROMPT_FILE"' EXIT
cat > "$PROMPT_FILE" <<EOF
Ты — независимый код-ревьюер. Код писала ДРУГАЯ модель (Claude); твоя ценность —
свежий взгляд: ты ловишь ошибки, которые автор у себя не видит. Проверь ветку
относительно $BASE. Твоя задача — найти РЕАЛЬНЫЕ проблемы, а не придраться.

ПЕРЕД оценкой прочитай каноны проекта: AGENTS.md и/или CLAUDE.md в корне
рабочего каталога (и в подпапках, затронутых диффом, если там есть свои).
Правила оттуда (импорты, логирование, RBAC-паттерны, стиль, запреты) —
обязательный критерий ревью: нарушение канона репо = замечание.

Контекст задачи (тикет):
${TICKET_CTX:-"(не передан — оценивай код сам по себе)"}

Коммиты ветки:
$COMMITS

Изменения (--stat):
$STAT

Полный дифф:
$DIFF

Проверь по убыванию важности:
1. Корректность: баги, сломанные сценарии, регрессии, гонки, краевые случаи.
2. Соответствие DoD тикета (если передан): всё ли обещанное сделано.
3. Безопасность: инъекции, утечки секретов, доступы.
4. Незаметные ловушки: молчаливое проглатывание ошибок, мёртвый код, стейл-кэши.
5. Стиль — ТОЛЬКО если он прячет баг. Вкусовщину не писать.

Формат ответа (по-русски, строго):
Первая строка: «ВЕРДИКТ: ПРИНЯТО» или «ВЕРДИКТ: ДОРАБОТКА».
Дальше при ДОРАБОТКЕ — нумерованный список замечаний: файл:строка — что не так —
чем грозит — как чинить (одной строкой). При ПРИНЯТО — 1-3 строки, что проверил.
Замечания уровня «можно лучше» — отдельным блоком «НЕБЛОКИРУЮЩЕЕ:» (они не
делают вердикт ДОРАБОТКОЙ).
EOF

OUT_FILE=$(mktemp)
MODEL_ARGS=()
[ -n "$MODEL" ] && MODEL_ARGS=(-m "$MODEL")
# ChatGPT-подписка даёт только gpt-5.5 (кодекс/про-варианты и 5.6 — API-only);
# топовость ревью добираем максимальным reasoning effort.
codex exec --sandbox read-only --cd "$REPO" --skip-git-repo-check \
  -c 'model_reasoning_effort="high"' \
  --output-last-message "$OUT_FILE" "${MODEL_ARGS[@]}" - < "$PROMPT_FILE" >&2

cat "$OUT_FILE"
rm -f "$OUT_FILE"
