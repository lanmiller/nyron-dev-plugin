<script>
  // Лента транскрипта: реплики (маркдаун), мысли (свёрнуты), плашки
  // инструментов (свёрнуты, разворачиваются в ввод+вывод), субагенты —
  // плашка Agent разворачивается во вложенный транскрипт (дерево).
  import Self from './Transcript.svelte';
  import { md, esc } from '$lib/md.js';

  let { items, project = null, sessionKey = null, depth = 0 } = $props();

  let agents = $state({}); // agentId → { items } | { error } | 'loading'

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
  {#each items as it, i (i)}
    {#if it.kind === 'user' && it.system}
      <!-- служебная вставка рантайма, не реплика человека — свёрнутая плашка -->
      <details class="sysnote">
        <summary>⚙ {it.system}</summary>
        <pre>{it.text}</pre>
      </details>
    {:else if it.kind === 'user'}
      <div class="user">
        <div class="bubble">
          {@html md(it.text)}
          {#each it.images || [] as src}
            {#if src}
              <img class="shot" {src} alt="вложение" loading="lazy" />
            {:else}
              <span class="imgs">🖼 картинка (не показана: формат или размер)</span>
            {/if}
          {/each}
        </div>
      </div>
    {:else if it.kind === 'assistant'}
      <div class="assistant">{@html md(it.text)}</div>
    {:else if it.kind === 'thinking'}
      <details class="think">
        <summary>мысли</summary>
        <div class="think-body">{@html md(it.text)}</div>
      </details>
    {:else if it.kind === 'tool'}
      {#if it.agent}
        <details class="tool agent"
          ontoggle={(e) => toggleAgent(it.agent, e.currentTarget.open)}>
          <summary>
            <span class="tname">⛭ субагент</span>
            <span class="tin">{it.agent.name || it.agent.agentId}{it.agent.agentType ? ` · ${it.agent.agentType}` : ''}{it.agent.description ? ` — ${it.agent.description}` : ''}</span>
            {#if it.is_error}<span class="terr">ошибка</span>{/if}
          </summary>
          {#if agents[it.agent.agentId] === 'loading'}
            <p class="quiet pad">читаю транскрипт субагента…</p>
          {:else if agents[it.agent.agentId]?.items}
            <Self items={agents[it.agent.agentId].items} {project} {sessionKey} depth={depth + 1} />
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
  .assistant { max-width: 100%; overflow-wrap: break-word; }
  .assistant :global(p), .user :global(p) { margin: 0 0 8px; }
  .assistant :global(p:last-child), .user :global(p:last-child) { margin-bottom: 0; }
  .assistant :global(h4) { margin: 12px 0 4px; font-size: 15px; }
  .assistant :global(pre), .think-body :global(pre), .tout pre {
    background: var(--bg-0); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 10px 12px; overflow-x: auto;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.45;
    white-space: pre-wrap; margin: 6px 0;
  }
  .assistant :global(code), .user :global(code) {
    background: var(--bg-0); border-radius: 4px; padding: 1px 5px;
    font-family: var(--mono); font-size: 0.88em;
  }
  .assistant :global(blockquote) {
    margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--border);
    color: var(--text-2);
  }
  .assistant :global(a) { color: var(--accent); }
  .think { border-left: 2px solid var(--border-soft); padding-left: 10px; }
  .think > summary { color: var(--text-4); font-size: 12.5px; cursor: pointer; font-style: italic; }
  .think-body { color: var(--text-3); font-size: 13px; margin-top: 4px; }
  .tool {
    background: var(--bg-2); border: 1px solid var(--border-soft);
    border-radius: 8px; font-size: 13px;
  }
  .tool.iserr { border-left: 3px solid var(--hot); }
  .tool.agent { border-left: 3px solid var(--accent); }
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
</style>
