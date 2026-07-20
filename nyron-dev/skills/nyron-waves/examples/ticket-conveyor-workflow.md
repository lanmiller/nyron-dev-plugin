# Скелет: конвейер тикета как Workflow

Стадийный конвейер одного тикета волны Workflow-скриптом: чекпойнт на каждой
границе стадий (упал/припарковался — `resumeFromRunId` вернёт готовые стадии
из кэша), стадию «забыть» невозможно, цикл доработок ограничен.

Правила адаптации по месту:
- пути/тикеты подставлять РАЗВЁРНУТЫМИ строками (грабля: `${...}` в
  строках-промтах workflow интерполируется — литеральный `$` экранировать);
- `codex`-стадия зовёт cross-review.sh Bash-ом ВНУТРИ агента стадии (агент
  синхронно ждёт — в workflow это нормально, параллелит конвейер);
- решения (вердикт диспетчера, блокеры, Jira-статусы) — НЕ в скрипте: скрипт
  возвращает результат, волна-сессия решает и двигает шину.

```javascript
export const meta = {
  name: 'ticket-conveyor',
  description: 'Конвейер тикета: impl → адверсарка → cross-review → пуш-готовность',
  phases: [
    { title: 'Impl' }, { title: 'Adversarial' }, { title: 'CrossReview' },
  ],
}
// args: { ticket: 'DEV-XXX', worktree: '/abs/path', brief: '<бриф-текст>',
//         ticketFile: '/abs/path/ticket.txt', crossReviewSh: '/abs/path/cross-review.sh' }

const VERDICT = { type: 'object', properties: {
  ok: { type: 'boolean' }, summary: { type: 'string' },
  findings: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'summary'] }

phase('Impl')
const impl = await agent(
  `Тикет ${args.ticket}, worktree ${args.worktree}. Бриф: ${args.brief}
   TDD: тест первым (red→green), затем код. py_compile/тесты прогнать.
   Коммиты «${args.ticket}: ...». Верни: что сделано, какие тесты, хэши.`,
  { label: `impl:${args.ticket}`, model: 'opus', agentType: 'backend-dev' })

phase('Adversarial')
let round = 0, adv
while (round < 3) {
  adv = await agent(
    `Адверсарно ОПРОВЕРГНИ готовность ${args.ticket} в ${args.worktree}
     (дифф origin/main..HEAD). Контекст имплементации: ${impl}
     ok=true только если опровергнуть не удалось; findings — конкретика.`,
    { label: `adv:${args.ticket}#${round}`, model: 'opus', schema: VERDICT })
  if (adv.ok) break
  await agent(
    `Почини по замечаниям адверсарки в ${args.worktree} (коммиты ${args.ticket}):
     ${adv.findings.join('; ')}. Тесты перегнать.`,
    { label: `fix:${args.ticket}#${round}`, model: 'opus', agentType: 'backend-dev' })
  round++
}
if (!adv.ok) return { status: 'БЛОКЕР', stage: 'adversarial', findings: adv.findings }

phase('CrossReview')
let crRound = 0, cr
while (crRound < 2) {
  cr = await agent(
    `Запусти Bash: ${args.crossReviewSh} -C ${args.worktree} -b main -t ${args.ticketFile}
     Дождись вердикта (синхронно). Верни ok=true при «ВЕРДИКТ: ПРИНЯТО»,
     иначе ok=false и findings = замечания дословно.`,
    { label: `sol:${args.ticket}#${crRound}`, model: 'sonnet', schema: VERDICT })
  if (cr.ok) break
  await agent(
    `Почини по вердикту Sol в ${args.worktree} (коммиты ${args.ticket}):
     ${cr.findings.join('; ')}. Тесты перегнать.`,
    { label: `fix-sol:${args.ticket}#${crRound}`, model: 'opus', agentType: 'backend-dev' })
  crRound++
}

return { status: cr.ok ? 'ГОТОВ К ПУШУ' : 'БЛОКЕР', stage: 'cross-review',
         impl, adversarial: adv, crossReview: cr }
// Дальше — СЕССИЯ: пуш, отчёт-коммент в Jira, статус, hub_post «сдал».
```

Несколько тикетов волны → `pipeline(tickets, t => workflow-конвейер t)` или
параллельные запуски — конвейеры едут одновременно, wall-clock = самый долгий.
