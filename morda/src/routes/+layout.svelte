<script>
  // Оболочка морды (этап 4): слева — проекты и сессии (дизайн-лок: сайдбар
  // на глубокой поверхности, как список чатов Claude), справа — контент.
  // Поллинг живёт здесь один: страницы берут данные из контекста.
  //
  // Волна 3: выдвижная навигация — Sheet (свой transform, свой скрим и
  // ловушка фокуса больше не нужны), действия открытой сессии — выпадающее
  // меню. Меню наполняет ОКНО СЕССИИ через контекст (st.sessionMenu):
  // кнопка живёт в общей шапке, а что она открывает — знает страница.
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { STATE_RU, age } from '$lib/states.js';
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import * as Sheet from '$lib/ui/sheet/index.js';
  import * as DropdownMenu from '$lib/ui/dropdown-menu/index.js';
  import * as Collapsible from '$lib/ui/collapsible/index.js';
  import '../app.css';

  let { children } = $props();

  const st = $state({ overview: null, sessions: [], tree: [], sendError: null,
    // «⋯» в шапке: открытость меню и его пункты от окна сессии
    sessionActions: false, sessionMenu: null });
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
  // в шапке — имя открытой сессии: своя шапка сессии на телефоне съедала
  // экран, а при прокрутке уезжала (CTO 11.08)
  let sessionTitle = $derived.by(() => {
    const k = page.params?.key;
    if (!k) return null;
    for (const p of st.tree) {
      const s = (p.sessions || []).find((x) => x.key === k);
      if (s) return s.title;
    }
    return null;
  });
  let totalOpen = $derived((st.overview?.projects || [])
    .reduce((n, p) => n + (p.asks?.filter((a) => a.status === 'open').length || 0), 0));

  // раскрытые проекты: активный всегда, остальные — по клику человека
  let opened = $state({});
  const isOpen = (name) => opened[name] ?? (name === project);
  function toggleProject(name) {
    opened = { ...opened, [name]: !isOpen(name) };
  }
  // кладбище отработавших волн: раскрывается по проекту, помнит выбор
  let doneOpen = $state({});

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

  // высота липкой полосы — в переменную: шапка окна сессии липнет ровно
  // под ней на любом устройстве (вырез, крупный шрифт)
  let barEl = $state(null);
  $effect(() => {
    if (!barEl) return;
    const set = () => document.documentElement.style.setProperty(
      '--bar-h', barEl.offsetHeight + 'px');
    set();
    const ro = new ResizeObserver(set);
    ro.observe(barEl);
    return () => ro.disconnect();
  });

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

<!-- Один и тот же сайдбар: на широком экране стоит колонкой, на телефоне
     приезжает шторкой. Разметка одна — расходиться им нечем. -->
{#snippet sessionRow(proj, s)}
  {@const [label, color] = STATE_RU[s.state] || ['', 'var(--text-4)']}
  <a href="/s/{encodeURIComponent(proj)}/{s.key}"
     class:active={page.params?.key === s.key}
     title="{s.title} · {label || 'вне надзора'}">
    <i class="dot" style="background:{color}"></i>
    <span class="t">{s.title}</span>
    {#if s.open_asks}<Badge>{s.open_asks}</Badge>{/if}
    <span class="age">{age(s.mtime)}</span>
  </a>
{/snippet}

{#snippet sidebar(inSheet = false)}
  <div class="side" class:in-sheet={inSheet}>
    <div class="brand">
      <Icon name="asterisk" size={18} class="text-primary" />
      <b>STOVP</b>
      <span class="at">{st.overview ? new Date(st.overview.at).toLocaleTimeString('ru') : '…'}</span>
    </div>

    <div class="side-h" title="цвет точки — вердикт сторожа: зелёная — работает; жёлтая — ждёт вашего решения (оформленный ask); оранжевая — спросила в чате и молчит; горчичная — застряла; серая — закончилась; тусклая — сторож её ещё не видел">
      Проекты и сессии <Icon name="circle-help" size={12} class="text-ink-4" />
    </div>

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
            <Icon name="chevron-right" size={13} class="caret {isOpen(p.name) ? 'open' : ''}" />
            <span class="pname">{p.name}</span>
            {#if n}<Badge>{n}</Badge>{/if}
            <span class="age">{ls.length || ''}</span>
          </button>
          {#if isOpen(p.name)}
            <div class="proj-body">
              {#each ls as s (s.key)}{@render sessionRow(p.name, s)}{/each}
              {#if !ls.length}<p class="quiet none">живых нет</p>{/if}
              <!-- кладбище отработавших волн не мешается с живыми (CTO 10.08) -->
              {#if ds.length}
                <Collapsible.Root open={!!doneOpen[p.name]}
                  onOpenChange={(v) => (doneOpen = { ...doneOpen, [p.name]: v })}>
                  <Collapsible.Trigger>
                    {#snippet child({ props })}
                      <button class="done-head" {...props}>
                        <Icon name="chevron-right" size={12}
                          class="caret {doneOpen[p.name] ? 'open' : ''}" />
                        завершённые ({ds.length})
                      </button>
                    {/snippet}
                  </Collapsible.Trigger>
                  <Collapsible.Content class="done-body">
                    {#each ds as s (s.key)}{@render sessionRow(p.name, s)}{/each}
                  </Collapsible.Content>
                </Collapsible.Root>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if !st.tree.length}<p class="quiet none">читаю проекты…</p>{/if}
    </nav>

    <a class="dslink" href="/design" title="токены, компоненты, макет рабочего места">
      <Icon name="asterisk" size={12} /> дизайн-система
    </a>

    {#if st.overview?.copies?.length}
      <div class="copies">
        <div class="side-h">Копии</div>
        <div class="copy-row">
          {#each st.overview.copies as app (app)}
            <Button variant="outline" size="xs" class="border-dashed"
              onclick={() => openCopy(app)} title="открыть {app}">{copyLabel(app)}</Button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<!-- Мобильная шапка: на узком экране сайдбар уезжает, навигация — по кнопке
     (кейс CTO 11.08 — вести флот с телефона) -->
<header class="mobile-bar" bind:this={barEl}>
  <Sheet.Root bind:open={navOpen}>
    <Sheet.Trigger>
      {#snippet child({ props })}
        <Button variant="ghost" size="icon" aria-label="проекты и сессии" {...props}>
          <Icon name="menu" size={20} />
        </Button>
      {/snippet}
    </Sheet.Trigger>
    <Sheet.Content side="left"
      class="gap-0 p-0 data-[side=left]:w-[84vw] data-[side=left]:max-w-80 data-[side=left]:sm:max-w-80">
      <Sheet.Header class="sr-only">
        <Sheet.Title>Проекты и сессии</Sheet.Title>
        <Sheet.Description>Навигация по флоту: проекты и их сессии</Sheet.Description>
      </Sheet.Header>
      {@render sidebar(true)}
    </Sheet.Content>
  </Sheet.Root>

  <b class="m-title">{sessionTitle || project || 'STOVP'}</b>
  {#if totalOpen}<Badge>{totalOpen}</Badge>{/if}

  {#if st.sessionMenu?.length}
    <!-- действия сессии: отдельная понятная кнопка, название остаётся
         названием (CTO 11.08: «стало кнопкой — плохо и непонятно») -->
    <DropdownMenu.Root bind:open={st.sessionActions}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="ghost" size="icon" class="ml-auto" aria-label="действия сессии"
            title="действия сессии" {...props}>
            <Icon name="sliders-horizontal" size={18} />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-56">
        {#each st.sessionMenu as a (a.label)}
          {#if a.note}
            <DropdownMenu.Label class="flex items-center gap-2">
              {#if a.dot}<i class="dot" style="background:{a.dot}"></i>{/if}{a.label}
            </DropdownMenu.Label>
          {:else}
            <DropdownMenu.Item disabled={a.disabled} onSelect={a.run}>
              <Icon name={a.icon} size={15} />{a.label}
            </DropdownMenu.Item>
          {/if}
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</header>

<div class="shell">
  <aside>{@render sidebar()}</aside>

  <main>
    {#if st.overview?.error}<p class="err">{st.overview.error}</p>{/if}
    {@render children()}
  </main>
</div>

<style>
  .shell { display: flex; min-height: 100vh; }
  /* сайдбар: содержимое одно, место разное — колонка или шторка */
  .side {
    display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%;
    overflow-y: auto; padding: var(--sp-6) var(--sp-5) var(--sp-5);
  }
  .brand { display: flex; align-items: center; gap: var(--sp-4); padding: 0 var(--sp-4) var(--sp-6); }
  /* в шторке справа сверху сидит её крестик — марка под него не лезет */
  .side.in-sheet .brand { padding-right: var(--sp-8); }
  .brand b { font-family: var(--serif); font-size: 17px; font-weight: 500; }
  .brand .at { margin-left: auto; font-size: var(--fs-micro); color: var(--text-4); }
  nav.tree { display: flex; flex-direction: column; gap: 1px; flex: 1; }
  .proj { display: flex; flex-direction: column; }
  .proj-head {
    display: flex; align-items: center; gap: var(--sp-3); width: 100%;
    padding: var(--sp-3) var(--sp-4); border-radius: var(--r);
    background: none; border: 0; text-align: left;
    color: var(--text-2); font: inherit; font-size: var(--fs-sm);
  }
  .proj-head:hover { background: var(--bg-2); }
  .proj.current > .proj-head { color: var(--text-1); font-weight: 600; }
  /* стрелка раскрытия — общий кирпич .caret из app.css (поворот на 90°) */
  .pname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .proj-body { display: flex; flex-direction: column; gap: 1px; padding-left: var(--sp-5); }
  .side-h {
    display: flex; align-items: center; gap: var(--sp-2);
    font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-4); padding: var(--sp-6) var(--sp-5) var(--sp-3); cursor: default;
  }
  nav.tree a {
    display: flex; align-items: center; gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-5); border-radius: var(--r-sm);
    color: var(--text-2); text-decoration: none; font-size: var(--fs-sm);
    min-width: 0;
  }
  nav.tree a:hover { background: var(--bg-2); }
  nav.tree a.active { background: var(--bg-2); color: var(--text-1); }
  nav.tree .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  nav.tree .age { font-size: var(--fs-micro); color: var(--text-4); flex: none; }
  .none { padding: var(--sp-2) var(--sp-5); font-size: var(--fs-sm); }
  .dslink {
    display: flex; align-items: center; gap: var(--sp-3);
    color: var(--text-4); text-decoration: none; font-size: var(--fs-xs);
    padding: var(--sp-4) var(--sp-5) 0;
  }
  .dslink:hover { color: var(--accent); }
  .done-head {
    display: flex; align-items: center; gap: var(--sp-3); width: 100%;
    background: none; border: 0; text-align: left; font: inherit;
    color: var(--text-4); font-size: var(--fs-xs);
    padding: var(--sp-4) var(--sp-5) var(--sp-2);
  }
  .done-head:hover { color: var(--text-2); }
  :global(.done-body) a { opacity: 0.75; }
  .copies { padding-bottom: var(--sp-2); }
  .copy-row { display: flex; flex-wrap: wrap; gap: var(--sp-3); padding: 0 var(--sp-5); }
  main { flex: 1; min-width: 0; max-width: 1620px; }

  /* --- mobile-first: база — шапка с кнопкой, сайдбар приезжает шторкой;
         широкий экран получает стационарную колонку (правило CTO 11.08) --- */
  .mobile-bar {
    display: flex; align-items: center; gap: var(--sp-4);
    position: sticky; top: 0; z-index: 30;
    background: var(--bg-0); border-bottom: 1px solid var(--border);
    /* лента уходит ПОД шапку — без слоя это читалось как обрыв текста
       (CTO 11.08: «почему обрезка идёт») */
    box-shadow: 0 8px 12px -8px rgba(0, 0, 0, 0.75);
    padding: var(--sp-3) var(--sp-4);
    padding-top: calc(var(--sp-3) + env(safe-area-inset-top, 0px));
  }
  .m-title {
    flex: 1; min-width: 0; font-size: var(--fs-md);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  aside { display: none; }
  /* под фиксированным композером окна сессии — запас, иначе последние
     реплики уезжают под него (CTO 11.08) */
  main {
    padding: var(--sp-5) var(--sp-5)
      calc(var(--dock-h, 96px) + var(--sp-6) + var(--safe-b));
  }

  @media (min-width: 901px) {
    .mobile-bar { display: none; }
    aside {
      display: block; position: sticky; top: 0; flex: none;
      width: 264px; height: 100vh;
      background: var(--bg-0); border-right: 1px solid var(--border-soft);
    }
    .side { padding: var(--sp-6) var(--sp-5) var(--sp-5); }
    main { padding: 18px 32px 60px; }
  }
</style>
