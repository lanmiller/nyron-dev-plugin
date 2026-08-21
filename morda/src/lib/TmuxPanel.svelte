<script>
  // Живой терминал сессии с управлением пальцем (CTO 20.08: «везде, где
  // есть tmux-сессия, нужны стрелки, Enter и Esc — чтобы поуправлять даже
  // с телефона»). Экран приходит текстом, клавиши уезжают наружу через
  // onKey — панель одинакова и для слотов подписок, и для сессий раннера.
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';

  let { screen = '', tmux = null, onKey = null, onType = null, busy = false,
    error = null, extra = null } = $props();

  // Экран приходит с ANSI-кодами (capture-pane -e). Красить весь терминал
  // палитрой пульта нечестно, но одно различие обязано выжить: серые
  // подсказки CLI (fg 38;5;232-253, 90, dim) против набранного человеком
  // (дефолтный цвет) — подсказку дважды принимали за неотправленное
  // сообщение и жали Enter впустую (CTO 21.08). Прочие коды снимаются.
  const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
  const ESC_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b./g;
  const isGrey = (n) => n === 8 || (n >= 232 && n <= 253);
  function segments(raw) {
    const txt = String(raw || '').replace(OSC_RE, '');
    const out = [];
    let ghost = false, buf = '', i = 0, m;
    const push = () => { if (buf) out.push({ t: buf, ghost }); buf = ''; };
    while ((m = ESC_RE.exec(txt))) {
      buf += txt.slice(i, m.index);
      i = ESC_RE.lastIndex;
      if (m[1] === undefined) continue;              // не-SGR код — выкинуть
      const c = m[1] === '' ? [0] : m[1].split(';').map(Number);
      let g = ghost;
      for (let k = 0; k < c.length; k++) {
        if (c[k] === 0 || c[k] === 22 || c[k] === 39) g = false;
        else if (c[k] === 2 || c[k] === 90) g = true;
        else if ((c[k] >= 30 && c[k] <= 37) || (c[k] >= 91 && c[k] <= 97)) g = false;
        else if (c[k] === 38 && c[k + 1] === 5) { g = isGrey(c[k + 2]); k += 2; }
        else if (c[k] === 38 && c[k + 1] === 2) { g = false; k += 4; }
      }
      if (g !== ghost) { push(); ghost = g; }
    }
    buf += txt.slice(i);
    push();
    return out;
  }
  let segs = $derived(segments(screen));

  // ввод текста прямо в терминал: клавиш мало, когда нужно набрать команду
  // или ответ (CTO 20.08 — «ввод не пашет»)
  let line = $state('');
  async function send() {
    const t = line;
    if (!t.trim() || !onType) return;
    line = '';
    await onType(t);
  }

  // Живой режим (десктоп): экран ловит фокус и принимает НАСТОЯЩИЕ нажатия —
  // буквы, Backspace, Ctrl-сочетания. Кнопки-стрелки остаются для телефона,
  // где физической клавиатуры нет (CTO 21.08: «на десктопе кнопки — костыль,
  // нужен нормальный контроль как в живом терминале»).
  let live = $state(false);
  let screenEl = $state(null);
  let buf = '';               // печатаемые символы копим и шлём пачкой
  let flushT = null;
  function flush() {
    const t = buf; buf = ''; flushT = null;
    if (t && onType) onType(t, { enter: false });
  }
  // имена клавиш у tmux свои — переводим раскладку браузера в его словарь
  const NAMED = {
    Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace',
    Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
    ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage',
  };
  const CTRL_OK = new Set(['a', 'c', 'e', 'k', 'l', 'r', 'u', 'w']);
  function onKeydown(e) {
    if (!live || !onKey) return;
    if (e.metaKey) return;                       // ⌘C/⌘V — браузеру, не сессии
    if (e.ctrlKey) {
      const c = e.key.toLowerCase();
      if (!CTRL_OK.has(c)) return;               // прочее (в т.ч. Ctrl-D) не шлём
      e.preventDefault(); flush(); onKey(`C-${c}`); return;
    }
    const named = e.shiftKey && e.key === 'Tab' ? 'BTab' : NAMED[e.key];
    if (named) { e.preventDefault(); flush(); onKey(named); return; }
    if (e.key.length === 1) {                    // обычный символ — в пачку
      e.preventDefault();
      buf += e.key;
      clearTimeout(flushT);
      flushT = setTimeout(flush, 90);
    }
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
  <div class="screen-wrap">
    <pre class="cli-screen" class:live tabindex="0" bind:this={screenEl}
      onkeydown={onKeydown}
      onfocus={() => (live = !!onKey)}
      onblur={() => { flush(); live = false; }}
      role="textbox" aria-label="экран терминала — кликни, чтобы печатать прямо в сессию"
    >{#if !screen}читаю экран…{:else}{#each segs as s}{#if s.ghost}<span class="ghost">{s.t}</span>{:else}{s.t}{/if}{/each}{/if}</pre>
    {#if onKey}
      <button class="live-hint" onclick={() => screenEl?.focus()}>
        {live ? 'печатаешь прямо в сессию · Esc-ом не выйти, кликни мимо'
          : 'кликни по экрану — и печатай как в терминале'}
      </button>
    {/if}
  </div>
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
  /* Живой режим: экран сам ловит клавиши. Рамка показывает, что фокус тут и
     нажатия уходят в сессию, а не в браузер. */
  .screen-wrap { position: relative; }
  .cli-screen:focus { outline: none; }
  /* серое CLI (подсказки, рамки, хвост статуса) остаётся приглушённым —
     как в настоящем терминале; набранное человеком — обычным цветом */
  .ghost { color: var(--text-4); }
  .cli-screen.live { box-shadow: inset 0 0 0 2px var(--accent, var(--primary)); }
  .live-hint {
    display: block; width: 100%; margin-top: var(--sp-2); padding: 0;
    background: none; border: 0; text-align: left; cursor: pointer;
    color: var(--text-4); font: inherit; font-size: var(--fs-xs);
  }
  .cli-screen.live + .live-hint { color: var(--accent, var(--primary)); }

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
