<script>
  // Витрина дизайн-системы: все токены и компоненты рядом, чтобы крутить
  // оформление глазами и собирать новые панели из готовых кирпичей, а не
  // рисовать стили заново в каждом файле (аудит 11.08 — 42/100).
  let busy = $state(false);
  let val = $state('');
  let picked = $state('панель');

  const SURFACES = [
    ['--bg-0', 'глубина: сайдбар, поля, код'],
    ['--bg-1', 'холст'],
    ['--bg-2', 'карточки и панели'],
    ['--bg-3', 'наведение / нажатое'],
    ['--border', 'граница'],
    ['--border-soft', 'мягкая граница'],
  ];
  const INK = [
    ['--text-1', 'основной'], ['--text-2', 'вторичный'],
    ['--text-3', 'подписи'], ['--text-4', 'приглушённый'],
  ];
  const MEANING = [
    ['--accent', 'бренд / активное / блокирующее'],
    ['--ok', 'успех, доставлено'],
    ['--warn', 'ждёт решения'],
    ['--hot', 'ошибка, молчит'],
    ['--stall', 'застряла'],
    ['--dead', 'закончилась'],
  ];
  const TYPE = [
    ['--fs-hero', 'имя проекта', 26],
    ['--fs-xl', 'заголовок окна сессии', 20],
    ['--fs-lg', 'заголовок панели, вопрос', 16],
    ['--fs-md', 'тело интерфейса', 14],
    ['--fs-sm', 'плотные списки, дерево', 13],
    ['--fs-xs', 'мета, техстроки', 12],
    ['--fs-micro', 'бейджи, надзаголовки', 11],
  ];
  const SPACE = [['--sp-1', 2], ['--sp-2', 4], ['--sp-3', 6], ['--sp-4', 8],
    ['--sp-5', 10], ['--sp-6', 14], ['--sp-7', 20], ['--sp-8', 28]];
</script>

<svelte:head><title>Дизайн-система — STOVP</title></svelte:head>

<header class="head">
  <h1>Дизайн-система</h1>
  <p class="quiet">
    Кирпичи, из которых собираются панели STOVP. Правило: локальные стили —
    только про раскладку; всё остальное берётся отсюда.
  </p>
</header>

<section>
  <h2 class="eyebrow">Поверхности</h2>
  <div class="swatches">
    {#each SURFACES as [tok, use]}
      <div class="sw"><i style="background: var({tok})"></i><b class="mono">{tok}</b><span class="quiet">{use}</span></div>
    {/each}
  </div>

  <h2 class="eyebrow">Текст</h2>
  <div class="swatches">
    {#each INK as [tok, use]}
      <div class="sw"><i style="background: var({tok})"></i><b class="mono">{tok}</b><span class="quiet">{use}</span></div>
    {/each}
  </div>

  <h2 class="eyebrow">Смысл (цвет = состояние, не украшение)</h2>
  <div class="swatches">
    {#each MEANING as [tok, use]}
      <div class="sw"><i style="background: var({tok})"></i><b class="mono">{tok}</b><span class="quiet">{use}</span></div>
    {/each}
  </div>
</section>

<section>
  <h2 class="eyebrow">Типографика — 7 ступеней</h2>
  <div class="type">
    {#each TYPE as [tok, use, px]}
      <div class="ty">
        <span style="font-size: var({tok})">Волна Ф3 ждёт решения</span>
        <span class="quiet mono">{tok} · {px}px · {use}</span>
      </div>
    {/each}
  </div>
</section>

<section>
  <h2 class="eyebrow">Ритм отступов</h2>
  <div class="space">
    {#each SPACE as [tok, px]}
      <div class="sp"><i style="width: var({tok}); height: var({tok})"></i><span class="quiet mono">{px}</span></div>
    {/each}
  </div>
</section>

<section>
  <h2 class="eyebrow">Кнопки и состояния</h2>
  <div class="demo">
    <button class="btn primary">Отправить</button>
    <button class="btn">Обычная</button>
    <button class="btn sm">Мелкая</button>
    <button class="btn" disabled>Недоступна</button>
    <button class="btn primary busy">Занята</button>
    <button class="btn" onclick={() => (busy = !busy)} class:busy>Нажми: занятость</button>
  </div>
  <p class="quiet note">
    Наведение — граница акцентом; нажатие — приподнятая поверхность; фокус
    с клавиатуры — обводка акцентом (проверьте табом).
  </p>
  <div class="demo">
    <button class="link">третичное действие</button>
    <button class="link danger">опасное третичное</button>
    <a class="link" href="/design">ссылка-действие</a>
  </div>
</section>

<section>
  <h2 class="eyebrow">Поля</h2>
  <div class="demo">
    <input type="text" placeholder="что уточнить у волны…" bind:value={val} />
    <select bind:value={picked}><option>панель</option><option>карточка</option></select>
    <button class="btn primary" disabled={!val.trim()}>Спросить</button>
  </div>
</section>

<section>
  <h2 class="eyebrow">Метки</h2>
  <div class="demo">
    <span class="badge">3</span>
    <span class="badge mute">12</span>
    <span class="chip"><i class="dot" style="background: var(--ok)"></i>работает</span>
    <span class="chip"><i class="dot" style="background: var(--warn)"></i>ждёт решения</span>
    <span class="chip">Desktop</span>
    <span class="mono">ai-evolve@500dc3e</span>
  </div>
</section>

<section>
  <h2 class="eyebrow">Панель — кирпич правой колонки</h2>
  <div class="panels">
    <article class="panel">
      <header>
        <h3>Фоновые задачи</h3>
        <div class="tools">
          <button class="link">развернуть</button>
          <button class="link">закрыть</button>
        </div>
      </header>
      <div class="body flush">
        <div class="row"><i class="dot" style="background: var(--ok)"></i><span class="grow">смоук-вотчер предпрода</span><span class="trail">19 мин</span></div>
        <div class="row"><i class="dot" style="background: var(--accent)"></i><span class="grow">перевзвод будки диспетчера</span><span class="trail">1 мин</span></div>
        <div class="row active"><i class="dot" style="background: var(--warn)"></i><span class="grow">превью фронта :5199</span><span class="trail">12 с</span></div>
      </div>
    </article>

    <article class="panel">
      <header><h3>Файлы</h3></header>
      <div class="body">
        <input type="search" placeholder="фильтр… (?текст — искать в содержимом)" />
        <div class="row" style="margin-top: 8px"><span class="grow">morda/src/lib/AskCard.svelte</span></div>
        <div class="row"><span class="grow">nyron-dev/hub/server.mjs</span></div>
      </div>
    </article>

    <article class="panel">
      <header><h3>Пусто и загрузка</h3></header>
      <div class="body">
        <p class="empty">Живых сессий нет — волны отработали, вопросов не осталось.</p>
        <div class="skeleton" style="width: 70%"></div>
        <div class="skeleton" style="width: 45%; margin-top: 6px"></div>
      </div>
    </article>
  </div>
</section>

<section>
  <h2 class="eyebrow">Сообщения</h2>
  <p class="err">Ответ не доставлен: панель сессии не найдена.</p>
  <p class="ok-note">Спрошено у «Волна Ф3» — ответит постом в будку.</p>
</section>

<style>
  .head { margin-bottom: var(--sp-7); }
  .head h1 { font-size: var(--fs-hero); margin: 0 0 var(--sp-2); }
  .head p { margin: 0; max-width: 60ch; }
  section { margin-bottom: var(--sp-8); }
  h2.eyebrow { margin: var(--sp-7) 0 var(--sp-5); }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-4); }
  .sw { display: flex; align-items: center; gap: var(--sp-4); font-size: var(--fs-xs); }
  .sw i { width: 26px; height: 26px; border-radius: var(--r-sm); border: 1px solid var(--border); flex: none; }
  .sw b { flex: none; }
  .type { display: flex; flex-direction: column; gap: var(--sp-4); }
  .ty { display: flex; align-items: baseline; gap: var(--sp-6); flex-wrap: wrap; }
  .ty .quiet { font-size: var(--fs-xs); }
  .space { display: flex; align-items: flex-end; gap: var(--sp-5); }
  .sp { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); }
  .sp i { background: var(--accent); border-radius: 2px; }
  .sp span { font-size: var(--fs-micro); }
  .demo { display: flex; gap: var(--sp-4); flex-wrap: wrap; align-items: center; }
  .note { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--sp-5); align-items: start; }
  .panels input[type='search'] { width: 100%; }
</style>
