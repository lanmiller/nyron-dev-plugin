<script>
  // Окно сессии (этап 4, требование CTO дословно: «хочу прям в чат нужный
  // отвечать и открывать чат»): весь разговор из транскрипта, ask этой
  // сессии с ответом на месте, ввод — tmux мгновенно / Desktop зеркало.
  import { onMount, getContext, tick } from 'svelte';
  import { page } from '$app/state';
  import Transcript from '$lib/Transcript.svelte';
  import AskCard from '$lib/AskCard.svelte';
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
  // действия сессии на телефоне открываются кнопкой в общей шапке
  const shell = getContext('morda');
  let actionsOpen = $derived(shell.sessionActions);

  // поле растёт под текст, как в Claude: одна строка по умолчанию,
  // Enter отправляет, Shift+Enter — перенос
  let ta = $state(null);
  function grow() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  $effect(() => { if (draft === '' && ta) ta.style.height = 'auto'; });
  let openAsks = $derived((data?.asks || []).filter((a) => a.status === 'open'));
  // в доке — только живое: открытые и ответы в пути; подтверждённое своё
  // отработало и чат не перекрывает (CTO 10.08)
  let recentDecided = $derived((data?.asks || [])
    .filter((a) => ['answered', 'delivered'].includes(a.status)).slice(-2));
  let stateInfo = $derived(STATE_RU[data?.state] || null);
  let isDesktop = $derived(data?.entrypoint === 'claude-desktop');
</script>

<svelte:head><title>{data?.title || key?.slice(0, 8)} — STOVP</title></svelte:head>

{#if error}
  <p class="err">{error}</p>
{:else if !data}
  <!-- каркас рисуется сразу: у диспетчеров транскрипт мегабайтный, и пустой
       экран на несколько секунд читался как «всё умерло» (CTO 11.08) -->
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">← {project}</a>
    <h1 class="quiet">Открываю сессию…</h1>
    <div class="s-meta"><span class="mono quiet">{key.slice(0, 8)}</span></div>
  </header>
  <div class="feed-skeleton">
    {#each [72, 45, 88, 60] as w}
      <div class="skeleton" style="width: {w}%"></div>
    {/each}
  </div>
{:else}
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">← {project}</a>
    <h1 class="s-title">{data.title || '(без названия)'}</h1>
    <!-- Шапка работает, а не подписывает: статус, действия сессии и уже
         потом технические детали (CTO 11.08 — «сделать её функциональной») -->
    <div class="s-actions" class:shown={actionsOpen}>
      {#if stateInfo}
        <span class="chip"><i class="dot" style="background:{stateInfo[1]}"></i>{stateInfo[0]}</span>
      {/if}
      <button class="chip" disabled={opening} onclick={openInClaude}
        title="claude://resume — приложение откроет копию этого разговора">копия в Claude ⧉</button>
      {#if data.cwd}
        <button class="chip" onclick={() => (details = !details)}
          title={data.cwd}>📁 {data.cwd.split('/').at(-1)}</button>
      {/if}
      <button class="chip more" onclick={() => (details = !details)}
        aria-label="технические детали">{details ? '×' : '⋯'}</button>
    </div>
    <div class="s-meta" class:shown={details}>
      <span class="mono quiet">{key.slice(0, 8)}</span>
      {#if stateInfo}
        <span class="chip"><i class="dot" style="background:{stateInfo[1]}"></i>{stateInfo[0]}</span>
      {/if}
      <span class="chip">{isDesktop ? 'Desktop' : data.entrypoint === 'sdk-cli' ? 'headless' : data.entrypoint || '?'}</span>
      {#if data.truncated}
        <span class="chip" title="файл больше лимита окна — показан хвост">хвост, файл {(data.size / 1048576).toFixed(1)} МБ</span>
      {/if}
      {#if data.cwd}
        <span class="chip" class:dead-cwd={data.cwd_alive === false} title={data.cwd}>
          📁 {data.cwd.split('/').at(-1)}{data.cwd_alive === false ? ' · папка снесена' : ''}
        </span>
      {/if}
      <!-- claude://resume всегда создаёт ИМПОРТ-КОПИЮ разговора (сфокусировать
           существующее Desktop-окно снаружи нечем — факт 10.08); имя честное,
           у сессий со снесённым воркtree копия попросит выбрать папку -->
      <button class="chip open-app" disabled={opening} onclick={openInClaude}
        title="claude://resume — приложение откроет копию этого разговора{data.cwd_alive === false ? '; рабочая папка сессии уже снесена — попросит выбрать другую' : ''}">
        открыть копию в Claude ⧉
      </button>
    </div>
    {#if data.reason}<p class="reason quiet">{data.reason}</p>{/if}
  </header>

  <Transcript items={data.items} {project} sessionKey={key} tracker={data.tracker} />

  <div class="dock">
    <!-- Узкий экран: сводка-кнопка вместо стопки карточек -->
    {#if openAsks.length || data.pending_hitl}
      <button class="sheet-toggle" onclick={() => (sheet = !sheet)}>
        <span class="badge">{openAsks.length + (data.pending_hitl ? 1 : 0)}</span>
        <span class="grow">{sheet ? 'скрыть вопросы' : 'вопросы ждут решения'}</span>
        <span class="caret" class:open={sheet}>›</span>
      </button>
    {/if}
    <!-- вопросы — в прокрутке, композер всегда виден (CTO 10.08: пачка
         карточек не должна выталкивать ввод за экран) -->
    <div class="dock-asks" class:sheet-open={sheet}>
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
            <button class="btn primary hitl-submit" disabled={saying || !hitlAny}
              onclick={sendHitlPicked}>отправить выбранное</button>
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
        aria-label="отправить (Enter)" title="Enter — отправить, Shift+Enter — новая строка">↑</button>
    </div>
    <!-- Как дойдёт сообщение — одной строкой; развёрнутое объяснение и
         кнопки копий приложения только по запросу (на телефоне подсказка
         занимала 84 px из 1063 — CTO 11.08) -->
    <p class="hint quiet">
      {#if data.input?.mode === 'tmux'}
        ⌘⏎ — отправить, доставка мгновенная в панель сессии.
      {:else}
        Уйдёт адресным постом в будку — сессия заберёт при чтении.
        <button class="link" onclick={() => (details = !details)}>
          {details ? 'свернуть' : 'подробнее'}
        </button>
      {/if}
    </p>
    {#if details && data.input?.mode !== 'tmux'}
      <p class="hint quiet">
        Прямого канала нет (Desktop или headless): рабочая сессия заберёт
        сообщение при чтении будки, спящую добудит почтальон. Открыть её окно
        руками:
        {#each st.overview?.copies || [] as app (app)}
          <button class="copy" onclick={() => openCopy(app)}>{copyLabel(app)}</button>
        {/each}
      </p>
    {/if}
    {#if sent}<p class="hint ok-note">{sent}</p>{/if}
    {#if sayError}<p class="err">Не отправлено: {sayError}</p>{/if}
  </div>
{/if}

<style>
  /* шапка прилипает сверху (CTO 10.08: чат открывается снизу — без шапки
     не видно, ЧЬЯ это сессия и в каком она состоянии) */
  .s-head {
    position: sticky; top: 0; z-index: 5;
    background: var(--bg-1); margin: -18px 0 14px;
    padding: 12px 0 10px; border-bottom: 1px solid var(--border-soft);
  }
  .back { color: var(--text-3); text-decoration: none; font-size: 13px; }
  .back:hover { color: var(--text-1); }
  h1 {
    font-size: 19px; margin: 4px 0 8px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .s-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .open-app { background: none; }
  .open-app:hover:not(:disabled) { border-color: var(--accent); color: var(--text-1); }
  .dead-cwd { color: var(--stall); }
  .reason {
    margin: 6px 0 0; font-size: 12.5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  /* mobile-first: композер приколочен к низу окна и переживает любую
     прокрутку; лента освобождает под него место снизу */
  /* mobile-first: детали свёрнуты, на широком экране показаны всегда */
  .s-actions { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; }
  .s-actions .more { min-width: 34px; justify-content: center; }
  .s-meta { display: none; }
  .s-meta.shown { display: flex; }
  @media (min-width: 901px) {
    .s-meta { display: flex; }
  }
  .feed-skeleton { display: flex; flex-direction: column; gap: var(--sp-5); margin-top: var(--sp-6); }
  .feed-skeleton .skeleton { height: 1.1em; }
  .dock {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 25;
    background: var(--bg-1); border-top: 1px solid var(--border-soft);
    padding: var(--sp-4) var(--sp-5) calc(var(--sp-4) + var(--safe-b));
  }
  .sheet-toggle {
    display: flex; align-items: center; gap: var(--sp-4); width: 100%;
    background: none; border: 0; color: var(--text-2); font: inherit;
    font-size: var(--fs-sm); padding: var(--sp-3) 0;
  }
  .sheet-toggle .grow { flex: 1; text-align: left; }
  .sheet-toggle .caret { transition: transform var(--t-fast); color: var(--text-4); }
  .sheet-toggle .caret.open { transform: rotate(-90deg); }
  .dock-asks { display: none; max-height: 60vh; overflow-y: auto; margin-bottom: var(--sp-4); }
  .dock-asks.sheet-open { display: block; }

  @media (min-width: 901px) {
    .dock {
      position: sticky; left: auto; right: auto; margin-top: 22px;
      padding: 10px 0 14px;
    }
    .sheet-toggle { display: none; }
    .dock-asks { display: block; max-height: 42vh; margin-bottom: 0; }
  }
  .hitl {
    background: var(--bg-2); border: 1px solid var(--border);
    border-color: var(--warn);
    border-radius: var(--r); padding: 12px 14px; margin-bottom: 10px;
  }
  .hitl header { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .hitl .meta { color: var(--text-3); font-size: 12.5px; margin: 6px 0 0; }
  .hitl .opt {
    display: block; width: 100%; text-align: left;
    background: var(--bg-1); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: 8px;
    padding: 6px 12px; margin-top: 6px; font-size: 13.5px;
  }
  .hitl .opt:hover:not(:disabled) { border-color: var(--warn); }
  .hitl .opt:disabled { opacity: 0.5; }
  .hitl .opt b { display: block; }
  .hitl .opt span { color: var(--text-3); font-size: 12.5px; }
  .hitl label.opt { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
  .hitl label.opt input { margin-top: 4px; accent-color: var(--accent); }
  .hitl label.opt.picked { border-color: var(--warn); }
  .hitl .opt-body { flex: 1; }
  .hitl-submit { margin-top: 10px; }
  /* На телефоне заголовок и действия живут в общей шапке: своя шапка
     дублировала имя и торчала обрывками чипов под липкой полосой
     (CTO 11.08 — «сделай лаконичной»). */
  .s-title, .back { display: none; }
  .s-head { margin: 0; }
  .s-actions { display: none; }
  .s-actions.shown { display: flex; margin-bottom: var(--sp-5); }
  @media (min-width: 901px) {
    .s-title, .back { display: block; }
    .s-actions { display: flex; }
  }
  .hint { font-size: 12px; margin: 6px 2px 0; }
  .hint .copy {
    background: none; border: 1px dashed var(--border); color: var(--text-3);
    border-radius: 8px; padding: 2px 9px; font-size: 12px; margin: 0 2px;
  }
  .hint .copy:hover { color: var(--text-1); border-color: var(--accent); border-style: solid; }
  .ok-note { color: var(--ok); }
</style>
