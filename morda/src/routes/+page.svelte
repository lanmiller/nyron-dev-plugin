<script>
  // Морда, этап 3 — список: вкладки проектов, «ждут вас», «идёт работа».
  // Данные — поллинг /api/overview каждые 5с (живой поток — этап 4).
  import { onMount } from 'svelte';

  let data = $state(null);
  let active = $state(null);      // имя активной вкладки
  let busyAsk = $state(null);     // id ask, по которому летит запрос
  let textDraft = $state({});     // черновики ответов для type=text
  let sendError = $state(null);
  let seq = 0;                    // анти-гонка: старый poll не затирает новый

  const STATE_RU = {
    working: ['работает', '#7bc47f'],
    waiting_decision: ['ждёт решения', '#e5a84b'],
    waiting_silent: ['ждёт молча', '#e5734b'],
    stalled: ['застряла', '#b3a53c'],
    dead: ['закончилась', '#8a857d'],
  };

  async function refresh() {
    const my = ++seq;
    try {
      const r = await fetch('/api/overview');
      const next = await r.json();
      if (my !== seq) return; // пришёл устаревший ответ — выбрасываем
      data = next;
      if (!active && data.projects?.length) {
        // первая вкладка с открытыми решениями, иначе просто первая
        const hot = data.projects.find((p) => p.asks?.some((a) => a.status === 'open'));
        active = (hot || data.projects[0]).name;
      }
    } catch { /* сервер перезапускается — следующий тик дотянется */ }
  }

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  async function send(projectName, ask, decision) {
    busyAsk = ask.id;
    sendError = null;
    try {
      const r = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project: projectName, ask_id: ask.id, decision: String(decision), by: 'CTO@morda' }),
      });
      if (!r.ok) sendError = (await r.json()).error || `HTTP ${r.status}`;
    } catch (e) {
      sendError = String(e.message || e);
    } finally {
      busyAsk = null;
      refresh();
    }
  }

  function age(ts) {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин`;
    return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  }

  let project = $derived(data?.projects?.find((p) => p.name === active));
  let openAsks = $derived((project?.asks || []).filter((a) => a.status === 'open'));
  let pendingAsks = $derived((project?.asks || []).filter((a) => a.status !== 'open'));
</script>

<main>
  <nav>
    {#each data?.projects || [] as p}
      {@const n = p.asks?.filter((a) => a.status === 'open').length || 0}
      <button class:active={active === p.name} onclick={() => (active = p.name)}>
        {p.name}
        {#if n}<span class="badge">{n}</span>{/if}
      </button>
    {/each}
    <span class="at">{data ? new Date(data.at).toLocaleTimeString('ru') : '…'}</span>
  </nav>

  {#if data?.error}
    <p class="err">{data.error}</p>
  {/if}
  {#if sendError}
    <p class="err">Ответ не доставлен: {sendError}</p>
  {/if}

  {#if project}
    {#if project.error}
      <p class="err">{project.name}: {project.error}</p>
    {/if}

    <section>
      <h2>Ждут вас {#if openAsks.length}<span class="badge hot">{openAsks.length}</span>{/if}</h2>
      {#if !openAsks.length}
        <p class="quiet">Открытых решений нет.</p>
      {/if}
      {#each openAsks as a (a.id)}
        <article class="ask" class:blocking={a.urgency === 'blocking'}>
          <header>
            <b>{a.question}</b>
            <span class="meta">
              {a.session}{a.ticket ? ` · ${a.ticket}` : ''} · {age(a.ts)}
              {#if a.urgency === 'blocking'}· <em>блокирует</em>{/if}
            </span>
          </header>
          {#if a.context}<details><summary>контекст</summary><p>{a.context}</p></details>{/if}
          {#if a.stamp}<span class="stamp">{a.stamp.split(' @')[0]}</span>{/if}
          <div class="answers">
            {#if a.type === 'choice' && a.options}
              {#each a.options as o}
                <button disabled={busyAsk === a.id} onclick={() => send(project.name, a, o.n)}>
                  <span>{o.n}. {o.label}</span>
                  {#if o.effect}<small>{o.effect}</small>{/if}
                </button>
              {/each}
            {:else if a.type === 'confirm'}
              <button disabled={busyAsk === a.id} onclick={() => send(project.name, a, 'да')}>да</button>
              <button disabled={busyAsk === a.id} onclick={() => send(project.name, a, 'нет')}>нет</button>
            {:else}
              <input
                placeholder="ответ…"
                bind:value={textDraft[a.id]}
                onkeydown={(e) => e.key === 'Enter' && textDraft[a.id] && send(project.name, a, textDraft[a.id])}
              />
              <button disabled={busyAsk === a.id || !textDraft[a.id]} onclick={() => send(project.name, a, textDraft[a.id])}>
                отправить
              </button>
            {/if}
          </div>
        </article>
      {/each}
      {#each pendingAsks as a (a.id)}
        <article class="ask done">
          <b>{a.question}</b>
          <span class="meta">решено: «{a.decision}» ({a.decided_by}) · {a.status} · сессия ещё не забрала</span>
        </article>
      {/each}
    </section>

    <section>
      <h2>Идёт работа</h2>
      {#if !project.watch?.length}
        <p class="quiet">Сторож ещё не отчитался по этому проекту.</p>
      {/if}
      <ul class="watch">
        {#each project.watch || [] as w (w.key)}
          {@const [label, color] = STATE_RU[w.state] || [w.state, '#888']}
          <li>
            <i style="background:{color}"></i>
            <code>{w.key.slice(0, 8)}</code>
            <b style="color:{color}">{label}</b>
            <span class="quiet">{w.reason || ''}</span>
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>Шина</h2>
      <ul class="feed">
        {#each [...(project.recent || [])].reverse() as m (m.id)}
          <li>
            <span class="meta">{age(m.ts)} · <b>{m.from}</b>{m.to && m.to !== 'all' ? ` → ${m.to}` : ''}{m.ticket ? ` · ${m.ticket}` : ''}</span>
            <p>{m.text}</p>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #262624;
    color: #e8e6e3;
    font: 15px/1.45 -apple-system, 'Segoe UI', sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; padding: 16px 20px 60px; }
  nav { display: flex; gap: 6px; align-items: center; padding: 8px 0 16px; position: sticky; top: 0; background: #262624; }
  nav button {
    background: #30302e; color: #b8b4ad; border: 1px solid #3d3c39;
    border-radius: 8px; padding: 6px 14px; font-size: 14px; cursor: pointer;
  }
  nav button.active { color: #f5f3f0; border-color: #d97757; }
  nav .at { margin-left: auto; color: #6f6b64; font-size: 12px; }
  .badge {
    background: #d97757; color: #1e1d1b; border-radius: 9px;
    font-size: 11px; font-weight: 700; padding: 1px 7px; margin-left: 6px;
  }
  .badge.hot { vertical-align: middle; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8a857d; margin: 26px 0 10px; }
  .ask {
    background: #30302e; border: 1px solid #3d3c39; border-left: 3px solid #6f6b64;
    border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
  }
  .ask.blocking { border-left-color: #d97757; }
  .ask.done { opacity: 0.55; border-left-color: #7bc47f; }
  .ask header { display: flex; flex-direction: column; gap: 2px; }
  .meta { color: #8a857d; font-size: 12.5px; }
  .meta em { color: #d97757; font-style: normal; font-weight: 600; }
  details { margin: 8px 0 0; color: #b8b4ad; font-size: 13.5px; }
  summary { cursor: pointer; color: #8a857d; }
  .stamp {
    display: inline-block; margin-top: 8px; font: 11.5px ui-monospace, monospace;
    color: #6f6b64; background: #262624; border-radius: 6px; padding: 2px 8px;
  }
  .answers { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .answers button {
    background: #3d3c39; color: #e8e6e3; border: 1px solid #4a4946;
    border-radius: 8px; padding: 7px 16px; font-size: 14px; cursor: pointer;
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  }
  .answers button small { color: #8a857d; font-size: 11.5px; font-weight: 400; }
  .answers button:hover:not(:disabled) { border-color: #d97757; }
  .answers button:disabled { opacity: 0.4; }
  .answers input {
    flex: 1; min-width: 200px; background: #262624; color: #e8e6e3;
    border: 1px solid #3d3c39; border-radius: 8px; padding: 7px 12px; font-size: 14px;
  }
  .watch { list-style: none; padding: 0; margin: 0; }
  .watch li { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid #2e2d2b; }
  .watch i { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; align-self: center; }
  .watch code { color: #8a857d; font-size: 12.5px; }
  .watch b { font-weight: 600; font-size: 13.5px; white-space: nowrap; }
  .watch .quiet { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feed { list-style: none; padding: 0; margin: 0; }
  .feed li { padding: 7px 0; border-bottom: 1px solid #2e2d2b; }
  .feed p { margin: 2px 0 0; font-size: 13.5px; color: #c9c5be; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .quiet { color: #6f6b64; }
  .err { color: #e5734b; background: #30302e; border-radius: 8px; padding: 10px 14px; }
</style>
