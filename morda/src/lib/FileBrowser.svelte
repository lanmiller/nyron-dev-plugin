<script>
  // Обозреватель файлов проекта: дерево слева, просмотр справа. Открывается
  // как поверхность, разворачивается на весь экран (эталон Claude Desktop —
  // «доп-окно, кручу по размеру как угодно», CTO 11.08).
  import { untrack } from 'svelte';
  import { md } from '$lib/md.js';

  let { project, tracker = null, onClose = null } = $props();

  let openDirs = $state({});     // путь → массив записей (раскрытые папки)
  let loading = $state({});
  let sel = $state(null);        // выбранный файл (ответ сервера)
  let selPath = $state(null);
  let q = $state('');
  let hits = $state(null);
  let full = $state(false);      // развернуть на весь экран
  let error = $state(null);

  async function api(params) {
    const u = new URLSearchParams({ project, ...params });
    const r = await fetch(`/api/files?${u}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function loadDir(p = '') {
    if (openDirs[p]) { openDirs = { ...openDirs, [p]: null }; return; } // свернуть
    loading = { ...loading, [p]: true };
    try {
      const d = await api({ path: p });
      openDirs = { ...openDirs, [p]: d.entries };
      error = null;
    } catch (e) { error = String(e.message || e); }
    finally { loading = { ...loading, [p]: false }; }
  }

  async function openFile(p) {
    selPath = p;
    sel = null;
    try { sel = await api({ path: p, mode: 'file' }); error = null; }
    catch (e) { error = String(e.message || e); }
  }

  let searchTimer;
  function onSearch() {
    clearTimeout(searchTimer);
    const term = q.trim();
    if (!term) { hits = null; return; }
    searchTimer = setTimeout(async () => {
      try { hits = await api({ q: term }); error = null; }
      catch (e) { error = String(e.message || e); }
    }, 300);
  }

  const isMd = (p) => /\.md$/i.test(p || '');
  const isCsv = (p) => /\.(csv|tsv)$/i.test(p || '');

  // CSV/TSV — таблицей, а не простынёй текста. Разбор с кавычками и
  // экранированием (""), разделитель определяется по расширению и по
  // первой строке (бывают точки с запятой из Excel).
  function parseTable(text, path_) {
    const tab = /\.tsv$/i.test(path_);
    const head = text.slice(0, 2000);
    const sep = tab ? '\t'
      : (head.split(';').length > head.split(',').length ? ';' : ',');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === sep) { row.push(cell); cell = ''; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
      if (c === '\r') continue;
      cell += c;
      if (rows.length > 2000) break;   // потолок показа
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c !== ''));
  }
  let table = $derived(sel && !sel.binary && isCsv(sel.path)
    ? parseTable(sel.text, sel.path) : null);
  async function openOutside(p) {
    // системный просмотрщик умеет всё, чего не умеет встроенный браузер
    await fetch('/api/open-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morda': '1' },
      body: JSON.stringify({ project, path: p }),
    });
  }
  const rawUrl = (p) =>
    `/api/files?${new URLSearchParams({ project, path: p, mode: 'raw' })}`;
  const kb = (n) => (n == null ? '' : n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(0)} КБ`);

  // Первичная загрузка — ТОЛЬКО по смене проекта. Раньше эффект вызывал
  // loadDir, тот читал openDirs и сам же его менял → бесконечный цикл
  // (effect_update_depth_exceeded, факт 11.08).
  let loadedFor = null;
  $effect(() => {
    const p = project;
    if (!p || p === loadedFor) return;
    loadedFor = p;
    untrack(async () => {
      openDirs = {}; sel = null; selPath = null; hits = null; q = '';
      loading = { '': true };
      try {
        const d = await api({ path: '' });
        openDirs = { '': d.entries };
        error = null;
      } catch (e) { error = String(e.message || e); }
      finally { loading = {}; }
    });
  });
</script>

<section class="fb" class:full>
  <header>
    <h3>Файлы <span class="quiet">{project}</span></h3>
    <div class="tools">
      <button class="link" onclick={() => (full = !full)}>{full ? 'свернуть' : 'развернуть'}</button>
      {#if onClose}<button class="link" onclick={onClose}>закрыть</button>{/if}
    </div>
  </header>

  <div class="cols">
    <div class="tree">
      <input type="search" placeholder="фильтр… (?текст — искать в содержимом)"
        bind:value={q} oninput={onSearch} />

      {#if hits}
        <div class="hits">
          <div class="eyebrow">{hits.byContent ? 'в содержимом' : 'по имени'}: {hits.entries.length}</div>
          {#each hits.entries as h (h.path)}
            <button class="row" class:active={selPath === h.path} onclick={() => openFile(h.path)}>
              <span class="grow">{h.path}{h.line ? ` : ${h.line}` : ''}</span>
            </button>
            {#if h.excerpt}<p class="excerpt quiet">{h.excerpt}</p>{/if}
          {/each}
          {#if !hits.entries.length}<p class="empty">Ничего не нашлось.</p>{/if}
        </div>
      {:else}
        {#snippet level(p, depth)}
          {#each openDirs[p] || [] as e (e.path)}
            {#if e.dir}
              <button class="row dir" style="padding-left: {8 + depth * 12}px" onclick={() => loadDir(e.path)}>
                <span class="caret" class:open={openDirs[e.path]}>›</span>
                <span class="grow">{e.name}</span>
              </button>
              {#if openDirs[e.path]}{@render level(e.path, depth + 1)}{/if}
            {:else}
              <button class="row" class:active={selPath === e.path}
                style="padding-left: {20 + depth * 12}px" onclick={() => openFile(e.path)}>
                <span class="grow">{e.name}</span>
                <span class="trail">{kb(e.size)}</span>
              </button>
            {/if}
          {/each}
        {/snippet}
        {@render level('', 0)}
        {#if loading['']}<p class="empty">читаю корень…</p>{/if}
      {/if}
    </div>

    <div class="view">
      {#if error}<p class="err">{error}</p>{/if}
      {#if !selPath}
        <p class="empty">Выберите файл слева — покажу целиком. Разметка отрисуется, код — как есть.</p>
      {:else if !sel}
        <div class="skeleton" style="width: 60%"></div>
      {:else}
        <div class="fhead">
          <b class="mono">{sel.path}</b>
          <span class="quiet">{kb(sel.size)}{sel.truncated ? ' · показано начало' : ''}</span>
        </div>
        {#if sel.viewer?.startsWith('image/')}
          <!-- скриншоты требований и дизайна смотрим прямо здесь (CTO 11.08) -->
          <a class="shot-link" href={rawUrl(sel.path)} target="_blank" rel="noopener"
             title="открыть в полном размере">
            <img class="shot" src={rawUrl(sel.path)} alt={sel.path} />
          </a>
        {:else if sel.viewer === 'application/pdf'}
          <!-- встроенный браузер Claude PDF не рисует (нет просмотрщика) —
               даём рамку для обычных браузеров и явный выход наружу -->
          <object class="pdf" data={rawUrl(sel.path)} type="application/pdf">
            <div class="pdf-fallback">
              <p>Встроенный браузер не показывает PDF.</p>
              <a class="btn primary" href={rawUrl(sel.path)} target="_blank" rel="noopener">Открыть вкладкой</a>
              <button class="btn" onclick={() => openOutside(sel.path)}>Открыть в системе</button>
            </div>
          </object>
          <p class="pdf-note quiet">
            Пусто? Значит просмотрщика в этом браузере нет —
            <a href={rawUrl(sel.path)} target="_blank" rel="noopener">открыть вкладкой</a>
            или <button class="link" onclick={() => openOutside(sel.path)}>в системе</button>.
          </p>
        {:else if sel.binary}
          <p class="empty">Двоичный файл — показывать нечего.</p>
        {:else if table}
          <div class="tw">
            <table>
              <thead><tr>{#each table[0] || [] as h}<th>{h}</th>{/each}</tr></thead>
              <tbody>
                {#each table.slice(1, 500) as r}
                  <tr>{#each r as c}<td>{c}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if table.length > 500}
            <p class="quiet pdf-note">Показаны первые 500 строк из {table.length - 1}.</p>
          {/if}
        {:else if isMd(sel.path)}
          <div class="doc">{@html md(sel.text, tracker)}</div>
        {:else}
          <pre class="code">{sel.text}</pre>
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  .fb {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r); display: flex; flex-direction: column;
    overflow: hidden; min-height: 320px;
  }
  .fb.full {
    position: fixed; inset: 16px; z-index: 50;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }
  header {
    display: flex; align-items: center; gap: var(--sp-4);
    padding: var(--sp-5) var(--sp-6); border-bottom: 1px solid var(--border-soft);
  }
  header h3 { margin: 0; font-size: var(--fs-md); font-weight: 600; flex: 1; }
  header .quiet { font-weight: 400; font-size: var(--fs-xs); }
  .tools { display: flex; gap: var(--sp-5); }
  .cols { display: grid; grid-template-columns: minmax(200px, 300px) minmax(0, 1fr); flex: 1; min-height: 0; }
  .tree {
    border-right: 1px solid var(--border-soft); overflow: auto;
    padding: var(--sp-4); display: flex; flex-direction: column; gap: 1px;
  }
  .tree input { width: 100%; margin-bottom: var(--sp-4); }
  .row {
    display: flex; align-items: center; gap: var(--sp-3);
    background: none; border: 0; text-align: left; width: 100%;
    padding: var(--sp-3) var(--sp-4); border-radius: var(--r-sm);
    color: var(--text-2); font: inherit; font-size: var(--fs-sm);
    transition: background var(--t-fast);
  }
  .row:hover { background: var(--bg-3); }
  .row.active { background: var(--bg-3); color: var(--text-1); }
  .row.dir { color: var(--text-1); }
  .caret { color: var(--text-4); display: inline-block; width: 10px; transition: transform var(--t-fast); }
  .caret.open { transform: rotate(90deg); }
  .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trail { color: var(--text-4); font-size: var(--fs-micro); flex: none; }
  .excerpt {
    font-size: var(--fs-micro); margin: 0 0 var(--sp-3) var(--sp-6);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .view { overflow: auto; padding: var(--sp-6); min-width: 0; }
  .fhead { display: flex; gap: var(--sp-5); align-items: baseline; margin-bottom: var(--sp-5); }
  .fhead .quiet { font-size: var(--fs-xs); }
  .code {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: var(--r-sm); padding: var(--sp-5);
    font-family: var(--mono); font-size: 12.5px; line-height: 1.5;
    white-space: pre; overflow-x: auto; margin: 0;
  }
  .doc { max-width: 80ch; }
  .shot-link { display: inline-block; }
  .shot {
    max-width: 100%; border: 1px solid var(--border);
    border-radius: var(--r-sm); background: var(--bg-0);
  }
  .pdf { width: 100%; height: 70vh; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-0); }
  .pdf-fallback { display: flex; flex-direction: column; gap: var(--sp-5); align-items: center; padding: var(--sp-8); }
  .pdf-note { font-size: var(--fs-xs); margin-top: var(--sp-4); }
  .pdf-note a { color: var(--accent); }
  .doc :global(pre) {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: var(--r-sm); padding: var(--sp-5); overflow-x: auto;
  }
  .doc :global(table) { border-collapse: collapse; }
  .doc :global(a) { color: var(--accent); }
  @media (max-width: 720px) {
    .cols { grid-template-columns: 1fr; }
    .tree { border-right: 0; border-bottom: 1px solid var(--border-soft); max-height: 40vh; }
    .fb.full { inset: 0; border-radius: 0; }
  }
</style>
