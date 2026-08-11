<script>
  // Макет рабочего места STOVP на выдуманных данных: слева дерево работы
  // (разведка → эпик → диспетчер → волны), справа поверхности сессии
  // (задачи с субагентами и стадиями воркфлоу, файлы, коммит-бар).
  // Смысл макета — договориться глазами ДО подключения к живым данным.
  let tab = $state('tasks');
  const VIEWPORTS = [['Свободно', null], ['Телефон', '375 × 812'],
    ['Планшет', '768 × 1024'], ['Десктоп', '1280 × 800']];
  let vp = $state('Свободно');

  // Панели тянутся за разделитель, чат остаётся центром — как в Claude
  // Desktop (CTO 11.08). Ширину помним между заходами.
  let sideW = $state(340);
  let dragging = $state(false);
  function startDrag(e) {
    dragging = true;
    const startX = e.clientX, startW = sideW;
    const move = (ev) => {
      sideW = Math.min(720, Math.max(260, startW + (startX - ev.clientX)));
    };
    const up = () => {
      dragging = false;
      try { localStorage.setItem('stovp.sideW', String(sideW)); } catch {}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  $effect(() => {
    try { const v = +localStorage.getItem('stovp.sideW'); if (v) sideW = v; } catch {}
  });

  const TREE = [
    { kind: 'scout', name: 'Разведка', items: [
      { t: 'Ресёрч: ручки Claude CLI и SDK', st: 'done', age: '1 ч' },
      { t: 'Гипотеза: волны с телефона', st: 'working', age: '20 мин' },
    ] },
    { kind: 'epic', key: 'DEV-1210', name: 'Плейбуки: сборка и превью', st: 'В работе',
      waves: 7, waiting: 2, disp: [
        { t: 'Диспетчер Блок 1', st: 'working', age: '3 мин', waves: [
          { t: 'Волна Ф1: флаг v2 + тонкая карточка', st: 'working', age: '4 мин' },
          { t: 'Волна Ф2: build-job + provenance', st: 'waiting_decision', age: '3 мин', asks: 1 },
          { t: 'Волна Ф3: CRDT fail-closed', st: 'waiting_decision', age: '1 мин', asks: 1 },
        ] },
        { t: 'Диспетчер Блок 2', st: 'working', age: '13 мин', waves: [
          { t: 'Волна Б2-1: DEV-1222→1223', st: 'working', age: '1 мин' },
          { t: 'Волна Б2-баги: DEV-1220', st: 'stalled', age: '9 мин' },
        ] },
      ] },
    { kind: 'plain', name: 'Вне эпика', items: [
      { t: 'Обновление плагина', st: 'working', age: '6 ч' },
      { t: 'Разбор пилота', st: 'done', age: '1 дн' },
    ] },
  ];

  const COLOR = { working: 'var(--ok)', waiting_decision: 'var(--warn)',
    stalled: 'var(--stall)', done: 'var(--dead)' };

  // «Задачи» — пульс сессии: что бежит прямо сейчас
  const RUNNING = [
    { name: 'смоук-вотчер предпрода', kind: 'bash', age: '19 мин 24 с' },
    { name: 'перевзвод будки диспетчера', kind: 'bash', age: '1 мин 17 с' },
  ];
  const AGENTS = [
    { name: 'backend-dev', task: 'DEV-1215: staged/reveal в сервисе', model: 'Opus 5', age: '4 мин', st: 'working' },
    { name: 'code-reviewer', task: 'ревью ветки wave-f3', model: 'Opus 5', age: '40 с', st: 'working' },
    { name: 'e2e-test-writer', task: 'red-тесты по DoD', model: 'Sonnet 5', age: '2 мин', st: 'done' },
  ];
  const WF = { name: 'Конвейер тикета DEV-1215', stages: [
    { s: 'Тестген', st: 'done', n: 2 },
    { s: 'Реализация', st: 'working', n: 3 },
    { s: 'Кросс-ревью', st: 'wait', n: 0 },
    { s: 'Сдача', st: 'wait', n: 0 },
  ] };
  const FILES = [
    'ai-evolve-back/services/playbook_service.py',
    'ai-evolve-front/src/lib/components/PlaybookCard.svelte',
    'ai-evolve-docs-test/waves/DEV-1210-playbooks/spec-staged-reveal.md',
  ];
</script>

<svelte:head><title>Макет рабочего места — STOVP</title></svelte:head>

<p class="hint quiet">
  Макет на выдуманных данных: так выглядит рабочее место, когда работа
  сгруппирована как она устроена. Живых данных здесь нет — смотрим вёрстку.
</p>

<div class="mock">
  <!-- ЛЕВО: дерево работы -->
  <nav class="tree">
    <div class="eyebrow pad">Работа проекта nyron</div>
    {#each TREE as group}
      {#if group.kind === 'epic'}
        <div class="epic">
          <div class="epic-head">
            <span class="caret">⌄</span>
            <a class="ticket" href="https://nyron.atlassian.net/browse/{group.key}">{group.key}</a>
            <span class="grow">{group.name}</span>
            {#if group.waiting}<span class="badge">{group.waiting}</span>{/if}
          </div>
          <div class="epic-meta quiet">{group.st} · волн {group.waves} · спека и ресёрчи внутри</div>
          {#each group.disp as d}
            <div class="disp">
              <div class="row"><i class="dot" style="background: {COLOR[d.st]}"></i><span class="grow">{d.t}</span><span class="trail">{d.age}</span></div>
              {#each d.waves as w}
                <div class="row wave"><i class="dot" style="background: {COLOR[w.st]}"></i><span class="grow">{w.t}</span>{#if w.asks}<span class="badge">{w.asks}</span>{/if}<span class="trail">{w.age}</span></div>
              {/each}
            </div>
          {/each}
        </div>
      {:else}
        <div class="plain">
          <div class="eyebrow pad">{group.name}</div>
          {#each group.items as i}
            <div class="row"><i class="dot" style="background: {COLOR[i.st]}"></i><span class="grow">{i.t}</span><span class="trail">{i.age}</span></div>
          {/each}
        </div>
      {/if}
    {/each}
  </nav>

  <!-- ЦЕНТР: разговор -->
  <main class="talk">
    <header class="talk-head">
      <h2>Волна Ф3: CRDT fail-closed + staged/reveal</h2>
      <div class="chips">
        <span class="chip"><i class="dot" style="background: var(--warn)"></i>ждёт вас</span>
        <span class="chip">CLI</span>
        <a class="ticket" href="https://nyron.atlassian.net/browse/DEV-1215">DEV-1215</a>
      </div>
    </header>

    <div class="bubble me">На какой базе вести back-часть, пока 1212 не влит?</div>
    <div class="msg">
      Развилка по базе. Собрал три пути и последствия каждого — вопрос ушёл
      вам карточкой, работа приостановлена до решения.
    </div>
    <details class="tool"><summary><span class="mono">⛭ субагент</span> backend-dev — staged/reveal в сервисе</summary>
      <p class="quiet">Разворачивается во вложенный транскрипт: видно, что он делал.</p>
    </details>

    <div class="commitbar">
      <span class="mono">ai-evolve</span>
      <span class="chip">wave-f3</span>
      <span class="diff"><b class="plus">+412</b> <b class="minus">−37</b></span>
      <button class="btn sm">Коммит</button>
    </div>
    <div class="composer">
      <input type="text" placeholder="написать волне…" />
      <button class="btn primary">Отправить</button>
    </div>
  </main>

  <!-- разделитель: тянем — панели шире, чат уже; центр остаётся центром -->
  <button class="splitter" class:dragging onpointerdown={startDrag}
    aria-label="изменить ширину панелей"></button>

  <!-- ПРАВО: поверхности сессии -->
  <aside class="side" style="width: {sideW}px">
    <div class="tabs">
      <button class="tab" class:on={tab === 'tasks'} onclick={() => (tab = 'tasks')}>Задачи</button>
      <button class="tab" class:on={tab === 'files'} onclick={() => (tab = 'files')}>Файлы</button>
      <button class="tab" class:on={tab === 'browser'} onclick={() => (tab = 'browser')}>Браузер</button>
    </div>

    {#if tab === 'tasks'}
      <article class="panel">
        <header><h3>Идёт сейчас</h3><div class="tools"><button class="link">свернуть</button></div></header>
        <div class="body flush">
          {#each RUNNING as r}
            <div class="row"><i class="dot" style="background: var(--accent)"></i><span class="grow">{r.name}</span><span class="trail">{r.age}</span></div>
          {/each}
        </div>
      </article>

      <article class="panel">
        <header><h3>Субагенты</h3><span class="badge mute">{AGENTS.length}</span></header>
        <div class="body flush">
          {#each AGENTS as a}
            <details class="ag">
              <summary>
                <i class="dot" style="background: {COLOR[a.st]}"></i>
                <span class="grow">{a.name}</span>
                <span class="trail">{a.model} · {a.age}</span>
              </summary>
              <p class="ag-task">{a.task}</p>
            </details>
          {/each}
        </div>
      </article>

      <article class="panel">
        <header><h3>Конвейер</h3></header>
        <div class="body">
          <div class="wf-name quiet">{WF.name}</div>
          <div class="wf">
            {#each WF.stages as s, i}
              <div class="stage" class:done={s.st === 'done'} class:working={s.st === 'working'}>
                <span class="s-name">{s.s}</span>
                <span class="s-n">{s.n ? `${s.n} агента` : '—'}</span>
              </div>
              {#if i < WF.stages.length - 1}<span class="wf-arrow">›</span>{/if}
            {/each}
          </div>
        </div>
      </article>
    {:else if tab === 'files'}
      <article class="panel">
        <header><h3>Файлы сессии</h3></header>
        <div class="body">
          <input type="search" placeholder="фильтр… (?текст — искать в содержимом)" />
          <div class="flist">
            {#each FILES as f}
              <div class="row"><span class="grow mono">{f}</span></div>
            {/each}
          </div>
          <p class="empty">Файлы эпика — спеки и ресёрчи — лежат в карточке эпика, не здесь.</p>
        </div>
      </article>
    {:else}
      <article class="panel">
        <header><h3>Браузер сессии</h3><span class="chip">:5199</span></header>
        <div class="body">
          <div class="seg" style="margin-bottom: 10px">
            {#each VIEWPORTS as [name, size]}
              <button class:on={vp === name} onclick={() => (vp = name)}>
                {name}{#if size}<span class="dim">{size}</span>{/if}
              </button>
            {/each}
          </div>
          <div class="viewport" style="width: {vp === 'Телефон' ? '100%' : vp === 'Планшет' ? '100%' : '100%'}; max-width: {vp === 'Телефон' ? '187px' : vp === 'Планшет' ? '280px' : 'none'}; height: 170px">
            <div class="skeleton" style="height: 100%"></div>
          </div>
          <p class="empty">Что смотрит агент. Масштаб переключается — видно, как страница ложится на телефоне.</p>
        </div>
      </article>
    {/if}
  </aside>
</div>

<style>
  .hint { margin: 0 0 var(--sp-5); font-size: var(--fs-xs); }
  .mock {
    display: flex; gap: var(--sp-5); align-items: stretch;
    border: 1px solid var(--border-soft); border-radius: var(--r-lg);
    background: var(--bg-1); padding: var(--sp-5); min-height: 70vh;
  }
  .pad { padding: var(--sp-3) var(--sp-4); }

  /* дерево работы */
  .tree { background: var(--bg-0); border-radius: var(--r); padding: var(--sp-4) var(--sp-3); width: 300px; flex: none; overflow: auto; }
  .epic { margin: var(--sp-3) 0 var(--sp-5); }
  .epic-head {
    display: flex; align-items: center; gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); color: var(--text-1);
  }
  .epic-head .caret { color: var(--text-4); }
  .epic-meta { font-size: var(--fs-micro); padding: 0 var(--sp-4) var(--sp-3) 26px; }
  .disp { padding-left: var(--sp-5); border-left: 1px solid var(--border-soft); margin-left: var(--sp-6); }
  .row.wave { padding-left: var(--sp-6); }
  .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plain { margin-top: var(--sp-5); }

  /* разговор */
  .talk { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; flex: 1; }
  .talk-head h2 { margin: 0 0 var(--sp-3); font-size: var(--fs-xl); font-family: var(--serif); font-weight: 500; }
  .chips { display: flex; gap: var(--sp-3); align-items: center; }
  .bubble.me {
    align-self: flex-end; background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r); padding: var(--sp-4) var(--sp-6); max-width: 80%;
  }
  .msg { max-width: 80ch; }
  .tool { background: var(--bg-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); }
  .tool > summary { padding: var(--sp-3) var(--sp-5); cursor: pointer; font-size: var(--fs-sm); }
  .tool p { padding: 0 var(--sp-5) var(--sp-4); margin: 0; font-size: var(--fs-xs); }

  .commitbar {
    display: flex; align-items: center; gap: var(--sp-4); margin-top: auto;
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r); padding: var(--sp-3) var(--sp-5);
  }
  .diff { margin-left: auto; font-size: var(--fs-xs); }
  .plus { color: var(--ok); } .minus { color: var(--hot); }
  .composer { display: flex; gap: var(--sp-4); }
  .composer input { flex: 1; }

  /* поверхности справа */
  .side { display: flex; flex-direction: column; gap: var(--sp-4); flex: none; min-width: 260px; }
  .tabs { display: flex; gap: var(--sp-2); }
  .tab {
    background: none; border: 1px solid transparent; border-radius: var(--r-pill);
    color: var(--text-3); padding: var(--sp-2) var(--sp-5); font-size: var(--fs-sm);
  }
  .tab:hover { color: var(--text-1); }
  .tab.on { background: var(--bg-2); border-color: var(--border); color: var(--text-1); }
  .ag > summary {
    display: flex; align-items: center; gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-5); cursor: pointer; font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .ag > summary:hover { background: var(--bg-3); }
  .ag-task { margin: 0; padding: 0 var(--sp-5) var(--sp-4) 30px; font-size: var(--fs-xs); color: var(--text-3); }
  .wf-name { font-size: var(--fs-xs); margin-bottom: var(--sp-4); }
  .wf { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
  .stage {
    display: flex; flex-direction: column; gap: 1px;
    border: 1px solid var(--border); border-radius: var(--r-sm);
    padding: var(--sp-2) var(--sp-4); font-size: var(--fs-micro);
    color: var(--text-3);
  }
  .stage.done { border-color: var(--ok); color: var(--text-2); }
  .stage.working { border-color: var(--accent); color: var(--text-1); background: var(--bg-3); }
  .s-name { font-size: var(--fs-xs); }
  .wf-arrow { color: var(--text-4); }
  .flist { margin-top: var(--sp-4); }
  .browser-frame {
    height: 180px; border: 1px solid var(--border); border-radius: var(--r-sm);
    overflow: hidden; background: var(--bg-0);
  }
  @media (max-width: 1100px) {
    .mock { flex-direction: column; }
    .tree, .side { width: auto !important; }
    .splitter { display: none; }
  }
</style>
