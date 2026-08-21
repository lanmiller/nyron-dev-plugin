<script>
  // Окно сессии (этап 4, требование CTO дословно: «хочу прям в чат нужный
  // отвечать и открывать чат»): весь разговор из транскрипта, ask этой
  // сессии с ответом на месте, ввод — tmux мгновенно / Desktop зеркало.
  //
  // Волна 3: действия сессии описаны ОДНИМ списком (ACTIONS) и показаны
  // двумя способами — рядом чипов на широком экране и выпадающим меню в
  // общей шапке на телефоне (кнопка там, список отсюда через контекст).
  // Раньше это был раздвижной ряд с max-height, который на широком экране
  // так и оставался схлопнутым — действия просто не показывались.
  import { onMount, getContext, tick } from 'svelte';
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import Transcript from '$lib/Transcript.svelte';
  import AskCard from '$lib/AskCard.svelte';
  import FileBrowser from '$lib/FileBrowser.svelte';
  import Icon from '$lib/Icon.svelte';
  import PickChip from '$lib/PickChip.svelte';
  import * as Sheet from '$lib/ui/sheet/index.js';
  import TmuxPanel from '$lib/TmuxPanel.svelte';
  import { MODEL_OPTS, EFFORT_OPTS, MODE_OPTS } from '$lib/composer-options.js';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import { Skeleton } from '$lib/ui/skeleton/index.js';
  import { STATE_RU, age } from '$lib/states.js';

  const st = getContext('morda');

  let data = $state(null);
  let error = $state(null);
  let draft = $state('');
  let saying = $state(false);
  let sayError = $state(null);
  let sent = $state(null);
  let seq = 0;

  let project = $derived(page.params.project);
  let key = $derived(page.params.key);

  // План сессии: свой список задач она ведёт тулами TaskCreate/TaskUpdate, и
  // он был виден только в терминале — в чате человек не понимал, на каком
  // шаге работа (жалоба CTO 21.08 на аудиторе psylia). Данные уже в ленте,
  // отдельной ручки не нужно: собираем проекцией.
  const TASK_RU = { in_progress: 'идёт', completed: 'готово', cancelled: 'снята' };
  let plan = $derived.by(() => {
    const byId = new Map();
    for (const it of data?.items || []) {
      if (it.kind !== 'tool') continue;
      let inp = {};
      try { inp = typeof it.input === 'string' ? JSON.parse(it.input) : (it.input || {}); } catch {}
      if (it.name === 'TaskCreate') {
        // номер задачи живёт в ответе тула: «Task #3 created successfully»
        const id = String(it.result || '').match(/#(\d+)/)?.[1];
        if (id) byId.set(id, { id, subject: inp.subject || '', active: inp.activeForm || '', status: 'pending' });
      } else if (it.name === 'TaskUpdate' && byId.has(String(inp.taskId))) {
        const t = byId.get(String(inp.taskId));
        if (inp.status) t.status = inp.status;
        if (inp.subject) t.subject = inp.subject;
      }
    }
    return [...byId.values()];
  });
  // Фоновые команды: сессия запускает долгое (скан секретов по шести репо —
  // двадцать минут) и молчит, а в пульте выглядело зависанием (факт 21.08).
  // Признак запуска — в ответе тула, признак конца — в уведомлении рантайма.
  let bgRunning = $derived.by(() => {
    const items = data?.items || [];
    const out = [];
    items.forEach((it, idx) => {
      if (it.kind !== 'tool' || it.name !== 'Bash') return;
      const id = String(it.result || '').match(/running in background with ID: (\w+)/)?.[1];
      if (!id) return;
      const done = items.slice(idx + 1).some((n) =>
        String(n.text || '').includes(id) && /<status>\s*(completed|failed|killed)/.test(String(n.text || '')));
      if (done) return;
      let inp = {};
      try { inp = typeof it.input === 'string' ? JSON.parse(it.input) : (it.input || {}); } catch {}
      out.push({ id, ts: it.ts, what: inp.description || String(inp.command || '').slice(0, 60) || 'фоновая команда' });
    });
    return out;
  });

  let planNow = $derived(plan.find((t) => t.status === 'in_progress') || null);
  let planDone = $derived(plan.filter((t) => t.status === 'completed').length);
  let planOpen = $state(false);

  // Ширину колонки файлов человек тянет сам и она запоминается: единственного
  // «правильного» деления нет — читаешь документ, нужен файл шире; пишешь в
  // чат, шире нужен чат (просьба CTO 21.08).
  let bodyEl = $state(null);
  let paneW = $state(460);
  let dragging = $state(false);
  onMount(() => {
    const v = Number(localStorage.getItem('stovp:pane'));
    if (v >= 300) paneW = v;
  });
  function gripMove(e) {
    if (!dragging || !bodyEl) return;
    const r = bodyEl.getBoundingClientRect();
    paneW = Math.min(Math.max(r.right - e.clientX, 300), Math.max(320, r.width - 380));
  }
  function gripUp() {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem('stovp:pane', String(Math.round(paneW))); } catch {}
  }

  // Окно открывается СРАЗУ после запуска, ещё до привязки транскрипта
  // (CTO 19.08: ждать молча на главной было непонятно). Ключ вида «n-<имя>»
  // — это запись раннера: показываем стадию старта и подменяем адрес на
  // настоящий sessionId, как только он появится.
  let starting = $derived(key?.startsWith('n-') ? key.slice(2) : null);
  let startStage = $state('поднимаю CLI-сессию…');
  let startError = $state(null);
  const STAGE_RU = {
    starting: 'поднимаю CLI-сессию…',
    goal_sent: 'цель отправлена, жду ответа…',
    running: 'сессия пошла — открываю чат…',
    needs_auth: null, died_on_start: null,
  };
  $effect(() => {
    if (!starting) return;
    let stop = false;
    (async () => {
      for (let i = 0; i < 120 && !stop; i++) {
        try {
          const l = await (await fetch(`/api/runner?project=${encodeURIComponent(project)}`)).json();
          const e = l.sessions?.find((x) => x.name === starting);
          if (e?.sessionId) {
            return replaceState(`/s/${encodeURIComponent(project)}/${e.sessionId}`, {});
          }
          if (e?.state === 'needs_auth')
            startError = 'CLI не авторизован — подключи копию подписки в настройках';
          else if (e?.state === 'died_on_start')
            startError = `сессия умерла на старте — посмотри: tmux attach -t ${e.tmux || ''}`;
          else if (e?.screen === 'permission')
            startStage = 'сессия спрашивает разрешение…';
          else startStage = STAGE_RU[e?.state] || 'поднимаю CLI-сессию…';
        } catch { /* пульт перезапускается — следующий тик дотянется */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => { stop = true; };
  });

  async function refresh() {
    const my = ++seq;
    const [p, k] = [project, key];
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(p)}/${k}`);
      const next = await r.json();
      if (my !== seq || p !== project || k !== key) return;
      if (!r.ok) { error = next.error; return; }
      error = null;
      const first = data === null;
      const stick = nearBottom();
      data = next;
      if (stick) scrollDown(first);
    } catch { /* сервер перезапускается — следующий тик дотянется */ }
  }

  // Вниз ПОСЛЕ фактической отрисовки: tick() отпускает раньше, чем длинная
  // лента займёт высоту (жалоба CTO 10.08 — «приходится листать в самый
  // низ»); на первом показе добиваем повторами, пока высота не устаканится.
  async function scrollDown(first) {
    await tick();
    const to = () => window.scrollTo({ top: document.body.scrollHeight });
    to();
    if (!first) return;
    let h = 0;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 80));
      if (document.body.scrollHeight === h) break;
      h = document.body.scrollHeight;
      to();
    }
  }

  function nearBottom() {
    if (!data) return true; // первая загрузка — сразу вниз
    return window.innerHeight + window.scrollY > document.body.scrollHeight - 300;
  }

  onMount(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });
  // смена сессии в URL — перезагрузка окна с чистого листа
  $effect(() => { if (project && key && !starting) { data = null; refresh(); } });

  // Очередь живёт на СЕРВЕРЕ (реестр раннера): переживает закрытие вкладки
  // и перезапуск пульта, уходит сама, когда сессия освободится. Здесь —
  // только показ и отмена (CTO 19.08).
  let queued = $derived(data?.runner?.queue || []);
  async function unqueue(id) {
    await runnerAct('queue_remove', { id });
    refresh();
  }

  // доставка одного сообщения; true = ушло
  async function deliver(text) {
    try {
      const r = await fetch('/api/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, key, text }),
      });
      const body = await r.json();
      if (!r.ok) { sayError = body.error || `HTTP ${r.status}`; return false; }
      sent = body.via === 'tmux' ? 'доставлено в чат сессии'
        : body.via === 'resume' ? body.note
          : `в будке (адресовано сессии) — ${body.note}`;
      return true;
    } catch (e) {
      sayError = String(e.message || e);
      return false;
    }
  }

  async function sendText() {
    if (!draft.trim() && !attachments.length) return;
    const text = (draft.trim() || 'посмотри приложенные файлы') + (attachments.length
      ? '\n\nПриложенные файлы (смотри их содержимое при необходимости):\n'
        + attachments.map((a) => `- ${a.path}`).join('\n')
      : '');
    // занята — в очередь пульта (видно, можно отменить, не теряется при
    // закрытии вкладки); свободна — уходит сразу
    if (data?.runner?.busy && data.runner.name) {
      const ok = await runnerAct('queue_add', { text });
      if (ok !== null) { draft = ''; attachments = []; sayError = null; sent = null; }
      refresh();
      return;
    }
    saying = true; sayError = null; sent = null;
    try {
      if (await deliver(text)) { draft = ''; attachments = []; }
    } finally { saying = false; refresh(); }
  }

  async function openCopy(app) {
    await fetch('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morda': '1' },
      body: JSON.stringify({ app }),
    });
  }

  let opening = $state(false);
  async function openInClaude() {
    opening = true;
    try {
      const r = await fetch('/api/open-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, key }),
      });
      if (!r.ok) sayError = (await r.json()).error || `HTTP ${r.status}`;
    } finally { opening = false; }
  }
  function copyLabel(app) {
    const m = app.match(/^Claude \((.+)\)$/);
    return m ? m[1] : 'Claude';
  }

  // На узком экране карточки вопросов съедали пол-экрана над вводом
  // (CTO 11.08: «на мобилке слабо»). Теперь они шторка: строка-кнопка с
  // числом, разворачивается поверх ленты, композер всегда на месте.
  let sheet = $state(false);
  // На телефоне пять чипов и подсказка про доставку съедали половину экрана
  // (замер 11.08: шапка 226 px, композер 179 px при высоте окна 812).
  // Детали прячем за кнопкой, разговор получает место.
  let details = $state(false);
  let files = $state(false);   // обозреватель файлов проекта этой сессии

  // шторка вопросов: на десктопе открыта сразу и открывается при новом
  // вопросе (CTO 17.08: «как на мобилке, но чтобы можно было свернуть»)
  onMount(() => {
    if (window.matchMedia('(min-width: 901px)').matches) sheet = true;
  });

  let stateInfo = $derived(STATE_RU[data?.state] || null);
  let isDesktop = $derived(data?.entrypoint === 'claude-desktop');

  // Раннер (этап 1 STOVP-58): если процессом владеет пульт — стоп и резюм
  // прямо из карточки. Стоп = парковка: транскрипт на диске, --resume
  // поднимет с контекстом.
  let runnerBusy = $state(false);
  async function runnerAct(action, extra = {}) {
    runnerBusy = true;
    try {
      const r = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ action, name: data.runner.name, ...extra }),
      });
      if (!r.ok) { sayError = (await r.json()).error || `HTTP ${r.status}`; return null; }
      return await r.json().catch(() => ({}));
    } finally { runnerBusy = false; refresh(); }
  }

  // Действия сессии — один список на два места показа: чипы в шапке
  // (широкий экран) и пункты меню в общей шапке (телефон).
  let actions = $derived(data ? [
    // «думает…» — модель отвечает прямо сейчас (CLI держит «esc to
    // interrupt»); иначе обычное состояние сторожа
    ...(data.runner?.busy ? [{ label: 'думает…', dot: 'var(--ok)', note: true }]
      : stateInfo ? [{ label: stateInfo[0], dot: stateInfo[1], note: true }] : []),
    ...(data.runner ? [data.runner.alive
      ? { label: 'остановить', icon: 'pause', disabled: runnerBusy,
        run: () => runnerAct('stop'),
        title: 'CLI-процесс закроется физически; транскрипт цел — сессия поднимется от сообщения или кнопкой «поднять резюмом»' }
      : { label: 'поднять резюмом', icon: 'play', disabled: runnerBusy,
        run: () => runnerAct('resume'),
        title: 'claude --resume — тот же разговор с полным контекстом' }] : []),
    ...(data.runner?.alive ? [{ label: 'консоль', icon: 'terminal',
      run: () => (consoleOpen = true),
      title: 'настоящий экран терминала сессии — как tmux attach, только здесь' }] : []),
    { label: 'копия в Claude', icon: 'external-link', disabled: opening, run: openInClaude,
      title: 'claude://resume — приложение откроет копию этого разговора' },
    ...(data.cwd ? [{ label: files ? 'скрыть файлы' : 'файлы проекта', icon: 'folder-tree',
      on: files, run: () => (files = !files), title: `файлы: ${data.cwd}` }] : []),
    { label: details ? 'скрыть детали' : 'детали', icon: 'info',
      on: details, run: () => (details = !details) },
  ] : []);
  $effect(() => {
    st.sessionMenu = actions;
    return () => { st.sessionMenu = null; };
  });

  // вложения в живой чат (этап 2, «вложения путём файла»): файл уезжает в
  // проект, сессии уйдёт путь — тем же чипом, что в композере старта
  let attachments = $state([]); // { path, name }
  let fileEl = $state(null);
  let uploading = $state(false);
  async function attachFiles(files) {
    uploading = true;
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append('project', project);
        fd.append('file', f);
        const r = await fetch('/api/upload', {
          method: 'POST', headers: { 'x-morda': '1' }, body: fd,
        });
        const out = await r.json();
        if (!r.ok) { sayError = out.error || `HTTP ${r.status}`; continue; }
        attachments = [...attachments, out];
      }
    } finally { uploading = false; if (fileEl) fileEl.value = ''; }
  }

  // Чипы параметров сессии — те же, что на старте (запрос CTO 17.08:
  // «сделай такой же инпут»). Смена у живой = перезапуск резюмом с новыми
  // аргументами (контекст цел), у запаркованной — запишется до подъёма.
  let tuneModel = $state('fable');
  let tuneEffort = $state('high');
  let tuneMode = $state('auto');
  let tuneName = null;   // за какую запись раннера отвечают чипы
  let prevTune = null;   // отпечаток значений: сид ≠ смена человеком
  $effect(() => {
    const r = data?.runner;
    if (!r || tuneName === r.name) return;
    tuneName = r.name;
    tuneModel = r.model || 'fable';
    tuneEffort = r.effort || 'high';
    tuneMode = r.mode || '';
    prevTune = null;
  });
  $effect(() => {
    const cur = [tuneModel, tuneMode, tuneEffort].join('|');
    if (!data?.runner) return;
    if (prevTune === null) { prevTune = cur; return; }
    if (cur === prevTune) return;
    prevTune = cur;
    runnerAct('retune', { model: tuneModel, mode: tuneMode, effort: tuneEffort });
  });

  // Живой TUI-диалог CLI (HITL-пикер, /usage, /model): транскрипт его не
  // видит. Формы рендерятся НАТИВНО (runner.dialog — структура с экрана,
  // семантика клавиш снята фактом 17.08); не распарсилось — сырой экран.
  let cliDialog = $derived(data?.runner?.alive
    && ['hitl', 'dialog'].includes(data.runner.screen)
    && data.runner.screen_text ? data.runner : null);
  async function sendKey(k) {
    await runnerAct('key', { key: k });
    setTimeout(refresh, 600);   // экран tmux дорисовывается после клика
  }
  // свой вариант ответа: цифрой фокусируется «Type something», текст
  // литералом, Enter — одной серверной операцией (между кликами не влезает
  // поллинг)
  // форма-слайдер: свёртка своей стрелкой; новая форма раскрывается сама
  let dlgOpen = $state(true);
  let hadDialog = false;
  $effect(() => {
    const has = !!cliDialog;
    if (has && !hadDialog) dlgOpen = true;
    hadDialog = has;
  });
  // клик по табу — прыжок Tab/BTab от текущего (подсветку отдаёт парсер)
  function jumpTab(i) {
    const tabs = cliDialog?.dialog?.tabs || [];
    const cur = tabs.findIndex((t) => t.current);
    if (cur < 0 || i === cur) return;
    runnerAct('key', { key: i > cur ? 'Tab' : 'BTab', times: Math.abs(i - cur) });
    setTimeout(refresh, 700);
  }
  // Субагент — отдельной поверхностью, а не вложенным аккордеоном
  // (CTO 19.08, mobile-first): тап по строке открывает шторку с его лентой.
  let agentSheet = $state(null);   // { agent, items, error } | null
  let agentOpen = $state(false);
  // содержимое действия на телефоне — той же шторкой (в ленте под
  // композером места не остаётся, а шторка всегда открывается во весь кадр)
  let toolSheet = $state(null);    // элемент ленты | null
  let toolOpen = $state(false);
  function openTool(it) { toolSheet = it; toolOpen = true; }
  let agentsOpen = $state(false);  // раскрыт ли список агентов у чипа
  async function openAgent(agent) {
    agentSheet = { agent, items: null, error: null };
    agentOpen = true;
    try {
      const r = await fetch(`/api/agent/${encodeURIComponent(project)}/${key}/${agent.agentId}`);
      const out = await r.json();
      agentSheet = r.ok ? { agent, items: out.items, error: null }
        : { agent, items: null, error: out.error || `HTTP ${r.status}` };
    } catch (e) {
      agentSheet = { agent, items: null, error: String(e.message || e) };
    }
  }

  // Чем сессия занята прямо сейчас: последнее действие из ленты. Плюс
  // «прервать» — Escape в её терминал: останавливает текущий шаг, но НЕ
  // убивает сессию (в отличие от «остановить» в меню). CTO 19.08.
  let lastAction = $derived.by(() => {
    const items = data?.items || [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind !== 'tool') continue;
      const n = String(it.name || '');
      const short = n.includes('__') ? n.split('__').filter(Boolean).pop() : n;
      return it.input ? `${short}: ${String(it.input).slice(0, 60)}` : short;
    }
    return 'думает над ответом';
  });
  async function interrupt() {
    await runnerAct('key', { key: 'Escape' });
    setTimeout(refresh, 800);
  }

  // Живая консоль сессии: настоящий экран tmux под рукой (CTO 19.08 —
  // «чтобы всегда можно было посмотреть реальную консоль»). Открыта —
  // обновляем раз в 2 секунды, закрыта — не дёргаем сервер.
  let consoleOpen = $state(false);
  let consoleText = $state('');
  let consoleErr = $state(null);
  $effect(() => {
    if (!consoleOpen || !data?.runner?.name) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/runner', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-morda': '1' },
          body: JSON.stringify({ action: 'screen', name: data.runner.name, lines: 80 }),
        });
        const out = await r.json();
        if (r.ok) { consoleText = out.screen; consoleErr = null; }
        else consoleErr = out.error;
      } catch (e) { consoleErr = String(e.message || e); }
    };
    tick();
    const t = setInterval(() => { if (!stop) tick(); }, 2000);
    return () => { stop = true; clearInterval(t); };
  });

  let freeText = $state('');
  async function sendFree(n) {
    if (!freeText.trim()) return;
    await runnerAct('type', { digit: String(n), text: freeText.trim() });
    freeText = '';
    setTimeout(refresh, 600);
  }
  // физическая клавиатура работает по форме (жалоба CTO: «кнопочки на
  // клавиатуре не срабатывают»); ввод в полях не перехватываем
  const KEYMAP = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'BTab',
    ArrowRight: 'Tab', Tab: 'Tab', Enter: 'Enter', Escape: 'Escape' };
  function dialogKeydown(e) {
    if (!cliDialog) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    const k = KEYMAP[e.key] || (/^[1-9]$/.test(e.key) ? e.key : null);
    if (!k) return;
    e.preventDefault();
    sendKey(e.shiftKey && k === 'Tab' ? 'BTab' : k);
  }

  // поле растёт под текст, как в Claude: одна строка по умолчанию,
  // Enter отправляет, Shift+Enter — перенос
  let ta = $state(null);
  // Лента уезжала под нижнюю плашку: отступ был константой, а плашка растёт
  // от шторки вопросов и подсказки (CTO 11.08 «текст под плашкой»).
  let dockEl = $state(null);
  $effect(() => {
    if (!dockEl) return;
    const set = () => document.documentElement.style.setProperty(
      '--dock-h', dockEl.offsetHeight + 'px');
    set();
    const ro = new ResizeObserver(set);
    ro.observe(dockEl);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--dock-h'); };
  });
  function grow() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  $effect(() => { if (draft === '' && ta) ta.style.height = 'auto'; });
  // форма-слайдер живёт НЕ в шторке (она всегда над композером), поэтому
  // здесь только карточки шторки: ask, родные HITL приложения, разрешения
  let openAsks = $derived((data?.asks || []).filter((a) => a.status === 'open'));
  let openCount = $derived(openAsks.length + (data?.pending_hitl ? 1 : 0)
    + (data?.runner?.alive && data.runner.screen === 'permission' ? 1 : 0));
  // в доке — только живое: открытые и ответы в пути; подтверждённое своё
  // отработало и чат не перекрывает (CTO 10.08)
  let recentDecided = $derived((data?.asks || [])
    .filter((a) => ['answered', 'delivered'].includes(a.status)).slice(-2));
  let sheetCount = $derived(openCount + recentDecided.length);
  // ответил — шторка закрывается сама; новый вопрос на десктопе — сам
  // открывается (на телефоне остаётся кнопкой, чтобы не съедать экран)
  let prevOpen = 0;
  $effect(() => {
    if (openCount < prevOpen) sheet = false;
    else if (openCount > prevOpen
      && window.matchMedia('(min-width: 901px)').matches) sheet = true;
    prevOpen = openCount;
  });
</script>

<svelte:head><title>{data?.title || key?.slice(0, 8)} — STOVP</title></svelte:head>
<svelte:window onkeydown={dialogKeydown} onpointermove={gripMove} onpointerup={gripUp} />

{#if starting}
  <!-- сессия рождается: человек видит стадию, а не пустой экран -->
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">
      <Icon name="arrow-left" size={13} /> {project}
    </a>
    <h1 class="s-title">Новая сессия</h1>
  </header>
  <div class="starting">
    {#if startError}
      <p class="err">{startError}</p>
      <a class="quiet" href="/settings">открыть настройки раннера →</a>
    {:else}
      <span class="spin"><Icon name="loader-circle" size={18} /></span>
      <b>{startStage}</b>
      <span class="quiet">цель уже отправлена — как только сессия ответит, чат откроется сам</span>
    {/if}
  </div>
{:else if error}
  <p class="err">{error}</p>
{:else if !data}
  <!-- каркас рисуется сразу: у диспетчеров транскрипт мегабайтный, и пустой
       экран на несколько секунд читался как «всё умерло» (CTO 11.08) -->
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">
      <Icon name="arrow-left" size={13} /> {project}
    </a>
    <h1 class="s-title quiet">Открываю сессию…</h1>
  </header>
  <div class="flex flex-col gap-2.5 pt-3.5">
    {#each [72, 45, 88, 60] as w}<Skeleton class="h-4" style="width: {w}%" />{/each}
  </div>
{:else}
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">
      <Icon name="arrow-left" size={13} /> {project}
    </a>
    <h1 class="s-title">{data.title || '(без названия)'}</h1>
    <!-- Шапка работает, а не подписывает: статус, действия сессии и уже
         потом технические детали (CTO 11.08 — «сделать её функциональной»).
         На телефоне тот же список открывает кнопка в общей шапке. -->
    <div class="s-actions">
      {#each actions as a (a.label)}
        {#if a.note}
          <Badge variant="outline"><i class="dot" style="background:{a.dot}"></i>{a.label}</Badge>
        {:else}
          <Button variant="outline" size="xs" disabled={a.disabled} onclick={a.run}
            title={a.title} class={a.on ? 'border-primary text-ink-1' : ''}>
            <Icon name={a.icon} size={13} />{a.label}
          </Button>
        {/if}
      {/each}
    </div>
    {#if details}
      <div class="s-meta">
        <Badge variant="outline" class="mono">{key.slice(0, 8)}</Badge>
        <Badge variant="outline">{isDesktop ? 'Desktop' : data.entrypoint === 'sdk-cli' ? 'headless' : data.entrypoint || '?'}</Badge>
        {#if data.truncated}
          <Badge variant="outline" title="файл больше лимита окна — показан хвост">хвост, файл {(data.size / 1048576).toFixed(1)} МБ</Badge>
        {/if}
        {#if data.cwd_alive === false}
          <Badge variant="warn">папка сессии снесена</Badge>
        {/if}
        <Badge variant="outline" class="max-w-full overflow-hidden text-ink-4" title={data.cwd}>{data.cwd || '—'}</Badge>
      </div>
    {/if}
    {#if data.reason}<p class="reason quiet">{data.reason}</p>{/if}
  </header>

  <!-- На широком экране файлы стоят колонкой справа, как в Клоде: раньше
       браузер файлов вставал НАД лентой и до него надо было листать вверх
       (жалоба CTO 21.08). На узком — та же разметка одной колонкой. -->
  <div class="body" class:with-files={files} class:dragging bind:this={bodyEl}
    style="--pane: {paneW}px">
    <div class="chat">
      <Transcript items={data.items} {project} sessionKey={key} tracker={data.tracker}
        {openAgent} {openTool} agents={data.agents} />
    <!-- ЗАКРЫТИЕ .chat — после нижней панели: ввод принадлежит чату, а не
         странице (CTO 21.08). Правая колонка вставлена ниже. -->

  <!-- Живая консоль: реальный экран tmux, обновляется сам -->
  <Sheet.Root bind:open={consoleOpen}>
    <Sheet.Content side="bottom" class="agent-sheet">
      <Sheet.Header class="agent-head">
        <div class="dlg-col">
          <Sheet.Title>Консоль сессии</Sheet.Title>
          <Sheet.Description>живой экран терминала, обновляется каждые 2 секунды</Sheet.Description>
        </div>
      </Sheet.Header>
      <div class="agent-body">
        <TmuxPanel screen={consoleText} tmux={data.runner?.tmux} error={consoleErr}
          busy={runnerBusy} onKey={(k) => sendKey(k)}
          onType={async (t) => { await runnerAct('type', { text: t }); setTimeout(refresh, 600); }} />
      </div>
    </Sheet.Content>
  </Sheet.Root>

  <!-- Что сделало действие: ввод и вывод во весь кадр, закрывается свайпом
       или крестиком (телефон; на десктопе плашка раскрывается в ленте) -->
  <Sheet.Root bind:open={toolOpen}>
    <Sheet.Content side="bottom" class="agent-sheet">
      <Sheet.Header class="agent-head">
        <div class="dlg-col">
          <Sheet.Title>{toolSheet?.name || 'действие'}</Sheet.Title>
          {#if toolSheet?.is_error}
            <Sheet.Description class="text-hot">завершилось ошибкой</Sheet.Description>
          {/if}
        </div>
      </Sheet.Header>
      <div class="agent-body">
        {#if toolSheet?.input}
          <p class="tsec">ввод</p>
          <pre class="cli-screen">{toolSheet.input}</pre>
        {/if}
        <p class="tsec">вывод</p>
        <pre class="cli-screen">{toolSheet?.result || '(пусто)'}</pre>
      </div>
    </Sheet.Content>
  </Sheet.Root>

  {#each queued as q (q.id)}
    <!-- ждёт в очереди пульта: уйдёт, когда сессия освободится; крестик снимает -->
    <div class="user queued">
      <div class="bubble md-body">
        {q.text}
        <button class="q-x" aria-label="убрать из очереди" title="убрать из очереди"
          onclick={() => unqueue(q.id)}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <!-- почему тишина: сообщение не потерялось, а ждёт конца текущего шага
           (CTO 21.08: «отправил два сообщения и тишина») -->
      <span class="q-note">ждёт — сессия занята, уйдёт как освободится</span>
    </div>
  {/each}

  <!-- Лента субагента во весь экран: заголовок = кто и зачем, тело — та же
       лента, что у сессии (вложенные субагенты открываются поверх) -->
  <Sheet.Root bind:open={agentOpen}>
    <Sheet.Content side="bottom" class="agent-sheet">
      <Sheet.Header class="agent-head">
        {#if agentSheet}
          <button class="dlg-x" aria-label="к списку агентов"
            onclick={() => (agentSheet = null)}><Icon name="arrow-left" size={16} /></button>
        {/if}
        <div class="dlg-col">
          <Sheet.Title>
            {#if agentSheet}
              {agentSheet.agent?.name || agentSheet.agent?.agentId || 'субагент'}
              {#if agentSheet.agent?.agentType}<span class="quiet"> · {agentSheet.agent.agentType}</span>{/if}
            {:else}
              Агенты сессии
            {/if}
          </Sheet.Title>
          {#if agentSheet?.agent?.description}
            <Sheet.Description>{agentSheet.agent.description}</Sheet.Description>
          {:else if !agentSheet}
            <Sheet.Description>кого сессия подняла себе в помощь — тап открывает его ленту</Sheet.Description>
          {/if}
        </div>
      </Sheet.Header>
      <div class="agent-body">
        {#if !agentSheet}
          <!-- список: статус точкой, имя, задача; тап — его лента -->
          <!-- строки как в шторке выбора модели: имя, задача, статус.
               Воркфлоу пойдут этим же списком (kind='workflow') —
               помощник сессии он и есть, отличается только иконкой. -->
          <div class="ag-list">
            {#each data.agents || [] as a (a.agentId)}
              <button class="ag-row" class:on={a.busy} onclick={() => openAgent(a)}>
                <Icon name={a.kind === 'workflow' ? 'workflow' : 'bot'} size={17}
                  class="flex-none {a.failed ? 'text-hot' : a.busy ? 'text-ok' : 'text-ink-4'}" />
                <span class="ag-col">
                  <b>{a.name || a.agentId}</b>
                  {#if a.description}<span class="ag-desc">{a.description}</span>{/if}
                </span>
                <!-- молчание агента само по себе ничего не говорило: «уже
                     отработал» и «не пойми что» выглядели одинаково (CTO 21.08) -->
                {#if a.busy}<span class="ag-state">работает</span>
                {:else if a.failed}<span class="ag-state bad">ошибка</span>
                {:else}<span class="ag-state done">отработал</span>{/if}
                <Icon name="chevron-right" size={16} class="text-ink-4 flex-none" />
              </button>
            {/each}
          </div>
        {:else if agentSheet.error}
          <p class="err">{agentSheet.error}</p>
        {:else if !agentSheet.items}
          <p class="quiet">читаю ленту субагента…</p>
        {:else}
          <Transcript items={agentSheet.items} {project} sessionKey={key}
            tracker={data.tracker} {openAgent} agents={data.agents} />
        {/if}
      </div>
    </Sheet.Content>
  </Sheet.Root>

  <div class="dock" bind:this={dockEl} style="--pane: {paneW}px">
    <!-- Узкий экран: сводка-кнопка вместо стопки карточек -->
    <!-- Кнопка живёт, пока в шторке есть что показывать: раньше она
         исчезала вместе с отвеченным вопросом и свернуть было нечем
         (CTO 11.08 «ответил — а как свернуть теперь?») -->
    {#if sheetCount}
      <div class="sheet-row">
        <Button variant="ghost" size="sm" class="w-full justify-start gap-2"
          aria-expanded={sheet} onclick={() => (sheet = !sheet)}>
          {#if openCount}<Badge>{openCount}</Badge>{/if}
          <span class="flex-1 text-left">
            {sheet ? 'свернуть' : openCount ? 'вопросы ждут решения' : 'ответы в пути'}
          </span>
          <Icon name={sheet ? 'chevron-down' : 'chevron-up'} size={14} class="text-ink-4" />
        </Button>
      </div>
    {/if}
    <!-- вопросы — в прокрутке, композер всегда виден (CTO 10.08: пачка
         карточек не должна выталкивать ввод за экран) -->
    <div class="dock-asks" class:sheet-open={sheet}>
      {#if data.runner?.alive && data.runner?.screen === 'permission'}
        <!-- CLI-диалог разрешения: сессия СТОИТ и ждёт человека в терминале.
             «Да»/«нет» уезжают в её tmux; «не спрашивать больше» — только
             лично в терминале (это решение шире одного клика). -->
        <article class="hitl">
          <header>
            <b>Сессия ждёт разрешения: {data.runner.permission?.title || 'действие'}</b>
            <span class="meta">диалог CLI в её терминале — реши здесь или tmux attach -t {data.runner.tmux}</span>
          </header>
          <!-- ЧТО именно просят: команда/файл как есть, плюс пометки CLI -->
          {#if data.runner.permission?.body}
            <pre class="cli-screen">{data.runner.permission.body}</pre>
          {/if}
          {#each data.runner.permission?.notes || [] as n (n)}
            <p class="meta">{n}</p>
          {/each}
          <div class="perm-row">
            <Button disabled={runnerBusy} onclick={() => runnerAct('approve', { answer: 'yes' })}>
              разрешить
            </Button>
            <Button variant="outline" disabled={runnerBusy}
              onclick={() => runnerAct('approve', { answer: 'no' })}>
              отказать
            </Button>
          </div>
        </article>
      {/if}
      {#if data.pending_hitl}
        <!-- родная форма AskUserQuestion ждёт человека В ОКНЕ ПРИЛОЖЕНИЯ:
             морда её показывает, но кликнуть вариант можно только там -->
        <article class="hitl">
          {#each data.pending_hitl.questions as q, qi}
            <header>
              <b>{q.question}</b>
              <span class="meta">
                форма приложения · {q.multiSelect ? 'можно несколько' : 'один вариант'} · {age(data.pending_hitl.ts)}
              </span>
            </header>
            {#each q.options || [] as o}
              {#if q.multiSelect}
                <label class="opt" class:picked={hitlPicked[qi]?.has(o.label)}>
                  <input type="checkbox"
                    checked={hitlPicked[qi]?.has(o.label)}
                    onchange={() => toggleHitl(qi, o.label)} />
                  <span class="opt-body"><b>{o.label}</b>
                    {#if o.description}<span>{o.description}</span>{/if}</span>
                </label>
              {:else}
                <button class="opt" disabled={saying}
                  onclick={() => sendFormChoice(q.question, o.label)}>
                  <b>{o.label}</b>
                  {#if o.description}<span>{o.description}</span>{/if}
                </button>
              {/if}
            {/each}
          {/each}
          {#if data.pending_hitl.questions.some((q) => q.multiSelect)}
            <Button class="mt-2.5" disabled={saying || !hitlAny} onclick={sendHitlPicked}>
              отправить выбранное
            </Button>
          {/if}
          <p class="meta">Выбор уйдёт сессии адресным сообщением (доставит почтальон); свой вариант — текстом в композере ниже. Мгновенно и наверняка — клик в её окне приложения.</p>
        </article>
      {/if}
      {#each openAsks as a (a.id)}
        <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
      {/each}
      {#each recentDecided as a (a.id)}
        <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
      {/each}
    </div>

    {#if plan.length}
      <!-- Ход работы: свой список ступеней сессия ведёт тулами задач, и он
           был виден только в терминале. Стоит внизу у ввода — там же, где
           его рисует сам CLI (CTO 21.08: «почему таск-трекер сверху?»).
           Свёрнут в строку «N из M», разворачивается списком. -->
      <div class="plan" class:open={planOpen}>
        <button class="plan-head" onclick={() => (planOpen = !planOpen)}>
          <Icon name={planOpen ? 'chevron-down' : 'chevron-right'} size={14} class="text-ink-4 flex-none" />
          <b>{planDone} из {plan.length}</b>
          <span class="plan-now">{planNow ? (planNow.active || planNow.subject) : 'ждёт следующего шага'}</span>
        </button>
        {#if planOpen}
          <ol class="plan-list">
            {#each plan as t (t.id)}
              <li class={t.status}>
                <Icon size={14} class="flex-none {t.status === 'completed' ? 'text-ok'
                  : t.status === 'in_progress' ? 'text-primary' : 'text-ink-4'}"
                  name={t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'loader-circle' : 'circle'} />
                <span>{t.subject}</span>
                {#if TASK_RU[t.status]}<em>{TASK_RU[t.status]}</em>{/if}
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    {/if}

    {#if data.runner?.busy}
      <!-- как в приложении Claude: строка «работает · чем занята», а
           остановку даёт сама кнопка композера (стрелка → квадрат) -->
      <div class="working">
        <Icon name="sparkles" size={13} class="text-primary" />
        <!-- та же строка, что показывает сам CLI: чем занята, сколько идёт,
             сколько токенов. Кусок JSON последнего тула тут не читался -->
        {#if data.runner?.pulse}
          {@const p = data.runner.pulse}
          <span class="work-what">
            {p.what || 'работает'}{p.elapsed ? ` · ${p.elapsed}` : ''}{p.tokens ? ` · ↓${p.tokens}` : ''}{p.note ? ` · ${p.note}` : ''}
          </span>
        {:else}
          <span class="work-what">работает · {lastAction}</span>
        {/if}
      </div>
    {/if}

    {#each bgRunning as b (b.id)}
      <div class="working bg-run">
        <Icon name="loader-circle" size={13} class="text-ink-4" />
        <span class="work-what">в фоне · {b.what} · {age(b.ts)}</span>
      </div>
    {/each}

    {#if cliDialog}
      <!-- Форма CLI (AskUserQuestion и пикеры) — единый слайдер над
           композером (CTO 17.08): кликабельные табы-вопросы, сворачивается
           своей стрелкой, без внутреннего скролла. Клик = клавиша в tmux;
           физическая клавиатура работает (цифры, стрелки, Tab, Enter, Esc). -->
      <article class="hitl dlg-card">
        {#if cliDialog.dialog}
          {@const d = cliDialog.dialog}
          {@const qtabs = d.tabs?.filter((t) => !t.submit) || []}
          <header class="dlg-head">
            <button class="dlg-x" aria-label={dlgOpen ? 'свернуть форму' : 'развернуть форму'}
              title={dlgOpen ? 'свернуть — ответишь позже' : 'развернуть форму'}
              onclick={() => (dlgOpen = !dlgOpen)}>
              <Icon name={dlgOpen ? 'chevron-down' : 'chevron-up'} size={15} />
            </button>
            {#if d.tabs && qtabs.length > 1}
              <div class="dlg-tabs">
                {#each d.tabs as t, i (t.label)}
                  <button class="dlg-tab" class:done={t.answered} class:cur={t.current}
                    disabled={runnerBusy}
                    title={t.submit ? 'к отправке ответов' : `перейти к вопросу «${t.label}»`}
                    onclick={() => jumpTab(i)}>
                    {#if t.answered}<Icon name="check" size={11} />{/if}{t.submit ? 'Отправка' : t.label}
                  </button>
                {/each}
              </div>
            {:else}
              <b class="dlg-mini">{d.kind === 'review' ? 'Отправить ответы?' : d.question || 'Форма сессии'}</b>
            {/if}
            <button class="dlg-x" title="отменить всю форму (Esc)" aria-label="отменить форму"
              onclick={() => sendKey('Escape')}><Icon name="x" size={15} /></button>
          </header>
          {#if dlgOpen}
            {#if d.kind === 'question'}
              {#if d.tabs && qtabs.length > 1}<b class="dlg-q">{d.question}</b>{/if}
              {#each d.options.filter((o) => !o.chat && !o.free) as o (o.n)}
                <button class="opt dlg-opt" class:picked={o.selected} disabled={runnerBusy}
                  title={d.multi ? 'переключить отметку' : 'выбрать и перейти дальше'}
                  onclick={() => sendKey(String(o.n))}>
                  {#if d.multi}
                    <span class="cbx" class:on={o.selected}>{#if o.selected}<Icon name="check" size={12} />{/if}</span>
                  {/if}
                  <span class="opt-col">
                    <b>{o.label}{#if !d.multi && o.selected} ✓{/if}</b>
                    {#if o.desc}<span>{o.desc}</span>{/if}
                  </span>
                </button>
              {/each}
              {#each d.options.filter((o) => o.free) as o (o.n)}
                <div class="opt free-opt" class:picked={o.selected}>
                  <b>Свой вариант</b>
                  <div class="free-row">
                    <input class="free-in" placeholder="напиши свой ответ…" bind:value={freeText}
                      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendFree(o.n); } }} />
                    <Button size="xs" disabled={runnerBusy || !freeText.trim()}
                      onclick={() => sendFree(o.n)}>ответить</Button>
                  </div>
                </div>
              {/each}
              {#if d.tabs}
                <div class="perm-row">
                  <Button variant="outline" size="xs" disabled={runnerBusy}
                    title="к предыдущему вопросу — ответ можно перевыбрать"
                    onclick={() => sendKey('BTab')}>← назад</Button>
                  <span class="grow-mini"></span>
                  <Button size="xs" disabled={runnerBusy}
                    title="к следующему вопросу; выбранное сохраняется"
                    onclick={() => sendKey('Tab')}>
                    {d.multi ? 'готово' : 'пропустить'} →
                  </Button>
                </div>
              {/if}
            {:else}
              {#each d.answers as a (a.question)}
                <div class="opt review-row"><b>{a.question}</b><span>→ {a.answer || '—'}</span></div>
              {/each}
              <div class="perm-row">
                <Button variant="outline" size="xs" disabled={runnerBusy}
                  title="вернуться и поменять ответы" onclick={() => sendKey('BTab')}>← назад</Button>
                <span class="grow-mini"></span>
                <Button size="xs" disabled={runnerBusy} onclick={() => sendKey('1')}>отправить ответы</Button>
                <Button variant="outline" size="xs" disabled={runnerBusy}
                  title="отменить всю форму" onclick={() => sendKey('2')}>отменить</Button>
              </div>
            {/if}
            <details class="dlg-raw">
              <summary>экран CLI как есть</summary>
              <pre class="cli-screen">{cliDialog.screen_text}</pre>
            </details>
          {/if}
        {:else}
          <!-- фолбэк: пикер не распарсился (напр. /usage) — сырой экран -->
          <header>
            <b>В терминале сессии открыт диалог</b>
            <span class="meta">живой экран; навигация — клавишами ниже</span>
          </header>
          <TmuxPanel screen={cliDialog.screen_text} tmux={cliDialog.tmux}
            busy={runnerBusy} onKey={(k) => sendKey(k)} />
        {/if}
      </article>
    {/if}

    <!-- Тот же композер, что на старте сессии (запрос CTO 17.08): сверху
         аккаунт-пометка и вложения, снизу параметры. Разница одна — проект
         уже выбран рождением сессии. -->
    <div class="composer-box launch-box">
      {#if data.runner || attachments.length || data.agents?.length}
        <div class="launch-top">
          {#if data.runner}
            <span class="chip-note" title="аккаунт, с которого едет сессия — задан при запуске">
              <Icon name="key-round" size={13} />{data.runner.slot_label || 'основной'}
            </span>
          {/if}
          <!-- агенты и воркфлоу сессии — чипом здесь же (CTO 19.08: так
               чище); тап открывает список шторкой, из него — лента агента -->
          {#if data.agents?.length}
            {@const busyN = data.agents.filter((a) => a.busy).length}
            <button class="agent-chip" class:busy={busyN > 0}
              title="субагенты этой сессии — открыть список"
              onclick={() => { agentSheet = null; agentOpen = true; }}>
              <i class="dot" style="background:{busyN ? 'var(--ok)' : 'var(--text-4)'}"></i>
              <b>агенты {data.agents.length}</b>
              {#if busyN}<span>{busyN} в работе</span>{/if}
            </button>
          {/if}
          {#each attachments as a (a.path)}
            <span class="att" title={a.path}>
              <Icon name="paperclip" size={12} />
              <span class="att-name">{a.name}</span>
              <button class="att-x" aria-label="убрать файл"
                onclick={() => (attachments = attachments.filter((x) => x.path !== a.path))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          {/each}
        </div>
      {/if}
      <input type="file" multiple hidden bind:this={fileEl}
        onchange={(e) => attachFiles([...e.currentTarget.files])} />
      <textarea rows="1" bind:this={ta} bind:value={draft} oninput={grow}
        placeholder={data.runner?.busy ? 'сообщение подождёт в очереди…' : data.input?.mode === 'tmux' ? 'написать в чат сессии…' : 'написать сессии…'}
        onkeydown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault(); sendText();
        }}></textarea>
      <div class="launch-bar">
        <button class="plus" disabled={uploading || saying}
          aria-label="приложить файл или фото" title="приложить файл или фото — сессии уйдёт путь"
          onclick={() => fileEl?.click()}>
          <Icon name={uploading ? 'loader-circle' : 'plus'} size={16} />
        </button>
        {#if data.runner}
          <PickChip bind:value={tuneModel} bind:subValue={tuneEffort}
            disabled={runnerBusy}
            title="Модель сессии — смена перезапустит её резюмом (контекст цел)"
            options={MODEL_OPTS}
            subLabel="Effort" subIcon="gauge" subTitle="Усилие рассуждения"
            subOptions={EFFORT_OPTS} />
          <PickChip bind:value={tuneMode} disabled={runnerBusy}
            title="Разрешения — смена перезапустит сессию резюмом" options={MODE_OPTS} />
        {/if}
        <span class="grow"></span>
        {#if data.runner?.busy && !draft.trim() && !attachments.length}
          <button class="send stop" disabled={runnerBusy} onclick={interrupt}
            aria-label="остановить текущий шаг"
            title="остановить текущий шаг; сессия останется живой">
            <Icon name="square" size={13} />
          </button>
        {:else}
          <button class="send" disabled={saying || (!draft.trim() && !attachments.length)}
            onclick={sendText}
            aria-label="отправить (Enter)" title="Enter — отправить, Shift+Enter — новая строка">
            <Icon name="arrow-up" size={16} />
          </button>
        {/if}
      </div>
    </div>
    <!-- Как дойдёт сообщение — одной строкой; развёрнутое объяснение и
         кнопки копий приложения только по запросу (на телефоне подсказка
         занимала 84 px из 1063 — CTO 11.08) -->
    <p class="hint quiet">
      {#if data.input?.mode === 'tmux'}
        Enter — отправить, сообщение уходит прямо в CLI-сессию.
      {:else}
        Мёртвую сессию сообщение поднимет резюмом и уедет в неё; живущую в
        Desktop доставит будка-почтальон.
        <Button variant="link" size="xs" class="px-0" onclick={() => (details = !details)}>
          {details ? 'свернуть' : 'подробнее'}
        </Button>
      {/if}
    </p>
    {#if details && data.input?.mode !== 'tmux'}
      <p class="hint quiet">
        Прямого канала нет (Desktop или headless): рабочая сессия заберёт
        сообщение при чтении будки, спящую добудит почтальон. Открыть её окно
        руками:
        {#each st.overview?.copies || [] as app (app)}
          <Button variant="outline" size="xs" class="mx-0.5 border-dashed"
            onclick={() => openCopy(app)}>{copyLabel(app)}</Button>
        {/each}
      </p>
    {/if}
    {#if sent}<p class="hint ok-note">{sent}</p>{/if}
    {#if sayError}<p class="err">Не отправлено: {sayError}</p>{/if}
  </div>
    </div>
    {#if files}
      <div class="grip" role="separator" aria-label="ширина колонки файлов"
        aria-orientation="vertical" tabindex="0"
        onpointerdown={(e) => { dragging = true; e.preventDefault(); }}
        onkeydown={(e) => {
          if (e.key === 'ArrowLeft') paneW = Math.min(paneW + 40, 900);
          else if (e.key === 'ArrowRight') paneW = Math.max(paneW - 40, 300);
          else return;
          e.preventDefault();
          try { localStorage.setItem('stovp:pane', String(Math.round(paneW))); } catch {}
        }}></div>
      <aside class="files-pane">
        <FileBrowser {project} tracker={data.tracker} onClose={() => (files = false)} />
      </aside>
    {/if}
  </div>
{/if}

<style>
  /* Шапка липнет под общей полосой (её высота — в --bar-h): лента уходит
     ПОД неё, а не обрывается. На широком экране полосы нет — липнет к нулю.
     mobile-first: имя сессии и «назад» живут в общей шапке телефона, здесь
     они появляются только на широком экране. */
  .s-head {
    position: sticky; top: var(--bar-h, 0px); z-index: 5;
    background: var(--bg-1); margin: calc(-1 * var(--sp-5)) 0 var(--sp-6);
    padding: var(--sp-5) 0 var(--sp-4);
    border-bottom: 1px solid var(--border-soft);
    display: flex; flex-direction: column; gap: var(--sp-4);
  }
  /* Ход работы — одна строка, разворачивается списком ступеней */
  .plan { border: 1px solid var(--border-soft); border-radius: var(--r); margin-bottom: var(--sp-4); }
  .plan-head {
    display: flex; align-items: center; gap: var(--sp-3); width: 100%;
    padding: var(--sp-3) var(--sp-4); background: none; border: 0; cursor: pointer;
    color: var(--text-2); font-size: var(--fs-sm); text-align: left; min-height: 44px;
  }
  .plan-now { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plan-list {
    list-style: none; margin: 0; padding: 0 var(--sp-4) var(--sp-3);
    display: flex; flex-direction: column; gap: var(--sp-2);
  }
  .plan-list li {
    display: flex; align-items: center; gap: var(--sp-3);
    font-size: var(--fs-sm); color: var(--text-2);
  }
  .plan-list li.completed { color: var(--text-3); }
  .plan-list em { margin-left: auto; font-style: normal; color: var(--text-4); font-size: var(--fs-xs); }

  /* Лента и файлы — две колонки на широком экране */
  .body { display: block; }
  .files-pane { min-width: 0; }
  .grip { display: none; }
  @media (min-width: 1100px) {
    .body.with-files {
      display: grid; grid-template-columns: minmax(380px, 1fr) 9px var(--pane);
      align-items: stretch;
    }
    .body.with-files .chat { min-width: 0; }
    /* ручка перетаскивания: широкая зона захвата, тонкая линия внутри —
       иначе целиться в неё невозможно, а выглядит она случайной чертой */
    .body.with-files .grip {
      display: flex; align-items: center; justify-content: center;
      align-self: stretch; cursor: col-resize; background: none;
    }
    .body.with-files .grip::after {
      content: ''; width: 1px; height: 100%;
      background: var(--border-soft); border-radius: 999px;
    }
    .grip:hover::after, .grip:focus-visible::after, .body.dragging .grip::after {
      width: 3px; background: var(--primary);
    }
    .grip:focus-visible { outline: none; }
    .body.dragging { user-select: none; }
    /* файлы — отдельный блок во всю высоту окна, а не карточка в потоке
       ленты: он живёт своей жизнью и не должен листаться вместе с чатом */
    .body.with-files .files-pane {
      position: sticky; top: calc(var(--bar-h, 0px) + 12px);
      height: calc(100vh - var(--bar-h, 0px) - 24px);
      display: flex; flex-direction: column; min-height: 0;
    }
    .body.with-files .files-pane :global(> *) { flex: 1; min-height: 0; height: auto; }
  }

  .back, .s-title { display: none; }
  .back { color: var(--text-3); text-decoration: none; font-size: var(--fs-sm); }
  .back:hover { color: var(--text-1); }
  .s-title {
    font-size: var(--fs-xl); margin: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* ряд действий: на телефоне их показывает меню общей шапки */
  .s-actions { display: none; }
  .s-meta { display: flex; gap: var(--sp-4); align-items: center; flex-wrap: wrap; }
  .reason {
    margin: 0; font-size: var(--fs-xs);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  @media (min-width: 901px) {
    .s-head { top: 0; margin-top: -18px; }
    .back, .s-title { display: block; }
    .s-actions { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; }
  }

  /* mobile-first: композер приколочен к низу окна и переживает любую
     прокрутку; лента освобождает под него место снизу (--dock-h) */
  .dock {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 25;
    background: var(--bg-1); border-top: 1px solid var(--border-soft);
    padding: var(--sp-4) var(--sp-5) calc(var(--sp-4) + var(--safe-b));
  }
  .dock-asks { display: none; max-height: 60vh; overflow-y: auto; margin-bottom: var(--sp-4); }
  .dock-asks.sheet-open { display: block; }

  @media (min-width: 901px) {
    .dock {
      position: sticky; left: auto; right: auto; margin-top: 22px;
      padding: 10px 0 14px;
    }
    /* шторка и на десктопе (CTO 17.08): открыта по умолчанию и при новом
       вопросе, но сворачивается той же кнопкой, что на телефоне */
    .dock-asks { max-height: 42vh; }
  }

  /* Родная форма приложения: жёлтая рамка = ждёт человека НЕ здесь. */
  .hitl {
    background: var(--bg-2); border: 1px solid var(--warn);
    border-radius: var(--r); padding: var(--sp-5) var(--sp-6); margin-bottom: var(--sp-5);
  }
  .hitl header { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-4); }
  .hitl .meta { color: var(--text-3); font-size: var(--fs-xs); margin: var(--sp-3) 0 0; }
  .hitl .opt {
    display: block; width: 100%; text-align: left;
    background: var(--bg-1); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--sp-3) var(--sp-5); margin-top: var(--sp-3); font-size: var(--fs-sm);
  }
  .hitl .opt:hover:not(:disabled) { border-color: var(--warn); }
  .hitl .opt:disabled { opacity: 0.5; }
  .hitl .opt b { display: block; }
  .hitl .opt span { color: var(--text-3); font-size: var(--fs-xs); }
  .hitl label.opt { display: flex; gap: var(--sp-5); align-items: flex-start; cursor: pointer; }
  .hitl label.opt input { margin-top: var(--sp-2); accent-color: var(--accent); }
  .hitl label.opt.picked { border-color: var(--warn); }
  .hitl .opt-body { flex: 1; }

  /* Форма-слайдер (единый виджет над композером): шапка = свёртка +
     кликабельные табы вопросов + крестик отмены; тело без своего скролла */
  /* занятость: одна дышащая строка над композером (референс — Claude) */
  .working {
    display: flex; align-items: center; gap: var(--sp-2);
    padding: 0 var(--sp-2) var(--sp-2); font-size: var(--fs-xs);
    animation: breathe 1.8s ease-in-out infinite;
  }
  /* сообщение в очереди: приглушено и подписано, почему оно ещё не ушло */
  .queued { opacity: .72; }
  .q-note { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-4); text-align: right; }
  /* фоновая команда дышать не должна — она идёт сама, это фон, не пульс */
  .working.bg-run { animation: none; color: var(--text-4); }
  .work-what {
    flex: 1; min-width: 0; color: var(--text-2);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  /* пока сессия занята, стрелка отправки становится кнопкой «стоп» */
  .send.stop { background: var(--text-1); color: var(--bg-0); }

  /* Форма живёт в приклеенном доке — страницей её не прокрутить, поэтому
     длинный вопрос листается внутри самой карточки (CTO 19.08: «текст не
     влез, а скроллить нечем»). Шапка с табами остаётся на месте. */
  .dlg-card {
    margin: 0 0 var(--sp-3);
    max-height: 62vh; overflow-y: auto; overscroll-behavior: contain;
  }
  .dlg-card .dlg-head {
    position: sticky; top: 0; z-index: 2;
    background: var(--bg-2); padding-top: var(--sp-2);
  }
  @media (min-width: 901px) { .dlg-card { max-height: 52vh; } }
  .hitl header.dlg-head {
    display: flex; flex-direction: row; align-items: center;
    gap: var(--sp-2); margin-bottom: var(--sp-3);
  }
  .dlg-tabs { flex: 1; display: flex; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; }
  .dlg-tab {
    display: inline-flex; align-items: center; gap: 3px;
    background: none; border: 1px solid var(--border-soft); border-radius: 999px;
    padding: 2px var(--sp-3); font: inherit; font-size: var(--fs-micro);
    color: var(--text-3); cursor: pointer; user-select: none;
  }
  .dlg-tab.done { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 45%, transparent); }
  .dlg-tab.cur { color: var(--text-1); border-color: var(--warn); }
  .dlg-tab:disabled { opacity: 0.6; cursor: default; }
  .dlg-mini {
    flex: 1; min-width: 0; font-size: var(--fs-sm);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dlg-q { display: block; margin-bottom: var(--sp-3); }
  .dlg-x {
    flex: none; background: none; border: 0; color: var(--text-3);
    padding: var(--sp-1); cursor: pointer; display: grid; place-items: center;
  }
  .dlg-x:hover { color: var(--text-1); }
  .hitl .opt.picked { border-color: var(--accent); }
  /* мультиселект: явный квадрат-чекбокс слева (жалоба CTO: «не понятно,
     что чекбоксы») */
  .hitl .opt.dlg-opt { display: flex; gap: var(--sp-4); align-items: flex-start; }
  .cbx {
    flex: none; width: 16px; height: 16px; margin-top: 2px;
    border: 1.5px solid var(--text-4); border-radius: 4px;
    display: grid; place-items: center; color: var(--accent-ink);
  }
  .cbx.on { background: var(--accent); border-color: var(--accent); }
  .hitl .opt-col { flex: 1; min-width: 0; text-align: left; }
  .hitl .opt-col b { display: block; }
  .hitl .opt-col span { display: block; color: var(--text-3); font-size: var(--fs-xs); }
  .free-opt b { margin-bottom: var(--sp-2); }
  .free-row { display: flex; gap: var(--sp-3); }
  .free-in {
    flex: 1; background: var(--bg-0); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--sp-2) var(--sp-4); font: inherit; font-size: var(--fs-sm);
  }
  .review-row span { display: block; color: var(--text-2); }
  .grow-mini { flex: 1; }
  .dlg-raw { margin-top: var(--sp-4); }
  .dlg-raw summary {
    color: var(--text-4); font-size: var(--fs-xs); cursor: pointer;
  }

  /* Агенты: один чип-сводка (как «детали»), под ним — полоса агентов */
  .agents-box { margin-bottom: var(--sp-4); }
  .agent-chip.head { color: var(--text-2); }
  .agents-strip {
    display: flex; gap: var(--sp-2); overflow-x: auto;
    padding: var(--sp-3) 0 var(--sp-2);
  }
  .agent-chip {
    display: inline-flex; align-items: center; gap: var(--sp-2); flex: none;
    background: var(--bg-2); color: var(--text-2);
    border: 1px solid var(--border-soft); border-radius: 999px;
    padding: var(--sp-2) var(--sp-4); font: inherit; font-size: var(--fs-xs);
    cursor: pointer; min-height: 30px;
  }
  .agent-chip.busy { border-color: color-mix(in oklab, var(--ok) 50%, transparent); }
  .agent-chip b { color: var(--text-1); font-weight: 500; }
  .agent-chip span { color: var(--text-4); }

  /* Шторка субагента: 70% высоты снизу (CTO 19.08) — видно и его ленту, и
     край разговора сессии под ней; скролл только внутри тела */
  /* высота по содержимому, но не выше 70% экрана: короткий список не
     превращается в пустое полотно, длинная лента скроллится внутри */
  :global(.agent-sheet) {
    max-height: 70vh; border-radius: var(--r-lg) var(--r-lg) 0 0;
    display: flex; flex-direction: column; gap: 0;
  }
  /* шапка шторки — строка: «назад», заголовок, крестик справа
     (по умолчанию Sheet.Header ставит детей колонкой и центрует) */
  :global(.agent-head) {
    flex-direction: row; align-items: flex-start; gap: var(--sp-3);
    padding-bottom: var(--sp-4);
  }
  :global(.agent-head) .dlg-x { margin-top: 1px; }
  .agent-body {
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 0 var(--sp-5) calc(var(--sp-5) + var(--safe-b));
  }
  /* строка агента: точка-статус, имя и задача, стрелка — как строки
     раннера, только тап-таргет крупнее (палец) */
  /* тот же кирпич, что строки шторки выбора (PickChip .pick-row):
     прозрачная рамка, подсветка активного — единый язык выбора */
  .ag-list { display: flex; flex-direction: column; gap: var(--sp-2); }
  .ag-row {
    display: flex; align-items: center; gap: var(--sp-4); width: 100%;
    background: var(--bg-2); color: var(--text-1); text-align: left;
    border: 1px solid transparent; border-radius: var(--r);
    padding: var(--sp-4) var(--sp-5); font: inherit; font-size: var(--fs-sm);
    min-height: var(--tap); cursor: pointer;
    transition: border-color var(--t-fast);
  }
  .ag-row:hover { border-color: var(--border-soft); }
  .ag-row.on { border-color: var(--accent); }
  .ag-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ag-col b { font-weight: 500; }
  .ag-desc {
    color: var(--text-3); font-size: var(--fs-xs);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ag-state { flex: none; color: var(--ok); font-size: var(--fs-xs); }
  .ag-state.bad { color: var(--hot); }
  .ag-state.done { color: var(--text-4); }
  /* подписи «ввод» / «вывод» в шторке действия */
  .tsec {
    margin: var(--sp-4) 0 var(--sp-2); color: var(--text-4);
    font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: 0.06em;
  }
  .agent-body .cli-screen { white-space: pre-wrap; max-height: none; }

  .hint { font-size: var(--fs-xs); margin: var(--sp-3) var(--sp-1) 0; }
  .ok-note { color: var(--ok); }
  .perm-row { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); flex-wrap: wrap; }
</style>
