<script>
  // Обозреватель файлов проекта: дерево слева, просмотр справа. Открывается
  // как поверхность, разворачивается на весь экран (эталон Claude Desktop —
  // «доп-окно, кручу по размеру как угодно», CTO 11.08).
  //
  // Волна 3: Card как поверхность, ScrollArea под дерево, Input под фильтр,
  // Skeleton на время чтения файла. Высота поверхности задана (а не растёт
  // с файлом): иначе открытый на десять экранов файл утаскивал вниз всю
  // страницу вместе с деревом.
  import { untrack } from 'svelte';
  import { md } from '$lib/md.js';
  import Icon from '$lib/Icon.svelte';
  import * as Card from '$lib/ui/card/index.js';
  import { Button } from '$lib/ui/button/index.js';
  import { Input } from '$lib/ui/input/index.js';
  import { Skeleton } from '$lib/ui/skeleton/index.js';
  import { ScrollArea } from '$lib/ui/scroll-area/index.js';

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

<Card.Root
  class="gap-0 py-0 {full
    ? 'fixed inset-0 z-50 rounded-none wide:inset-4 wide:rounded-lg'
    : 'h-[78vh] wide:h-[70vh]'}">
  <div class="flex items-center gap-2 border-b border-border-soft px-3.5 py-2.5">
    <h3 class="flex-1">Файлы <span class="quiet text-xs font-normal">{project}</span></h3>
    <Button variant="ghost" size="icon-sm" onclick={() => (full = !full)}
      title={full ? 'свернуть' : 'развернуть на весь экран'}
      aria-label={full ? 'свернуть' : 'развернуть на весь экран'}>
      <Icon name={full ? 'minimize-2' : 'maximize-2'} />
    </Button>
    {#if onClose}
      <Button variant="ghost" size="icon-sm" onclick={onClose} title="закрыть" aria-label="закрыть">
        <Icon name="x" />
      </Button>
    {/if}
  </div>

  <!-- пока файл не выбран, дерево забирает всю высоту: на телефоне иначе
       видно три строки дерева и полэкрана пустого просмотра -->
  <div class="cols" class:picked={!!selPath}>
    <div class="flex min-h-0 flex-col gap-2 border-b border-border-soft p-2 wide:border-b-0 wide:border-r">
      <Input type="search" class="flex-none"
        placeholder="фильтр… (?текст — искать в содержимом)"
        bind:value={q} oninput={onSearch} />

      <!-- дерево длиннее панели всегда: своя прокрутка, страница не растёт -->
      <ScrollArea class="min-h-0 flex-1">
        {#if hits}
          <div class="eyebrow px-2 py-1">{hits.byContent ? 'в содержимом' : 'по имени'}: {hits.entries.length}</div>
          {#each hits.entries as h (h.path)}
            <button class="row" class:active={selPath === h.path} onclick={() => openFile(h.path)}>
              <Icon name="file-text" size={13} class="text-ink-4" />
              <span class="grow">{h.path}{h.line ? ` : ${h.line}` : ''}</span>
            </button>
            {#if h.excerpt}<p class="excerpt quiet">{h.excerpt}</p>{/if}
          {/each}
          {#if !hits.entries.length}<p class="empty">Ничего не нашлось.</p>{/if}
        {:else}
          <div class="filetree">
            {#snippet level(p, depth)}
              {#each openDirs[p] || [] as e (e.path)}
                {#if e.dir}
                  <button class="row dir" style="padding-left: {8 + depth * 12}px" onclick={() => loadDir(e.path)}>
                    <Icon name="chevron-right" size={13}
                      class="caret {openDirs[e.path] ? 'open' : ''}" />
                    <Icon name={openDirs[e.path] ? 'folder-open' : 'folder'} size={13} class="text-ink-3" />
                    <span class="grow">{e.name}</span>
                  </button>
                  {#if openDirs[e.path]}{@render level(e.path, depth + 1)}{/if}
                {:else}
                  <button class="row" class:active={selPath === e.path}
                    style="padding-left: {20 + depth * 12}px" onclick={() => openFile(e.path)}>
                    <Icon name="file-text" size={13} class="text-ink-4" />
                    <span class="grow">{e.name}</span>
                    <span class="trail">{kb(e.size)}</span>
                  </button>
                {/if}
              {/each}
            {/snippet}
            {@render level('', 0)}
          </div>
          {#if loading['']}
            <div class="flex flex-col gap-2 p-2">
              {#each [70, 55, 80, 45] as w}<Skeleton class="h-4" style="width: {w}%" />{/each}
            </div>
          {/if}
        {/if}
      </ScrollArea>
    </div>

    <div class="view">
      {#if error}<p class="err">{error}</p>{/if}
      {#if !selPath}
        <p class="empty">Выберите файл в дереве — покажу целиком. Разметка отрисуется, код — как есть.</p>
      {:else if !sel}
        <div class="flex flex-col gap-2">
          {#each [60, 90, 75, 85, 40] as w}<Skeleton class="h-4" style="width: {w}%" />{/each}
        </div>
      {:else}
        <div class="viewer-head">
          <b class="mono">{sel.path}</b>
          <span class="quiet">{kb(sel.size)}{sel.truncated ? ' · показано начало' : ''}</span>
        </div>
        {#if sel.viewer?.startsWith('image/')}
          <!-- скриншоты требований и дизайна смотрим прямо здесь (CTO 11.08) -->
          <a class="inline-block" href={rawUrl(sel.path)} target="_blank" rel="noopener"
             title="открыть в полном размере">
            <img class="shot" src={rawUrl(sel.path)} alt={sel.path} />
          </a>
        {:else if sel.viewer === 'application/pdf'}
          <!-- встроенный браузер Claude PDF не рисует (нет просмотрщика) —
               даём рамку для обычных браузеров и явный выход наружу -->
          <object class="pdf" data={rawUrl(sel.path)} type="application/pdf"
            aria-label="PDF: {sel.path}">
            <div class="viewer-fallback">
              <p>Встроенный браузер не показывает PDF.</p>
              <Button href={rawUrl(sel.path)} target="_blank" rel="noopener">Открыть вкладкой</Button>
              <Button variant="outline" onclick={() => openOutside(sel.path)}>Открыть в системе</Button>
            </div>
          </object>
          <p class="note quiet">
            Пусто? Значит просмотрщика в этом браузере нет —
            <a href={rawUrl(sel.path)} target="_blank" rel="noopener">открыть вкладкой</a>
            или <Button variant="link" size="xs" class="px-0" onclick={() => openOutside(sel.path)}>в системе</Button>.
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
            <p class="quiet note">Показаны первые 500 строк из {table.length - 1}.</p>
          {/if}
        {:else if isMd(sel.path)}
          <div class="md-body doc">{@html md(sel.text, tracker)}</div>
        {:else}
          <pre class="filecode">{sel.text}</pre>
        {/if}
      {/if}
    </div>
  </div>
</Card.Root>

<style>
  /* Раскладка: на телефоне дерево над просмотром, на широком — колонками.
     Обе колонки катаются сами, поверхность держит заданную высоту. */
  .cols { display: grid; grid-template-rows: minmax(0, 1fr) auto; flex: 1; min-height: 0; }
  .cols.picked { grid-template-rows: minmax(0, 2fr) minmax(0, 3fr); }
  @media (min-width: 901px) {
    .cols, .cols.picked {
      grid-template-rows: none; grid-template-columns: minmax(200px, 300px) minmax(0, 1fr);
    }
  }
  .view { overflow: auto; padding: var(--sp-6); min-width: 0; }
  .excerpt {
    font-size: var(--fs-micro); margin: 0 0 var(--sp-3) var(--sp-6);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .doc { max-width: 80ch; }
  .pdf {
    width: 100%; height: 60vh; background: var(--bg-0);
    border: 1px solid var(--border); border-radius: var(--r-sm);
  }
  .note { font-size: var(--fs-xs); margin-top: var(--sp-4); }
  .note a { color: var(--accent); }
</style>
