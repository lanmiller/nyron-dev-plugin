# HANDOFF — состояние на 09.08.2026 (вечер, перед этапом 4 морды)

Точка входа для новой сессии / после /compact. Читать в порядке:
[VISION.md](VISION.md) — зачем; [docs/SYSTEM.md](docs/SYSTEM.md) — канон
процесса и системы; [docs/specs/2026-08-08-morda-pult.md](docs/specs/2026-08-08-morda-pult.md) —
спека морды (нормативная); этот файл — что сделано и что дальше.
Прежний хендофф (до 05.08, пилот флоу) — в истории git этого файла.

**Рамка сессии**: плагин и система STOVP. Продуктовые дефекты проектов —
не сюда (у них свои диспетчеры).

## Промпт восстановления (вставить первым сообщением)

> Продолжаем этап 4 морды по спеке `docs/specs/2026-08-08-morda-pult.md`
> (раздел «Порядок строительства», п.4 — там требования CTO дословно).
> Прочитай HANDOFF.md и спеку. Начни с `/refero:refero-design` —
> дизайн-лок Claude Code. Цикл: red → код → Sol (фоновый codex exec,
> 3 раунда до ПРИНЯТО) → релиз. Морда живёт в `morda/`, dev-сервер:
> `cd morda && npm run dev` → http://127.0.0.1:4747.

## Что построено и работает (всё в бою, всё через Sol до ПРИНЯТО)

| Кусок | Релиз | Где |
|---|---|---|
| Маршрут работы: доска DEV перестроена (Дизайн-проектирование → … → Ревью → ГкТ(QA) → … → Готово(QA) → Готово в прод), формы задач 7 / эпиков 8 разделов, метки `code:*`, вердикт@SHA | 0.8.24 | скиллы + `ai-evolve-docs-test/shared/work-route.md` + `docs/SYSTEM.md` |
| Автомат ask/decision в будке: open→answered→delivered→acknowledged, идемпотентность, дедуп, штамп базы `repo@sha` в каждом сообщении | 0.8.25 | `nyron-dev/hub/` (hub-db.mjs, server.mjs), тест `hub-ask-test.sh` (30) |
| Haiku-надзиратель: состояния сессий каждые 5 мин (launchd `com.nyron.watchdog.c9b73e3f`), заглушки-ask за молчунов, слепота видима | 0.8.26 | `nyron-dev/hub/watchdog*.{mjs,sh}`, тест 17; закрыл STOVP-42 |
| Морда этап 3: вкладки проектов, «Ждут вас» (ответ кликом), «Идёт работа» (watch), шина, кнопки открытия копий приложения | коммиты до `5b78099` | `morda/` (SvelteKit; fleet.js — тонкий слой, hub.db мимо него не читать) |

Живьём доказано 09.08: полный межкопийный цикл решения за 6 минут
(copy-1), перекличка флота (copy-2/4 + psylia-florange в своей будке),
сторож сам завёл ask за молчунов (включая нашу сессию), CTO ответил из
морды кликом.

## Этап 4 — что делать (требования CTO дословно — в спеке, п.4)

1. `/refero:refero-design` ПЕРВЫМ ходом — лок на дизайн Claude Code,
   перекраска всей морды (CTO: «дизайн не с Refero — от чата GPT» 😄).
2. Клик по карточке ask ИЛИ строке сессии в «Идёт работа» → окно сессии:
   весь разговор из транскрипта `~/.claude/projects/<munged-root>/*.jsonl`
   (маркдаун + плашки инструментов + дерево субагентов).
3. Ответ прямо в чат: tmux-сессии — send-keys мгновенно; Desktop-окна —
   зеркало без ввода + кнопка «открыть копию» (в чужое живое окно писать
   нельзя — гонка двух рук).
4. Статус доставки на карточке (answered/delivered/acknowledged + время).
5. Исследовать: deep-link `claude://` (схема есть у приложений, формат
   сессионных ссылок недокументирован) + реестр сессия↔копия.
6. Паритет Desktop-чата: вложения в worktree сессии, обозреватель файлов.

## Карта машины CTO

- Копии Claude: `/Applications/Claude (Main stovpet|Psylia - florange|stovpe3tt|stovpe4tt).app` + `Claude.app`;
  цифра иконки = цифра аккаунта (память `subscriptions-pool.md`).
  Main stovpet = CLI/headless/сторож.
- Будки: `<проект>/.nyron-hub/hub.db` (ai-evolve, psylia, betzo,
  noproblemo); морда читает их через `morda/projects.json` (gitignored).
- Сторож: launchd каждые 300с, лог `~/Library/Logs/com.nyron.watchdog.*`.
- Плагин-репо remote: GitHub HTTPS (`lanmiller/nyron-dev-plugin`, токен в
  Keychain; SSH-ключа от GitHub на машине НЕТ). Marketplace-клон
  `~/.claude/plugins/marketplaces/nyron-dev-marketplace-v2` — git pull
  после каждого пуша.

## Хвосты (не блокеры этапа 4)

- SQL-LIMIT в `hub-db.asks()` — перф-долг (полный SELECT каждые 5с
  поллинга; Sol СПОРНО).
- psylia-конфиг на `plugin_version 0.6.1` — контур отстал, догнать.
- JQL-фильтры команды со старым именем «Готово к тестированию (Ревью)».
- Ревью CTO документов SYSTEM.md + спеки — формально черновики.
- PILOT.md: 4 неразобранных находки (разбор у CTO раз в неделю).
- Копии 1–2: аккаунты stovpe1tt/stovpe2tt по схеме, тултипом не
  подтверждены.

## Каноны, которые легко забыть после компакта

- Sol-ревью: только фоновый `codex exec --sandbox read-only` с выводом в
  файл скратчпада (НЕ MCP-тулом — виснет); до 3 раундов до ПРИНЯТО.
- Тесты будки: `bash nyron-dev/hub/{hub-ask,watchdog,hub-anchor,hub-error,hub-race}-test.sh` — все зелёные на `5b78099`.
- Релиз: bump `nyron-dev/.claude-plugin/plugin.json` + CHANGELOG → commit →
  `git push github main` → `git -C ~/.claude/plugins/marketplaces/nyron-dev-marketplace-v2 pull`.
- Вопрос человеку = `hub_ask` в будку (иначе сторож заведёт заглушку за
  тебя — проверено на себе 09.08).
- Найденное «мешает процессу» — строкой в `ai-evolve-docs-test/PILOT.md`,
  коммит+пуш сразу.
