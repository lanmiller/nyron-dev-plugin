<script>
  // Git-панель проекта (мандат CTO 22.08: визуальный git уровня VS Code —
  // «чтобы всё было видно и можно было разобраться с ветками, слияниями,
  // коммитами»). Референсы устройства: Source Control VS Code (список
  // изменений, инлайн stage/discard, поле коммита сверху) и Git Graph
  // (граф с цветными дорожками). Проект — моно-папка: репозиториев
  // несколько, навигация по ним — чипами сверху.
  import { page } from '$app/state';
  import Icon from '$lib/Icon.svelte';
  import GitGraph from '$lib/GitGraph.svelte';
  import * as Dialog from '$lib/ui/dialog/index.js';

  const project = $derived(page.params.project);

  let repos = $state([]);          // сводка всех репо проекта
  let repo = $state(null);         // выбранный rel
  let st = $state(null);           // статус выбранного репо
  let view = $state('graph');      // диф | граф | ветки
  let sel = $state(null);          // выбранный файл {file, s, staged}
  let diff = $state(null);
  let graphData = $state(null);
  let branchData = $state(null);
  let commitSel = $state(null);    // выбранный коммит в графе
  let commitData = $state(null);
  let msg = $state('');            // сообщение коммита
  let newBranch = $state('');
  let busy = $state({});           // op → true
  let err = $state(null);
  let note = $state(null);         // итог push/pull
  let confirmDiscard = $state(null); // {files, label}

  const api = (params) => fetch('/api/git?' + new URLSearchParams({ project, ...params }))
    .then((r) => r.json());
  async function post(op, body = {}) {
    err = null;
    busy = { ...busy, [op]: true };
    try {
      const r = await fetch('/api/git', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project, repo, op, ...body }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      return j;
    } catch (e) {
      err = String(e.message || e);
      return null;
    } finally {
      busy = { ...busy, [op]: false };
    }
  }

  async function loadOverview() {
    const j = await api({ op: 'overview' });
    if (j.error) { err = j.error; return; }
    repos = j.repos;
    if (!repo || !repos.some((r) => r.rel === repo))
      repo = (repos.find((r) => r.staged + r.changed > 0) || repos[0])?.rel || null;
  }
  async function loadRepo() {
    if (!repo) return;
    sel = null; diff = null; commitSel = null; commitData = null; note = null;
    const [s, g] = await Promise.all([
      api({ op: 'status', repo }), api({ op: 'graph', repo })]);
    if (s.error || g.error) { err = s.error || g.error; return; }
    st = s; graphData = g;
    branchData = null;
    if (view === 'diff') view = st.staged.length + st.unstaged.length ? view : 'graph';
  }
  async function refresh() {
    await Promise.all([loadOverview(), loadRepo()]);
  }

  $effect(() => { project; loadOverview(); });
  $effect(() => { repo; loadRepo(); });
  $effect(() => {
    if (view === 'branches' && !branchData)
      api({ op: 'branches', repo }).then((j) => (j.error ? (err = j.error) : (branchData = j)));
  });

  async function openFile(f, staged) {
    sel = { ...f, staged };
    view = 'diff';
    diff = null;
    diff = await api({ op: 'diff', repo, file: f.file,
      staged: staged ? '1' : '0', untracked: f.s === 'U' ? '1' : '0' });
  }
  function diffLines(text) {
    return (text || '').split('\n').map((l) => ({
      t: l,
      cls: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del'
        : l.startsWith('@@') ? 'hunk'
        : /^(diff |index |new file|deleted|similarity|rename)/.test(l) ? 'meta' : '',
    }));
  }

  async function act(op, body, reload = true) {
    const r = await post(op, body);
    if (r && reload) await refresh();
    return r;
  }
  async function doCommit() {
    if (!(await act('commit', { message: msg }))) return;
    msg = '';
  }
  async function doDiscard() {
    const files = confirmDiscard.files;
    confirmDiscard = null;
    await act('discard', { files });
  }
  async function netOp(op) {
    const r = await act(op);
    if (r) note = r.out || (op === 'fetch' ? 'обновлено' : 'готово');
  }
  async function pickCommit(c) {
    commitSel = c.sha;
    commitData = null;
    commitData = await api({ op: 'commit', repo, sha: c.sha });
  }

  const repoLabel = (rel) => rel === '.' ? '(корень)' : rel;
  // имя файла ведущее, каталог приглушён и режется (как в VS Code) —
  // RTL-трюк с ellipsis переворачивал точки в «.secrets» и «x.log»
  function split(f) {
    // неотслеживаемый каталог (вложенный репозиторий) приходит как «mcp/» —
    // хвостовой слэш не должен превращать имя в пустоту
    const p = f.endsWith('/') ? f.slice(0, -1) : f;
    const i = p.lastIndexOf('/');
    return i === -1 ? [p, ''] : [p.slice(i + 1), p.slice(0, i)];
  }
  const changesTotal = $derived(st ? st.staged.length + st.unstaged.length : 0);
</script>

<svelte:head><title>git · {project}</title></svelte:head>

<div class="git-page">
  <header class="head">
    <h2>Git</h2>
    <span class="quiet">{project}</span>
    <button class="link" onclick={refresh} title="перечитать статусы">обновить</button>
  </header>

  <!-- навигация по репозиториям моно-папки: как группы в Source Control -->
  <div class="repos" role="tablist" aria-label="репозитории">
    {#each repos as r (r.rel)}
      <button class="chip" class:on={r.rel === repo} role="tab"
        aria-selected={r.rel === repo}
        onclick={() => (repo = r.rel)}
        title="{r.rel} · {r.branch || r.error}{r.upstream ? ' → ' + r.upstream : ''}">
        <Icon name="git-branch" size={11} />
        {repoLabel(r.rel)}
        {#if r.error}<span class="gstat d">!</span>
        {:else}
          {#if r.staged + r.changed}<b>{r.staged + r.changed}</b>{/if}
          {#if r.behind}<span class="ab">{r.behind}↓</span>{/if}
          {#if r.ahead}<span class="ab">{r.ahead}↑</span>{/if}
        {/if}
      </button>
    {/each}
    {#if !repos.length}<span class="quiet">ищу репозитории…</span>{/if}
  </div>

  {#if err}<p class="err">{err}</p>{/if}

  {#if repo && st}
    <div class="cols">
      <!-- левая колонка: изменения и коммит — как Source Control -->
      <section class="panel">
        <header>
          <h3>Изменения</h3>
          {#if changesTotal}<span class="badge mute">{changesTotal}</span>{/if}
          <div class="tools ab" title="ветка{st.upstream ? ' → ' + st.upstream : ' (без апстрима)'}">
            <Icon name="git-branch" size={12} /> <b>{st.detached ? 'HEAD откреплён' : st.branch}</b>
          </div>
        </header>
        <div class="body flush">
          <!-- поле коммита сверху, как в VS Code -->
          <div class="commit-box">
            <textarea rows="2" placeholder="Сообщение коммита" bind:value={msg}></textarea>
            <button class="btn primary sm" class:busy={busy.commit}
              disabled={!st.staged.length || !msg.trim()}
              onclick={doCommit}
              title={st.staged.length ? `закоммитить ${st.staged.length} файл(ов)` : 'сначала подготовь файлы (stage)'}>
              Коммит в {st.branch || 'HEAD'}
            </button>
          </div>

          {#if st.staged.length}
            <div class="group-h">
              <span class="eyebrow">Подготовлено</span><span class="quiet">{st.staged.length}</span>
              <button class="iconbtn" title="убрать всё из подготовленного"
                onclick={() => act('unstage', { files: st.staged.map((f) => f.file) })}>
                <Icon name="minus" size={14} /></button>
            </div>
            {#each st.staged as f (f.file)}
              <div class="frow row" class:active={sel?.file === f.file && sel?.staged}>
                <button class="fname" onclick={() => openFile(f, true)} title={f.file}>
                  <span class="gstat {f.s.toLowerCase()}">{f.s}</span>
                  <span class="base">{split(f.file)[0]}</span>
                  <span class="dir">{split(f.file)[1]}</span>
                </button>
                <button class="iconbtn" title="убрать из подготовленного"
                  onclick={() => act('unstage', { files: [f.file] })}>
                  <Icon name="minus" size={14} /></button>
              </div>
            {/each}
          {/if}

          <div class="group-h">
            <span class="eyebrow">Изменения</span><span class="quiet">{st.unstaged.length}</span>
            {#if st.unstaged.length}
              <button class="iconbtn" title="подготовить всё"
                onclick={() => act('stage', { files: st.unstaged.map((f) => f.file) })}>
                <Icon name="plus" size={14} /></button>
            {/if}
          </div>
          {#each st.unstaged as f (f.file)}
            <div class="frow row" class:active={sel?.file === f.file && !sel?.staged}>
              <button class="fname" onclick={() => openFile(f, false)} title={f.file}>
                <span class="gstat {f.s.toLowerCase()}">{f.s}</span>
                <span class="base">{split(f.file)[0]}</span>
                <span class="dir">{split(f.file)[1]}</span>
              </button>
              <button class="iconbtn" title={f.s === 'U' ? 'удалить файл' : 'откатить правки'}
                onclick={() => (confirmDiscard = { files: [f.file], label: f.file, del: f.s === 'U' })}>
                <Icon name="undo-2" size={14} /></button>
              <button class="iconbtn" title="подготовить к коммиту"
                onclick={() => act('stage', { files: [f.file] })}>
                <Icon name="plus" size={14} /></button>
            </div>
          {/each}
          {#if !changesTotal}<p class="empty">дерево чистое</p>{/if}
        </div>
      </section>

      <!-- правая колонка: диф / граф / ветки + сеть -->
      <section class="panel">
        <header>
          <div class="seg">
            <button class:on={view === 'diff'} onclick={() => (view = 'diff')}
              disabled={!sel}>Диф</button>
            <button class:on={view === 'graph'} onclick={() => (view = 'graph')}>Граф</button>
            <button class:on={view === 'branches'} onclick={() => (view = 'branches')}>Ветки</button>
          </div>
          <div class="tools">
            <button class="link" class:busy={busy.fetch} onclick={() => netOp('fetch')}
              title="git fetch — узнать состояние удалённого">свериться</button>
            <button class="link" class:busy={busy.pull} onclick={() => netOp('pull')}
              disabled={!st.upstream || busy.pull}
              title="git pull --ff-only{st.behind ? ` — принять ${st.behind}` : ''}">
              pull{#if st.behind}&nbsp;{st.behind}↓{/if}</button>
            <button class="link" class:busy={busy.push} onclick={() => netOp('push')}
              disabled={busy.push}
              title="git push{st.ahead ? ` — отдать ${st.ahead}` : ''}{st.upstream ? '' : ' (создаст апстрим origin)'}">
              push{#if st.ahead}&nbsp;{st.ahead}↑{/if}</button>
          </div>
        </header>
        <div class="body" class:flush={view === 'graph'}>
          {#if note}<p class="ok-note netnote">{note}</p>{/if}

          {#if view === 'diff' && sel}
            <div class="viewer-head">
              <b class="mono">{sel.file}</b>
              <span class="quiet">{sel.staged ? 'подготовлено' : sel.s === 'U' ? 'новый файл' : 'правки'}</span>
            </div>
            {#if !diff}<div class="skeleton" style="height:120px"></div>
            {:else if diff.error}<p class="err">{diff.error}</p>
            {:else if !diff.text}<p class="empty">диф пуст</p>
            {:else}
              <pre class="diff-view">{#each diffLines(diff.text) as l}<span class="ln {l.cls}">{l.t || ' '}</span>{/each}</pre>
              {#if diff.truncated}<p class="quiet">показано начало — файл больше 400 КБ</p>{/if}
            {/if}

          {:else if view === 'graph'}
            {#if !graphData}<div class="skeleton" style="height:200px;margin:var(--sp-5)"></div>
            {:else}
              <GitGraph commits={graphData.commits} laneCount={graphData.laneCount}
                selected={commitSel} onselect={pickCommit} />
              {#if !graphData.commits.length}<p class="empty">коммитов нет</p>{/if}
            {/if}

          {:else if view === 'branches' && branchData}
            <div class="new-branch">
              <input type="text" placeholder="имя новой ветки" bind:value={newBranch} />
              <button class="btn sm" class:busy={busy['create-branch']} disabled={!newBranch.trim()}
                onclick={async () => { if (await act('create-branch', { name: newBranch.trim() })) newBranch = ''; }}>
                Создать от {st.branch}</button>
            </div>
            <div class="eyebrow bh">Локальные</div>
            {#each branchData.locals as b (b.name)}
              <button class="row brow" class:active={b.current} disabled={b.current || busy.checkout}
                onclick={() => act('checkout', { branch: b.name })}
                title={b.current ? 'текущая' : `переключиться на ${b.name} (дерево должно быть чистым)`}>
                <Icon name="git-branch" size={13} class={b.current ? 'text-primary' : 'text-ink-4'} />
                <span class="grow">{b.name}</span>
                {#if b.upstream}<span class="trail">→ {b.upstream}</span>{/if}
                <span class="trail mono">{b.sha}</span>
              </button>
            {/each}
            <div class="eyebrow bh">Удалённые</div>
            {#each branchData.remotes as b (b.name)}
              <button class="row brow" disabled={busy.checkout}
                onclick={() => act('checkout', { branch: b.name })}
                title="переключиться на локальную ветку, трекающую {b.name}">
                <Icon name="cloud" size={13} class="text-ink-4" />
                <span class="grow">{b.name}</span>
                <span class="trail mono">{b.sha}</span>
              </button>
            {/each}
          {:else if view === 'branches'}
            <div class="skeleton" style="height:120px"></div>
          {/if}
        </div>
      </section>
    </div>

    <!-- выбранный коммит графа: сообщение целиком и его файлы -->
    {#if commitSel && view === 'graph'}
      <section class="panel commit-info">
        <header>
          <h3 class="mono">{commitSel.slice(0, 8)}</h3>
          {#if commitData}<span class="quiet">{commitData.author} · {commitData.date}</span>{/if}
          <div class="tools">
            <button class="iconbtn" title="закрыть"
              onclick={() => { commitSel = null; commitData = null; }}>
              <Icon name="x" size={14} /></button>
          </div>
        </header>
        <div class="body">
          {#if !commitData}<div class="skeleton" style="height:60px"></div>
          {:else}
            <pre class="cmsg">{commitData.message}</pre>
            {#each commitData.files as f (f.file)}
              <div class="frow row">
                <span class="gstat {f.s.toLowerCase()}">{f.s}</span>
                <span class="grow mono cfile">{f.orig ? `${f.orig} → ` : ''}{f.file}</span>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    {/if}
  {:else if repo}
    <div class="skeleton" style="height:200px"></div>
  {/if}
</div>

<!-- discard — разрушительное: подтверждение обязательно (мандат) -->
<Dialog.Root open={!!confirmDiscard} onOpenChange={(v) => { if (!v) confirmDiscard = null; }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{confirmDiscard?.del ? 'Удалить файл?' : 'Откатить правки?'}</Dialog.Title>
      <Dialog.Description>
        <span class="mono">{confirmDiscard?.label}</span> —
        {confirmDiscard?.del ? 'файл не в git, он будет удалён с диска.' : 'несохранённые правки будут потеряны.'}
        Вернуть их будет нельзя.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <button class="btn sm" onclick={() => (confirmDiscard = null)}>Оставить</button>
      <button class="btn primary sm" onclick={doDiscard}>
        {confirmDiscard?.del ? 'Удалить' : 'Откатить'}</button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .git-page { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
  .head { display: flex; align-items: baseline; gap: var(--sp-5); }
  .head .link { margin-left: auto; }

  .repos { display: flex; gap: var(--sp-4); overflow-x: auto; padding-bottom: 2px; }
  .repos .chip { display: inline-flex; align-items: center; gap: var(--sp-3); flex: none; }
  .repos .chip b { color: var(--warn); font-weight: 600; }

  .cols { display: grid; gap: var(--sp-5); align-items: start; min-width: 0; }
  @media (min-width: 901px) {
    .cols { grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); }
    /* сотни изменённых файлов не должны утаскивать граф за экран:
       каждая колонка скроллится сама, как панели Source Control */
    .cols > .panel > .body { max-height: calc(100vh - 240px); overflow: auto; }
  }

  .commit-box {
    display: flex; flex-direction: column; gap: var(--sp-4);
    padding: var(--sp-5); border-bottom: 1px solid var(--border-soft);
  }
  .commit-box textarea {
    background: var(--bg-0); border: 1px solid var(--border);
    border-radius: var(--r-sm); color: var(--text-1); resize: vertical;
  }
  .commit-box textarea:disabled { opacity: 0.5; }

  .group-h {
    display: flex; align-items: center; gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-5) var(--sp-2);
  }
  .group-h .iconbtn { margin-left: auto; }

  .frow { gap: var(--sp-3); }
  .frow .fname {
    display: flex; align-items: center; gap: var(--sp-4); flex: 1; min-width: 0;
    background: none; border: 0; padding: 0; font: inherit; color: inherit;
    text-align: left; cursor: pointer;
  }
  .frow .base { flex: none; }
  .frow .dir {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-4); font-size: var(--fs-xs); flex: 1; min-width: 0;
  }

  .netnote { margin: 0 0 var(--sp-4); }
  .viewer-head { min-width: 0; }
  .viewer-head b { overflow-wrap: anywhere; }

  .new-branch { display: flex; gap: var(--sp-4); margin-bottom: var(--sp-5); flex-wrap: wrap; }
  .new-branch input { flex: 1; min-width: 160px; background: var(--bg-0);
    border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text-1); }
  .bh { margin: var(--sp-5) 0 var(--sp-2); }
  .brow { width: 100%; background: none; border: 0; font: inherit; text-align: left; }
  .brow .grow { text-align: left; }
  .brow:disabled { cursor: default; }
  .brow .trail { flex: none; }

  .commit-info .cmsg {
    font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-2);
    white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--sp-5);
  }
  .cfile { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
