<script>
  // Оболочка морды (этап 4): слева — проекты и сессии (дизайн-лок: сайдбар
  // на глубокой поверхности, как список чатов Claude), справа — контент.
  // Поллинг живёт здесь один: страницы берут данные из контекста.
  import { onMount, setContext } from 'svelte';
  import { page } from '$app/state';
  import { STATE_RU, age } from '$lib/states.js';
  import '../app.css';

  let { children } = $props();

  const st = $state({ overview: null, sessions: [], sendError: null });
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

  // живые — работают/ждут/застряли или несут открытый ask; остальное —
  // отработавшие волны, свёрнутая группа
  const ACTIVE = ['working', 'waiting_decision', 'waiting_silent', 'stalled'];
  let liveSessions = $derived(st.sessions.filter((s) => s.open_asks || ACTIVE.includes(s.state)));
  let doneSessions = $derived(st.sessions.filter((s) => !s.open_asks && !ACTIVE.includes(s.state)));

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
  async function refreshSessions() {
    if (!project) return;
    const p = project;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(p)}`);
      const next = await r.json();
      if (project === p && next.sessions) st.sessions = next.sessions;
    } catch {}
  }
  onMount(() => {
    refresh().then(refreshSessions);
    const t1 = setInterval(refresh, 5000);
    const t2 = setInterval(refreshSessions, 10_000);
    return () => { clearInterval(t1); clearInterval(t2); };
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

<div class="shell">
  <aside>
    <div class="brand">
      <span class="mark">✳</span>
      <b>Морда</b>
      <span class="at">{st.overview ? new Date(st.overview.at).toLocaleTimeString('ru') : '…'}</span>
    </div>

    <nav class="projects">
      {#each st.overview?.projects || [] as p (p.name)}
        {@const n = openCount(p)}
        <a href="/?p={encodeURIComponent(p.name)}" class:active={project === p.name}>
          {p.name}
          {#if n}<span class="badge">{n}</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="side-h" title="цвет точки — вердикт сторожа: зелёная — работает; жёлтая — ждёт вашего решения (оформленный ask); оранжевая — спросила в чате и молчит; горчичная — застряла; серая — закончилась; тусклая — сторож её ещё не видел">Сессии <span class="hint-q">?</span></div>
    {#snippet row(s)}
      {@const [label, color] = STATE_RU[s.state] || ['', 'var(--text-4)']}
      <a href="/s/{encodeURIComponent(project)}/{s.key}"
         class:active={page.params?.key === s.key}
         title="{s.title} · {label || 'вне надзора'}">
        <i class="dot" style="background:{color}"></i>
        <span class="t">{s.title}</span>
        {#if s.open_asks}<span class="badge">{s.open_asks}</span>{/if}
        <span class="age">{age(s.mtime)}</span>
      </a>
    {/snippet}
    <nav class="sessions">
      {#each liveSessions as s (s.key)}{@render row(s)}{/each}
      {#if !liveSessions.length}
        <p class="quiet none">живых сессий нет</p>
      {/if}
      <!-- кладбище отработавших волн (воркtree снесены — норма) не должно
           тонуть вперемешку с живыми (CTO 10.08) -->
      {#if doneSessions.length}
        <details class="done-group">
          <summary>завершённые ({doneSessions.length})</summary>
          {#each doneSessions as s (s.key)}{@render row(s)}{/each}
        </details>
      {/if}
    </nav>

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
    width: 264px; flex: none; background: var(--bg-0);
    border-right: 1px solid var(--border-soft);
    display: flex; flex-direction: column;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    padding: 14px 10px 12px;
  }
  .brand { display: flex; align-items: baseline; gap: 8px; padding: 0 8px 12px; }
  .brand .mark { color: var(--accent); }
  .brand b { font-family: var(--serif); font-size: 17px; font-weight: 500; }
  .brand .at { margin-left: auto; font-size: 11px; color: var(--text-4); }
  nav.projects { display: flex; flex-direction: column; gap: 2px; }
  nav.projects a {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: var(--r);
    color: var(--text-2); text-decoration: none; font-size: 14px;
  }
  nav.projects a:hover { background: var(--bg-2); }
  nav.projects a.active { background: var(--bg-2); color: var(--text-1); }
  .side-h {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-4); padding: 16px 10px 6px; cursor: default;
  }
  .hint-q {
    display: inline-block; border: 1px solid var(--border); border-radius: 50%;
    width: 13px; height: 13px; line-height: 13px; text-align: center;
    font-size: 9px; margin-left: 4px; color: var(--text-4);
  }
  nav.sessions { display: flex; flex-direction: column; gap: 1px; flex: 1; }
  nav.sessions a {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 10px; border-radius: 8px;
    color: var(--text-2); text-decoration: none; font-size: 13px;
    min-width: 0;
  }
  nav.sessions a:hover { background: var(--bg-2); }
  nav.sessions a.active { background: var(--bg-2); color: var(--text-1); }
  nav.sessions .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  nav.sessions .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  nav.sessions .age { font-size: 11px; color: var(--text-4); flex: none; }
  .none { padding: 4px 10px; font-size: 13px; }
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
  main { flex: 1; min-width: 0; padding: 18px 26px 60px; max-width: 980px; }
</style>
