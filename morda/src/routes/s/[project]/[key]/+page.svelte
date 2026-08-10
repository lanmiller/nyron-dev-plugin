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

  let openAsks = $derived((data?.asks || []).filter((a) => a.status === 'open'));
  let recentDecided = $derived((data?.asks || [])
    .filter((a) => ['answered', 'delivered', 'acknowledged'].includes(a.status)).slice(-2));
  let stateInfo = $derived(STATE_RU[data?.state] || null);
  let isDesktop = $derived(data?.entrypoint === 'claude-desktop');
</script>

<svelte:head><title>{data?.title || key?.slice(0, 8)} — Морда</title></svelte:head>

{#if error}
  <p class="err">{error}</p>
{:else if !data}
  <p class="quiet">Читаю транскрипт…</p>
{:else}
  <header class="s-head">
    <a href="/?p={encodeURIComponent(project)}" class="back">← {project}</a>
    <h1>{data.title || '(без названия)'}</h1>
    <div class="s-meta">
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

  <Transcript items={data.items} {project} sessionKey={key} />

  <div class="dock">
    <!-- вопросы — в прокрутке, композер всегда виден (CTO 10.08: пачка
         карточек не должна выталкивать ввод за экран) -->
    <div class="dock-asks">
      {#each openAsks as a (a.id)}
        <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
      {/each}
      {#each recentDecided as a (a.id)}
        <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
      {/each}
    </div>

    <div class="composer">
      <textarea rows="2"
        placeholder={data.input?.mode === 'tmux'
          ? `написать в чат (${data.input.pane.session} · ${data.input.pane.pane}) — мгновенно…`
          : 'написать сессии — адресным постом в будку…'}
        bind:value={draft}
        onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && sendText()}></textarea>
      <button class="btn primary" disabled={saying || !draft.trim()} onclick={sendText}>
        отправить
      </button>
    </div>
    <p class="hint quiet">
      {data.input?.mode === 'tmux'
        ? '⌘⏎ — отправить. Панель доказанно держит транскрипт этой сессии, доставка мгновенная.'
        : 'Прямого канала нет (Desktop/headless): сообщение уйдёт адресным постом в будку — рабочая сессия заберёт при чтении, спящую добудит почтальон. Открыть её окно руками:'}
      {#if data.input?.mode !== 'tmux'}
        {#each st.overview?.copies || [] as app (app)}
          <button class="copy" onclick={() => openCopy(app)}>{copyLabel(app)}</button>
        {/each}
      {/if}
    </p>
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
  .dock {
    position: sticky; bottom: 0; margin-top: 22px;
    background: var(--bg-1); padding: 10px 0 14px;
    border-top: 1px solid var(--border-soft);
  }
  .dock-asks { max-height: 42vh; overflow-y: auto; }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; resize: vertical; }
  .hint { font-size: 12px; margin: 6px 2px 0; }
  .hint .copy {
    background: none; border: 1px dashed var(--border); color: var(--text-3);
    border-radius: 8px; padding: 2px 9px; font-size: 12px; margin: 0 2px;
  }
  .hint .copy:hover { color: var(--text-1); border-color: var(--accent); border-style: solid; }
  .ok-note { color: var(--ok); }
</style>
