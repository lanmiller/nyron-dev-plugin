<script>
  // Главная: «Ждут вас» + доставка ответов + шина активного проекта.
  // Сессии и состояния сторожа — в сайдбаре (клик по строке = окно сессии).
  import { getContext } from 'svelte';
  import AskCard from '$lib/AskCard.svelte';
  import { age } from '$lib/states.js';

  const st = getContext('morda');
  const active = getContext('morda-project');

  let project = $derived(st.overview?.projects?.find((p) => p.name === active.name));
  let openAsks = $derived((project?.asks || []).filter((a) => a.status === 'open'));
  let pendingAsks = $derived((project?.asks || []).filter((a) => a.status !== 'open'));
</script>

{#if project}
  {#if project.error}<p class="err">{project.name}: {project.error}</p>{/if}

  <h1>{project.name}</h1>

  <section>
    <h2>Ждут вас {#if openAsks.length}<span class="badge">{openAsks.length}</span>{/if}</h2>
    {#if !openAsks.length}
      <p class="quiet">Открытых решений нет.</p>
    {/if}
    {#each openAsks as a (a.id)}
      <AskCard ask={a} project={project.name} />
    {/each}
  </section>

  {#if pendingAsks.length}
    <section>
      <h2>Доставка ответов</h2>
      {#each pendingAsks as a (a.id)}
        <AskCard ask={a} project={project.name} />
      {/each}
    </section>
  {/if}

  <section>
    <h2>Шина</h2>
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
  h1 { font-size: 26px; margin: 4px 0 6px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-3); margin: 26px 0 10px; font-weight: 600;
  }
  .badge {
    background: var(--accent); color: var(--accent-ink); border-radius: var(--r-pill);
    font-size: 10.5px; font-weight: 700; padding: 1px 7px; vertical-align: middle;
  }
  .feed { list-style: none; padding: 0; margin: 0; }
  .feed li { padding: 7px 0; border-bottom: 1px solid var(--border-soft); }
  .feed .meta { color: var(--text-3); font-size: 12.5px; }
  .feed p {
    margin: 2px 0 0; font-size: 13.5px; color: var(--text-2);
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
</style>
