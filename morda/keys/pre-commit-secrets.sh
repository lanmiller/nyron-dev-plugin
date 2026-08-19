#!/bin/sh
# Замок на коммит (STOVP-59, гриль 18.08): не даёт закоммитить значение
# секрета — ловим ДО попадания в git-историю, а не ротируем ПОСЛЕ.
# Ставится в .git/hooks/pre-commit строкой:
#   exec sh "<клон-плагина>/morda/keys/pre-commit-secrets.sh"
# Паттерны — те же, что у верификатора паспорта (passport.js SECRET_RE).

PATTERN='ATATT[A-Za-z0-9_=.-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|://[^ /@]*:[^ /@]\{6,\}@'

# 1) файлы из ключницы в коммит не попадают вообще
staged_secrets=$(git diff --cached --name-only | grep -E '(^|/)\.secrets/' || true)
if [ -n "$staged_secrets" ]; then
  echo "pre-commit: в коммите файлы ключницы — им нельзя в git:" >&2
  echo "$staged_secrets" >&2
  echo "сними их: git restore --staged <файл>; проверь .gitignore (.secrets/)" >&2
  exit 1
fi

# 2) добавляемые строки не содержат значений секретов
hits=$(git diff --cached -U0 | grep -E '^\+' | grep -E "$PATTERN" || true)
if [ -n "$hits" ]; then
  echo "pre-commit: в добавляемых строках похоже на ЗНАЧЕНИЕ секрета:" >&2
  echo "$hits" | head -5 | sed 's/\(.\{60\}\).*/\1…/' >&2
  echo "значения живут в .secrets/ (ключница), в git — только указатели." >&2
  echo "это ложное срабатывание — закоммить с git commit --no-verify и скажи, поправим паттерн." >&2
  exit 1
fi

exit 0
