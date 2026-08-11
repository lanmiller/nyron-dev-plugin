<script>
  // Оболочка морды (этап 4): слева — проекты и сессии (дизайн-лок: сайдбар
  // на глубокой поверхности, как список чатов Claude), справа — контент.
  // Поллинг живёт здесь один: страницы берут данные из контекста.
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { STATE_RU, age } from '$lib/states.js';
  import '../app.css';

  let { children } = $props();

  const st = $state({ overview: null, sessions: [], tree: [], sendError: null });
  setContext('morda', st);

  // активный проект: из URL окна сессии → из ?p= → первый с открытыми ask
  let project = $derived.by(() => {
    const names = st.overview?.projects?.map((p) => p.name) || [];
    const fromRoute = page.params?.project;
    if (fromRoute && names.includes(fromRoute)) return fromRoute;
    const fromQuery = page.url.searchParams.get('p');
    if (fromQuery && names.includes(fromQuery)) return fromQuery;
    const hot = st.overview?.projects?.find((p) => p.asks?.some((a) => a.status === 'open'));
    return (hot || st.overview?.projects?.[0])?.name || null;
  });
  setContext('morda-project', { get name() { return project; } });

  // живые — работают/ждут/застряли, несут открытый ask ИЛИ свежие, но ещё
  // не оценённые сторожем (слепота/лимит ≠ «завершилась» — факт 10.08);
  // остальное — отработавшие волны, свёрнутая группа
  const ACTIVE = ['working', 'waiting_decision', 'waiting_silent', 'stalled'];
  const isLive = (s) => s.open_asks || ACTIVE.includes(s.state)
    || (!s.state && Date.now() - new Date(s.mtime).getTime() < 2 * 3600 * 1000);
  const live = (ss) => (ss || []).filter(isLive);
  const done = (ss) => (ss || []).filter((s) => !isLive(s));

  // выдвижная навигация на узком экране; закрывается при переходе
  let navOpen = $state(false);
  afterNavigate(() => { navOpen = false; });  // эффект по page.url гасил открытие сразу
  let totalOpen = $derived((st.overview?.projects || [])
    .reduce((n, p) => n + (p.asks?.filter((a) => a.status === 'open').length || 0), 0));

  // раскрытые проекты: активный всегда, остальные — по клику человека
  let opened = $state({});
  const isOpen = (name) => opened[name] ?? (name === project);
  function toggleProject(name) {
    opened = { ...opened, [name]: !isOpen(name) };
  }

  let seq = 0;
  async function refresh() {
    const my = ++seq;
    try {
      const r = await fetch('/api/overview');
      const next = await r.json();
      if (my !== seq) return; // устаревший ответ — выбрасываем
      st.overview = next;
    } catch { /* сервер перезапускается — следующий тик дотянется */ }
  }
  // дерево «проект → сессии» одним запросом: слева одна навигация
  // (эталон Claude Desktop, требование CTO 11.08)
  async function refreshSessions() {
    try {
      const r = await fetch('/api/tree');
      const next = await r.json();
      if (next.projects) {
        st.tree = next.projects;
        st.sessions = next.projects.find((p) => p.name === project)?.sessions || [];
      }
    } catch {}
  }
  // Ссылки трекера — попап-окном поверх STOVP (в браузере вы уже
  // залогинены, тикет открывается сразу и не уводит со страницы);
  // остальные внешние — обычной вкладкой (CTO 10.08).
  function linkClicks(e) {
    const a = e.target.closest?.('a.ticket');
    if (!a) return;
    e.preventDefault();
    window.open(a.href, `stovp-ticket`, 'popup,width=1200,height=900');
  }

  onMount(() => {
    refresh().then(refreshSessions);
    const t1 = setInterval(refresh, 5000);
    const t2 = setInterval(refreshSessions, 10_000);
    document.addEventListener('click', linkClicks);
    return () => {
      clearInterval(t1); clearInterval(t2);
      document.removeEventListener('click', linkClicks);
    };
  });
  $effect(() => { if (project) refreshSessions(); });

  async function openCopy(app) {
    await fetch('/api/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morda': '1' },
      body: JSON.stringify({ app }),
    });
  }
  function copyLabel(app) {
    const m = app.match(/^Claude \((.+)\)$/);
    return m ? m[1] : 'Claude';
  }
  function openCount(p) {
    return p.asks?.filter((a) => a.status === 'open').length || 0;
  }
</script>

<!-- Мобильная шапка: на узком экране сайдбар уезжает, навигация — по кнопке
     (кейс CTO 11.08 — вести флот с телефона) -->
<header class="mobile-bar">
  <button class="burger" onclick={() => (navOpen = !navOpen)} aria-label="проекты и сессии">
    {navOpen ? '✕' : '☰'}
  </button>
  <b class="m-title">{page.params?.project || project || 'STOVP'}</b>
  {#if totalOpen}<span class="badge">{totalOpen}</span>{/if}
</header>

<div class="shell" class:nav-open={navOpen}>
  {#if navOpen}
    <button class="scrim" onclick={() => (navOpen = false)} aria-label="закрыть навигацию"></button>
  {/if}
  <aside>
    <div class="brand">
      <span class="mark">✳</span>
      <b>STOVP</b>
      <span class="at">{st.overview ? new Date(st.overview.at).toLocaleTimeString('ru') : '…'}</span>
    </div>

    <div class="side-h" title="цвет точки — вердикт сторожа: зелёная — работает; жёлтая — ждёт вашего решения (оформленный ask); оранжевая — спросила в чате и молчит; горчичная — застряла; серая — закончилась; тусклая — сторож её ещё не видел">Проекты и сессии <span class="hint-q">?</span></div>

    {#snippet row(proj, s)}
      {@const [label, color] = STATE_RU[s.state] || ['', 'var(--text-4)']}
      <a href="/s/{encodeURIComponent(proj)}/{s.key}"
         class:active={page.params?.key === s.key}
         title="{s.title} · {label || 'вне надзора'}">
        <i class="dot" style="background:{color}"></i>
        <span class="t">{s.title}</span>
        {#if s.open_asks}<span class="badge">{s.open_asks}</span>{/if}
        <span class="age">{age(s.mtime)}</span>
      </a>
    {/snippet}

    <!-- Дерево: проект → его сессии (эталон Claude Desktop). Свёрнутый
         проект всё равно показывает бейдж открытых вопросов — затор виден
         не раскрывая. -->
    <nav class="tree">
      {#each st.tree as p (p.name)}
        {@const ov = st.overview?.projects?.find((x) => x.name === p.name)}
        {@const n = ov ? openCount(ov) : 0}
        {@const ls = live(p.sessions)}
        {@const ds = done(p.sessions)}
        <div class="proj" class:current={project === p.name}>
          <button class="proj-head" onclick={() => toggleProject(p.name)}
            title="{p.name} · живых {ls.length}">
            <span class="caret" class:open={isOpen(p.name)}>›</span>
            <span class="pname">{p.name}</span>
            {#if n}<span class="badge">{n}</span>{/if}
            <span class="age">{ls.length || ''}</span>
          </button>
          {#if isOpen(p.name)}
            <div class="proj-body">
              {#each ls as s (s.key)}{@render row(p.name, s)}{/each}
              {#if !ls.length}<p class="quiet none">живых нет</p>{/if}
              <!-- кладбище отработавших волн не мешается с живыми (CTO 10.08) -->
              {#if ds.length}
                <details class="done-group">
                  <summary>завершённые ({ds.length})</summary>
                  {#each ds as s (s.key)}{@render row(p.name, s)}{/each}
                </details>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if !st.tree.length}<p class="quiet none">читаю проекты…</p>{/if}
    </nav>

    <a class="dslink" href="/design" title="токены, компоненты, макет рабочего места">✳ дизайн-система</a>

    {#if st.overview?.copies?.length}
      <div class="copies">
        <div class="side-h">Копии</div>
        {#each st.overview.copies as app (app)}
          <button onclick={() => openCopy(app)} title="открыть {app}">{copyLabel(app)}</button>
        {/each}
      </div>
    {/if}
  </aside>

  <main>
    {#if st.overview?.error}<p class="err">{st.overview.error}</p>{/if}
    {@render children()}
  </main>
</div>

<style>
  .shell { display: flex; min-height: 100vh; }
  aside {
    flex: none; background: var(--bg-0);
    border-right: 1px solid var(--border-soft);
    display: flex; flex-direction: column; overflow-y: auto;
  }
  .brand { display: flex; align-items: baseline; gap: 8px; padding: 0 8px 12px; }
  .brand .mark { color: var(--accent); }
  .brand b { font-family: var(--serif); font-size: 17px; font-weight: 500; }
  .brand .at { margin-left: auto; font-size: 11px; color: var(--text-4); }
  nav.tree { display: flex; flex-direction: column; gap: 1px; flex: 1; }
  .proj { display: flex; flex-direction: column; }
  .proj-head {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 6px 8px; border-radius: var(--r);
    background: none; border: 0; cursor: pointer; text-align: left;
    color: var(--text-2); font: inherit; font-size: 13.5px;
  }
  .proj-head:hover { background: var(--bg-2); }
  .proj.current > .proj-head { color: var(--text-1); font-weight: 600; }
  .caret {
    display: inline-block; flex: none; width: 10px;
    color: var(--text-4); transition: transform 0.15s;
  }
  .caret.open { transform: rotate(90deg); }
  .pname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .proj-body { display: flex; flex-direction: column; gap: 1px; padding-left: 10px; }
  .side-h {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-4); padding: 16px 10px 6px; cursor: default;
  }
  .hint-q {
    display: inline-block; border: 1px solid var(--border); border-radius: 50%;
    width: 13px; height: 13px; line-height: 13px; text-align: center;
    font-size: 9px; margin-left: 4px; color: var(--text-4);
  }
    nav.tree a {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 10px; border-radius: 8px;
    color: var(--text-2); text-decoration: none; font-size: 13px;
    min-width: 0;
  }
  nav.tree a:hover { background: var(--bg-2); }
  nav.tree a.active { background: var(--bg-2); color: var(--text-1); }
  nav.tree .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  nav.tree .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  nav.tree .age { font-size: 11px; color: var(--text-4); flex: none; }
  .none { padding: 4px 10px; font-size: 13px; }
  .dslink {
    color: var(--text-4); text-decoration: none; font-size: var(--fs-xs);
    padding: var(--sp-4) var(--sp-5) 0;
  }
  .dslink:hover { color: var(--accent); }
  .done-group > summary {
    cursor: pointer; color: var(--text-4); font-size: 12px;
    padding: 10px 10px 4px; list-style: none;
  }
  .done-group > summary::before { content: '▸ '; }
  .done-group[open] > summary::before { content: '▾ '; }
  .done-group a { opacity: 0.75; }
  .badge {
    background: var(--accent); color: var(--accent-ink); border-radius: var(--r-pill);
    font-size: 10.5px; font-weight: 700; padding: 1px 6px; flex: none;
  }
  .copies { padding-bottom: 4px; }
  .copies button {
    background: none; border: 1px dashed var(--border); color: var(--text-3);
    border-radius: 8px; padding: 3px 10px; font-size: 12px; margin: 2px 2px 0 8px;
  }
  .copies button:hover { color: var(--text-1); border-color: var(--accent); border-style: solid; }
  main { flex: 1; min-width: 0; max-width: 1620px; }
  /* --- узкий экран: сайдбар выезжает поверх, шапка с кнопкой --- */
  /* mobile-first: база — выдвижной сайдбар и шапка с кнопкой; широкий
     экран получает стационарную колонку (правило CTO 11.08) */
  .mobile-bar {
    display: flex; align-items: center; gap: var(--sp-4);
    position: sticky; top: 0; z-index: 30;
    background: var(--bg-0); border-bottom: 1px solid var(--border-soft);
    padding: var(--sp-3) var(--sp-4);
    padding-top: calc(var(--sp-3) + env(safe-area-inset-top, 0px));
  }
  .burger {
    background: none; border: 0; color: var(--text-1);
    font-size: 20px; width: var(--tap); height: var(--tap);
    display: flex; align-items: center; justify-content: center;
  }
  .m-title { font-size: var(--fs-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  aside {
    position: fixed; top: 0; bottom: 0; left: 0; z-index: 40;
    width: min(84vw, 320px); height: 100dvh;
    transform: translateX(-102%); transition: transform var(--t);
    padding-top: calc(var(--sp-6) + env(safe-area-inset-top, 0px));
  }
  .shell.nav-open aside { transform: none; }
  .scrim {
    display: block; position: fixed; inset: 0; z-index: 35;
    background: rgba(0, 0, 0, 0.5); border: 0;
  }
  main { padding: var(--sp-5) var(--sp-5) calc(var(--sp-7) + var(--safe-b)); }

  @media (min-width: 901px) {
    .mobile-bar { display: none; }
    .scrim { display: none; }
    aside {
      position: sticky; top: 0; left: auto; z-index: auto;
      width: 264px; height: 100vh; transform: none;
      padding: 14px 10px 12px;
    }
    main { padding: 18px 32px 60px; }
  }


</style>
