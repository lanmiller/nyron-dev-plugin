# Как сейчас устроен флоу: скиллы, тексты, механика

Состояние на 12.08.2026, после правок сегодняшнего дня. Всё, что описано,
лежит в рабочей копии плагина и в бой ещё не выкачено — выкат после закрытия
Блоков 1–3 эпика DEV-1210.

---

## Путь работы от идеи до «Готово»

```
сырьё от человека            решённая фича              гипотеза
   intake-groom          →   feature-intake         →   product-flow
   (черновик тикета)         (требование → эпик →       (ставка, замер)
                              нарезка → прототип)
                    ↓
             jira-task-standard
        (любой тикет доводится до стандарта: JTBD, DoD, «Как тестировать»)
                    ↓
              nyron-waves  ← диспетчер: груминг, нарезка волн, брифы, чипы
                    ↓
        сессия-волна работает по канону правил волн
        конвейер тикета: тесты чужой моделью → чекпойнт → код субагентами →
        критика находок (только СЛОЖНЫЕ) → cross-review → сдача
                    ↓
        Ревью → вердикт диспетчера → мерж пачкой → смоук предпрода
                    ↓
        Готово к тестированию (assignee QA) → Тестирование → Готово (ставит QA)
                    ↓
        live-epic-testing (живой прогон с человеком) · qa-handoff (приёмка эпика)
```

Ключевое правило маршрута: **волна доводит тикет только до «Ревью»**. Дальше
двигает диспетчер, а «Готово» ставит исключительно QA.

---

## Скиллы: кто за что отвечает

| Скилл | Когда включается | Главный текст |
|---|---|---|
| `project-config` | первым ходом в любой сессии | [project-config/SKILL.md](../nyron-dev/skills/project-config/SKILL.md) · [references/setup.md](../nyron-dev/skills/project-config/references/setup.md) |
| `intake-groom` | «прилетело от методолога» | [intake-groom/SKILL.md](../nyron-dev/skills/intake-groom/SKILL.md) |
| `jira-task-standard` | завести, переписать, догрумить тикет | [jira-task-standard/SKILL.md](../nyron-dev/skills/jira-task-standard/SKILL.md) · [task-template.md](../nyron-dev/skills/jira-task-standard/assets/task-template.md) |
| `feature-intake` | решённая фича → требование → эпик → прототип | [feature-intake/SKILL.md](../nyron-dev/skills/feature-intake/SKILL.md) |
| `product-flow` | гипотеза, петля проверки | [product-flow/SKILL.md](../nyron-dev/skills/product-flow/SKILL.md) |
| `nyron-waves` | массовое закрытие эпика волнами | [nyron-waves/SKILL.md](../nyron-dev/skills/nyron-waves/SKILL.md) · [wave-protocol.md](../nyron-dev/skills/nyron-waves/references/wave-protocol.md) |
| `cross-review` | проверка кода другой моделью | [cross-review/SKILL.md](../nyron-dev/skills/cross-review/SKILL.md) · [cross-review.sh](../nyron-dev/skills/cross-review/scripts/cross-review.sh) |
| `team-roles` | «я продакт», «надень роль QA» | [team-roles/SKILL.md](../nyron-dev/skills/team-roles/SKILL.md) · [карточки ролей](../nyron-dev/skills/team-roles/references/) |
| `live-epic-testing` | живой прогон эпика с человеком | [live-epic-testing/SKILL.md](../nyron-dev/skills/live-epic-testing/SKILL.md) |
| `qa-handoff` | эпик закрыт → приёмка QA | [qa-handoff/SKILL.md](../nyron-dev/skills/qa-handoff/SKILL.md) |

---

## Тексты, которые реально управляют поведением

Порядок — от самого влиятельного к частному.

1. **[hooks/code-policy.md](../nyron-dev/hooks/code-policy.md)** — 20 строк, приходят в КАЖДУЮ сессию при старте.
   Лестница до кода, три проверки при написании (бывшие DRY/KISS/SOLID),
   политика легаси, флаги, режим прогона тестов, стоп-ступени качества.
   Здесь же теперь требование вкладывать политику в задание субагенту.
2. **[wave-rules-template.md](../nyron-dev/skills/nyron-waves/assets/wave-rules-template.md)** — правила волны,
   главный текст исполнителя. Из него собирается проектный канон
   `ai-evolve-docs-test/shared/wave-rules.md` в док-репо.
3. **[cross-review.sh](../nyron-dev/skills/cross-review/scripts/cross-review.sh)**, строки 63–150 — промт
   ревьюера. Глубина, метки, границы, потолок замечаний, правило вердикта.
4. **[nyron-waves/SKILL.md](../nyron-dev/skills/nyron-waves/SKILL.md)** — роль диспетчера, статус-машина,
   роутинг моделей, конвейер тикета, телеметрия.
5. **[wave-protocol.md](../nyron-dev/skills/nyron-waves/references/wave-protocol.md)** — механика: формат
   чипа, шина ревью, вотчеры, guard'ы зависимых волн.
6. **[wave-brief-template.md](../nyron-dev/skills/nyron-waves/assets/wave-brief-template.md)** — форма брифа и
   чек-лист финала, по которому волна себя проверяет.

Разборы, по которым всё это правится: [RULES-AUDIT.md](RULES-AUDIT.md) (двенадцать
пунктов «как сейчас → как надо») и [SKILLS-AUDIT.md](SKILLS-AUDIT.md) (аудит скиллов
против трёх официальных канонов, чек-лист приёмки из пятнадцати пунктов).

---

## Механика: что работает само, без дисциплины модели

| Что | Где | Зачем |
|---|---|---|
| Политика кода в каждую сессию | [hooks.json](../nyron-dev/hooks/hooks.json) → SessionStart | правило доезжает без напоминаний |
| Взвод будка-вотчера при засыпании | [hub-rearm.sh](../nyron-dev/hub/hub-rearm.sh) → Stop | сессия не уснёт без связи с будкой |
| Нянька вотчеров снаружи | [watch-nanny.sh](../nyron-dev/hub/watch-nanny.sh) (launchd, раз в 3 мин) | будит того, кто выпал молча |
| Сборка канона правил | [wave-rules-sync.py](../nyron-dev/hub/wave-rules-sync.py) | проектная копия не расходится с плагином |
| Уборка после пачки | [wave-cleanup.sh](../nyron-dev/hub/wave-cleanup.sh) | ветки и worktree не копятся |
| Будка (шина сессий) | [server.mjs](../nyron-dev/hub/server.mjs) · [hub-watch.sh](../nyron-dev/hub/hub-watch.sh) | «взял / сдал / блокер» за секунды |
| Надзиратель флота | [watchdog.mjs](../nyron-dev/hub/watchdog.mjs) | видит зависшие сессии |

---

## Что изменилось сегодня (и чего ждать на первом же прогоне)

1. **Ревью перестанет копать вширь.** Один слой вместо четырёх, потолок семь
   замечаний, вердикт ДОРАБОТКА только при блокере в границах тикета.
2. **Замечания станут решаемыми.** Метка и граница у каждого: сразу видно,
   чинить сейчас, спрашивать постановщика или отправить в долг.
3. **Полный набор тестов перестанет крутиться каждый круг** — точечно в цикле,
   полный один раз на финале.
4. **Автор кода получит политику.** Раньше лестница и DRY доходили до сессии,
   но не до субагента, который пишет код.
5. **Ревьюер больше не предлагает менять интерфейс** — это зона постановщика.
6. **Канон правил перестанет расходиться** — он собирается, а расхождение
   ловится проверкой.

Мерило успеха одно: время круга простого тикета и доля тикетов, выросших за
свои границы. Замер — на Блоке 4 как контрольном прогоне.
