<!-- Проектная вставка правил волн для ai-evolve.
     Место назначения: ai-evolve-docs-test/shared/wave-rules.project.md
     Этот файл команда правит РУКАМИ: сюда идут зоны, команды и уроки ЭТОГО
     проекта. Универсальные правила — в шаблоне плагина, не здесь. -->

### Зоны, агенты, репозитории

- Корень — мультирепо-чекаут: git-репо в подпапках `ai-evolve-front/`,
  `ai-evolve-back/`, `n8n/`, `ai-evolve-docs-test/`. `canvas-mcp-server` —
  подпапка ВНУТРИ `ai-evolve-back`, не отдельный чекаут.
- Имплементация по зоне обязательными проектными агентами: фронт —
  `front-dev`, бек — `backend-dev`, LangGraph/n8n — `langgraph-dev` (канон
  CLAUDE.md).
- Зона `catalog/*` в `ai-evolve-front` — Юрина: без явного тикета не трогать.
- На `ai-evolve-front` может жить живой стенд пользователя (vite на main) —
  рабочее дерево не переключать.
- Прототипы `feature-intake` поднимать конфигурацией `front-proto` (порт 5199,
  `.claude/launch.json`), чтобы не занимать 5173.
- Актуальная документация через Context7 нужна по: Svelte 5, SvelteKit,
  FastAPI, Pydantic, Yjs, Playwright, OpenAI Agents SDK.

### Ветки и выкатка

- Пуш в main front/back/n8n = авто-CI predprod + HMR живого стенда
  пользователя. Волны в main не пушат; мержит диспетчер пачкой.
- Ветки `prod2` и `nyron` волна не трогает никогда. Рабочий контур команды —
  ТОЛЬКО predprod (флаги там сразу `=true`); `prod2` заморожен, `nyron`
  катится отдельным решением пользователя.
- Флоу-правки за env-флагом: predprod-компоуз `=true`, prod2/nyron `=false`.
- **rsync на серверы — БЕЗ `--delete`** (инцидент 29.07): рядом с кодом живут
  файлы вне репо (`.env`, локальные оверрайды), `--delete` их сносит, compose
  пересоздаёт контейнеры с пустыми кредами и валит стек. Выкатка кода —
  `rsync -a` без `--delete` (+ явные `--exclude`) либо git-pull на сервере;
  перед любой операцией, способной удалить файлы, — бэкап конфигов:
  `cp .env /root/env-backup-$(date +%Y%m%d).env`.

### Тесты: где лежат и чем гонять

- Каталог тестов — `ai-evolve-docs-test/tests/{back,front,n8n}/`; новый тест
  обязан иметь шапку-описание и запись в каталоге.
- Бек: точечно `pytest <путь>` / `-k`, полный набор —
  `make -C ai-evolve-docs-test test-back-unit`; перед пушем `py_compile`.
- Фронт: точечно `vitest related`, полный — `npm run test`. Грабля:
  vitest client-тесты НЕ работают из worktree (симлинк `node_modules` ломает
  `server.fs.allow`) — гонять из основного чекаута либо расширить `fs.allow`
  локально без коммита.
- Паспорта конвейера по зонам: бек → `ai-evolve-docs-test/tests/back`,
  фронт e2e → `tests/front/e2e`, фронт vitest-unit → `tests/front/unit`
  (зеркало `src/`), n8n → `n8n/tests`.

### Правила стека

- **Бек**: импорты БЕЗ префикса `app.` (код выполняется из `/app`);
  логирование через `config.logging_config.get_logger`, без мусорных debug;
  миграции руками НЕ создавать (автосоздание при сборке контейнера); RBAC —
  через permission codes (`require_permission`), никаких `if
  user.is_global_admin` в бизнес-логике; Python — только под `.venv`.
- **Фронт**: Svelte 5 runes (`$state`/`$derived`/`$effect`); RBAC-гейтинг —
  через named derived stores в `permissionStore.js`, не `$user?.is_global_admin`
  в компонентах; компоненты shadcn-svelte вместо голого HTML.
- **n8n (agent)**: промты — файлами конвейера + Langfuse; боевую заливку
  Langfuse и рестарт агента волна НЕ делает, это диспетчер при выкатке;
  артефакты — по эталонам `n8n/docs/artifact-catalog` (синк «каталог → агент»
  скриптом, руками не править).

### Уроки этого проекта

- Витрина дизайн-системы — источник правды по внешнему виду: если у
  поверхности есть утверждённый макет (например
  `/design-system/passport-variants`, статус FINAL), правка сверяется с ним
  состояние-в-состояние.
- Шум базлайна линтера у нас ровно один класс — `Import could not be
  resolved`; всё остальное в базлайне подозрительно и требует проверки.

### Будка и сессии

- Будка одна на проект, якорь — каталог с `.claude/nyron-dev.md`. Сомнение
  «мы в одной будке?» проверяется в каждой сессии:
  `${CLAUDE_PLUGIN_ROOT}/hub/hub-watch.sh hubdir` — пути обязаны совпадать.
- Граф кода: user-scope MCP `codebase-memory` (пруф лестницы «нет ли уже» —
  `tool: graph`; реиндекс при мерже). Граф недоступен — фолбэк на grep, не
  блокер.
