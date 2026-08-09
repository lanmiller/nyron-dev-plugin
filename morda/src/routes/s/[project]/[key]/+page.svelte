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
  let pane = $state(null);
  let saying = $state(false);
  let sayError = $state(null);
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
      const stick = nearBottom();
      data = next;
      if (!pane || !next.tmux?.some((c) => c.pane === pane))
        pane = next.tmux?.[0]?.pane || null;
      if (stick) tick().then(() => window.scrollTo({ top: document.body.scrollHeight }));
    } catch { /* сервер перезапускается — следующий тик дотянется */ }
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
    if (!draft.trim() || !pane) return;
    saying = true; sayError = null;
    try {
      const r = await fetch('/api/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, pane, text: draft }),
      });
      if (!r.ok) sayError = (await r.json()).error || `HTTP ${r.status}`;
      else draft = '';
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
      <button class="chip open-app" disabled={opening} onclick={openInClaude}
        title="claude://resume — открыть эту сессию в приложении Claude">открыть в Claude ⧉</button>
    </div>
    {#if data.reason}<p class="reason quiet">{data.reason}</p>{/if}
  </header>

  <Transcript items={data.items} {project} sessionKey={key} />

  <div class="dock">
    {#each openAsks as a (a.id)}
      <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
    {/each}
    {#each recentDecided as a (a.id)}
      <AskCard ask={a} project={project} linkToSession={false} onSent={refresh} />
    {/each}

    {#if data.tmux?.length}
      <div class="composer">
        {#if data.tmux.length > 1}
          <select bind:value={pane} title="панель tmux">
            {#each data.tmux as c (c.pane)}
              <option value={c.pane}>{c.session} · {c.pane}</option>
            {/each}
          </select>
        {/if}
        <textarea rows="2" placeholder="написать в чат (tmux {pane})…"
          bind:value={draft}
          onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && sendText()}></textarea>
        <button class="btn primary" disabled={saying || !draft.trim()} onclick={sendText}>
          отправить
        </button>
      </div>
      <p class="hint quiet">⌘⏎ — отправить. Текст уходит tmux send-keys в панель проекта.</p>
    {:else}
      <div class="mirror">
        <span class="quiet">
          {isDesktop
            ? 'Desktop-сессия: это зеркало, ввод в чужое живое окно запрещён (гонка двух рук). Ответы на ask доходят pull-ом; для живого ввода откройте копию:'
            : 'tmux для этой сессии не найден — только зеркало. Ответы на ask доходят pull-ом; либо откройте копию:'}
        </span>
        {#each st.overview?.copies || [] as app (app)}
          <button class="copy" onclick={() => openCopy(app)}>{copyLabel(app)}</button>
        {/each}
      </div>
    {/if}
    {#if sayError}<p class="err">Не отправлено: {sayError}</p>{/if}
  </div>
{/if}

<style>
  .s-head { margin-bottom: 18px; }
  .back { color: var(--text-3); text-decoration: none; font-size: 13px; }
  .back:hover { color: var(--text-1); }
  h1 { font-size: 24px; margin: 6px 0 8px; }
  .s-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .open-app { background: none; }
  .open-app:hover:not(:disabled) { border-color: var(--accent); color: var(--text-1); }
  .reason { margin: 8px 0 0; font-size: 13px; }
  .dock {
    position: sticky; bottom: 0; margin-top: 22px;
    background: var(--bg-1); padding: 10px 0 14px;
    border-top: 1px solid var(--border-soft);
  }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; resize: vertical; }
  .hint { font-size: 12px; margin: 6px 2px 0; }
  .mirror { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13.5px; }
  .mirror .copy {
    background: none; border: 1px dashed var(--border); color: var(--text-3);
    border-radius: 8px; padding: 3px 10px; font-size: 12.5px;
  }
  .mirror .copy:hover { color: var(--text-1); border-color: var(--accent); border-style: solid; }
</style>
