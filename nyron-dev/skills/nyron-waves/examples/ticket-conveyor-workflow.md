# Скелет: конвейер тикета v2.1 — ДВА workflow + сессионные интерлюдии (0.7.0)

Урок пилота НБ-1: workflow-агент не может ждать внешний процесс >10 мин и не
умеет «повиснуть до колбэка» — длинные прогоны (codex ~10 мин, docker ~12 мин)
ведёт СЕССИЯ фоном (`run_in_background` + task-notification), workflow гоняет
короткую механику. Разбиение: **WF-тестген → чекпойнт сессии (тесты=спека,
можно уточнить бриф кодеру) → WF-импл → Sol-циклы сессией фоном (r1 полный,
r2+ по диффу фиксов, раунд без новых находок → стоп) → полный сьют ОДИН раз
после последнего фикса → вердикт**. Ниже — скелет WF-импл (главный); тест-ген
мелкого тикета допустимо вести сессией без WF. Прежний монолитный скелет
(всё в одном workflow) — АНТИПАТТЕРН, не воспроизводить.

Правила адаптации по месту:
- **args передавать ОБЪЕКТОМ, не JSON-строкой** (`args: {ticket: "…", dod: […]}`,
  НЕ `args: "{\"ticket\"…}"`): стрингифай — известная грабля платформы, все
  `${args.*}` в промптах становятся `undefined`, телеметрия уезжает в
  файл-пустышку, паспорт не доходит до стадий (наступлено на НБ-2). После
  запуска — смоук: первая стадия в журнале видит реальные значения, не
  «undefined»;
- пути/тикеты подставлять РАЗВЁРНУТЫМИ строками (грабля: `${...}` в
  строках-промтах workflow интерполируется — литеральный `$` экранировать);
- codex-стадии зовут CLI Bash-ом ВНУТРИ агента стадии (синхронно — в workflow
  это нормально, параллелит сам конвейер);
- решения (вердикт диспетчера, блокеры, Jira-статусы) — НЕ в скрипте: скрипт
  возвращает результат, волна-сессия решает и двигает шину;
- телеметрию пишет каждая стадия — строка в `.nyron-hub/metrics.jsonl`
  (echo >> из механического агента, дёшево).

```javascript
export const meta = {
  name: 'ticket-conveyor-v2',
  description: 'Конвейер тикета: тест-ген(Sol) → чекпойнт → код → валидатор → адверсарка → Sol-ревью',
  phases: [
    { title: 'TestGen' }, { title: 'Impl' }, { title: 'Guard' },
    { title: 'Adversarial' }, { title: 'CrossReview' },
  ],
}
// args: { ticket, worktree, testsDir, brief, dod, howToTest, ticketFile,
//         crossReviewSh, metricsFile, behavioral: true|false,
//         complexity: 'обычный'|'СЛОЖНЫЙ' }

const VERDICT = { type: 'object', properties: {
  ok: { type: 'boolean' }, summary: { type: 'string' },
  findings: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'summary'] }

const metric = (stage, data) =>
  `echo '${'${'}JSON.stringify({ts: args.now, ticket: args.ticket, stage, ...data})}' >> ${'${'}args.metricsFile}`
// упрощённо: реальную запись делает механический агент стадии одной echo-командой

// ── Стадия 1: red-тесты из DoD пишет Sol (НЕ видит будущий код) ──
phase('TestGen')
let tests = null
if (args.behavioral) {
  tests = await agent(
    `Запусти Bash: codex exec в каталоге ${args.testsDir} (репо тестов).
     Промт для codex: «Напиши ПАДАЮЩИЕ тесты для тикета ${args.ticket} строго
     из DoD и "Как тестировать" ниже. Реализации ещё нет — тесты фиксируют
     ожидаемое наблюдаемое поведение, не выдумывай внутренности.
     ТЕСТ-БЮДЖЕТ: 1 пункт DoD = 1-2 теста + негативные из "Как тестировать",
     MECE (не пересекаются, вместе покрывают DoD). Сверх бюджета НЕ писать:
     тест, не доказывающий пункт DoD, — лишний код.
     DoD: ${args.dod}
     Как тестировать: ${args.howToTest}
     Каждый тест — шапка-описание + регистрация в каталоге тестов.»
     Верни список созданных файлов и имена тест-кейсов.`,
    { label: `testgen:${args.ticket}`, model: 'sonnet' })
  // ЧЕКПОЙНТ СЕССИИ: workflow возвращает управление? Нет — конвейер продолжает,
  // но волна смотрит тесты на своём чекпойнте (workflow-журнал) и может
  // остановить ДО импла. Для строгого гейта: разбить на два workflow.
}

// ── Стадия 2: код. Тестовые файлы трогать НЕЛЬЗЯ ──
phase('Impl')
const impl = await agent(
  `Тикет ${args.ticket}, worktree ${args.worktree}. Бриф: ${args.brief}
   Лестница до кода: ответь на 3 вопроса ДО правок (пруф №2 — граф
   codebase-memory, фолбэк grep; путь:строка). Red-тесты уже написаны
   (${args.testsDir}): твоя задача red → green. ТЕСТОВЫЕ ФАЙЛЫ НЕ ПРАВИТЬ —
   не согласен с тестом → верни это как блокер, не подгоняй.
   В цикле гоняй ТОЧЕЧНЫЕ тесты по затронутому; полный сьют — один раз в конце.
   Коммиты «${args.ticket}: ...». Верни: лестница (3 ответа с пруфом), что
   сделано, red→green статус, хэши.`,
  { label: `impl:${args.ticket}`, model: 'opus', agentType: 'backend-dev' })

// ── Стадия 3: механический гвард — дифф не трогает тесты ──
phase('Guard')
const guard = await agent(
  `Bash в ${args.worktree}: git diff origin/main..HEAD --name-only | grep -E
   '(tests?/|\\.test\\.|\\.spec\\.)' — если код-МР тронул тестовые файлы,
   верни ok=false и список; иначе ok=true. Плюс допиши метрику:
   echo-строку {stage:"guard", ok, ladder_proof: "<graph|grep|none из отчёта импла>"}
   в ${args.metricsFile}.`,
  { label: `guard:${args.ticket}`, model: 'haiku', schema: VERDICT })
if (!guard.ok) return { status: 'БЛОКЕР', stage: 'guard', findings: guard.findings }

// ── Стадия 4: адверсарка (пока ВСЕМ тикетам — до данных телеметрии) ──
phase('Adversarial')
let round = 0, adv
while (round < 3) {
  adv = await agent(
    `Адверсарно ОПРОВЕРГНИ готовность ${args.ticket} в ${args.worktree}
     (дифф origin/main..HEAD). Контекст: ${impl}
     ok=true только если опровергнуть не удалось. Каждую находку — строкой
     «[adversarial] тип: суть» (тип: bug|overengineering|dup|style).`,
    { label: `adv:${args.ticket}#${round}`, model: 'opus', schema: VERDICT })
  if (adv.ok) break
  await agent(
    `Почини по замечаниям в ${args.worktree} (коммиты ${args.ticket}):
     ${adv.findings.join('; ')}. Точечные тесты перегнать. Тестовые файлы не трогать.`,
    { label: `fix:${args.ticket}#${round}`, model: 'opus', agentType: 'backend-dev' })
  round++
}
if (!adv.ok) return { status: 'БЛОКЕР', stage: 'adversarial', findings: adv.findings }

// ── Стадия 5 (ВНИМАНИЕ, v2.1): длинный codex-прогон ЛУЧШЕ вести сессией
// фоном после завершения этого WF (Bash-лимит 10 мин у агента — codex
// впритык). Вариант ниже оставлен для коротких ревью; если codex стабильно
// >8 мин — выносить в сессию, WF завершать после адверсарки. ──
phase('CrossReview')
let crRound = 0, cr
while (crRound < 2) {
  cr = await agent(
    `1) Полный прогон тестов проекта для зоны тикета (make -C ... / npm test).
     2) Запусти Bash: ${args.crossReviewSh} -C ${args.worktree} -b main -t ${args.ticketFile}
     Верни ok=true при зелёном полном прогоне И «ВЕРДИКТ: ПРИНЯТО»; иначе
     findings (замечания дословно, «[sol] тип: суть»; НЕБЛОКИРУЮЩЕЕ — отдельным
     списком nonblocking). Метрики находок — echo в ${args.metricsFile}.`,
    { label: `sol:${args.ticket}#${crRound}`, model: 'sonnet', schema: VERDICT })
  if (cr.ok) break
  await agent(
    `Почини по вердикту Sol в ${args.worktree}: ${cr.findings.join('; ')}.
     Точечные тесты перегнать. Тестовые файлы не трогать.`,
    { label: `fix-sol:${args.ticket}#${crRound}`, model: 'opus', agentType: 'backend-dev' })
  crRound++
}

return { status: cr.ok ? 'ГОТОВ К ПУШУ' : 'БЛОКЕР', stage: 'cross-review',
         tests, impl, adversarial: adv, crossReview: cr }
// Дальше — СЕССИЯ (Fable): смотрит red-тесты и дифф, вердикт, пуш, Jira,
// hub_post. СЛОЖНЫЙ тикет → перед вердиктом разбор конструкции thinker'ом.
// Неблокирующие замечания волна в конце собирает в файл долгов проекта.
```

Несколько тикетов волны → `pipeline(tickets, t => конвейер t)` — едут
одновременно, wall-clock = самый долгий. Телеметрия всех тикетов — в одном
`metrics.jsonl`, сводка волны по нему.
