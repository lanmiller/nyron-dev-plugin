<script>
  // Конфигуратор инструментов флота (docs/specs/2026-08-20-configurator.md):
  // вкладки Коннекторы · Скиллы · Плагины, карточка каждого элемента — три
  // факта (основной / копии / проекты по паспорту) и действия. Порядок
  // постановщика (CTO 21.08) зашит в интерфейс: сначала основной доводится
  // до канона и смоукается, и только потом открывается «раздать копиям».
  // Раздача — зеркало (slotSync): что копия потеряет, показывается ДО
  // нажатия превью-панелью.
  import { onMount } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import * as Card from '$lib/ui/card/index.js';
  import * as Tabs from '$lib/ui/tabs/index.js';

  let data = $state(null);      // матрица /api/config
  let busy = $state(false);
  let error = $state(null);
  let smoked = $state({});      // `${kind}:${id}` → { ok, fact, busy }
  let needOpen = $state(null);  // `${kind}:${id}` — открыт выбор проектов
  let preview = $state(null);   // превью раздачи: { id, label, replaced, lost, kept_mcp }
  let syncNote = $state({});    // id копии → итог раздачи

  async function refresh() {
    try {
      const r = await fetch('/api/config');
      const next = await r.json();
      if (!r.ok) { error = next.error; return; }
      error = null; data = next;
    } catch { /* сервер перезапускается */ }
  }
  onMount(refresh);

  async function act(body) {
    busy = true; error = null;
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) { error = out.error || `HTTP ${r.status}`; return null; }
      return out;
    } catch (e) { error = String(e.message || e); return null; }
    finally { busy = false; }
  }

  const key = (i) => `${i.kind}:${i.id}`;
  async function smoke(i) {
    smoked = { ...smoked, [key(i)]: { busy: true } };
    const out = await act({ action: 'smoke', kind: i.kind, name: i.id });
    smoked = { ...smoked, [key(i)]: out || { ok: false, fact: error } };
  }
  async function install(i) {
    const out = await act({ action: 'install', kind: i.kind, name: i.id });
    if (out) await refresh();
  }
  async function requireIn(i, project, required) {
    const out = await act({ action: 'require', project, kind: i.kind, name: i.id, required });
    if (out) await refresh();
  }
  async function openPreview(id) {
    preview = await act({ action: 'sync_preview', id });
  }
  async function doSync(id) {
    const out = await act({ action: 'sync', id });
    preview = null;
    if (out?.copied) {
      syncNote = { ...syncNote, [id]: `раздано: ${out.copied.join(', ')} · MCP-серверов ${out.mcpServers}` };
      await refresh();
    }
  }

  const TABS = [
    ['mcp', 'Коннекторы', 'MCP-серверы: user-scope раздаётся копиям, project-scope остаётся в проекте'],
    ['skill', 'Скиллы', 'каталоги в skills/ конфиг-каталога аккаунта'],
    ['plugin', 'Плагины', 'enabledPlugins в settings.json аккаунта'],
  ];
  const ofKind = (k) => (data?.items || []).filter((i) => i.kind === k);
  // сколько канон-пунктов у копии на месте — зелёность копии одним числом
  const copyScore = (id) => {
    const canon = (data?.items || []).filter((i) => i.canon);
    return [canon.filter((i) => i.copies[id]?.ok).length, canon.length];
  };
  const requiredIn = (i) =>
    Object.entries(i.projects).filter(([, v]) => v.required).map(([p]) => p);
</script>

<svelte:head><title>Инструменты — STOVP</title></svelte:head>

<header class="head">
  <h1>Инструменты флота</h1>
  <p class="quiet">Канон — morda/canon.json. Поток: довести основной до канона →
    смоук фактом → раздать копиям → смоук на копии. Пока основной красный,
    раздача закрыта.</p>
</header>

{#if error}<p class="err">{error}</p>{/if}

{#if data}
  <!-- светофор потока: главный факт страницы — можно ли уже раздавать -->
  <section class="flow" class:green={data.main_green}>
    <Icon name={data.main_green ? 'circle-check' : 'circle-alert'} size={16} />
    {#if data.main_green}
      <b>Основной по канону</b> — раздача копиям открыта.
    {:else}
      <b>Основной не по канону:</b> {data.main_red.join(' · ')} — раздача копиям закрыта.
    {/if}
  </section>

  <!-- копии: зеркальная раздача конфига основного (slotSync), с превью потерь -->
  <section class="copies-row">
    {#each data.copies as c (c.id)}
      {@const [have, total] = copyScore(c.id)}
      <div class="copy-chip" class:ok={have === total}>
        <Icon name="copy" size={13} />
        <b>{c.label}</b>
        <span class="quiet">{have}/{total} по канону</span>
        {#if syncNote[c.id]}<span class="ok-note">{syncNote[c.id]}</span>{/if}
        <Button variant="outline" size="xs" disabled={busy || !data.main_green}
          title={data.main_green
            ? 'зеркало конфига основного: settings, MCP, скиллы, правила, плагины; вход и история копии не трогаются'
            : 'закрыто: сначала доведи основной до канона'}
          onclick={() => openPreview(c.id)}>
          <Icon name="send" size={13} /> раздать
        </Button>
      </div>
    {/each}
    {#if !data.copies.length}
      <p class="quiet">копий подписки нет — подключаются в <a href="/settings">настройках</a></p>
    {/if}
  </section>

  {#if preview}
    <!-- зеркало показывается ДО нажатия: что заменится и что копия потеряет -->
    <section class="preview">
      <p><b>Раздать на «{preview.label}» — это зеркало, не докладка:</b></p>
      <p>заменится конфигом основного: {preview.replaced.join(', ')}.</p>
      {#if preview.lost.length}
        <p class="warn-note">копия потеряет своё: {preview.lost.join(', ')}</p>
      {:else}
        <p class="quiet">своего, чего нет у основного, в каталогах копии не найдено.</p>
      {/if}
      {#if preview.kept_mcp.length}
        <p class="quiet">свои MCP-серверы копии сохранятся (мерж): {preview.kept_mcp.join(', ')}</p>
      {/if}
      <div class="preview-actions">
        <Button size="xs" disabled={busy} onclick={() => doSync(preview.id)}>
          <Icon name="send" size={13} /> раздать (зеркало)
        </Button>
        <Button variant="ghost" size="xs" class="text-ink-4" onclick={() => (preview = null)}>отмена</Button>
      </div>
    </section>
  {/if}

  <Tabs.Root value="mcp">
    <Tabs.List>
      {#each TABS as [k, title] (k)}
        <Tabs.Trigger value={k}>{title}
          {#if ofKind(k).some((i) => i.canon && !i.main.ok)}
            <i class="dot hot"></i>
          {/if}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#each TABS as [k, title, hint] (k)}
      <Tabs.Content value={k}>
        <p class="quiet tab-hint">{hint}</p>
        <div class="grid">
          {#each ofKind(k) as i (key(i))}
            {@const sm = smoked[key(i)]}
            {@const req = requiredIn(i)}
            <Card.Root class={i.canon && !i.main.ok ? 'card-red' : ''}>
              <Card.Header>
                <Card.Title>{i.title || i.id}</Card.Title>
                {#if i.why}<Card.Description>{i.why}</Card.Description>{/if}
                <Card.Action>
                  <Badge variant="outline">{i.canon ? 'канон' : 'вне канона'}</Badge>
                </Card.Action>
              </Card.Header>
              <Card.Content class="card-facts">
                <!-- факт 1: основной -->
                <div class="fact">
                  <Icon name={i.main.ok ? 'check' : 'x'} size={14}
                    class={i.main.ok ? 'text-ok' : 'text-hot'} />
                  <span><b>основной:</b> {i.main.fact}</span>
                </div>
                <!-- факт 2: копии -->
                <div class="fact">
                  <Icon name="copy" size={13} class="text-ink-4" />
                  <span class="chips">
                    {#each data.copies as c (c.id)}
                      <i class="chip" class:on={i.copies[c.id]?.ok}
                        title={i.copies[c.id]?.fact}>{c.label}</i>
                    {:else}
                      <span class="quiet">копий нет</span>
                    {/each}
                  </span>
                </div>
                <!-- факт 3: проекты по паспорту -->
                <div class="fact">
                  <Icon name="folder-tree" size={13} class="text-ink-4" />
                  <span class="chips">
                    {#if req.length}
                      {#each req as p (p)}
                        <i class="chip on" title={i.projects[p].fact || 'в паспорте'}>{p}</i>
                      {/each}
                    {:else}
                      <span class="quiet">ни один паспорт не требует</span>
                    {/if}
                  </span>
                </div>
                {#if sm && !sm.busy}
                  <p class="smoke" class:ok={sm.ok} class:bad={sm.ok === false}>
                    смоук: {sm.fact}</p>
                {/if}
                <div class="actions">
                  <Button variant="outline" size="xs" disabled={busy || sm?.busy}
                    title="реальный вызов: MCP — запуск сервера, скилл/плагин — файлы на месте"
                    onclick={() => smoke(i)}>
                    <Icon name={sm?.busy ? 'loader-circle' : 'shield-check'} size={13} />
                    {sm?.busy ? 'проверяю…' : 'проверить фактом'}
                  </Button>
                  {#if i.canon && !i.main.ok && (i.install || i.source)}
                    <Button size="xs" disabled={busy}
                      title={i.kind === 'mcp'
                        ? 'claude mcp add-json --scope user из canon.json — встанет основному и поедет копиям при раздаче'
                        : `копия git-источника ${i.source} в skills/ основного`}
                      onclick={() => install(i)}>
                      <Icon name="plus" size={13} /> поставить основному
                    </Button>
                  {/if}
                  <Button variant="outline" size="xs" disabled={busy}
                    title="записать в .claude/passport.json проекта — верификатор начнёт проверять фактом"
                    onclick={() => (needOpen = needOpen === key(i) ? null : key(i))}>
                    <Icon name="file-badge" size={13} /> нужен проекту
                  </Button>
                </div>
                {#if needOpen === key(i)}
                  <div class="need-row">
                    {#each data.projects as p (p)}
                      {@const on = i.projects[p]?.required}
                      <button class="chip pick" class:on disabled={busy}
                        title={on ? 'убрать из паспорта' : 'записать в паспорт'}
                        onclick={() => requireIn(i, p, !on)}>{p}</button>
                    {/each}
                  </div>
                {/if}
              </Card.Content>
            </Card.Root>
          {/each}
        </div>
      </Tabs.Content>
    {/each}
  </Tabs.Root>
{:else if !error}
  <p class="quiet">собираю матрицу…</p>
{/if}

<style>
  .head { margin-bottom: var(--sp-6); }
  .head h1 { font-size: var(--fs-xl); margin: 0 0 var(--sp-2); }
  .head p { margin: 0; font-size: var(--fs-sm); }
  .flow {
    display: flex; align-items: center; gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-4);
    border: 1px solid color-mix(in oklab, var(--warn) 45%, transparent);
    border-radius: var(--r); font-size: var(--fs-sm); color: var(--warn);
  }
  .flow.green { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 45%, transparent); }
  .flow b { color: inherit; }
  .copies-row { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin-bottom: var(--sp-4); }
  .copy-chip {
    display: flex; align-items: center; gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-soft);
    border-radius: var(--r); font-size: var(--fs-sm);
  }
  .copy-chip.ok { border-color: color-mix(in oklab, var(--ok) 35%, transparent); }
  .preview {
    border: 1px solid color-mix(in oklab, var(--warn) 45%, transparent);
    border-radius: var(--r); padding: var(--sp-4); margin-bottom: var(--sp-4);
    font-size: var(--fs-sm);
  }
  .preview p { margin: 0 0 var(--sp-2); }
  .preview-actions { display: flex; gap: var(--sp-3); margin-top: var(--sp-3); }
  .warn-note { color: var(--warn); }
  .ok-note { color: var(--ok); font-size: var(--fs-xs); }
  .tab-hint { margin: var(--sp-3) 0 var(--sp-4); font-size: var(--fs-xs); }
  .grid {
    display: grid; gap: var(--sp-5);
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }
  :global(.card-red) { border-color: color-mix(in oklab, var(--hot) 40%, transparent); }
  :global(.card-facts) { display: flex; flex-direction: column; gap: var(--sp-3); }
  .fact {
    display: flex; align-items: baseline; gap: var(--sp-3);
    font-size: var(--fs-xs);
  }
  .fact > span { min-width: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .chip {
    font-style: normal; font-size: var(--fs-micro); line-height: 1;
    padding: 3px 7px; border-radius: 999px;
    border: 1px solid var(--border-soft); color: var(--text-3);
  }
  .chip.on { border-color: color-mix(in oklab, var(--ok) 45%, transparent); color: var(--ok); }
  .chip.pick { background: var(--bg-1); cursor: pointer; font: inherit; font-size: var(--fs-micro); }
  .smoke { margin: 0; font-size: var(--fs-xs); color: var(--text-3); }
  .smoke.ok { color: var(--ok); }
  .smoke.bad { color: var(--hot); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .need-row {
    display: flex; flex-wrap: wrap; gap: var(--sp-2);
    padding-top: var(--sp-3); border-top: 1px solid var(--border-soft);
  }
  .dot.hot { width: 6px; height: 6px; border-radius: 50%; background: var(--hot); display: inline-block; margin-left: 4px; }
</style>
