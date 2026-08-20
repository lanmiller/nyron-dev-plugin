<script>
  // Живой терминал сессии с управлением пальцем (CTO 20.08: «везде, где
  // есть tmux-сессия, нужны стрелки, Enter и Esc — чтобы поуправлять даже
  // с телефона»). Экран приходит текстом, клавиши уезжают наружу через
  // onKey — панель одинакова и для слотов подписок, и для сессий раннера.
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';

  let { screen = '', tmux = null, onKey = null, onType = null, busy = false,
    error = null, extra = null } = $props();

  // ввод текста прямо в терминал: клавиш мало, когда нужно набрать команду
  // или ответ (CTO 20.08 — «ввод не пашет»)
  let line = $state('');
  async function send() {
    const t = line;
    if (!t.trim() || !onType) return;
    line = '';
    await onType(t);
  }

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
  {#if onType}
    <div class="tinput">
      <input placeholder="набрать в терминал…" bind:value={line} disabled={busy}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      <button class="tsend" disabled={busy || !line.trim()} onclick={send}
        aria-label="отправить в терминал" title="отправить (Enter)">
        <Icon name="corner-down-left" size={15} />
      </button>
    </div>
  {/if}
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
  /* строка ввода: то же поле, что в композере, но уходит прямо в tmux */
  .tinput { display: flex; gap: var(--sp-2); margin-top: var(--sp-4); }
  .tinput input {
    flex: 1; min-width: 0; min-height: 44px;
    background: var(--bg-0); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--sp-2) var(--sp-4); font: inherit; font-size: var(--fs-sm);
  }
  .tsend {
    flex: none; width: 44px; min-height: 44px; border-radius: var(--r-sm);
    background: var(--accent); color: var(--accent-ink); border: 0;
    display: grid; place-items: center; cursor: pointer;
  }
  .tsend:disabled { opacity: 0.4; cursor: default; }
  .tfoot {
    display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
    margin-top: var(--sp-3); font-size: var(--fs-xs);
  }
  .tfoot .mono { color: var(--text-4); margin-left: auto; }
</style>
