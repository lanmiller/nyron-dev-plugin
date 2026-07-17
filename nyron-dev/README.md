# nyron-dev — плагин команды AI Evolve / Nyron

Операционка команды в Claude Code / Claude Desktop: как ставим задачи, как
грумим и массово закрываем эпики волнами, как тестируем живьём и как передаём QA.

## Скиллы

| Скилл | Когда | Что делает |
|---|---|---|
| `jira-task-standard` | заведение/груминг любого тикета | стандарт задачи: JTBD, MECE, McKinsey-стиль, два слоя, DoD, «Как тестировать»; приём бизнес-задач; суперповеры в флоу |
| `nyron-waves` | массовое закрытие тикетов эпика | сессия-диспетчер: груминг → волны отдельными сессиями через /goal-чипы → Jira-шина ревью → мерж пачкой |
| `live-epic-testing` | ручная приёмка эпика живьём | пользователь кликает, сессия мониторит все слои, посекундная разметка, карта флоу, находка = тикет |
| `qa-handoff` | эпик закрыт, передаём QA | сборка одного понятного QA-тикета приёмки (чек-лист из «Как тестировать», материалы для автотестов) |

Жизненный цикл эпика: **бизнес-задача → jira-task-standard (декомпозиция,
стандарт) → nyron-waves (закрытие волнами) ⇄ live-epic-testing (живая
диагностика) → qa-handoff (приёмка QA) → эпик закрыт**.

## Установка

Плагин живёт в отдельном репо (канон — GitLab `your2563006/nyron-dev-plugin`,
зеркало — GitHub `lanmiller/nyron-dev-plugin`); детали — README корня репо.

```bash
# Claude Desktop: Settings → Plugins → Add from a repository →
#   lanmiller/nyron-dev-plugin → установить nyron-dev

# Claude Code (терминал):
/plugin marketplace add https://github.com/lanmiller/nyron-dev-plugin
# или локальным клоном:
claude --plugin-dir <клон>/nyron-dev
```

Требования:
- **Плагинный Atlassian MCP** (`plugin:atlassian`) с грантом на
  nyron.atlassian.net — на нём вся шина; другие Atlassian-коннекторы профиля
  без гранта на nyron не годятся (скиллы проверяют это первым ходом);
- git по SSH-ключам к репо проекта (токены не нужны);
- опционально: плагин `superpowers` (brainstorming/writing-plans на груминге);
- опционально: Atlassian REST API-токен в `~/psylia-secrets` — ускоритель
  Jira-вотчеров диспетчера (дефолт плагина — бес-токенный).

## Конвенции (сквозные)

- Jira — единственная шина коммуникации: брифы, отчёты, вердикты — комментами.
- Папка эпика: `ai-evolve-docs-test/waves/<DEV-эпик>-<слаг>/` — всё длиннее
  коммента файлами, в тикет — ссылка.
- Канон правил волн: `ai-evolve-docs-test/shared/wave-rules.md` (восстановимо
  из `skills/nyron-waves/assets/wave-rules-template.md`).
- Язык — русский; секреты в тикеты и чипы не вписываются.
