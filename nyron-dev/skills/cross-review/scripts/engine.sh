# engine.sh — выбор ревьюера КРЕСТ-НАКРЕСТ по автору кода. Подключается
# (source) из cross-review.sh и plan-challenge.sh — один механизм на оба.
#
# Канон «кто писал — тот не проверяет» (решение CTO 06.09.2026):
#   писал Claude  → проверяет GPT   (codex exec,  дефолт gpt-6-astra / Astra);
#   писал codex   → проверяет Claude (claude -p,  дефолт fable / Fable).
#
# Вход (переменные вызывающего скрипта):
#   ENGINE        codex | claude | auto (пусто = auto)
#   MODEL         модель codex (-m), пусто = gpt-6-astra
#   CLAUDE_MODEL  модель claude (-M), пусто = fable
#   EFFORT        low | medium | high (усилие обеих сторон)
#   REPO PROMPT_FILE OUT_FILE ERR_FILE TAG
# Выход: ENGINE (разрешён), AUTHOR / REVIEWER (для промта), engine_run.
#
# auto — по окружению вызывающей сессии: команды из codex идут с
# CODEX_SANDBOX / CODEX_THREAD_ID / CODEX_SESSION_ID в env (проверено фактом
# на codex-cli 0.153.4) → автор codex → ревьюер claude; иначе (Claude Code:
# CLAUDECODE=1, или голый терминал) — прежнее поведение, ревьюер codex.

engine_resolve() {
  case "${ENGINE:-auto}" in
    codex|claude) ;;
    auto|"")
      if [ -n "${CODEX_THREAD_ID:-}${CODEX_SANDBOX:-}${CODEX_SESSION_ID:-}" ]; then ENGINE=claude; else ENGINE=codex; fi ;;
    *) echo "ошибка: -e принимает codex, claude или auto" >&2; exit 2 ;;
  esac
  if [ "$ENGINE" = codex ]; then
    AUTHOR="Claude"; REVIEWER="GPT"
    command -v codex >/dev/null || { echo "ошибка: codex CLI не установлен (npm i -g @openai/codex)" >&2; exit 3; }
    [ -n "${MODEL:-}" ] || MODEL="gpt-6-astra"
  else
    AUTHOR="GPT (codex)"; REVIEWER="Claude"
    command -v claude >/dev/null || { echo "ошибка: claude CLI не установлен" >&2; exit 3; }
    [ -n "${CLAUDE_MODEL:-}" ] || CLAUDE_MODEL="fable"
  fi
}

# codex: read-only песочница, промт со stdin, ответ — в OUT_FILE.
run_codex() {
  codex exec --sandbox read-only --cd "$REPO" --skip-git-repo-check \
    -c "model_reasoning_effort=\"$EFFORT\"" \
    --output-last-message "$OUT_FILE" "$@" - < "$PROMPT_FILE" >&2 2>"$ERR_FILE"
}

# claude: только инструменты чтения (Read/Grep/Glob), без MCP и без записи
# сессии; «$@» — необязательный --model. Ответ (stdout) — в OUT_FILE.
run_claude() {
  ( cd "$REPO" && claude -p --effort "$EFFORT" \
      --tools Read Grep Glob --allowedTools Read Grep Glob \
      --permission-mode dontAsk --no-session-persistence --strict-mcp-config \
      --output-format text "$@" < "$PROMPT_FILE" > "$OUT_FILE" 2>"$ERR_FILE" )
}

# Прогон с авто-фолбэком: модель недоступна аккаунту (codex: 400 «model is not
# supported») — повтор на дефолтной модели аккаунта. Возвращает 1, если не
# отработал и фолбэк.
engine_run() {
  if [ "$ENGINE" = codex ]; then
    run_codex -m "$MODEL" && return 0
    echo "$TAG: модель $MODEL недоступна аккаунту — фолбэк на дефолт codex" >&2
    run_codex
  else
    run_claude --model "$CLAUDE_MODEL" && return 0
    echo "$TAG: claude -p с моделью $CLAUDE_MODEL не отработал — фолбэк на дефолт claude" >&2
    run_claude
  fi
}
