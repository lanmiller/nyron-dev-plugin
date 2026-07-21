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

## Трек изменений

История версий — [CHANGELOG.md](CHANGELOG.md). Бамп версии = запись там же,
тем же коммитом.

## Правило версий (для всех, кто правит плагин)

Любая правка содержимого плагина = бамп `version` **тем же коммитом** и
**в ДВУХ местах**: `nyron-dev/.claude-plugin/plugin.json` И запись плагина в
`.claude-plugin/marketplace.json` (semver: фикс — patch, новый скилл/секция —
minor, слом конвенций — major). Desktop-синк детектит обновления по манифесту
маркетплейса: без версии там он обновления НЕ видит, даже если plugin.json
бампнут (проверено на 0.1.3). Проверка согласованности: `claude plugin validate .`

## Известные грабли

- **Плагин «не обновляется» / рассинхрон версий**: локальный клон маркетплейса
  (`~/.claude/plugins/marketplaces/nyron-dev-marketplace-v2`) сам НЕ фетчится —
  он залипает на коммите установки, и ни `/reload-skills`, ни UI-Sync его не
  двигают. Проверенный рецепт обновления (проверено на 0.1.1 → 0.1.3):

  ```bash
  claude plugin marketplace update nyron-dev-marketplace-v2
  claude plugin update nyron-dev@nyron-dev-marketplace-v2
  # затем перезапустить сессию/приложение (Restart to apply changes)
  ```

  Диагностика залипания: `grep version
  ~/.claude/plugins/marketplaces/nyron-dev-marketplace-v2/nyron-dev/.claude-plugin/plugin.json`
  против версии в репо. Пока рассинхрон не устранён, канон правил волн читать
  из `ai-evolve-docs-test/shared/wave-rules.md` (синкается коммитом релиза).
