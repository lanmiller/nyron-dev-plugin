<script>
  // Граф коммитов: дорожки веток SVG-полилиниями, без библиотек (мандат
  // CTO 22.08). Раскладку по колонкам считает сервер (git.js/graph):
  // здесь только геометрия — сегменты между соседними рядами.
  //
  // Правило сегмента: дорожка, НЕ тронутая коммитом ряда, идёт вертикально;
  // тронутая (продолжение первого родителя, новая колонка второго родителя
  // мержа) начинается от точки коммита; дорожка, чей ожидаемый sha — следующий
  // коммит, сходится в его точку. Этого достаточно для мержей и ветвлений.
  import Icon from '$lib/Icon.svelte';

  let { commits = [], laneCount = 1, selected = null, onselect = () => {} } = $props();

  const RH = 30;                 // высота ряда — синхронна .gg-row в app.css
  const LW = 13;                 // шаг дорожки
  const PAD = 10;
  // цвета дорожек — смысловые токены лока по кругу
  const COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--stall)', 'var(--dead)'];
  const col = (j) => COLORS[j % COLORS.length];
  const px = (j) => PAD + j * LW;
  const py = (i) => i * RH + RH / 2;

  let W = $derived(PAD * 2 + Math.max(0, laneCount - 1) * LW);
  let H = $derived(commits.length * RH);

  let segs = $derived.by(() => {
    const out = [];
    commits.forEach((c, i) => {
      const prev = i ? commits[i - 1].snapshot : [];
      const next = commits[i + 1];
      c.snapshot.forEach((sha, j) => {
        if (!sha) return;
        const x1 = prev[j] === sha ? j : c.lane;
        const x2 = next && sha === next.sha ? next.lane : j;
        out.push({ y1: py(i), y2: py(i + 1), x1: px(x1), x2: px(x2), c: col(j) });
      });
    });
    return out;
  });

  // Ветки на коммите: HEAD и локальные — акцентом, удалённые — тише.
  // Показываем не больше трёх (main с кучей claude/*-веток разваливал ряд),
  // остальное — счётчиком, полный список в title ряда.
  function refBadges(c) {
    const all = c.refs.map((r) => ({
      name: r.replace(/^HEAD -> /, ''),
      head: r.startsWith('HEAD'),
      remote: /^(origin|upstream)\//.test(r.replace(/^HEAD -> /, '')),
    })).filter((r, idx, a) => a.findIndex((x) => x.name === r.name) === idx)
      .sort((a, b) => (b.head - a.head) || (a.remote - b.remote));
    return { shown: all.slice(0, 3), more: Math.max(0, all.length - 3) };
  }
</script>

<div class="ggraph">
  <div class="gg-inner" style="padding-left:{W}px">
    <svg width={W} height={H} aria-hidden="true">
      {#each segs as s}
        <polyline points="{s.x1},{s.y1} {s.x1},{s.y1 + 8} {s.x2},{s.y2 - 8} {s.x2},{s.y2}"
          fill="none" stroke={s.c} stroke-width="2" />
      {/each}
      {#each commits as c, i}
        <circle cx={px(c.lane)} cy={py(i)} r={c.parents.length > 1 ? 3 : 4}
          fill={c.parents.length > 1 ? 'var(--bg-1)' : col(c.lane)}
          stroke={col(c.lane)} stroke-width="2" />
      {/each}
    </svg>
    {#each commits as c, i (c.sha)}
      {@const rb = refBadges(c)}
      <button class="gg-row" class:active={selected === c.sha} onclick={() => onselect(c)}
        title="{c.sha.slice(0, 8)} · {c.author} · {c.date}{c.refs.length ? '\n' + c.refs.join('\n') : ''}">
        {#each rb.shown as r (r.name)}
          <span class="gg-ref" class:remote={r.remote} title={r.name}>
            {#if r.head}<Icon name="check" size={10} />{/if}{r.name}</span>
        {/each}
        {#if rb.more}<span class="gg-ref remote">+{rb.more}</span>{/if}
        <span class="subj">{c.subject}</span>
        <span class="quiet mono sha">{c.sha.slice(0, 7)}</span>
        <span class="trail">{c.author.split(' ')[0]} · {c.date}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  /* Узко — граф катается внутри себя (страница вбок не едет, 375px);
     широко — ряд занимает панель и тема коммита режется многоточием. */
  .ggraph { overflow-x: auto; }
  .gg-inner { position: relative; min-width: 560px; }
  .subj { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 12ch; }
  svg { position: absolute; left: 0; top: 0; }
  .subj { color: var(--text-1); }
  .sha, .trail { flex: none; font-size: var(--fs-xs); color: var(--text-4); }
</style>
