<script>
  // Лента транскрипта: реплики (маркдаун), мысли (свёрнуты), плашки
  // инструментов (свёрнуты, разворачиваются в ввод+вывод), субагенты —
  // плашка Agent разворачивается во вложенный транскрипт (дерево).
  //
  // Волна 3 нарочно НЕ переводит плашки на Collapsible: в ленте диспетчера
  // их тысячи, а нативный <details> не держит ни своего состояния, ни
  // подписки — он и есть самый дешёвый свёрток из возможных (окно сессии
  // уже разгоняли 16 с → 15 мс, повторять не за чем). Компоненты пришли
  // туда, где они дают поведение: карточки вопросов, шапка, шторка.
  import Self from './Transcript.svelte';
  import { md } from '$lib/md.js';
  import Icon from '$lib/Icon.svelte';

  // openAgent — способ показать субагента отдельной поверхностью (шторка
  // окна сессии). Не передан — работает старая вложенная раскрывашка.
  let { items, project = null, sessionKey = null, depth = 0, tracker = null,
    openAgent = null, openTool = null, agents: sessionAgents = [] } = $props();

  // Пачка действий: типы — фильтры (CTO 19.08 «Read, Bash, Agent как
  // фильтры»). Клик по типу разворачивает пачку и оставляет только его.
  let packFilter = $state({});   // индекс блока → имя типа | null
  let packOpen = $state({});     // индекс блока → раскрыта ли пачка
  // Строка «Agent …» внутри пачки — фоновый агент: у него нет привязки к
  // вызову, но описание совпадает с меткой строки, по нему и находим.
  const agentOf = (it) => (it.name === 'Agent' || it.name === 'Task')
    ? sessionAgents.find((a) => a.description && it.input
        && (a.description === it.input || it.input.startsWith(a.description))) || null
    : null;

  let agents = $state({}); // agentId → { items } | { error } | 'loading'

  // Подряд идущие вызовы инструментов сворачиваются в одну строку: в ленте
  // диспетчера это стена из Bash и hub_read, которая топит смысл (CTO 11.08
  // «слишком много места занимают, группировать»). Субагенты и реплики
  // группу разрывают — они и есть содержание.
  let blocks = $derived.by(() => {
    const out = [];
    for (const it of items) {
      const plain = it.kind === 'tool' && !it.agent;
      const last = out.at(-1);
      if (plain && last?.group) last.tools.push(it);
      else if (plain) out.push({ group: true, tools: [it] });
      else out.push({ item: it });
    }
    return out;
  });
  // «Bash ×3 · hub_read ×2» — что именно делала сессия, без разворачивания
  function groupKinds(tools) {
    const by = new Map();
    for (const t of tools) by.set(t.name, (by.get(t.name) || 0) + 1);
    return [...by].map(([name, count]) => ({ name, count }));
  }
  const hasErr = (tools) => tools.some((t) => t.is_error);

  // Длинные имена MCP-инструментов («mcp__claude_ai_Atlassian_Rovo__search
  // JiraIssuesUsingJql») распирали строку и делали её нечитаемой на телефоне
  // (CTO 19.08). Показываем последний осмысленный сегмент, полное имя —
  // в подсказке и в шторке.
  function shortTool(name) {
    const n = String(name || '');
    if (!n.includes('__')) return n;
    const parts = n.split('__').filter(Boolean);
    return parts[parts.length - 1] || n;
  }

  // Что показать в строке вызова: у большинства это его аргументы как есть,
  // а у формы вопроса — сам вопрос. Сырой JSON «AskUserQuestion {"questions":
  // [{"question":…» в ленте не читался и дублировал форму (CTO 21.08).
  function inputOf(it) {
    if (it.name !== 'AskUserQuestion') return it.input;
    try {
      const q = JSON.parse(it.input)?.questions || [];
      const first = q[0]?.question || '';
      return q.length > 1 ? `${first} (+ ещё ${q.length - 1})` : first;
    } catch {
      // длинный ввод лента отдаёт обрезанным — JSON не собирается; тогда
      // вынимаем первый вопрос как есть, лишь бы не показывать скобки
      const m = String(it.input).match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)/);
      return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : it.input;
    }
  }

  // Раскрытое показываем целиком: сначала внутри своего скролл-контейнера
  // (пачка), потом страницей — чтобы не уехало под композер. Два кадра:
  // в первом Svelte дорисовывает содержимое, во втором высота настоящая.
  // Раскрыл — экран встаёт на начало раскрытого (отступ под липкую шапку
  // задан в CSS через scroll-margin-top).
  function revealPack(el) {
    if (!el) return;
    requestAnimationFrame(() => requestAnimationFrame(() =>
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })));
  }

  async function toggleAgent(a, open) {
    if (!open || agents[a.agentId] || !project || !sessionKey) return;
    agents[a.agentId] = 'loading';
    try {
      const r = await fetch(`/api/agent/${encodeURIComponent(project)}/${sessionKey}/${a.agentId}`);
      agents[a.agentId] = r.ok ? await r.json() : { error: (await r.json()).error };
    } catch (e) {
      agents[a.agentId] = { error: String(e.message || e) };
    }
  }
</script>

<div class="feed" class:nested={depth > 0}>
  {#each blocks as b, bi (bi)}
    {#if b.group && b.tools.length > 1}
      <!-- пачка технических действий: одна строка вместо стены плашек -->
      <!-- пачку раскрывает и «N действий», и чип типа; состояние держим
           сами: реактивный open перебивал нативный клик по summary -->
      <details class="toolpack" class:iserr={hasErr(b.tools)} open={!!packOpen[bi]}>
        <summary onclick={(e) => {
          e.preventDefault();
          const willOpen = !packOpen[bi];
          packOpen = { ...packOpen, [bi]: willOpen };
          if (!willOpen) packFilter = { ...packFilter, [bi]: null };
          // раскрытая пачка не должна остаться под композером
          if (willOpen) revealPack(e.currentTarget.parentElement);
        }}>
          <span class="tname"><Icon name="layers" size={13} /> {b.tools.length} действ{b.tools.length < 5 ? 'ия' : 'ий'}</span>
          <!-- типы = фильтры: клик открывает пачку и оставляет этот вид -->
          <span class="kinds">
            {#each groupKinds(b.tools) as k (k.name)}
              <button class="kind" class:on={packFilter[bi] === k.name}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const off = packFilter[bi] === k.name;
                  packFilter = { ...packFilter, [bi]: off ? null : k.name };
                  packOpen = { ...packOpen, [bi]: !off };
                  // как и «N действий»: раскрытое подкручиваем к глазам
                  if (!off) revealPack(e.currentTarget.closest('.toolpack'));
                }} title={k.name}>{shortTool(k.name)}{k.count > 1 ? ` ×${k.count}` : ''}</button>
            {/each}
          </span>
          {#if hasErr(b.tools)}<span class="terr">есть ошибка</span>{/if}
          <Icon name={packOpen[bi] ? 'chevron-up' : 'chevron-down'} size={14}
            class="text-ink-4 flex-none" />
        </summary>
        <div class="packbody">
          {#each b.tools.filter((t) => !packFilter[bi] || t.name === packFilter[bi]) as it (it)}
            {@const ag = agentOf(it)}
            {#if ag && openAgent}
              <!-- фоновый агент строкой: открывается той же шторкой -->
              <button class="tool agent agent-row" onclick={() => openAgent(ag)}>
                <span class="tname"><Icon name="bot" size={13} /> {ag.name || 'агент'}</span>
                <span class="tin">{ag.description || it.input}</span>
                {#if ag.busy}<span class="terr" style="color:var(--ok)">работает</span>{/if}
                <Icon name="chevron-right" size={14} class="text-ink-4 flex-none" />
              </button>
            {:else}
              {#if openTool}
                <button class="tool tool-row" class:iserr={it.is_error}
                  onclick={() => openTool(it)}>
                  <span class="tname" title={it.name}>{shortTool(it.name)}</span>
                  <span class="tin">{inputOf(it)}</span>
                  {#if it.is_error}<span class="terr">ошибка</span>{/if}
                  <Icon name="chevron-right" size={14} class="text-ink-4 flex-none" />
                </button>
              {:else}
                <details class="tool" class:iserr={it.is_error}
                  ontoggle={(e) => e.currentTarget.open && revealPack(e.currentTarget)}>
                  <summary>
                    <span class="tname" title={it.name}>{shortTool(it.name)}</span>
                    <span class="tin">{inputOf(it)}</span>
                    {#if it.is_error}<span class="terr">ошибка</span>{/if}
                  </summary>
                  {#if it.input}<div class="tout"><b>ввод</b><pre>{it.input}</pre></div>{/if}
                  <div class="tout"><b>вывод</b><pre>{it.result || '(пусто)'}</pre></div>
                </details>
              {/if}
            {/if}
          {/each}
        </div>
      </details>
    {:else}
      {@const it = b.group ? b.tools[0] : b.item}
    {#if it.kind === 'user' && it.system}
      <!-- служебная вставка рантайма, не реплика человека — свёрнутая плашка -->
      <details class="sysnote">
        <summary><Icon name="info" size={13} /> {it.system}</summary>
        <pre>{it.text}</pre>
      </details>
    {:else if it.kind === 'user'}
      <div class="user">
        <div class="bubble md-body">
          {@html md(it.text, tracker)}
          {#each it.images || [] as src}
            {#if src}
              <img class="shot" {src} alt="вложение из сообщения" loading="lazy"
                onerror={(e) => { e.currentTarget.replaceWith(
                  Object.assign(document.createElement('span'),
                    { className: 'imgs', textContent: 'вложение не открылось' })); }} />
            {:else}
              <span class="imgs"><Icon name="image" size={13} /> картинка (не показана: формат или размер)</span>
            {/if}
          {/each}
        </div>
      </div>
    {:else if it.kind === 'assistant'}
      <div class="assistant md-body">{@html md(it.text, tracker)}</div>
    {:else if it.kind === 'thinking'}
      <details class="think">
        <summary>мысли</summary>
        <div class="think-body md-body">{@html md(it.text, tracker)}</div>
      </details>
    {:else if it.kind === 'tool'}
      {#if it.agent && openAgent}
        <!-- Окно сессии умеет показать субагента шторкой во весь экран
             (mobile-first, CTO 19.08: вложенный аккордеон на телефоне
             нечитаем). Где шторки нет (главная) — старая раскрывашка ниже. -->
        <button class="tool agent agent-row" onclick={() => openAgent(it.agent)}>
          <span class="tname"><Icon name="bot" size={13} /> субагент</span>
          <span class="tin">{it.agent.name || it.agent.agentId}{it.agent.agentType ? ` · ${it.agent.agentType}` : ''}{it.agent.description ? ` — ${it.agent.description}` : ''}</span>
          {#if it.is_error}<span class="terr">ошибка</span>{/if}
          <Icon name="chevron-right" size={14} class="text-ink-4 flex-none" />
        </button>
      {:else if it.agent}
        <details class="tool agent"
          ontoggle={(e) => toggleAgent(it.agent, e.currentTarget.open)}>
          <summary>
            <span class="tname"><Icon name="bot" size={13} /> субагент</span>
            <span class="tin">{it.agent.name || it.agent.agentId}{it.agent.agentType ? ` · ${it.agent.agentType}` : ''}{it.agent.description ? ` — ${it.agent.description}` : ''}</span>
            {#if it.is_error}<span class="terr">ошибка</span>{/if}
          </summary>
          {#if agents[it.agent.agentId] === 'loading'}
            <p class="quiet pad">читаю транскрипт субагента…</p>
          {:else if agents[it.agent.agentId]?.items}
            <Self items={agents[it.agent.agentId].items} {project} {sessionKey} {tracker} depth={depth + 1} />
          {:else if agents[it.agent.agentId]?.error}
            <p class="err pad">{agents[it.agent.agentId].error}</p>
          {/if}
          {#if it.result}
            <div class="tout"><b>итог субагента</b><pre>{it.result}</pre></div>
          {/if}
        </details>
      {:else}
        {#if openTool}
          <button class="tool tool-row" class:iserr={it.is_error}
            onclick={() => openTool(it)}>
            <span class="tname" title={it.name}>{shortTool(it.name)}</span>
            <span class="tin">{inputOf(it)}</span>
            {#if it.is_error}<span class="terr">ошибка</span>{/if}
            <Icon name="chevron-right" size={14} class="text-ink-4 flex-none" />
          </button>
        {:else}
          <details class="tool" class:iserr={it.is_error}
            ontoggle={(e) => e.currentTarget.open && revealPack(e.currentTarget)}>
            <summary>
              <span class="tname" title={it.name}>{shortTool(it.name)}</span>
              <span class="tin">{inputOf(it)}</span>
              {#if it.is_error}<span class="terr">ошибка</span>{/if}
            </summary>
            {#if it.input}<div class="tout"><b>ввод</b><pre>{it.input}</pre></div>{/if}
            <div class="tout"><b>вывод</b><pre>{it.result || '(пусто)'}</pre></div>
          </details>
        {/if}
      {/if}
      {/if}
    {/if}
  {/each}
</div>

<style>
  .feed { display: flex; flex-direction: column; gap: 10px; }
  .feed.nested {
    margin: 8px 0 4px 14px; padding-left: 12px;
    border-left: 2px solid var(--border);
  }
  .user { display: flex; justify-content: flex-end; }
  .user .bubble {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r); padding: 8px 14px; max-width: 85%;
  }
  .user .imgs { display: block; color: var(--text-3); font-size: 12px; margin-top: 4px; }
  .user .shot {
    display: block; max-width: 100%; margin-top: 8px;
    border: 1px solid var(--border); border-radius: 8px;
  }
  .sysnote { color: var(--text-4); font-size: 12.5px; }
  .sysnote > summary { cursor: pointer; padding: 2px 0; }
  .sysnote pre {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 8px 10px; margin: 6px 0 0;
    font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap;
    max-height: 40vh; overflow: auto;
  }
  /* Оформление маркдауна — общее правило .md-body в app.css (там же его
     берёт просмотрщик файлов). Здесь только то, что про место в ленте. */
  .assistant { max-width: 100%; }
  /* вывод инструмента не растягивает ленту: своя рамка со скроллом
     (CTO 19.08 — «ls -la» на пол-экрана телефона) */
  .tout pre {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 10px 12px; overflow: auto;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.45;
    white-space: pre-wrap; margin: 6px 0;
    max-height: 34vh; overscroll-behavior: contain;
  }
  @media (min-width: 901px) { .tout pre { max-height: 44vh; } }
  .think { border-left: 2px solid var(--border-soft); padding-left: 10px; }
  .think > summary { color: var(--text-4); font-size: 12.5px; cursor: pointer; font-style: italic; }
  .think-body { color: var(--text-3); font-size: 13px; margin-top: 4px; }
  .tool, .toolpack {
    background: var(--bg-2); border: 1px solid var(--border-soft);
    border-radius: 8px; font-size: 13px;
    /* раскрытое встаёт под липкую шапку окна сессии, а не под неё */
    scroll-margin-top: calc(var(--bar-h, 0px) + 64px);
  }
  /* различие несёт цвет всей рамки: толстая полоса сбоку — узнаваемый
     признак ИИ-вёрстки (детектор impeccable, 11.08) */
  .tool.iserr { border-color: var(--hot); }
  .tool.agent { border-color: var(--accent); }
  .tool.agent > summary .tname { color: var(--accent); }
  /* строка действия — кнопка: тап открывает шторку с вводом и выводом
     (одно поведение на телефоне и на десктопе) */
  .tool-row {
    display: flex; gap: 8px; align-items: center; width: 100%;
    padding: 8px 10px; text-align: left; font: inherit; cursor: pointer;
    color: var(--text-1); min-height: var(--tap);
  }
  /* строка субагента как кнопка: тап открывает его ленту шторкой */
  .agent-row {
    display: flex; gap: 8px; align-items: center; width: 100%;
    padding: 8px 10px; text-align: left; font: inherit; cursor: pointer;
    color: var(--text-1); min-height: var(--tap);
  }
  .agent-row .tname { color: var(--accent); display: inline-flex; align-items: center; gap: 4px; }
  .tool > summary {
    display: flex; gap: 8px; align-items: baseline; cursor: pointer;
    padding: 6px 10px; min-width: 0;
  }
  /* у пачки строка выше: в ней живут чипы-фильтры */
  .toolpack > summary { align-items: center; }
  .tool[open] > summary { border-bottom: 1px solid var(--border-soft); }
  /* типы действий = фильтры: пилюли, чтобы читались кликабельными
     (CTO 19.08: слипшиеся «ReadBash ×3Agent ×3» никто не нажмёт) */
  .kinds { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0; }
  .kind {
    background: var(--bg-1); color: var(--text-3);
    border: 1px solid var(--border-soft); border-radius: 999px;
    padding: 1px 8px; font: inherit; font-family: var(--mono);
    font-size: 11.5px; cursor: pointer; white-space: nowrap;
    transition: color var(--t-fast), border-color var(--t-fast);
  }
  .kind:hover { color: var(--text-1); border-color: var(--border); }
  .kind.on { color: var(--accent); border-color: var(--accent); }
  .tname { font-family: var(--mono); font-size: 12px; color: var(--text-2); flex: none; }
  .tin {
    color: var(--text-4); font-family: var(--mono); font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  }
  .terr { color: var(--hot); font-size: 12px; flex: none; }
  .tout { padding: 4px 10px 8px; }
  .tout b { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-4); font-weight: 600; }
  .pad { padding: 8px 10px; }
  /* пачка действий: свёрнутая — одна строка; развёрнутая — те же плашки */
  .toolpack {
    background: var(--bg-2); border: 1px solid var(--border-soft);
    border-radius: 8px; font-size: 13px;
  }
  .toolpack.iserr { border-left: 1px solid var(--hot); }
  .toolpack > summary {
    display: flex; gap: 8px; align-items: baseline; cursor: pointer;
    padding: 6px 10px; min-width: 0; color: var(--text-3);
  }
  .toolpack[open] > summary { border-bottom: 1px solid var(--border-soft); }
  .packbody { display: flex; flex-direction: column; gap: 4px; padding: 6px; }
</style>
