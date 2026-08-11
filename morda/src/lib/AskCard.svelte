<script>
  // Карточка запроса на решение. Живёт и на главной, и в окне сессии.
  // Статус доставки (этап 4, требование CTO дословно: «статус доставки
  // виден на карточке») — цепочка решено → доставлено → подтверждено.
  //
  // Волна 3: собрана из Card / Button / Badge / Collapsible / Input. Своих
  // стилей осталось ровно два вида — раскладка рядов и цвет рамки по
  // состоянию; всё остальное приходит из компонентов.
  import { age, hhmm } from '$lib/states.js';
  import Icon from '$lib/Icon.svelte';
  import * as Card from '$lib/ui/card/index.js';
  import * as Collapsible from '$lib/ui/collapsible/index.js';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import { Input } from '$lib/ui/input/index.js';

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
  let context = $state(false);
</script>

<Card.Root
  class="mb-2.5 {ask.urgency === 'blocking' && ask.status === 'open' ? 'border-primary' : ''}
         {ask.status !== 'open' ? 'border-ok/45' : ''}">
  <Card.Header>
    <Card.Title class={ask.status === 'open' ? 'font-semibold' : 'text-ink-2'}>
      {#if sessionHref}
        <a href={sessionHref} class="no-underline hover:text-primary" title="открыть окно сессии">{ask.question}</a>
      {:else}
        {ask.question}
      {/if}
    </Card.Title>
    <Card.Description>
      спрашивает:&nbsp;
      {#if sessionHref}
        <a href={sessionHref} class="text-ink-2 no-underline hover:text-primary"
           title="открыть окно сессии · {ask.session}">{ask.session_title || ask.session.slice(0, 8)}<Icon name="external-link" size={12} class="ml-0.5" /></a>
      {:else}
        <b class="text-ink-2">{ask.session_title || ask.session}</b>
      {/if}
      {ask.ticket ? ` · ${ask.ticket}` : ''} · {age(ask.ts)}
      {#if ask.urgency === 'blocking' && ask.status === 'open'}
        <Badge class="ml-1">блокирует</Badge>
      {/if}
    </Card.Description>
  </Card.Header>

  {#if ask.context || ask.stamp}
    <Card.Content class="text-ink-2">
      {#if ask.context}
        <Collapsible.Root bind:open={context}>
          <Collapsible.Trigger>
            {#snippet child({ props })}
              <Button variant="link" size="xs" class="px-0" {...props}>
                <Icon name="chevron-right" size={13} class={context ? 'rotate-90 transition-transform' : 'transition-transform'} />
                контекст
              </Button>
            {/snippet}
          </Collapsible.Trigger>
          <Collapsible.Content class="pt-1 text-sm">{ask.context}</Collapsible.Content>
        </Collapsible.Root>
      {/if}
      {#if ask.stamp}
        <span class="mono mt-2 inline-block rounded-sm bg-muted px-2 py-0.5 text-ink-4">{ask.stamp.split(' @')[0]}</span>
      {/if}
    </Card.Content>
  {/if}

  <Card.Content>
    {#if ask.status === 'open'}
      <div class="flex flex-wrap items-center gap-2">
        {#if ask.type === 'choice' && ask.options}
          {#each ask.options as o}
            <Button variant="outline" class="flex-col items-start gap-0.5 text-left"
              disabled={busy} onclick={() => send(o.n)}>
              <span>{o.n}. {o.label}</span>
              {#if o.effect}<span class="text-micro font-normal text-ink-3">{o.effect}</span>{/if}
            </Button>
          {/each}
        {:else if ask.type === 'confirm'}
          <Button variant="outline" disabled={busy} onclick={() => send('да')}>да</Button>
          <Button variant="outline" disabled={busy} onclick={() => send('нет')}>нет</Button>
        {:else}
          <Input class="min-w-52 flex-1" placeholder="ответ…" bind:value={draft}
            onkeydown={(e) => e.key === 'Enter' && draft && send(draft)} />
          <Button disabled={busy || !draft} onclick={() => send(draft)}>отправить</Button>
        {/if}

        <!-- третичный ряд: уточнить, перейти, снять — во всю ширину карточки -->
        <div class="flex w-full items-center gap-3.5">
          <Button variant="link" size="xs" class="px-0" disabled={busy} onclick={() => (asking = !asking)}
            title="вопрос непонятен — спросить у того, кто его задал; ask останется открытым">
            {#if asking}<Icon name="arrow-left" size={13} />назад{:else}уточнить у автора{/if}
          </Button>
          {#if authorHref}
            <Button variant="link" size="xs" class="px-0" href={authorHref}
              title="открыть окно этой сессии и общаться там">
              перейти в её сессию<Icon name="external-link" size={13} />
            </Button>
          {/if}
          <Button variant="link" size="xs" class="ml-auto px-0 underline decoration-dotted hover:text-destructive"
            disabled={busy} onclick={dismiss}
            title="вопрос неактуален (сессия умерла, тема закрыта) — снять; сторож не пересоздаст его, пока сессия молчит">
            снять вопрос
          </Button>
        </div>

        {#if asking}
          <div class="flex w-full gap-2">
            <Input class="flex-1" placeholder="что уточнить у «{ask.session_title || ask.session}»…"
              bind:value={probe} onkeydown={(e) => e.key === 'Enter' && askBack()} />
            <Button size="sm" disabled={busy || !probe.trim()} onclick={askBack}>спросить</Button>
          </div>
        {/if}
        {#if probeSent}<p class="w-full text-xs text-ok">{probeSent}</p>{/if}
      </div>
    {:else}
      <!-- цепочка доставки: решено → забрала сессия → подтверждено -->
      <div class="flex flex-wrap items-center gap-2 text-xs text-ink-4">
        <span class="text-ink-2">решено «{ask.decision}» · {ask.decided_by} · {hhmm(ask.decided_ts)}</span>
        {#if String(ask.decided_by || '').includes('@morda')}
          <span class="text-ink-2" title="решение продублировано постом в шину — живой диспетчер видит его, не дожидаясь pull автора">
            <Icon name="corner-down-right" size={13} /> диспетчеру в шину
          </span>
        {/if}
        <Icon name="arrow-right" size={13} />
        <span class={ask.delivered_ts || ask.acked_ts ? 'text-ink-2' : ''}
          title="ответ забирает сама сессия-автор чтением будки (pull)">
          {ask.delivered_ts ? `сессия забрала ${hhmm(ask.delivered_ts)}`
            : ask.acked_ts ? 'доставка не фиксировалась' : `ждёт в будке для «${ask.session_title || ask.session}»`}
        </span>
        <Icon name="arrow-right" size={13} />
        <span class={ask.acked_ts ? 'text-ink-2' : ''}>
          {ask.acked_ts ? `подтверждено ${hhmm(ask.acked_ts)}` : 'не подтверждено'}
        </span>
      </div>
    {/if}

    {#if error}<p class="err mt-2.5">Ответ не доставлен: {error}</p>{/if}
  </Card.Content>
</Card.Root>
