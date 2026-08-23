<script>
  // Главная: «Ждут вас» + доставка ответов + шина активного проекта.
  // Сессии и состояния сторожа — в сайдбаре (клик по строке = окно сессии).
  import { getContext } from 'svelte';
  import AskCard from '$lib/AskCard.svelte';
  import FileBrowser from '$lib/FileBrowser.svelte';
  import Icon from '$lib/Icon.svelte';
  import PickChip from '$lib/PickChip.svelte';
  import { MODEL_OPTS, EFFORT_OPTS, MODE_OPTS, MCP_OPTS, SLOT_AUTO,
    LAUNCH_PRESETS, presetOf } from '$lib/composer-options.js';
  import { groupSessions } from '$lib/session-tree.js';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import { Input } from '$lib/ui/input/index.js';
  import * as Card from '$lib/ui/card/index.js';
  import * as Collapsible from '$lib/ui/collapsible/index.js';
  import { PresetSwitch } from '$lib/ui/preset-switch/index.js';
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
  // Дефолты запуска — пресет «Задача» (STOVP-69): auto + строгий MCP +
  // автослот, модель/effort остаются каноном CTO (Fable 5, high). Слот по
  // умолчанию больше не «основной»: выбор подписки — работа пульта
  // (runner.js: slotPick), а не человека.
  let launchMode = $state('auto');
  let launchMcp = $state('strict'); // '' = все серверы; strict = профиль под задачу
  let launchModel = $state('fable');
  let launchEffort = $state('high');
  let launchSlot = $state('auto');
  let launchTicket = $state('');    // ключ тикета, если его нет в тексте цели
  let claudeSlots = $state([]);
  let tuneOpen = $state(false);     // шторка «тонкая настройка»
  // Пресет — не отдельная память, а ВЫВОД из чипов: покрутил чип руками —
  // переключатель гаснет («своя настройка»), значения чипов остаются.
  let preset = $derived(presetOf({ mode: launchMode, mcp: launchMcp, slot: launchSlot }));
  let presetDef = $derived(LAUNCH_PRESETS.find((p) => p.value === preset) || null);
  function applyPreset(v) {
    const p = LAUNCH_PRESETS.find((x) => x.value === v);
    if (!p) return;
    launchMode = p.set.mode; launchMcp = p.set.mcp; launchSlot = p.set.slot;
  }
  // варианты слота: «авто» первым, дальше живые подписки машины
  let slotOpts = $derived([SLOT_AUTO, ...claudeSlots.map((sl) => ({
    value: sl.id, label: sl.label, desc: sl.hint || sl.kind || null,
  }))]);
  // Сводка флота на главной: пока её не было, «кто ждёт меня» и «кто работает»
  // я собирал руками через терминал (CTO 21.08 — голова должна видеть флот
  // одним экраном). Отдельного списка не заводим: место для ожидающих уже
  // есть — секция «Ждут вас», туда же идут и сессии.
  let fleet = $state([]);
  async function pullFleet() {
    try {
      // флот — ТОЛЬКО выбранного проекта: без фильтра на странице stovp
      // висели волны nyron, и «почему их нет в сайдбаре» (CTO 23.08)
      if (!project?.name) return;
      const r = await (await fetch(`/api/runner?project=${encodeURIComponent(project.name)}`)).json();
      claudeSlots = (r.slots || []).filter((s) => s.provider === 'claude');
      // «авто» — не слот машины, а решение пульта: список его не отменяет
      if (launchSlot !== 'auto' && !claudeSlots.some((s) => s.id === launchSlot))
        launchSlot = 'auto';
      fleet = (r.sessions || []).filter((x) => x.alive);
    } catch {}
  }
  onMount(() => {
    pullFleet();
    const t = setInterval(pullFleet, 5000);
    return () => clearInterval(t);
  });
  // ждут человека: форма или запрос разрешения на экране CLI
  let needsMe = $derived(fleet.filter((s) =>
    ['hitl', 'permission', 'needs_auth'].includes(s.screen)));
  // застрявшие — впереди работающих: спиннер у них бодрый, а лента молчит
  let stuck = $derived(fleet.filter((s) => s.stuck && !needsMe.includes(s)));
  let working = $derived(fleet.filter((s) => s.busy && !s.stuck && !needsMe.includes(s)));
  const mins = (ms) => Math.round((ms || 0) / 60000);
  let idle = $derived(fleet.filter((s) => !s.busy && !needsMe.includes(s)));
  // Флот раскладывается тем же деревом, что сайдбар (STOVP-69): эпик →
  // тикет → сессии, а внутри группы прежний порядок «застряла → работает →
  // не занята». Раскладку считает $lib/session-tree.js — второго парсера
  // иерархии в пульте нет.
  const KIND = { stuck: 'stuck', working: 'working', idle: 'idle' };
  let fleetGroups = $derived(groupSessions([
    ...stuck.map((s) => ({ ...s, kind: KIND.stuck })),
    ...working.map((s) => ({ ...s, kind: KIND.working })),
    ...idle.map((s) => ({ ...s, kind: KIND.idle })),
  ]));
  const NEED_RU = { hitl: 'ждёт ответа на форму', permission: 'просит разрешения',
    needs_auth: 'нужен вход' };
  const href = (s) => `/s/${encodeURIComponent(s.project)}/${s.sessionId || 'n-' + s.name}`;
  // вердикт судьи по застрявшей: пульт собирает улики кодом, модель судит
  let judging = $state({});
  let verdicts = $state({});
  async function judge(s) {
    judging = { ...judging, [s.name]: true };
    try {
      const r = await fetch('/api/runner', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ action: 'judge', name: s.name, project: s.project, sessionId: s.sessionId }) });
      const out = await r.json();
      verdicts = { ...verdicts, [s.name]: out.verdict || out.error || 'судья промолчал' };
    } catch (e) { verdicts = { ...verdicts, [s.name]: String(e.message || e) }; }
    judging = { ...judging, [s.name]: false };
  }
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
          // поле формы сильнее ключа из текста цели (runner.js: ticketOf)
          ticket: launchTicket.trim() || undefined,
        }),
      });
      const out = await r.json();
      if (!r.ok) { launchError = out.error || `HTTP ${r.status}`; return; }
      goal = '';
      launchTicket = '';
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
      <!-- над полем: пресет запуска (три случая вместо шести чипов) и
           чипы вложений -->
      <div class="launch-top">
        <PresetSwitch value={preset} options={LAUNCH_PRESETS} disabled={launching}
          label="Пресет запуска" onchange={applyPreset} />
      </div>
      {#if attachments.length}
        <div class="launch-top">
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
      {/if}
      <textarea rows="2" bind:value={goal} disabled={launching}
        placeholder="{presetDef?.placeholder || 'Опиши задачу — запустится новая сессия'} в «{project.name}»…"
        onkeydown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault(); launch();
        }}></textarea>
      <input type="file" multiple hidden bind:this={fileEl}
        onchange={(e) => addFiles([...e.currentTarget.files])} />
      <!-- прежние чипы ушли под шторку: в один клик запускается пресет,
           а крутить модель/режим/MCP/слот приходится редко (STOVP-69) -->
      <Collapsible.Root bind:open={tuneOpen}>
        <div class="launch-bar">
          <button class="plus" disabled={uploading || launching}
            aria-label="приложить файл или фото" title="приложить файл или фото"
            onclick={() => fileEl?.click()}>
            <Icon name={uploading ? 'loader-circle' : 'plus'} size={16} />
          </button>
          <Collapsible.Trigger>
            {#snippet child({ props })}
              <Button variant="ghost" size="xs" {...props}
                title="модель, effort, режим, MCP, слот, ключ тикета">
                <Icon name="sliders-horizontal" size={13} />
                тонкая настройка
                <Icon name="chevron-right" size={12} class="caret {tuneOpen ? 'open' : ''}" />
              </Button>
            {/snippet}
          </Collapsible.Trigger>
          <span class="grow"></span>
          <button class="send" disabled={launching || !goal.trim()} onclick={launch}
            aria-label="запустить новую сессию (Enter)"
            title="Enter — запустить новую сессию">
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
        <Collapsible.Content class="tune">
          <PickChip bind:value={launchModel} bind:subValue={launchEffort}
            disabled={launching} title="Модель сессии" options={MODEL_OPTS}
            subLabel="Effort" subIcon="gauge" subTitle="Усилие рассуждения"
            subOptions={EFFORT_OPTS} />
          <PickChip bind:value={launchMode} disabled={launching}
            title="Как сессия спрашивает разрешения" options={MODE_OPTS} />
          <PickChip bind:value={launchMcp} disabled={launching}
            title="MCP-набор сессии: все серверы машины или строгий профиль под задачу"
            options={MCP_OPTS} />
          <PickChip bind:value={launchSlot} disabled={launching} icon="key-round"
            title="Аккаунт, с которого поедет сессия" options={slotOpts} />
          <label class="tune-ticket">
            <span class="quiet">тикет</span>
            <Input bind:value={launchTicket} disabled={launching}
              placeholder="STOVP-65 — если не хочешь писать ключ в цели" />
          </label>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
    <!-- подсказка пресета: что вообще писать в поле (волна ≠ диспетчер) -->
    {#if presetDef?.hint}<p class="quiet launch-note">{presetDef.hint}</p>{/if}
    {#if !preset}
      <p class="quiet launch-note">своя настройка — пресет не выбран, чипы держат ваши значения</p>
    {/if}
    {#if launchError}<p class="err">{launchError}</p>{/if}
    {#if launchNote && !launchError}<p class="quiet launch-note">{launchNote}</p>{/if}
  </section>

  <section>
    <h2 class="eyebrow sect">Ждут вас {#if openAsks.length}<Badge>{openAsks.length}</Badge>{/if}</h2>
    {#if !openAsks.length && !needsMe.length}
      <p class="quiet">Открытых решений нет.</p>
    {/if}
    {#each needsMe as s (s.name)}
      <a class="fleet-row need" href={href(s)}>
        <Icon name="hand" size={14} class="text-warn flex-none" />
        <b>{s.name}</b><span class="quiet">{s.project}</span>
        <span class="fleet-what">{NEED_RU[s.screen] || 'ждёт вас'}</span>
        <Icon name="chevron-right" size={15} class="text-ink-4 flex-none" />
      </a>
    {/each}
    {#each openAsks as a (a.id)}
      <AskCard ask={a} project={project.name} />
    {/each}
  </section>

  {#snippet fleetRow(s)}
    {#if s.kind === 'stuck'}
      <div class="fleet-row need fleet-stuck">
        <a class="fleet-core" href={href(s)}>
          <Icon name="alert-triangle" size={14} class="text-hot flex-none" />
          <b>{s.name}</b><span class="quiet">{s.project}</span>
          <span class="fleet-what">
            похоже, встала: счётчик идёт, а лента молчит {mins(s.quiet_ms)} мин
          </span>
        </a>
        <!-- судья — прямой HTTP к внешней модели, НЕ Claude CLI: судья не
             живёт в том же стеке, что подсудимые (вердикт CTO 22.08) -->
        <Button variant="outline" size="xs" disabled={judging[s.name]}
          onclick={() => judge(s)}>
          {judging[s.name] ? 'сужу…' : 'разобраться'}
        </Button>
        {#if verdicts[s.name]}
          <p class="verdict">{verdicts[s.name]}</p>
        {:else if s.judge?.verdict}
          <!-- автосудья (10-минутный цикл сервера) уже отсудил без кнопки -->
          <p class="verdict">автосудья {mins(Date.now() - new Date(s.judge.at).getTime())} мин назад · {s.judge.verdict}</p>
        {/if}
      </div>
    {:else if s.kind === 'working'}
      <a class="fleet-row" href={href(s)}>
        <Icon name="sparkles" size={14} class="text-primary flex-none" />
        <b>{s.name}</b><span class="quiet">{s.project}</span>
        <span class="fleet-what">
          {s.pulse?.what || 'работает'}{s.pulse?.elapsed ? ` · ${s.pulse.elapsed}` : ''}{s.pulse?.tokens ? ` · ↓${s.pulse.tokens}` : ''}
        </span>
        {#if s.queue?.length}<Badge variant="outline">в очереди {s.queue.length}</Badge>{/if}
        <Icon name="chevron-right" size={15} class="text-ink-4 flex-none" />
      </a>
    {:else}
      <a class="fleet-row quiet-row" href={href(s)}>
        <Icon name="circle-pause" size={14} class="text-ink-4 flex-none" />
        <b>{s.name}</b><span class="quiet">{s.project}</span>
        <span class="fleet-what">не занята — доложила или ждёт задачи</span>
        <Icon name="chevron-right" size={15} class="text-ink-4 flex-none" />
      </a>
    {/if}
  {/snippet}

  {#if working.length || idle.length || stuck.length}
    <section>
      <h2 class="eyebrow sect">Флот <Badge>{working.length + idle.length + stuck.length}</Badge></h2>
      <!-- те же группы, что в сайдбаре: эпик → тикет → сессии; внутри
           группы порядок прежний (застряла → работает → не занята) -->
      {#each fleetGroups as g (g.epic || 'вне')}
        <div class="fgroup">
          <h3 class="fgroup-head">
            <Icon name="layers" size={12} class="text-ink-4 flex-none" />
            <span class="fkey">{g.epic || 'вне эпиков'}</span>
            {#if g.epic_title}<span class="ftitle">{g.epic_title}</span>{/if}
            <span class="fnum">{g.all.length}</span>
          </h3>
          {#each g.tickets as t (t.ticket)}
            <div class="ftick">
              <div class="ftick-head">
                <Icon name="ticket" size={12} class="text-ink-4 flex-none" />
                <span class="fkey">{t.ticket}</span>
                {#if t.ticket_title}<span class="ftitle">{t.ticket_title}</span>{/if}
              </div>
              {#each t.sessions as s (s.name)}{@render fleetRow(s)}{/each}
            </div>
          {/each}
          {#each g.loose as s (s.name)}{@render fleetRow(s)}{/each}
        </div>
      {/each}
    </section>
  {/if}

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
  /* строка флота: одна сессия — одна строка, палец попадает (44px) */
  .fleet-row {
    display: flex; align-items: center; gap: var(--sp-3);
    min-height: 44px; padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-soft); border-radius: var(--r);
    margin-bottom: var(--sp-2); color: var(--text-2);
    text-decoration: none; font-size: var(--fs-sm); min-width: 0;
  }
  .fleet-row:hover { border-color: var(--accent, var(--primary)); }
  .fleet-row.need { border-color: color-mix(in oklab, var(--warn) 55%, transparent); }
  .fleet-row.quiet-row { opacity: .72; }
  .fleet-stuck { flex-wrap: wrap; }
  .fleet-core { display: flex; align-items: center; gap: var(--sp-3); flex: 1; min-width: 0; color: inherit; text-decoration: none; }
  .verdict { flex-basis: 100%; margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-2); white-space: pre-line; }
  .fleet-what {
    flex: 1; min-width: 0; color: var(--text-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* группа флота: заголовок эпика, под ним тикеты со своими строками.
     Уровни — отступом на ступень шкалы, а не «на глаз». */
  .fgroup { margin-bottom: var(--sp-5); }
  .fgroup-head, .ftick-head {
    display: flex; align-items: center; gap: var(--sp-2);
    margin: 0 0 var(--sp-2); font-weight: 500; min-width: 0;
  }
  .fgroup-head { color: var(--text-3); font-size: var(--fs-xs); }
  .ftick-head { color: var(--text-3); font-size: var(--fs-micro); }
  .fgroup .fkey { flex: none; font-variant-numeric: tabular-nums; }
  .fgroup .ftitle {
    color: var(--text-4); min-width: 0; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fgroup .fnum { color: var(--text-4); flex: none; }
  .ftick { padding-left: var(--sp-5); }

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
  /* шторка «тонкая настройка»: те же чипы, что стояли в ряду, плюс поле
     тикета — переносятся, на 375 не выезжают за край */
  :global(.tune) {
    display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
    padding-top: var(--sp-3); margin-top: var(--sp-3);
    border-top: 1px solid var(--border-soft);
  }
  .tune-ticket {
    display: flex; align-items: center; gap: var(--sp-3);
    flex: 1 1 220px; min-width: 0;
  }
  .tune-ticket .quiet { font-size: var(--fs-xs); flex: none; }
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
