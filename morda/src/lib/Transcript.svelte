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
    openAgent = null } = $props();

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
  function groupLabel(tools) {
    const by = new Map();
    for (const t of tools) by.set(t.name, (by.get(t.name) || 0) + 1);
    return [...by].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
  }
  const hasErr = (tools) => tools.some((t) => t.is_error);

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
      <details class="toolpack" class:iserr={hasErr(b.tools)}>
        <summary>
          <span class="tname"><Icon name="layers" size={13} /> {b.tools.length} действ{b.tools.length < 5 ? 'ия' : 'ий'}</span>
          <span class="tin">{groupLabel(b.tools)}</span>
          {#if hasErr(b.tools)}<span class="terr">есть ошибка</span>{/if}
        </summary>
        <div class="packbody">
          {#each b.tools as it (it)}
            <details class="tool" class:iserr={it.is_error}>
              <summary>
                <span class="tname">{it.name}</span>
                <span class="tin">{it.input}</span>
                {#if it.is_error}<span class="terr">ошибка</span>{/if}
              </summary>
              {#if it.input}<div class="tout"><b>ввод</b><pre>{it.input}</pre></div>{/if}
              <div class="tout"><b>вывод</b><pre>{it.result || '(пусто)'}</pre></div>
            </details>
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
        <details class="tool" class:iserr={it.is_error}>
          <summary>
            <span class="tname">{it.name}</span>
            <span class="tin">{it.input}</span>
            {#if it.is_error}<span class="terr">ошибка</span>{/if}
          </summary>
          {#if it.input}<div class="tout"><b>ввод</b><pre>{it.input}</pre></div>{/if}
          <div class="tout"><b>вывод</b><pre>{it.result || '(пусто)'}</pre></div>
        </details>
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
  .tout pre {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 10px 12px; overflow-x: auto;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.45;
    white-space: pre-wrap; margin: 6px 0;
  }
  .think { border-left: 2px solid var(--border-soft); padding-left: 10px; }
  .think > summary { color: var(--text-4); font-size: 12.5px; cursor: pointer; font-style: italic; }
  .think-body { color: var(--text-3); font-size: 13px; margin-top: 4px; }
  .tool {
    background: var(--bg-2); border: 1px solid var(--border-soft);
    border-radius: 8px; font-size: 13px;
  }
  /* различие несёт цвет всей рамки: толстая полоса сбоку — узнаваемый
     признак ИИ-вёрстки (детектор impeccable, 11.08) */
  .tool.iserr { border-color: var(--hot); }
  .tool.agent { border-color: var(--accent); }
  .tool.agent > summary .tname { color: var(--accent); }
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
  .tool[open] > summary { border-bottom: 1px solid var(--border-soft); }
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
