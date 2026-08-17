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
  import Transcript from '$lib/Transcript.svelte';
  import AskCard from '$lib/AskCard.svelte';
  import FileBrowser from '$lib/FileBrowser.svelte';
  import Icon from '$lib/Icon.svelte';
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
  $effect(() => { if (project && key) { data = null; refresh(); } });

  // клик по варианту родной формы: адресное сообщение сессии с явной
  // привязкой к вопросу — доставляет почтальон через канал приложения
  function sendFormChoice(question, label) {
    draft = `Ответ на твою форму «${question}»: ${label}`;
    sendText();
  }

  // multiSelect-формы: копим отметки по вопросам, шлём одним сообщением
  let hitlPicked = $state({}); // qi → Set(label)
  let hitlAny = $derived(Object.values(hitlPicked).some((s) => s?.size));
  function toggleHitl(qi, label) {
    const s = new Set(hitlPicked[qi] || []);
    s.has(label) ? s.delete(label) : s.add(label);
    hitlPicked = { ...hitlPicked, [qi]: s };
  }
  function sendHitlPicked() {
    const parts = data.pending_hitl.questions
      .map((q, qi) => {
        const s = hitlPicked[qi];
        return s?.size ? `«${q.question}»: ${[...s].join('; ')}` : null;
      })
      .filter(Boolean);
    if (!parts.length) return;
    draft = `Ответ на твою форму — ${parts.join(' | ')}`;
    hitlPicked = {};
    sendText();
  }

  async function sendText() {
    if (!draft.trim()) return;
    saying = true; sayError = null; sent = null;
    try {
      const r = await fetch('/api/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, key, text: draft }),
      });
      const body = await r.json();
      if (!r.ok) sayError = body.error || `HTTP ${r.status}`;
      else {
        draft = '';
        sent = body.via === 'tmux' ? `доставлено в панель ${body.pane}` : `в будке (адресовано сессии) — ${body.note}`;
      }
    } catch (e) {
      sayError = String(e.message || e);
    } finally {
      saying = false;
      refresh();
    }
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
      if (!r.ok) sayError = (await r.json()).error || `HTTP ${r.status}`;
    } finally { runnerBusy = false; refresh(); }
  }

  // Действия сессии — один список на два места показа: чипы в шапке
  // (широкий экран) и пункты меню в общей шапке (телефон).
  let actions = $derived(data ? [
    ...(stateInfo ? [{ label: stateInfo[0], dot: stateInfo[1], note: true }] : []),
    ...(data.runner ? [data.runner.alive
      ? { label: 'остановить', icon: 'pause', disabled: runnerBusy,
        run: () => runnerAct('stop'),
        title: 'парковка: транскрипт цел, поднимается резюмом' }
      : { label: 'поднять резюмом', icon: 'play', disabled: runnerBusy,
        run: () => runnerAct('resume'),
        title: 'claude --resume — тот же контекст, той же tmux-сессией' }] : []),
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
  let openAsks = $derived((data?.asks || []).filter((a) => a.status === 'open'));
  let openCount = $derived(openAsks.length + (data?.pending_hitl ? 1 : 0));
  // в доке — только живое: открытые и ответы в пути; подтверждённое своё
  // отработало и чат не перекрывает (CTO 10.08)
  let recentDecided = $derived((data?.asks || [])
    .filter((a) => ['answered', 'delivered'].includes(a.status)).slice(-2));
  let sheetCount = $derived(openCount + recentDecided.length);
  // ответил — шторка закрывается сама, разговор возвращается на экран
  let prevOpen = 0;
  $effect(() => {
    if (openCount < prevOpen) sheet = false;
    prevOpen = openCount;
  });
</script>

<svelte:head><title>{data?.title || key?.slice(0, 8)} — STOVP</title></svelte:head>

{#if error}
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

  {#if files}
    <div class="mb-3.5">
      <FileBrowser {project} tracker={data.tracker} onClose={() => (files = false)} />
    </div>
  {/if}

  <Transcript items={data.items} {project} sessionKey={key} tracker={data.tracker} />

  <div class="dock" bind:this={dockEl}>
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
            <b>Сессия ждёт разрешения на действие</b>
            <span class="meta">диалог CLI в её терминале — реши здесь или tmux attach -t {data.runner.tmux}</span>
          </header>
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

    <div class="composer-box">
      <textarea rows="1" bind:this={ta} bind:value={draft} oninput={grow}
        placeholder={data.input?.mode === 'tmux' ? 'написать в чат сессии…' : 'написать сессии…'}
        onkeydown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault(); sendText();
        }}></textarea>
      <button class="send" disabled={saying || !draft.trim()} onclick={sendText}
        aria-label="отправить (Enter)" title="Enter — отправить, Shift+Enter — новая строка">
        <Icon name="arrow-up" size={16} />
      </button>
    </div>
    <!-- Как дойдёт сообщение — одной строкой; развёрнутое объяснение и
         кнопки копий приложения только по запросу (на телефоне подсказка
         занимала 84 px из 1063 — CTO 11.08) -->
    <p class="hint quiet">
      {#if data.input?.mode === 'tmux'}
        ⌘⏎ — отправить, доставка мгновенная в панель сессии.
      {:else}
        Уйдёт адресным постом в будку — сессия заберёт при чтении.
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
    .sheet-row { display: none; }   /* на широком экране карточки видны всегда */
    .dock-asks { display: block; max-height: 42vh; margin-bottom: 0; }
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

  .hint { font-size: var(--fs-xs); margin: var(--sp-3) var(--sp-1) 0; }
  .ok-note { color: var(--ok); }
  .perm-row { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); }
</style>
