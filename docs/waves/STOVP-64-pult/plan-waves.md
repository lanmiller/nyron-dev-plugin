# STOVP-64 — план волн (диспетчер, 23.08.2026)

Эпик: «Пульт отвечает мгновенно, а три рабочих жеста (дифф · браузер ·
отправить) делаются в один клик». Репо — `nyron-dev-plugin` (проект `stovp`
в пульте), зона кода — `morda/` (SvelteKit + adapter-node, боевой 4747 под
launchd, тесты `node --test morda/tests/*.test.mjs`).

## Отличия от дефолтов ai-evolve (зафиксировано)

- Репо одно — сам `nyron-dev-plugin` (не мультирепо). Worktree — по
  конвенции пульта: ветка `wt-<имя>`, worktree `.claude/worktrees/<имя>`
  (git-панель «влить»/«прибрать» уже работает с такими — коммиты
  `мерж worktree-wt-* в main`).
- Папка эпика — `docs/waves/STOVP-64-pult/` в этом репо (конфиг указывает
  на `ai-evolve-docs-test/waves`, но плагин-репо ведёт свою доку в `docs/`).
- Доска STOVP: статусы только `К выполнению(11) → В работе(21) → In Review(31)
  → Готово(41)`. «Доработка»/«ГкТ» нет: вердикт `ДОРАБОТКА:` — комментом,
  статус остаётся In Review; после мержа + пересборки 4747 — `Готово`
  (QA-роли в проекте нет — приёмку руками делает постановщик по чекпоинтам).
- Будка: сессия диспетчера поднята под строгим MCP-профилем
  (`morda/runner-mcp-disp-stovp64.json`) — `hub_*` в ней нет, канал —
  CLI-фолбэк (`hub-watch.sh`, sqlite). Волнам в чипе — профиль по умолчанию
  (с будкой).
- Тесты: `morda/tests/*.test.mjs` (node:test), регистрации в
  ai-evolve-docs-test нет — шапка-описание в файле теста обязательна.
- UI: компоненты — `morda/src/lib/ui/*` (shadcn-svelte), витрина
  `/design` (`src/routes/design/+page.svelte`), скилл `design-system`
  (`morda/canon-skills/design-system`). Проверка руками — десктоп И 375px.
- Боевой 4747 пересобирается `bash morda/install-launchd.sh` ТОЛЬКО после
  мержа в main (делает диспетчер/постановщик, не волна). Волна проверяет на
  dev-сервере `npm --prefix morda run dev` (порт 5747) или своём порту.
- Забор раннера (`guard/pretooluse-guard.mjs`) считает корнем cwd — волне
  НЕ делать `cd morda` в персистентном shell, иначе запись в `docs/` режется.

## Карта «тикет → файлы» (из разведки кода 23.08)

| Тикет | Файлы | Пересечения |
|---|---|---|
| 65 индекс сессий | `src/lib/server/fleet.js` (listSessionsCached/transcriptsSig/readSessionCached/ovCache), `src/lib/server/checkin.js` (actCache/lastActivityMs), `src/lib/server/runner.js` (runnerList/listCache/aliveCache) | runner.js с 69 |
| 69 запуски | `src/routes/+page.svelte`, `src/lib/PickChip.svelte`, `src/lib/server/runner.js` (runnerStart, реестр runner.json), `fleet.js:epics()/toEpic()` | runner.js/fleet.js с 65 |
| 67 дифф сессии | `src/routes/s/[project]/[key]/+page.svelte` (вкладка), `src/lib/server/git.js` + `src/routes/api/git/+server.js` (только потребление) | +page.svelte с 66 |
| 66 терминал | `src/lib/TmuxPanel.svelte`, `src/routes/s/[project]/[key]/+page.svelte`, `src/lib/server/runner.js` (tmux), новый WS-слой (`morda/server.mjs` поверх `build/handler.js` + `ws` + `node-pty`), `install-launchd.sh`, `package.json` | +page.svelte с 67; install-launchd.sh/package.json с 71 (мерж по очереди) |
| 68 браузер | новое: `src/routes/browse/+page.svelte`, `src/routes/api/browse/+server.js`, `src/lib/server/browser.js` (playwright, как `judge.js`), `queueAdd` + `/api/upload` (потребление) | — |
| 70 пуш | новое `src/lib/server/notify.js`; интеграция в `src/hooks.server.js` (фоновые циклы), источники — asks будки (`fleet.js:196`), вердикт судьи (`judge.js`); ключ — `keys.js` | hooks.server.js — чужие циклы не трогать |
| 71 PWA | `src/app.html`, `static/manifest.webmanifest`, `static/sw.js`, иконки | app.html/package.json — с 66 только по очереди мержа |
| 72 MCP-виджет | `morda/mcp/pult-mcp.mjs` (+ html-виджет рядом), `/api/runner` (потребление) | — |

## Волны (порядок постановщика), ветки, параллель

| Волна | Тикеты (порядок внутри) | Ветка / worktree | Старт |
|---|---|---|---|
| 1 «скорость и запуски» | STOVP-65 → STOVP-69 | `wt-w1-speed` / `.claude/worktrees/w1-speed` | сразу |
| 2 «окно сессии» | STOVP-67 → STOVP-66 | `wt-w2-session` / `.claude/worktrees/w2-session` | после мержа в. 1 |
| 3 «браузер» | STOVP-68 | `wt-w3-browse` / `.claude/worktrees/w3-browse` | **после мержа в. 2** (общий WS-хост `server.mjs` — Sol п.1) |
| 4 «пуш · PWA · виджет» | STOVP-71 → STOVP-70 → STOVP-72 | `wt-w4-app` / `.claude/worktrees/w4-app` | после мержа в. 1 (по файлам не зависит — можно параллельно с в. 2 и 3) |

Параллельность: после мержа волны 1 — волны 2 и 4 по файлам не
пересекаются (волна 3 — строго после 2, см. вердикт Sol п.1) (единственное касание — `package.json`/`install-launchd.sh`
у 66 и 71, решается очередью мержа). Потолок `max_parallel_waves: 4`.
Постановщик задал порядок 1→2→3→4; чип 4 выдаётся с guard'ом
«волна 1 влита», чип 3 — «волна 2 влита» — запускать ли их одновременно с волной 2, решает
постановщик кликом.

Внутри волны тикеты — последовательно (общие файлы): 65 раньше 69 (69
правит runnerStart поверх кэшей 65); 67 раньше 66 (67 заводит табы в шапке
окна сессии — «лента | изменения», 66 добавляет «терминал» третьим табом и
переводит ленту на поток).

## Масштаб конвейера

- Полный (тестген → чекпойнт → импл → Sol r1 полный, r2+ по диффу): 65, 69,
  67, 66, 68, 70, 72.
- **СЛОЖНЫЙ** (разбор конструкции на дорогой модели перед вердиктом +
  критика находок): 65 (архитектура чтения лент), 66 (WS/pty-слой сквозь
  adapter-node), 68 (CDP-стрим + пикер элемента).
- **Лайт**: 71 (PWA-манифест — механическая правка + Lighthouse + 1 круг Sol).

## Решения груминга (развилки закрыты диспетчером)

1. **66, WS сквозь adapter-node**: SvelteKit adapter-node не отдаёт upgrade —
   канон: тонкий `morda/server.mjs` (http.createServer поверх
   `build/handler.js`, `ws` на `/ws/term/<name>`, `node-pty` → `tmux attach -t
   stovp-<name>`), `npm start` и `install-launchd.sh` переводятся на него.
   Dev-режим: vite-плагин `configureServer` с тем же ws-модулем (один модуль,
   два хоста). Ввод — только в `stovp-*` tmux (проверка префикса на сервере).
2. **66, UI-режим «на потоке»**: не второй транспорт, а тот же WS: сервер
   шлёт `session`-события (дельта ленты/экрана по fs.watch индекса из 65)
   вместо setInterval 2/5 с; поллинг остаётся фолбэком для мёртвых сессий.
3. **65, индекс**: in-memory индекс сессий проекта (key → {file, size,
   mtime, head-заголовок, lastActivity}), инвалидация `fs.watch` на
   каталог транскриптов + сигнатура как страховка; `overview`/`runnerList`/
   `checkin.lastActivityMs` читают индекс. Персистентность на диск — НЕ в
   этот тикет (нет требования). Заплатки 22–23.08 (кэши runnerList/
   liveAgents, один tmux list-sessions) остаются, индекс строится поверх.
4. **69, парсинг ключа** — регэксп `\b[A-Z][A-Z0-9]+-\d+\b` из цели, поле
   формы сильнее; запись в реестр `runner.json` (`ticket`), `toEpic()`
   читает его первым.
5. **68**: один persistent browser-context (playwright chromium, как в
   judge.js), CDP `Page.startScreencast` → кадры в WS (переиспользовать
   ws-слой 66 если уже влит; если нет — свой `/ws/browse`, объединить
   позже тикетом-хвостом); клики/скролл/ввод → `page.mouse/keyboard`;
   пикер элемента — инжект-скрипт с подсветкой, селектор строится
   стабильным путём (data-testid/id/aria → css-path); «отправить» →
   `queueAdd` текст `url + селектор + outerHTML(обрезан) + приписка`, скрин —
   `/api/upload` в проект сессии, путь — в текст очереди.
6. **70**: ntfy.sh, топик — ключ `NTFY_TOPIC` в ключнице (`keys.js`), URL
   пульта — `PULT_PUBLIC_URL` там же (туннель); триггеры: новая открытая ask
   будки, вердикт судьи «встала»; дребезг 10 мин/сессию в памяти процесса.
7. **72**: MCP Apps — по рабочему примеру `my-mcp-app` на машине; тул
   `pult_dashboard` в `pult-mcp.mjs`, HTML-виджет на токенах дизайн-системы
   (inline css, т.к. виджет живёт вне пульта); действия — существующие
   `queue_add`/judge.
8. Описания 66, 68, 69 в Jira содержат экранированный markdown (`\*\*`) —
   диспетчер перезаписывает описания чистым текстом, смысл не меняется.

## Челлендж плана (Sol, plan-challenge.sh)

Волна 1 — M; волна 2 — L → один прогон челленджа по этому файлу целиком
(постановки + план), вердикт — `plan-challenge-sol.md` рядом.

## Вердикт Sol — `ПЛАН: РИСКИ` (11 пунктов, `plan-challenge-sol.md`) → решения

| # | Риск | Решение диспетчера (куда вшито) |
|---|---|---|
| 1 | 68 зависит от WS-хоста 66; prod = `node build`, vite без upgrade-плагина | **Волна 3 стартует только после мержа волны 2** (порядок постановщика и так такой). В карту файлов 66 добавлены `vite.config.js`, `package-lock.json`, `install-launchd.sh`. Бриф 68: кадры — по слою `server.mjs`/ws из 66, свой транспорт не заводить |
| 2 | WS обходит Basic-auth (`hooks.server.js:49–67`) и CSRF (`guard.js`) | Бриф 66: общий `authenticateUpgrade` (Basic-auth той же проверкой + `Origin/Host` = пульт/туннель) ДО резолва имени; имя — только из `runner.json`; тесты: без auth → 401, чужой Origin → 403, не-stovp → 403 |
| 3 | 67 не «только потребление»: `repoPath()` режет глубину >2, worktree `.claude/worktrees/x` глубже | Бриф 67: серверная session-aware операция `git.js: sessionRepo(project, key)` — cwd из реестра/транскрипта, сверка с `git worktree list`; ручка `/api/git?op=session-diff`; тесты API |
| 4 | Индекс 65 дублирует канонический `nyron-dev/hub/transcript.mjs` (`metaCache`, все root/worktree-каталоги, cwd/entrypoint/custom-title) | Бриф 65: **индекс развивается в `transcript.mjs`** (metaCache → наблюдаемый индекс с `fs.watch` + сигнатурой), экспорт в morda; `fleet.js`/`checkin.js` — только потребители; сигнатура morda по одному каталогу заменяется каноническим обходом по префиксу; сохранить фильтр по cwd, слоты, поздние custom-title |
| 5 | Raw PTY не поддержан текущим `TmuxPanel` (`<pre>` без эмулятора); deps нет | Бриф 66: эмулятор `@xterm/xterm` + `addon-fit` + `addon-webgl`, протокол ws: `{t:'in'|'out'|'resize'}`; `node-pty`, `ws` — в deps; `TmuxPanel` остаётся фолбэком |
| 6 | «Поллинг только мёртвым» ломает desktop/mirror-сессии без runner-записи | Бриф 66: две подписки — `/ws/term/<name>` (pty) и `/ws/session/<project>/<key>` (события ленты); поллинг сохраняется для ЛЮБОЙ сессии без подтверждённого session-WS |
| 7 | `ticket` теряется на restart/resume, `toEpic()`/`runnerOwned()` его не знают | Бриф 69: `ticket` в мете записи сохраняется при `runnerStart` (перезапись записи — merge меты), передаётся в resume/adopt, `runnerOwned` отдаёт `ticket`, `toEpic` принимает его первым; поле `ticket` в схеме `pult_start` |
| 8 | «Persistent context как в judge.js» — ложь: там одноразовый CLI `screenshot` | Бриф 68: `browser.js` — новая инфраструктура: launch/user-data-dir (`.secrets`-соседний каталог профиля), владелец page, reconnect при падении, cleanup на shutdown; judge.js не переделывать |
| 9 | MCP Apps: `pult-mcp.mjs` объявляет только tools, нет `resources/*`, `_meta`; действия — `pult_send`/`pult_judge` | Бриф 72: `resources/list`/`resources/read` (`ui://pult/dashboard.html`, MIME `text/html;profile=mcp-app`), `tools/list` с `_meta.ui.resourceUri`, `structuredContent` в ответе; кнопки вызывают `pult_send`/`pult_judge`/`pult_fleet`; образец — `my-mcp-app` |
| 10 | Нет env-флагов для флоу-правок | Флаги `MORDA_WS` (66) и `MORDA_BROWSE` (68), дефолт on, `off` → прежний поллинг / нет /browse; UI получает `capabilities` из `/api/overview`. Тикет на снос — **STOVP-73**. 69 (форма), 70 (ключ в ключнице = выключатель), 72 (тул в MCP, пульт не трогает) — без флагов: откат = не ставить ключ / старый путь жив под «тонкой настройкой» |
| 11 | Пуш по старым/решённым ask, два пути судьи | Бриф 70: на старте засеять `seen` без отправки; реагировать только на переход в `status=open`; событие «встала» — из общего `judgeStuck` (и ручной, и фоновый путь) |

Неблокирующее (в `docs/tech-debt.md` при сведении): нет `AGENTS.md`/`CLAUDE.md` в корне и `morda/`; TmuxPanel+поллинг — деградационный фолбэк (так и сделано, п.5/6); PWA: network-only для `/api`, `/ws`, страниц сессий — в бриф 71.
