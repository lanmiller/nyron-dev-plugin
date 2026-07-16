# nyron-dev-plugin — маркетплейс плагина команды AI Evolve / Nyron

Подключение:
- **Claude Desktop**: Settings → Plugins → Add → Add from a repository →
  `git@gitlab.com:your2563006/nyron-dev-plugin.git` → установить плагин `nyron-dev`.
- **Claude Code**: `claude --plugin-dir <путь-клона>/nyron-dev` или
  `/plugin marketplace add git@gitlab.com:your2563006/nyron-dev-plugin.git`.

Канон плагина живёт здесь; описание скиллов — `nyron-dev/README.md`.

## Установка

- **Claude Desktop**: Settings → Plugins → Add → Add from a repository →
  `lanmiller/nyron-dev-plugin` → установить плагин `nyron-dev`.
- **Claude Code**: `/plugin marketplace add https://github.com/lanmiller/nyron-dev-plugin`
  или `claude --plugin-dir <клон>/nyron-dev`.

Канон — GitLab `your2563006/nyron-dev-plugin`; он push-зеркалится в GitHub
`lanmiller/nyron-dev-plugin` автоматически (Desktop-синк берёт с GitHub).
Правки пушить только в GitLab.

## Правило версий (для всех, кто правит плагин)

Любая правка содержимого плагина = бамп `version` в
`nyron-dev/.claude-plugin/plugin.json` **тем же коммитом** (semver: фикс —
patch, новый скилл/секция — minor, слом конвенций — major). Без бампа
маркетплейс-синк не покажет команде обновление.
