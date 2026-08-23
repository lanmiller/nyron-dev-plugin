<script>
  // Сегментный переключатель пресетов — кирпич дизайн-системы пульта.
  // Импорт: `import { PresetSwitch } from '$lib/ui/preset-switch/index.js';`
  // Витрина: /design → «Пресеты запуска».
  //
  // Зачем свой, а не .seg из app.css: .seg — однострочная капсула масштабера
  // (одно слово в сегменте, выбран ровно один). Пресету нужны подпись «что
  // он делает», состояние «ни один не выбран» (человек покрутил чипы руками)
  // и клавиатура стрелками — это radiogroup, а не капсула вида.
  //
  // Выбранного нет — это НЕ ошибка: значит настройка своя, и переключатель
  // молчит вместо того, чтобы врать галочкой.
  import Icon from '$lib/Icon.svelte';

  let { value = $bindable(null), options = [], disabled = false,
    label = '', dense = false, onchange = null } = $props();

  let btns = $state([]);          // узлы сегментов — для стрелок клавиатуры

  function pick(o) {
    if (disabled || o.disabled) return;
    value = o.value;
    onchange?.(o.value);
  }
  // стрелки ходят по сегментам и сразу выбирают — поведение radiogroup
  function keys(e, i) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const live = options.map((o, k) => (o.disabled ? null : k)).filter((k) => k !== null);
    if (!live.length) return;
    const at = live.indexOf(i);
    const next = live[((at < 0 ? 0 : at + step) + live.length) % live.length];
    btns[next]?.focus();
    pick(options[next]);
  }
</script>

<div class="pset" class:dense role="radiogroup" aria-label={label} aria-disabled={disabled}>
  {#each options as o, i (o.value)}
    <button type="button" class="pset-seg" class:on={o.value === value}
      role="radio" aria-checked={o.value === value}
      disabled={disabled || o.disabled} title={o.title || o.desc || o.label}
      bind:this={btns[i]}
      onclick={() => pick(o)} onkeydown={(e) => keys(e, i)}>
      {#if o.icon}<Icon name={o.icon} size={14} class="flex-none" />{/if}
      <span class="pset-body">
        <b>{o.label}</b>
        {#if o.desc}<span class="pset-desc">{o.desc}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  /* поверхность глубины + пилюля — та же геометрия, что у .seg (app.css),
     чтобы два переключателя пульта не выглядели из разных систем */
  .pset {
    display: flex; flex-wrap: wrap; gap: 2px;
    background: var(--bg-0); border: 1px solid var(--border);
    border-radius: var(--r-lg); padding: 2px;
  }
  .pset[aria-disabled='true'] { opacity: 0.5; }
  .pset-seg {
    display: flex; align-items: center; gap: var(--sp-3);
    flex: 1 1 auto; min-width: 0;
    background: none; border: 1px solid transparent; border-radius: var(--r);
    color: var(--text-3); font: inherit; text-align: left;
    padding: var(--sp-3) var(--sp-5); min-height: var(--tap);
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .pset-seg:hover:not(:disabled) { color: var(--text-1); background: var(--bg-2); }
  .pset-seg:active:not(:disabled) { background: var(--bg-3); }
  .pset-seg:disabled { opacity: 0.45; cursor: default; }
  /* выбранный — приподнятая поверхность и акцентная кромка (тот же язык,
     что .seg button.on и .pick-row.on) */
  .pset-seg.on {
    background: var(--bg-3); color: var(--text-1);
    border-color: color-mix(in oklab, var(--accent) 55%, transparent);
  }
  .pset-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .pset-body b { font-weight: 500; font-size: var(--fs-sm); white-space: nowrap; }
  .pset-desc {
    color: var(--text-4); font-size: var(--fs-micro);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pset-seg.on .pset-desc { color: var(--text-3); }
  /* узкий экран: остаются названия, подпись прячется — иначе три сегмента
     разъезжают форму за 375px (проверка волны на 375) */
  @media (max-width: 520px) {
    .pset-desc { display: none; }
    .pset-seg { padding: var(--sp-3) var(--sp-4); }
    .pset-body b { font-size: var(--fs-xs); white-space: normal; }
  }
  @media (pointer: fine) {
    .pset-seg { min-height: 0; }
  }
  /* плотный вариант — для рядов, где переключатель не главный элемент */
  .dense .pset-seg { padding: var(--sp-2) var(--sp-4); }
</style>
