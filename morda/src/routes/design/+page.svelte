<script>
  // Витрина дизайн-системы: все токены и компоненты рядом, чтобы крутить
  // оформление глазами и собирать новые панели из готовых кирпичей, а не
  // рисовать стили заново в каждом файле (аудит 11.08 — 42/100).
  import Icon from '$lib/Icon.svelte';

  // Компоненты shadcn, приведённые к локу (волна 2). На витрине они стоят
  // рядом со старыми кирпичами намеренно: если пара выглядит по-разному —
  // значит компонент не приведён и его нельзя нести в экраны.
  import { Button } from '$lib/ui/button/index.js';
  import { Input } from '$lib/ui/input/index.js';
  import { Textarea } from '$lib/ui/textarea/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import * as Card from '$lib/ui/card/index.js';
  import { Separator } from '$lib/ui/separator/index.js';
  import * as Tabs from '$lib/ui/tabs/index.js';
  import * as DropdownMenu from '$lib/ui/dropdown-menu/index.js';
  import * as Sheet from '$lib/ui/sheet/index.js';
  import * as Dialog from '$lib/ui/dialog/index.js';
  import * as Tooltip from '$lib/ui/tooltip/index.js';
  import { Skeleton } from '$lib/ui/skeleton/index.js';
  import { ScrollArea } from '$lib/ui/scroll-area/index.js';
  import * as Collapsible from '$lib/ui/collapsible/index.js';

  let busy = $state(false);
  let val = $state('');
  let picked = $state('панель');
  let tab = $state('лента');
  let sheetOpen = $state(false);
  let dialogOpen = $state(false);
  let folded = $state(false);
  // масштабер вьюпорта — как в браузере Claude Desktop
  const VIEWPORTS = [['Свободно', null], ['Телефон', '375 × 812'],
    ['Планшет', '768 × 1024'], ['Десктоп', '1280 × 800']];
  let vp = $state('Свободно');

  // Иконки берутся по смыслу, а не «какая красивее»: у каждой одна роль в
  // пульте, иначе набор расползётся так же, как расползлись размеры шрифта.
  const ICONS = [
    ['radio', 'сессия жива'],
    ['circle-help', 'ждёт вашего решения'],
    ['check', 'решено, доставлено'],
    ['triangle-alert', 'ошибка, молчит'],
    ['message-square', 'транскрипт'],
    ['folder-tree', 'файлы проекта'],
    ['terminal', 'команда, конвейер'],
    ['git-branch', 'ветка и коммит'],
    ['panel-right', 'правая колонка'],
    ['external-link', 'открыть снаружи'],
  ];

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
  <nav class="dnav">
    <span class="chip">токены и компоненты</span>
    <a class="chip" href="/design/mock">макет рабочего места ↗</a>
    <a class="chip" href="/">вернуться в пульт</a>
  </nav>
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

  <h3 class="sub">Компонент <b class="mono">Button</b> — то же самое вариантами</h3>
  <div class="demo">
    <Button>Отправить</Button>
    <Button variant="outline">Обычная</Button>
    <Button variant="secondary">Плоская</Button>
    <Button variant="ghost">Инструмент</Button>
    <Button variant="destructive">Снять волну</Button>
    <Button variant="link" class="px-0">третичное действие</Button>
    <Button disabled>Недоступна</Button>
    <Button variant="outline" disabled>Недоступна</Button>
  </div>
  <div class="demo">
    <Button size="lg">Крупная</Button>
    <Button size="sm" variant="outline">Мелкая</Button>
    <Button size="xs" variant="outline">Микро</Button>
    <Button size="icon" variant="outline" aria-label="файлы проекта"><Icon name="folder-tree" /></Button>
    <Button size="icon-sm" variant="ghost" aria-label="открыть снаружи"><Icon name="external-link" /></Button>
    <Button variant="outline" href="/design">Ссылка-кнопка</Button>
    <Button variant="outline"><Icon name="git-branch" />С иконкой</Button>
  </div>
  <p class="quiet note">
    Размеры mobile-first: базово кнопка ростом с цель пальца (44px), под
    мышью ужимается вариантом <b class="mono">fine:</b> до плотной раскладки
    лока — те же 7×14px, что у <b class="mono">.btn</b>. Фокус кнопка себе не
    рисует: обводку даёт одно правило <b class="mono">:focus-visible</b> на
    весь пульт (проверьте табом — у обеих кнопок она одинаковая).
  </p>
</section>

<section>
  <h2 class="eyebrow">Поля</h2>
  <div class="demo">
    <input type="text" placeholder="что уточнить у волны…" bind:value={val} />
    <select bind:value={picked}><option>панель</option><option>карточка</option></select>
    <button class="btn primary" disabled={!val.trim()}>Спросить</button>
  </div>

  <h3 class="sub">Компоненты <b class="mono">Input</b> и <b class="mono">Textarea</b></h3>
  <div class="demo">
    <Input class="max-w-72" placeholder="что уточнить у волны…" bind:value={val} />
    <Input class="max-w-52" placeholder="недоступно" disabled />
    <Button disabled={!val.trim()}>Спросить</Button>
  </div>
  <div class="demo">
    <Textarea class="max-w-96" placeholder="ответ волне — растёт под текст…" />
  </div>
  <p class="quiet note">
    Кегль поля задан не классом, а правилом лока: на телефоне 16px, иначе
    iOS зумит страницу при фокусе. Ошибочное состояние — атрибутом
    <b class="mono">aria-invalid</b>, а не своим классом: подсветка и
    доступность не расходятся.
  </p>
  <div class="demo">
    <Input class="max-w-72" aria-invalid="true" value="ключ тикета не найден" />
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

  <h3 class="sub">Компонент <b class="mono">Badge</b> — счётчик и плашка в одном</h3>
  <div class="demo">
    <Badge>3</Badge>
    <Badge variant="secondary">12</Badge>
    <Badge variant="outline">Desktop</Badge>
    <Badge variant="ok">доставлено</Badge>
    <Badge variant="warn">ждёт решения</Badge>
    <Badge variant="destructive">молчит</Badge>
    <Badge variant="outline" href="/design">кликабельная</Badge>
  </div>
  <p class="quiet note">
    Смысловые варианты (<b class="mono">ok</b>, <b class="mono">warn</b>,
    <b class="mono">destructive</b>) существуют, чтобы состояние сессии не
    красили заново в каждом файле «на глаз».
  </p>
</section>

<section>
  <h2 class="eyebrow">Иконки</h2>
  <div class="icons">
    {#each ICONS as [name, use]}
      <div class="ic">
        <Icon {name} />
        <b class="mono">{name}</b>
        <span class="quiet">{use}</span>
      </div>
    {/each}
  </div>
  <p class="quiet note">
    Набор lucide, лежит локально — пульт рисует иконки без сети. Размер по
    умолчанию 16px и штрих 1.5 задаются один раз в <b class="mono">Icon.svelte</b>
    и <b class="mono">.icon</b>; цвет не задаётся вовсе — иконка окрашивается
    тем же правилом, что и текст, в который она вложена:
    <span class="pair ok-note"><Icon name="check" /> доставлено</span>,
    <span class="pair" style="color: var(--hot)"><Icon name="triangle-alert" /> не дошло</span>.
  </p>
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

    <article class="panel collapsed">
      <header>
        <button class="fold" aria-label="развернуть">›</button>
        <h3>Свёрнутая панель</h3>
        <span class="badge mute">7</span>
      </header>
      <div class="body"><p class="empty">содержимое скрыто</p></div>
    </article>

    <article class="panel">
      <header>
        <button class="fold open" aria-label="свернуть">›</button>
        <h3>Пусто и загрузка</h3>
      </header>
      <div class="body">
        <p class="empty">Живых сессий нет — волны отработали, вопросов не осталось.</p>
        <div class="skeleton" style="width: 70%"></div>
        <div class="skeleton" style="width: 45%; margin-top: 6px"></div>
      </div>
    </article>
  </div>

  <h3 class="sub">Компонент <b class="mono">Card</b> — та же панель по частям</h3>
  <div class="panels">
    <Card.Root>
      <Card.Header>
        <Card.Title>Волна Ф3 ждёт решения</Card.Title>
        <Card.Description>CRDT fail-closed · DEV-1214 → 1216</Card.Description>
        <Card.Action>
          <Badge variant="warn">2</Badge>
        </Card.Action>
      </Card.Header>
      <Card.Content>
        <p class="m-0">
          Нужен ли ребейз перед мержем? Ветка отстала на четыре коммита,
          конфликтов нет.
        </p>
      </Card.Content>
      <Card.Footer>
        <Button size="sm">Ответить</Button>
        <Button size="sm" variant="outline">Уточнить у автора</Button>
      </Card.Footer>
    </Card.Root>

    <Card.Root size="sm">
      <Card.Header><Card.Title>Плотная карточка</Card.Title></Card.Header>
      <Card.Content>
        <div class="rows">
          <Skeleton class="h-4 w-3/4" />
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-4 w-2/3" />
        </div>
      </Card.Content>
    </Card.Root>
  </div>
  <p class="quiet note">
    Скелет внутри — тот же <b class="mono">.skeleton</b>, что и слева:
    компонент не заводит второе мерцание, а размер ему задают утилитами
    (<b class="mono">h-4 w-3/4</b>) — слой утилит главнее слоя лока.
  </p>
</section>

<section>
  <h2 class="eyebrow">Вкладки</h2>
  <div class="demo">
    <Tabs.Root bind:value={tab}>
      <Tabs.List>
        <Tabs.Trigger value="лента">Лента</Tabs.Trigger>
        <Tabs.Trigger value="файлы">Файлы</Tabs.Trigger>
        <Tabs.Trigger value="браузер">Браузер</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="лента"><p class="quiet tabbody">транскрипт сессии</p></Tabs.Content>
      <Tabs.Content value="файлы"><p class="quiet tabbody">дерево проекта</p></Tabs.Content>
      <Tabs.Content value="браузер"><p class="quiet tabbody">окно наблюдения</p></Tabs.Content>
    </Tabs.Root>
  </div>
  <div class="demo">
    <Tabs.Root value="обзор">
      <Tabs.List variant="line">
        <Tabs.Trigger value="обзор">Обзор</Tabs.Trigger>
        <Tabs.Trigger value="решения">Решения</Tabs.Trigger>
        <Tabs.Trigger value="история">История</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  </div>
  <p class="quiet note">
    Капсула — тот же кирпич, что <b class="mono">.seg</b> выше: активный
    сегмент показывает приподнятая поверхность, а не тень. Вариант
    <b class="mono">line</b> подчёркивает активный раздел акцентом — для
    крупных разделов окна сессии.
  </p>
</section>

<section>
  <h2 class="eyebrow">Выпадающее меню, подсказка, свёртка</h2>
  <div class="demo">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="outline" {...props}>Действия сессии<Icon name="panel-right" /></Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Label>Волна Ф3</DropdownMenu.Label>
        <DropdownMenu.Item><Icon name="terminal" />Открыть в терминале</DropdownMenu.Item>
        <DropdownMenu.Item><Icon name="folder-tree" />Файлы проекта</DropdownMenu.Item>
        <DropdownMenu.Item>
          <Icon name="git-branch" />Ветка и коммит
          <DropdownMenu.Shortcut>⌘B</DropdownMenu.Shortcut>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="destructive"><Icon name="triangle-alert" />Снять волну</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>

    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button variant="ghost" size="icon" aria-label="что это значит" {...props}>
              <Icon name="circle-help" />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Сессия ждёт вашего решения</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>

    <Collapsible.Root bind:open={folded}>
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <Button variant="secondary" {...props}>
            {folded ? 'свернуть' : 'развернуть'} контекст
          </Button>
        {/snippet}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <p class="quiet tabbody">спрашивает: Диспетчер остатков релиза · 2 дн</p>
      </Collapsible.Content>
    </Collapsible.Root>
  </div>
  <p class="quiet note">
    Подсказка — приподнятая поверхность, а не инверсия в светлое: белая
    плашка в тёмном пульте читается как чужой элемент. Меню и подсказка
    появляются за 120 мс — движение только про состояние.
  </p>
</section>

<section>
  <h2 class="eyebrow">Шторка и диалог — поверхности поверх работы</h2>
  <div class="demo">
    <Sheet.Root bind:open={sheetOpen}>
      <Sheet.Trigger>
        {#snippet child({ props })}
          <Button variant="outline" {...props}>Открыть шторку</Button>
        {/snippet}
      </Sheet.Trigger>
      <Sheet.Content side="right">
        <Sheet.Header>
          <Sheet.Title>Файлы проекта</Sheet.Title>
          <Sheet.Description>ai-evolve · ветка main</Sheet.Description>
        </Sheet.Header>
        <div class="sheetbody">
          <div class="row"><span class="grow">morda/src/app.css</span><span class="trail">18 КБ</span></div>
          <div class="row"><span class="grow">morda/src/lib/ui/button/button.svelte</span><span class="trail">4 КБ</span></div>
          <div class="row"><span class="grow">nyron-dev/hub/server.mjs</span><span class="trail">31 КБ</span></div>
        </div>
        <Sheet.Footer>
          <Button variant="outline" onclick={() => (sheetOpen = false)}>Закрыть</Button>
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet.Root>

    <Dialog.Root bind:open={dialogOpen}>
      <Dialog.Trigger>
        {#snippet child({ props })}
          <Button variant="destructive" {...props}>Снять волну…</Button>
        {/snippet}
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>Снять волну Ф3?</Dialog.Title>
          <Dialog.Description>
            Сессия закроется, незакоммиченные правки останутся в рабочей копии.
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="outline" onclick={() => (dialogOpen = false)}>Отмена</Button>
          <Button variant="destructive" onclick={() => (dialogOpen = false)}>Снять</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </div>
  <p class="quiet note">
    На телефоне правая колонка пульта — это и есть шторка. Затемнение под
    ней берёт свой токен (<b class="mono">--scrim</b>): чистый чёрный из
    палитры вычищен, а холодная чернота под тёплым графитом читается грязью.
  </p>
</section>

<section>
  <h2 class="eyebrow">Разделитель, скелет, область прокрутки</h2>
  <div class="demo sep">
    <span class="quiet">15 сессий</span>
    <Separator orientation="vertical" />
    <span class="quiet">3 ждут решения</span>
    <Separator orientation="vertical" />
    <span class="quiet">ветка main</span>
  </div>
  <Separator class="my-4" />
  <div class="panels">
    <div class="rows">
      <Skeleton class="h-4 w-full" />
      <Skeleton class="h-4 w-4/5" />
      <Skeleton class="h-4 w-2/5" />
    </div>
    <ScrollArea class="h-32">
      <div class="rows">
        {#each ['Волна Ф3', 'Волна Ф2', 'Блок 1 диспетчер', 'Блок 2 диспетчер', 'Блок 3 диспетчер', 'Финишер мержевой', 'Канон занятости', 'Паспорт волны'] as name}
          <div class="row"><i class="dot" style="background: var(--ok)"></i><span class="grow">{name}</span></div>
        {/each}
      </div>
    </ScrollArea>
  </div>
  <p class="quiet note">
    Область прокрутки нужна там, где список длиннее панели, а системная
    полоса на Маке появляется только во время скролла и теряется.
  </p>
</section>

<section>
  <h2 class="eyebrow">Переключатель размеров и окно наблюдения</h2>
  <div class="demo">
    <div class="seg">
      {#each VIEWPORTS as [name, size]}
        <button class:on={vp === name} onclick={() => (vp = name)}>
          {name}{#if size}<span class="dim">{size}</span>{/if}
        </button>
      {/each}
    </div>
  </div>
  <p class="quiet note">
    Тем же кирпичом переключается размер в панели браузера сессии: видно,
    как страница выглядит на телефоне, не выходя из пульта.
  </p>
  <div class="viewport" style="width: {vp === 'Телефон' ? '375px' : vp === 'Планшет' ? '768px' : '100%'}; height: 150px; display: grid; place-items: center; color: var(--text-4); font-size: 12px; margin-top: 10px">
    окно {vp === 'Свободно' ? 'по ширине панели' : vp.toLowerCase()}
  </div>
</section>

<section>
  <h2 class="eyebrow">Разделитель — панели тянутся, центр остаётся центром</h2>
  <div class="splitdemo">
    <div class="sd-main">чат (центр, тянется сам)</div>
    <button class="splitter" aria-label="изменить ширину"></button>
    <div class="sd-side" style="width: 220px">панель (ширина меняется)</div>
  </div>
  <p class="quiet note">
    Модель Claude Desktop: поверхности открываются справа и тянутся за
    разделитель, разговор никуда не уезжает. Ширина запоминается.
  </p>
</section>

<section>
  <h2 class="eyebrow">Файлы: дерево и просмотрщик</h2>
  <div class="panels">
    <article class="panel">
      <header><h3>Дерево</h3><div class="tools"><button class="link">развернуть</button></div></header>
      <div class="body">
        <input type="search" placeholder="фильтр… (?текст — искать в содержимом)" />
        <div class="filetree" style="margin-top: 8px">
          <button class="row dir"><span class="caret open">›</span><span class="grow">ai-evolve-docs-test</span></button>
          <button class="row dir" style="padding-left: 20px"><span class="caret">›</span><span class="grow">requirements</span></button>
          <button class="row active" style="padding-left: 32px"><span class="grow">03-form-filled.png</span><span class="trail">172 КБ</span></button>
          <button class="row" style="padding-left: 32px"><span class="grow">spec-staged-reveal.md</span><span class="trail">14 КБ</span></button>
          <button class="row" style="padding-left: 32px"><span class="grow">выгрузка.csv</span><span class="trail">8 КБ</span></button>
        </div>
      </div>
    </article>

    <article class="panel">
      <header><h3>Просмотр: вложение</h3></header>
      <div class="body">
        <div class="viewer-head"><b class="mono">requirements/03-form-filled.png</b><span class="quiet">172 КБ</span></div>
        <div class="shot" style="height: 120px; display: grid; place-items: center; color: var(--text-4); font-size: 12px">
          картинка вложения — клик открывает в полном размере
        </div>
      </div>
    </article>

    <article class="panel">
      <header><h3>Просмотр: таблица (CSV)</h3></header>
      <div class="body">
        <div class="tw">
          <table>
            <thead><tr><th>Тикет</th><th>Волна</th><th>Статус</th></tr></thead>
            <tbody>
              <tr><td>DEV-1215</td><td>Ф3</td><td>ждёт, решения</td></tr>
              <tr><td>DEV-1212</td><td>Ф2</td><td>в работе</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </article>

    <article class="panel">
      <header><h3>Просмотр: код и неподдержанное</h3></header>
      <div class="body">
        <pre class="filecode">export function askAuthor(&#123; project, ask_id &#125;) &#123;
  // встречный вопрос автору ask
&#125;</pre>
        <div class="viewer-fallback">
          <p>Встроенный браузер не показывает PDF.</p>
          <button class="btn primary">Открыть вкладкой</button>
          <button class="btn">Открыть в системе</button>
        </div>
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
  .dnav { display: flex; gap: var(--sp-4); margin-top: var(--sp-5); }
  .dnav a { text-decoration: none; }
  .dnav a:hover { border-color: var(--accent); color: var(--text-1); }
  section { margin-bottom: var(--sp-8); }
  h2.eyebrow { margin: var(--sp-7) 0 var(--sp-5); }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-4); }
  .sw { display: flex; align-items: center; gap: var(--sp-4); font-size: var(--fs-xs); }
  .sw i { width: 26px; height: 26px; border-radius: var(--r-sm); border: 1px solid var(--border); flex: none; }
  .sw b { flex: none; }
  .icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-4); }
  .ic { display: flex; align-items: center; gap: var(--sp-4); font-size: var(--fs-xs); }
  .ic b { flex: none; }
  /* иконка и её слово не разъезжаются по разным строкам при переносе */
  .pair { white-space: nowrap; }
  .type { display: flex; flex-direction: column; gap: var(--sp-4); }
  .ty { display: flex; align-items: baseline; gap: var(--sp-6); flex-wrap: wrap; }
  .ty .quiet { font-size: var(--fs-xs); }
  .space { display: flex; align-items: flex-end; gap: var(--sp-5); }
  .sp { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); }
  .sp i { background: var(--accent); border-radius: 2px; }
  .sp span { font-size: var(--fs-micro); }
  .demo { display: flex; gap: var(--sp-4); flex-wrap: wrap; align-items: center; }
  .note { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; }
  /* подзаголовок пары «старый кирпич — новый компонент» */
  .sub {
    font-size: var(--fs-sm); font-weight: 600; color: var(--text-3);
    margin: var(--sp-7) 0 var(--sp-4);
  }
  .rows { display: flex; flex-direction: column; gap: var(--sp-3); }
  .tabbody { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; }
  /* Строка статуса. Высота задана явно не для красоты: вертикальный
     разделитель тянется на height:100%, а от контейнера с автовысотой
     сто процентов — это ноль, и разделителя просто не видно. */
  .sep { align-items: center; height: 20px; }
  .sheetbody { display: flex; flex-direction: column; padding: 0 var(--sp-5); overflow: auto; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--sp-5); align-items: start; }
  .panels input[type='search'] { width: 100%; }
  .splitdemo { display: flex; align-items: stretch; gap: var(--sp-4); height: 110px; }
  .sd-main, .sd-side {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--r); display: grid; place-items: center;
    color: var(--text-3); font-size: var(--fs-xs);
  }
  .sd-main { flex: 1; }
  .sd-side { flex: none; }
</style>
