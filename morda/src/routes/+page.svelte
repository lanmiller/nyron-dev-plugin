<script>
  // Главная: «Ждут вас» + доставка ответов + шина активного проекта.
  // Сессии и состояния сторожа — в сайдбаре (клик по строке = окно сессии).
  import { getContext } from 'svelte';
  import AskCard from '$lib/AskCard.svelte';
  import FileBrowser from '$lib/FileBrowser.svelte';
  import Icon from '$lib/Icon.svelte';
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
  async function launch() {
    const target = project?.name;
    if (!goal.trim() || !target) return;
    launching = true; launchError = null;
    const name = 's-' + Date.now().toString(36).slice(-6);
    try {
      const r = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({
          action: 'start', project: target, name, goal: goal.trim(),
          model: launchModel, effort: launchEffort,
          mode: launchMode || undefined,
          slot: launchSlot || undefined,
        }),
      });
      const out = await r.json();
      if (!r.ok) { launchError = out.error || `HTTP ${r.status}`; return; }
      goal = '';
      launchNote = 'сессия стартует — жду привязки транскрипта…';
      // привязка занимает секунды: стартовые экраны CLI + первый ответ
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const l = await (await fetch(`/api/runner?project=${encodeURIComponent(target)}`)).json();
        const e = l.sessions?.find((x) => x.name === name);
        if (e?.sessionId) return goto(`/s/${encodeURIComponent(target)}/${e.sessionId}`);
        if (e?.state === 'needs_auth') {
          launchError = 'CLI не авторизован — подключи слот в настройках'; return;
        }
        if (e?.state === 'died_on_start') { launchError = 'сессия умерла на старте — tmux attach -t ' + (e.tmux || ''); return; }
      }
      launchNote = 'старт затянулся — смотри статус в настройках (раннер)';
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
      <textarea rows="2" bind:value={goal} disabled={launching}
        placeholder="Опиши задачу — запустится новая сессия в «{project.name}»…"
        onkeydown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault(); launch();
        }}></textarea>
      <div class="launch-bar">
        <label class="chip" title="режим разрешений сессии">
          <Icon name={launchMode === 'auto' ? 'zap' : launchMode === 'acceptEdits' ? 'file-pen' : launchMode === 'plan' ? 'notebook-pen' : 'hand'} size={13} />
          <select bind:value={launchMode} disabled={launching}>
            <option value="auto">Auto</option>
            <option value="acceptEdits">Accept edits</option>
            <option value="plan">Plan</option>
            <option value="">Manual</option>
            <option value="bypass">Bypass (за забором)</option>
          </select>
        </label>
        <label class="chip" title="модель сессии">
          <select bind:value={launchModel} disabled={launching}>
            <option value="fable">Fable 5</option>
            <option value="opus">Opus 5</option>
            <option value="sonnet">Sonnet 5</option>
            <option value="haiku">Haiku 4.5</option>
          </select>
        </label>
        <label class="chip" title="усилие рассуждения (effort)">
          <Icon name="gauge" size={13} />
          <select bind:value={launchEffort} disabled={launching}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra</option>
            <option value="max">Max</option>
          </select>
        </label>
        {#if claudeSlots.length > 1}
          <label class="chip" title="подписка, на которой поедет сессия">
            <Icon name="key-round" size={13} />
            <select bind:value={launchSlot} disabled={launching}>
              {#each claudeSlots as sl (sl.id)}
                <option value={sl.id}>{sl.label}</option>
              {/each}
            </select>
          </label>
        {/if}
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

  /* Композер запуска: рамка системы, внутри колонкой — поле и ряд
     параметров (режим, модель, effort, подписка) со стрелкой отправки. */
  .launchpad { margin-top: var(--sp-6); }
  .launch-box { flex-direction: column; align-items: stretch; }
  .launch-bar {
    display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
    padding-top: var(--sp-2);
  }
  .launch-bar .grow { flex: 1; }
  /* чип параметра — пилюля, как в композере Claude («Opus 5», «⚡ Auto») */
  .launch-bar .chip {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    background: var(--bg-2); color: var(--text-2);
    border: 1px solid var(--border-soft); border-radius: 999px;
    padding: var(--sp-2) var(--sp-4); cursor: pointer;
    transition: color var(--t-fast), border-color var(--t-fast);
  }
  .launch-bar .chip:hover { color: var(--text-1); border-color: var(--border); }
  .launch-bar .chip:focus-within { border-color: var(--accent); color: var(--text-1); }
  .launch-bar .chip select {
    appearance: none; background: none; border: 0; padding: 0;
    color: inherit; font: inherit; font-size: var(--fs-xs); cursor: pointer;
    outline: none;
    /* ширина по выбранному значению, а не по самой длинной опции списка
       («Bypass (за забором)» раздувал чип Auto на мобилке) */
    field-sizing: content;
  }
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
