<script>
  // Карточка запроса на решение. Живёт и на главной, и в окне сессии.
  // Статус доставки (этап 4, требование CTO дословно: «статус доставки
  // виден на карточке») — цепочка решено → доставлено → подтверждено.
  import { age, hhmm } from '$lib/states.js';

  let { ask, project, linkToSession = true, onSent = () => {} } = $props();

  let busy = $state(false);
  let draft = $state('');
  let error = $state(null);

  async function post(body) {
    busy = true; error = null;
    try {
      const r = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, ask_id: ask.id, by: 'CTO@morda', ...body }),
      });
      if (!r.ok) error = (await r.json()).error || `HTTP ${r.status}`;
    } catch (e) {
      error = String(e.message || e);
    } finally {
      busy = false;
      onSent();
    }
  }
  const send = (decision) => post({ decision: String(decision) });

  // Вопрос непонятен — уточнить у того, кто его задал, НЕ решая и не
  // разыскивая его сессию (флоу CTO 11.08). Ask остаётся открытым.
  let asking = $state(false);
  let probe = $state('');
  let probeSent = $state(null);
  async function askBack() {
    if (!probe.trim()) return;
    busy = true; error = null; probeSent = null;
    try {
      const r = await fetch('/api/ask-author', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, ask_id: ask.id, by: 'CTO@morda', text: probe }),
      });
      const body = await r.json();
      if (!r.ok) error = body.error || `HTTP ${r.status}`;
      else { probe = ''; asking = false; probeSent = `спрошено у «${body.to}» — ответит постом в будку`; }
    } catch (e) {
      error = String(e.message || e);
    } finally { busy = false; }
  }
  // снятие неактуального вопроса (мёртвые сессии, устаревшие заглушки
  // сторожа): отмена только из open — решённые забирает ack сессии
  const dismiss = () => post({ action: 'cancel', reason: 'снят человеком из морды' });

  // Окно сессии автора: uuid-ключ напрямую либо резолв сервера по имени
  // волны («wave-f3» → «Волна Ф3…»), чтобы «перейти и общаться там»
  let authorKey = $derived(
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(ask.session) ? ask.session : ask.session_key || null);
  let authorHref = $derived(
    linkToSession && authorKey ? `/s/${encodeURIComponent(project)}/${authorKey}` : null);
  let sessionHref = $derived(authorHref);
</script>

<article class="ask" class:blocking={ask.urgency === 'blocking'} class:done={ask.status !== 'open'}>
  <header>
    {#if sessionHref}
      <a href={sessionHref} class="q" title="открыть окно сессии"><b>{ask.question}</b></a>
    {:else}
      <b>{ask.question}</b>
    {/if}
    <span class="meta">
      спрашивает:&nbsp;
      {#if sessionHref}
        <a href={sessionHref} class="sess" title="открыть окно сессии · {ask.session}">{ask.session_title || ask.session.slice(0, 8)} ↗</a>
      {:else}
        <b class="from">{ask.session_title || ask.session}</b>
      {/if}
      {ask.ticket ? ` · ${ask.ticket}` : ''} · {age(ask.ts)}
      {#if ask.urgency === 'blocking' && ask.status === 'open'}· <em>блокирует</em>{/if}
    </span>
  </header>

  {#if ask.context}<details><summary>контекст</summary><p>{ask.context}</p></details>{/if}
  {#if ask.stamp}<span class="stamp mono">{ask.stamp.split(' @')[0]}</span>{/if}

  {#if ask.status === 'open'}
    <div class="answers">
      {#if ask.type === 'choice' && ask.options}
        {#each ask.options as o}
          <button class="btn" disabled={busy} onclick={() => send(o.n)}>
            <span>{o.n}. {o.label}</span>
            {#if o.effect}<small>{o.effect}</small>{/if}
          </button>
        {/each}
      {:else if ask.type === 'confirm'}
        <button class="btn" disabled={busy} onclick={() => send('да')}>да</button>
        <button class="btn" disabled={busy} onclick={() => send('нет')}>нет</button>
      {:else}
        <input type="text" placeholder="ответ…" bind:value={draft}
          onkeydown={(e) => e.key === 'Enter' && draft && send(draft)} />
        <button class="btn" disabled={busy || !draft} onclick={() => send(draft)}>отправить</button>
      {/if}
      <div class="ask-tools">
        <button class="link" disabled={busy} onclick={() => (asking = !asking)}
          title="вопрос непонятен — спросить у того, кто его задал; ask останется открытым">
          {asking ? '← назад' : 'уточнить у автора'}
        </button>
        {#if authorHref}
          <a class="link" href={authorHref} title="открыть окно этой сессии и общаться там">перейти в её сессию ↗</a>
        {/if}
        <button class="dismiss" disabled={busy} onclick={dismiss}
          title="вопрос неактуален (сессия умерла, тема закрыта) — снять; сторож не пересоздаст его, пока сессия молчит">
          снять вопрос
        </button>
      </div>
      {#if asking}
        <div class="probe">
          <input type="text" placeholder="что уточнить у «{ask.session_title || ask.session}»…"
            bind:value={probe} onkeydown={(e) => e.key === 'Enter' && askBack()} />
          <button class="btn small" disabled={busy || !probe.trim()} onclick={askBack}>спросить</button>
        </div>
      {/if}
      {#if probeSent}<p class="sent">{probeSent}</p>{/if}
    </div>
  {:else}
    <div class="delivery">
      <span class="step on">решено «{ask.decision}» · {ask.decided_by} · {hhmm(ask.decided_ts)}</span>
      {#if String(ask.decided_by || '').includes('@morda')}
        <span class="step on" title="решение продублировано постом в шину — живой диспетчер видит его, не дожидаясь pull автора">⇢ диспетчеру в шину</span>
      {/if}
      <span class="arrow">→</span>
      <span class="step" class:on={ask.delivered_ts || ask.acked_ts}
        title="ответ забирает сама сессия-автор чтением будки (pull)">
        {ask.delivered_ts ? `сессия забрала ${hhmm(ask.delivered_ts)}`
          : ask.acked_ts ? 'доставка не фиксировалась' : `ждёт в будке для «${ask.session_title || ask.session}»`}
      </span>
      <span class="arrow">→</span>
      <span class="step" class:on={ask.acked_ts}>
        {ask.acked_ts ? `подтверждено ${hhmm(ask.acked_ts)}` : 'не подтверждено'}
      </span>
    </div>
  {/if}

  {#if error}<p class="err">Ответ не доставлен: {error}</p>{/if}
</article>

<style>
  .ask {
    background: var(--bg-2); border: 1px solid var(--border);
    border-left: 3px solid var(--text-4);
    border-radius: var(--r); padding: 12px 14px; margin-bottom: 10px;
  }
  .ask.blocking { border-left-color: var(--accent); }
  .ask.done { border-left-color: var(--ok); }
  .ask.done header b { color: var(--text-2); font-weight: 500; }
  header { display: flex; flex-direction: column; gap: 2px; }
  .meta { color: var(--text-3); font-size: 12.5px; }
  .meta em { color: var(--accent); font-style: normal; font-weight: 600; }
  .meta .sess { color: var(--text-2); text-decoration: none; }
  .meta .sess:hover { color: var(--accent); }
  .meta .from { color: var(--text-2); font-weight: 600; }
  header .q { color: inherit; text-decoration: none; }
  header .q:hover b { color: var(--accent); }
  details { margin: 8px 0 0; color: var(--text-2); font-size: 13.5px; }
  summary { cursor: pointer; color: var(--text-3); }
  .stamp {
    display: inline-block; margin-top: 8px;
    color: var(--text-4); background: var(--bg-0); border-radius: 6px; padding: 2px 8px;
  }
  .answers { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .ask-tools { display: flex; gap: 14px; align-items: center; width: 100%; margin-top: 2px; }
  .link {
    background: none; border: 0; padding: 0; cursor: pointer;
    color: var(--text-3); font: inherit; font-size: 12px; text-decoration: none;
  }
  .link:hover { color: var(--accent); }
  .probe { display: flex; gap: 8px; width: 100%; }
  .probe input { flex: 1; }
  .btn.small { padding: 6px 12px; font-size: 13px; }
  .sent { color: var(--ok); font-size: 12.5px; margin: 6px 0 0; width: 100%; }
  .answers .btn { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
  .answers .btn small { color: var(--text-3); font-size: 11.5px; font-weight: 400; }
  .answers input { flex: 1; min-width: 200px; }
  .dismiss {
    margin-left: auto; background: none; border: none;
    color: var(--text-4); font-size: 12.5px; text-decoration: underline dotted;
    padding: 7px 2px;
  }
  .dismiss:hover:not(:disabled) { color: var(--hot); }
  .delivery {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    margin-top: 10px; font-size: 12.5px;
  }
  .delivery .step { color: var(--text-4); }
  .delivery .step.on { color: var(--text-2); }
  .delivery .arrow { color: var(--text-4); }
  .err { margin: 10px 0 0; }
</style>
