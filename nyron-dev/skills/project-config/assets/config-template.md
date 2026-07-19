---
# Конфиг проекта для плагина nyron-dev. Канон: .claude/nyron-dev.md (в репо,
# общий для команды, БЕЗ секретов). Личные оверрайды: .claude/nyron-dev.local.md
# (gitignored, тот же формат, значения поверх канона).
project: my-project          # слаг проекта
type: development            # development (код) | research (данные/гипотезы)
storage: jira                # jira | files — где живут задачи
workers: code                # code | data — чем занимаются рабочие волны

jira:                        # для storage: jira
  site: example.atlassian.net
  project_key: DEV
  mcp_server: jira-nyron     # имя MCP-сервера Jira в .mcp.json проекта

files:                       # для storage: files
  tasks_dir: _tasks          # куда класть задачи-файлы (от корня проекта)

docs_dir: docs               # папка эпиков/спек (от корня проекта)

models:                      # карта моделей по ролям конвейера
  thinker: fable             # продумать сложное — точечно
  dispatcher: opus           # диспетчер волн
  code: opus                 # написание кода
  search: sonnet             # обработка/поиск/ресёрч
  mass: haiku                # массовые однотипные операции

reviewer:                    # кросс-ревью другой моделью («кто писал — тот не проверяет»)
  engine: codex              # codex (CLI, ChatGPT-подписка) | none
  model: gpt-5.6             # пусто = дефолт codex

flows: []                    # РЕАЛЬНЫЕ режимы/флоу продукта, трогающие общие данные
                             # (например: create, restart/переиспользование, edit,
                             # publish→use). Эту карту получают Sol-ревьюер и
                             # план-челлендж для проверки смежных узлов — держать
                             # актуальной, вписывать только существующий функционал.

roles:                       # оверрайды ролевых карточек team-roles (все опциональны)
  product:
    model: fable
    context:                 # «куда конкретно смотреть» в ЭТОМ проекте
      - docs/
    notes: ""                # проектные особенности роли, 1-3 строки
  ux-designer:
    enabled: true
  data-analyst:
    enabled: false           # в кодовых проектах обычно выключен
  tech-lead:
    model: opus
  sre-lead:
    enabled: true
  qa:
    enabled: true
---

# Заметки проекта для агентов

Свободный текст ниже фронтматтера: специфика проекта, которую должны знать
все роли (стек, стенды, запреты, ссылки на канон-доки). Коротко, по делу.
