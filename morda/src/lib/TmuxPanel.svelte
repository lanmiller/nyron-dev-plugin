<script>
  // Живой терминал сессии с управлением пальцем (CTO 20.08: «везде, где
  // есть tmux-сессия, нужны стрелки, Enter и Esc — чтобы поуправлять даже
  // с телефона»). Экран приходит текстом, клавиши уезжают наружу через
  // onKey — панель одинакова и для слотов подписок, и для сессий раннера.
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';

  let { screen = '', tmux = null, onKey = null, busy = false,
    error = null, extra = null } = $props();

  // порядок кнопок — как на клавиатуре: навигация, потом подтверждение
  const KEYS = [
    ['Up', '↑', 'вверх'],
    ['Down', '↓', 'вниз'],
    ['Left', '←', 'влево'],
    ['Right', '→', 'вправо'],
    ['Tab', 'Tab', 'следующее поле'],
    ['Enter', 'Enter', 'подтвердить'],
    ['Escape', 'Esc', 'отменить / закрыть'],
  ];
</script>

{#if error}
  <p class="err">{error}</p>
{:else}
  <pre class="cli-screen">{screen || 'читаю экран…'}</pre>
  <div class="keys">
    {#each KEYS as [k, label, title] (k)}
      <button class="tkey" {title} disabled={busy || !onKey} onclick={() => onKey?.(k)}>{label}</button>
    {/each}
  </div>
  <div class="tfoot">
    {#if extra}{@render extra()}{/if}
    {#if tmux}<span class="quiet mono">tmux attach -t {tmux}</span>{/if}
  </div>
{/if}

<style>
  /* клавиши крупные: это единственный способ управлять сессией с телефона */
  .keys {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: var(--sp-2); margin-top: var(--sp-4);
  }
  .tkey {
    min-height: 44px; background: var(--bg-2); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    font: inherit; font-size: var(--fs-sm); cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast);
  }
  .tkey:hover:not(:disabled) { border-color: var(--accent); }
  .tkey:active:not(:disabled) { background: var(--bg-1); }
  .tkey:disabled { opacity: 0.45; cursor: default; }
  .tfoot {
    display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
    margin-top: var(--sp-3); font-size: var(--fs-xs);
  }
  .tfoot .mono { color: var(--text-4); margin-left: auto; }
</style>
