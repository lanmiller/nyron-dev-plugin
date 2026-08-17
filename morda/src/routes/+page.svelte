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

  // Этап 2 STOVP-58: сессия рождается из поля ввода — «сделаем фичу X» /
  // «закрой эпик DEV-NNN». Пульт запускает CLI-сессию раннером, цель уходит
  // первым вводом; как раннер привяжет sessionId — открываем её окно.
  import { goto } from '$app/navigation';
  let goal = $state('');
  let launching = $state(false);
  let launchNote = $state(null);
  let launchError = $state(null);
  // куда рожать сессию — выбор человека, не догадка по сайдбару
  // (CTO 17.08: «нет выбора, в какой папке запустить»); дефолт — активный
  let launchProject = $state('');
  $effect(() => { if (!launchProject && project) launchProject = project.name; });
  async function launch() {
    const target = launchProject || project?.name;
    if (!goal.trim() || !target) return;
    launching = true; launchError = null;
    const name = 's-' + Date.now().toString(36).slice(-6);
    try {
      const r = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ action: 'start', project: target, name, goal: goal.trim() }),
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

  <div class="flex items-center gap-2.5">
    <h1 class="flex-none">{project.name}</h1>
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

  <!-- Рождение сессии из пульта (этап 2 STOVP-58): цель — вводом, дальше
       обычная CLI-сессия со всеми скиллами и хуками плагина -->
  <section class="launcher">
    <textarea rows="2" bind:value={goal} disabled={launching}
      placeholder="Новая сессия: «сделаем фичу X» / «закрой эпик DEV-NNN»…"
      onkeydown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault(); launch();
      }}></textarea>
    <select class="launch-proj" bind:value={launchProject} disabled={launching}
      title="в какой папке родится сессия (список проектов — настройки)">
      {#each st.overview?.projects || [] as p (p.name)}
        <option value={p.name}>{p.name}</option>
      {/each}
    </select>
    <Button disabled={launching || !goal.trim()} onclick={launch}>
      <Icon name="play" size={14} /> запустить
    </Button>
  </section>
  {#if launchError}<p class="err">{launchError}</p>{/if}
  {#if launchNote && !launchError}<p class="quiet launch-note">{launchNote}</p>{/if}

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
  /* композер рождения сессии: тот же вид, что композер окна сессии
     (.composer-box app.css задаёт textarea), кнопка — рядом */
  .launcher {
    display: flex; gap: var(--sp-3); align-items: flex-end;
    margin-top: var(--sp-6);
  }
  .launcher textarea {
    flex: 1; resize: none; min-height: 44px;
    background: var(--bg-2); color: var(--text-1);
    border: 1px solid var(--border); border-radius: var(--r);
    padding: var(--sp-3) var(--sp-4); font: inherit; font-size: var(--fs-sm);
  }
  .launcher textarea:focus { outline: none; border-color: var(--accent); }
  .launch-proj {
    flex: none; height: 44px;
    background: var(--bg-2); color: var(--text-2);
    border: 1px solid var(--border); border-radius: var(--r);
    padding: 0 var(--sp-3); font: inherit; font-size: var(--fs-sm);
  }
  .launch-proj:focus { outline: none; border-color: var(--accent); }
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
