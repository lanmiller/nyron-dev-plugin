<script>
  // Главная: «Ждут вас» + доставка ответов + шина активного проекта.
  // Сессии и состояния сторожа — в сайдбаре (клик по строке = окно сессии).
  import { getContext } from 'svelte';
  import AskCard from '$lib/AskCard.svelte';
  import FileBrowser from '$lib/FileBrowser.svelte';
  import Icon from '$lib/Icon.svelte';
  import PickChip from '$lib/PickChip.svelte';
  import { MODEL_OPTS, EFFORT_OPTS, MODE_OPTS, MCP_OPTS } from '$lib/composer-options.js';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import * as Card from '$lib/ui/card/index.js';
  import { age } from '$lib/states.js';

  const st = getContext('morda');
  const active = getContext('morda-project');

  let project = $derived(st.overview?.projects?.find((p) => p.name === active.name));
  let showFiles = $state(false);
  let openAsks = $derived((project?.asks || []).filter((a) => a.status === 'open'));
  let pendingAsks = $derived((project?.asks || []).filter((a) => a.status !== 'open'));

  // Этап 2 STOVP-58: сессия рождается из композера — «сделаем фичу X» /
  // «закрой эпик DEV-NNN». Референс — композер Claude Desktop (CTO 17.08):
  // отправка стрелкой, снизу режим / модель / effort / подписка. Проект —
  // НЕ здесь: его выбирает шапка страницы, композер наследует.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  let goal = $state('');
  let launching = $state(false);
  let launchNote = $state(null);
  let launchError = $state(null);
  // дефолты запуска — канон CTO: основной слот + Fable 5, Auto, high
  let launchMode = $state('auto');
  let launchMcp = $state('');   // '' = все серверы; strict = профиль под задачу
  let launchModel = $state('fable');
  let launchEffort = $state('high');
  let launchSlot = $state('claude-main');
  let claudeSlots = $state([]);
  onMount(async () => {
    try {
      const r = await (await fetch('/api/runner')).json();
      claudeSlots = (r.slots || []).filter((s) => s.provider === 'claude');
      if (!claudeSlots.some((s) => s.id === launchSlot) && claudeSlots[0])
        launchSlot = claudeSlots[0].id;
    } catch {}
  });
  // вложения: файл уезжает в проект, сессии — путь (CLI прочитает Read-ом,
  // картинки тоже — факт этапа 0)
  let attachments = $state([]); // { path, name }
  let fileEl = $state(null);
  let uploading = $state(false);
  async function addFiles(files) {
    uploading = true; launchError = null;
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append('project', project.name);
        fd.append('file', f);
        const r = await fetch('/api/upload', {
          method: 'POST', headers: { 'x-morda': '1' }, body: fd,
        });
        const out = await r.json();
        if (!r.ok) { launchError = out.error || `HTTP ${r.status}`; continue; }
        attachments = [...attachments, out];
      }
    } finally { uploading = false; if (fileEl) fileEl.value = ''; }
  }

  async function launch() {
    const target = project?.name;
    if (!goal.trim() || !target) return;
    launching = true; launchError = null;
    const name = 's-' + Date.now().toString(36).slice(-6);
    const text = goal.trim() + (attachments.length
      ? '\n\nПриложенные файлы (смотри их содержимое при необходимости):\n'
        + attachments.map((a) => `- ${a.path}`).join('\n')
      : '');
    try {
      const r = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({
          action: 'start', project: target, name, goal: text,
          model: launchModel, effort: launchEffort,
          mode: launchMode || undefined,
          mcp: launchMcp || undefined,
          slot: launchSlot || undefined,
        }),
      });
      const out = await r.json();
      if (!r.ok) { launchError = out.error || `HTTP ${r.status}`; return; }
      goal = '';
      attachments = [];
      // окно открываем СРАЗУ, не дожидаясь привязки транскрипта: ждать
      // молча на главной было непонятно (CTO 19.08). Ключ — имя записи
      // раннера с префиксом «n-»; окно само подменит его на sessionId.
      return goto(`/s/${encodeURIComponent(target)}/n-${name}`);
    } finally { launching = false; }
  }
</script>

{#if project}
  {#if project.error}<p class="err">{project.name}: {project.error}</p>{/if}

  <!-- проект выбирается ЗДЕСЬ и двигает весь экран: файлы, шину, композер
       (CTO 17.08: «выбор проекта — там, где файлы смотрятся») -->
  <div class="flex items-center gap-2.5">
    <label class="proj-pick" title="проект: файлы, шина и новые сессии — его">
      <select value={project.name} disabled={launching}
        onchange={(e) => goto(`/?p=${encodeURIComponent(e.currentTarget.value)}`)}>
        {#each st.overview?.projects || [] as p (p.name)}
          <option value={p.name}>{p.name}</option>
        {/each}
      </select>
      <Icon name="chevron-down" size={16} class="text-ink-4" />
    </label>
    <Button variant="outline" size="sm" onclick={() => (showFiles = !showFiles)}>
      <Icon name={showFiles ? 'x' : 'folder-tree'} size={14} />
      {showFiles ? 'файлы' : 'файлы проекта'}
    </Button>
  </div>

  {#if showFiles}
    <section class="mt-3.5">
      <FileBrowser project={project.name} tracker={project.tracker}
        onClose={() => (showFiles = false)} />
    </section>
  {/if}

  <!-- Рождение сессии (этап 2 STOVP-58): текст + стрелка = новая CLI-сессия
       со всеми скиллами и хуками. Низ — параметры запуска, как в Claude. -->
  <section class="launchpad">
    <div class="composer-box launch-box">
      <!-- над полем: с какого аккаунта поедет сессия + чипы вложений -->
      <div class="launch-top">
        {#if claudeSlots.length}
          <PickChip bind:value={launchSlot} disabled={launching} icon="key-round"
            title="Аккаунт, с которого поедет сессия"
            options={claudeSlots.map((sl) => ({
              value: sl.id, label: sl.label,
              desc: sl.hint || sl.kind || null,
            }))} />
        {/if}
        {#each attachments as a (a.path)}
          <span class="att" title={a.path}>
            <Icon name="paperclip" size={12} />
            <span class="att-name">{a.name}</span>
            <button class="att-x" aria-label="убрать файл"
              onclick={() => (attachments = attachments.filter((x) => x.path !== a.path))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        {/each}
      </div>
      <textarea rows="2" bind:value={goal} disabled={launching}
        placeholder="Опиши задачу — запустится новая сессия в «{project.name}»…"
        onkeydown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault(); launch();
        }}></textarea>
      <input type="file" multiple hidden bind:this={fileEl}
        onchange={(e) => addFiles([...e.currentTarget.files])} />
      <div class="launch-bar">
        <button class="plus" disabled={uploading || launching}
          aria-label="приложить файл или фото" title="приложить файл или фото"
          onclick={() => fileEl?.click()}>
          <Icon name={uploading ? 'loader-circle' : 'plus'} size={16} />
        </button>
        <PickChip bind:value={launchModel} bind:subValue={launchEffort}
          disabled={launching} title="Модель сессии" options={MODEL_OPTS}
          subLabel="Effort" subIcon="gauge" subTitle="Усилие рассуждения"
          subOptions={EFFORT_OPTS} />
        <PickChip bind:value={launchMode} disabled={launching}
          title="Как сессия спрашивает разрешения" options={MODE_OPTS} />
        <PickChip bind:value={launchMcp} disabled={launching}
          title="MCP-набор сессии: все серверы машины или строгий профиль под задачу"
          options={MCP_OPTS} />
        <span class="grow"></span>
        <button class="send" disabled={launching || !goal.trim()} onclick={launch}
          aria-label="запустить новую сессию (Enter)"
          title="Enter — запустить новую сессию">
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
    {#if launchError}<p class="err">{launchError}</p>{/if}
    {#if launchNote && !launchError}<p class="quiet launch-note">{launchNote}</p>{/if}
  </section>

  <section>
    <h2 class="eyebrow sect">Ждут вас {#if openAsks.length}<Badge>{openAsks.length}</Badge>{/if}</h2>
    {#if !openAsks.length}
      <p class="quiet">Открытых решений нет.</p>
    {/if}
    {#each openAsks as a (a.id)}
      <AskCard ask={a} project={project.name} />
    {/each}
  </section>

  <!-- Ответы человеку: сессия отвечает постом (на встречный вопрос по ask),
       и без этой ленты ответ терялся в будке (найдено CTO 11.08) -->
  {#if project.inbox?.length}
    <section>
      <h2 class="eyebrow sect">Ответы вам <Badge>{project.inbox.length}</Badge></h2>
      <div class="flex flex-col gap-2">
        {#each project.inbox as m (m.id)}
          <!-- зелёная рамка = ответ дошёл; тот же цвет, что у доставленного ask -->
          <Card.Root size="sm" class="border-ok/45">
            <Card.Header>
              <Card.Description>
                {age(m.ts)} ·
                {#if m.from_key}
                  <a class="text-ink-2 no-underline hover:text-primary"
                     href="/s/{encodeURIComponent(project.name)}/{m.from_key}"
                     title="открыть её сессию">{m.from_title || m.from}<Icon name="external-link" size={12} class="ml-0.5" /></a>
                {:else}<b class="text-ink-2">{m.from}</b>{/if}
                {m.ticket ? ` · ${m.ticket}` : ''}
              </Card.Description>
            </Card.Header>
            <Card.Content class="whitespace-pre-wrap text-sm">{m.text}</Card.Content>
          </Card.Root>
        {/each}
      </div>
    </section>
  {/if}

  {#if pendingAsks.length}
    <section>
      <h2 class="eyebrow sect">Доставка ответов</h2>
      {#each pendingAsks as a (a.id)}
        <AskCard ask={a} project={project.name} />
      {/each}
    </section>
  {/if}

  <section>
    <h2 class="eyebrow sect">Шина</h2>
    <ul class="feed">
      {#each [...(project.recent || [])].reverse() as m (m.id)}
        <li>
          <span class="meta">{age(m.ts)} · <b>{m.from}</b>{m.to && m.to !== 'all' ? ` → ${m.to}` : ''}{m.ticket ? ` · ${m.ticket}` : ''}</span>
          <p>{m.text}</p>
        </li>
      {/each}
    </ul>
  </section>
{:else}
  <p class="quiet">Загрузка…</p>
{/if}

<style>
  /* надзаголовок секции: класс .eyebrow даёт вид, здесь — только ритм */
  .sect { margin: var(--sp-8) 0 var(--sp-5); display: flex; align-items: center; gap: var(--sp-4); }
  /* Заголовок-переключатель проекта: тот же вес, что h1, стрелка рядом —
     видно, что кликается. Кирпич .composer-box — из системы. */
  .proj-pick {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    cursor: pointer; min-width: 0;
  }
  .proj-pick select {
    appearance: none; background: none; border: 0; padding: 0;
    color: var(--text-1); font-family: var(--serif);
    font-size: var(--fs-xl); font-weight: 500; cursor: pointer;
    max-width: 60vw; text-overflow: ellipsis;
  }
  .proj-pick select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--r-sm); }

  /* Композер запуска: кирпичи системы .composer-box/.launch-* (app.css,
     витрина /design) — здесь только локальный ритм страницы. */
  .launchpad { margin-top: var(--sp-6); }
  .launch-note { font-size: var(--fs-xs); margin-top: var(--sp-2); }
  /* Шина — плотный список: карточка на реплику превратила бы её в стену
     плашек, а это фон работы, а не решения. */
  .feed { list-style: none; padding: 0; margin: 0; }
  .feed li { padding: var(--sp-3) 0; border-bottom: 1px solid var(--border-soft); }
  .feed .meta { color: var(--text-3); font-size: var(--fs-xs); }
  .feed p {
    margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-2);
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
</style>
