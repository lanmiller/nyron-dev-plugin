<script>
  // Чип-пилюля с выбором значения — референс композера Claude (скрины CTO
  // 17.08). Строка выбора = название + описание + галочка; на телефоне
  // варианты выезжают шторкой снизу (лучший мобильный паттерн выбора),
  // на десктопе — компактным меню у чипа.
  //
  // Вложенный параметр (sub*, например Effort внутри выбора модели — как в
  // приложении Claude): на десктопе — подменю, на мобилке — второй экран
  // шторки с «назад».
  import Icon from '$lib/Icon.svelte';
  import * as DropdownMenu from '$lib/ui/dropdown-menu/index.js';
  import * as Sheet from '$lib/ui/sheet/index.js';

  let { value = $bindable(), options = [], title = '', icon = null,
    disabled = false,
    subValue = $bindable(null), subOptions = [], subTitle = '',
    subLabel = '', subIcon = null } = $props();
  let current = $derived(options.find((o) => o.value === value));
  let subCurrent = $derived(subOptions.find((o) => o.value === subValue));

  // та же граница, что у сайдбара (901px): до неё — палец, после — мышь
  let mobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const set = () => (mobile = mq.matches);
    set();
    mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  });
  let open = $state(false);
  let view = $state('main'); // main | sub (экран шторки)
  $effect(() => { if (!open) view = 'main'; });
  function pick(o) {
    if (o.disabled) return;
    value = o.value;
    open = false;
  }
  function pickSub(o) {
    if (o.disabled) return;
    subValue = o.value;
    view = 'main';
  }
</script>

{#snippet chip(props = {})}
  <button class="chip" {...props} {disabled} title={title}>
    {#if current?.icon || icon}<Icon name={current?.icon || icon} size={13} />{/if}
    <span>{current?.label ?? value}</span>
    <Icon name="chevron-down" size={12} class="text-ink-4" />
  </button>
{/snippet}

{#snippet row(o, on, handler, size = 17)}
  <button class="pick-row" class:on disabled={o.disabled} onclick={handler}>
    {#if o.icon}<Icon name={o.icon} size={size} class="flex-none" />{/if}
    <span class="pick-body">
      <b>{o.label}</b>
      {#if o.desc}<span class="pick-desc">{o.desc}</span>{/if}
    </span>
    {#if on}<Icon name="check" size={size} class="text-primary flex-none" />{/if}
  </button>
{/snippet}

{#if mobile}
  <Sheet.Root bind:open>
    <Sheet.Trigger {disabled}>
      {#snippet child({ props })}{@render chip(props)}{/snippet}
    </Sheet.Trigger>
    <Sheet.Content side="bottom" class="pick-sheet">
      <Sheet.Header class="pick-head">
        {#if view === 'sub'}
          <button class="back" onclick={() => (view = 'main')} aria-label="назад">
            <Icon name="arrow-left" size={18} />
          </button>
        {/if}
        <Sheet.Title>{view === 'sub' ? subTitle : title}</Sheet.Title>
      </Sheet.Header>
      <div class="pick-list">
        {#if view === 'main'}
          {#each options as o (o.value)}
            {@render row(o, o.value === value, () => pick(o))}
          {/each}
          {#if subOptions.length}
            <button class="pick-row sub-link" onclick={() => (view = 'sub')}>
              {#if subIcon}<Icon name={subIcon} size={17} class="flex-none" />{/if}
              <span class="pick-body">
                <b>{subLabel}</b>
                <span class="pick-desc accent">{subCurrent?.label ?? subValue}</span>
              </span>
              <Icon name="chevron-right" size={17} class="text-ink-4 flex-none" />
            </button>
          {/if}
        {:else}
          {#each subOptions as o (o.value)}
            {@render row(o, o.value === subValue, () => pickSub(o))}
          {/each}
        {/if}
      </div>
    </Sheet.Content>
  </Sheet.Root>
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger {disabled}>
      {#snippet child({ props })}{@render chip(props)}{/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="min-w-64">
      {#if title}<DropdownMenu.Label>{title}</DropdownMenu.Label>{/if}
      <DropdownMenu.RadioGroup bind:value>
        {#each options as o (o.value)}
          <DropdownMenu.RadioItem value={o.value} disabled={o.disabled} class="pick-item">
            {#if o.icon}<Icon name={o.icon} size={15} class="flex-none" />{/if}
            <span class="pick-body">
              <b>{o.label}</b>
              {#if o.desc}<span class="pick-desc">{o.desc}</span>{/if}
            </span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
      {#if subOptions.length}
        <DropdownMenu.Separator />
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger class="pick-item">
            {#if subIcon}<Icon name={subIcon} size={15} class="flex-none" />{/if}
            <span class="pick-body">
              <b>{subLabel}</b>
              <span class="pick-desc accent">{subCurrent?.label ?? subValue}</span>
            </span>
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class="min-w-56">
            {#if subTitle}<DropdownMenu.Label>{subTitle}</DropdownMenu.Label>{/if}
            <DropdownMenu.RadioGroup bind:value={subValue}>
              {#each subOptions as o (o.value)}
                <DropdownMenu.RadioItem value={o.value} disabled={o.disabled} class="pick-item">
                  <span class="pick-body">
                    <b>{o.label}</b>
                    {#if o.desc}<span class="pick-desc">{o.desc}</span>{/if}
                  </span>
                </DropdownMenu.RadioItem>
              {/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  .chip {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    background: var(--bg-2); color: var(--text-2);
    border: 1px solid var(--border-soft); border-radius: 999px;
    padding: var(--sp-2) var(--sp-4); cursor: pointer;
    font: inherit; font-size: var(--fs-xs);
    transition: color var(--t-fast), border-color var(--t-fast);
  }
  .chip:hover:not(:disabled) { color: var(--text-1); border-color: var(--border); }
  .chip:focus-visible { outline: none; border-color: var(--accent); color: var(--text-1); }
  .chip:disabled { opacity: 0.5; cursor: default; }
  /* палец: чип 28–30px не дотягивал до --tap 44 (аудит 19.08) — пилюля чуть
     выше, остаток добит невидимой хит-зоной по вертикали (соседей в ряду
     не перекрывает: по горизонтали зона не растёт) */
  @media (pointer: coarse) {
    .chip { position: relative; padding-top: var(--sp-3); padding-bottom: var(--sp-3); }
    .chip::after { content: ''; position: absolute; inset: -6px 0; }
  }

  /* строка меню на десктопе: две строки текста, галочку рисует RadioItem */
  :global(.pick-item) { align-items: flex-start; padding-top: var(--sp-3); padding-bottom: var(--sp-3); }
  .pick-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .pick-body b { font-weight: 500; }
  .pick-desc { color: var(--text-3); font-size: var(--fs-xs); }
  .pick-desc.accent { color: var(--accent); }

  /* шторка снизу: скруглённый верх, крупные цели пальца, «назад» на
     втором экране */
  :global(.pick-sheet) {
    border-radius: var(--r-lg) var(--r-lg) 0 0;
    padding-bottom: calc(var(--sp-5) + var(--safe-b));
  }
  :global(.pick-head) { flex-direction: row; align-items: center; gap: var(--sp-3); }
  .back {
    background: none; border: 0; color: var(--text-2); padding: var(--sp-2);
    display: grid; place-items: center; cursor: pointer;
  }
  .pick-list { display: flex; flex-direction: column; gap: var(--sp-2); padding: 0 var(--sp-5); }
  .pick-row {
    display: flex; align-items: flex-start; gap: var(--sp-4); width: 100%;
    background: var(--bg-2); color: var(--text-1); text-align: left;
    border: 1px solid transparent; border-radius: var(--r);
    padding: var(--sp-4) var(--sp-5); font: inherit; font-size: var(--fs-sm);
    min-height: var(--tap);
  }
  .pick-row.on { border-color: var(--accent); }
  .pick-row:disabled { opacity: 0.5; }
  .sub-link .pick-body b { font-weight: 500; }
</style>
