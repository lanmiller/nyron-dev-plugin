---
# Конфиг проекта для плагина nyron-dev. Канон: .claude/nyron-dev.md (в репо,
# общий для команды, БЕЗ секретов). Личные оверрайды: .claude/nyron-dev.local.md
# (gitignored, тот же формат, значения поверх канона).
project: my-project          # слаг проекта
plugin_version: "0.3.0"      # под какую версию nyron-dev написан конфиг
type: development            # development (код) | research (данные/гипотезы)
storage: jira                # jira | files — где живут задачи
workers: code                # code | data — чем занимаются рабочие волны

jira:                        # для storage: jira (трекер задач)
  site: example.atlassian.net
  project_key: DEV
  mcp_server: jira-nyron     # имя MCP-сервера Jira в .mcp.json проекта

  routes:                    # отдел → куда уходит работа. Значение — ключ проекта
    dev: DEV                 # трекера, доска, канал или папка: набор отделов НЕ
                             # жёсткий (у одного продукта dev+design+crm, у другого
                             # один общий скоуп). Блоки «требования по отделам» в
                             # шаблонах строятся ИЗ ЭТОЙ КАРТЫ, а не хардкодом.

  issue_types:               # как типы названы на этой доске (имена различаются!)
    task: "Задание"
    bug: "Баг"
    subtask: "Subtask"
    epic: "Эпик"

  labels: [front, back, agent, infra]   # лейблы зон проекта

  statuses:                  # человеческие имена статусов лестницы; transition id
    backlog: "Бэклог"        # всегда получать по месту (getTransitionsForJiraIssue),
    in_progress: "В работе"  # ориентир — категория new / indeterminate / done
    review: "Тестирование"
    done: "Готово"

files:                       # пути артефактов (нужны и при storage: jira)
  tasks_dir: _tasks          # задачи-файлы (только storage: files)
  requirements_dir: docs/requirements   # файлы-требования (скилл feature-intake)
  hypotheses_dir: docs/hypotheses       # карточки гипотез (скилл product-flow)

docs_dir: docs               # папка доков/спек (от корня проекта)
epic_folder: "docs/epics/{key}-{slug}" # шаблон папки эпика: {key} — ключ эпика,
                             # {slug} — слаг. Сюда кладётся всё длиннее коммента.
hypothesis_folder: "docs/hypotheses/{id}-{slug}"   # пакет гипотезы: карточка,
                             # расчёт, ресёрч, замер. {id} — идентификатор гипотезы.

canon_dir: docs/canon        # память продукта: атомарные файлы по доменам
canon_index: docs/canon/INDEX.md   # индекс канона. Пополняется шагами product-flow
                             # (замер → метрики, раскатка → реестр, вердикт → инсайты),
                             # а не отдельной рутиной. Дисциплина устаревания:
                             # значение · дата · источник; старое → «проверить».

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
    card: ""                 # путь к проектной роль-карточке, если роли нет в плагине
    method: ""               # скилл, которым роль работает (напр. deep-research)
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

x_myproject:                 # ЗАРЕЗЕРВИРОВАННЫЙ неймспейс проектных доп-полей
                             # (x_<слаг>): чтобы не столкнуться с новыми полями плагина
  after_plugin_update:       # чек-лист сверки при бампе plugin_version
    - "сверить схему с skills/project-config/assets/config-template.md"
    - "проверить, не завёл ли плагин роли/скиллы, для которых тут костыль (card/method)"
    - "проверить дефолты roles.* и models.*"
---

# Заметки проекта для агентов

Свободный текст ниже фронтматтера: специфика проекта, которую должны знать
все роли (стек, стенды, запреты, ссылки на канон-доки). Коротко, по делу.
