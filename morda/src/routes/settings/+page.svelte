<script>
  // Страница конфигурации пульта (STOVP-58, пул ресурсов; полные два
  // конфигуратора — SYSTEM-DESIGN §6–7, здесь их первый кусок):
  //   1) копии подписок машины (слоты): Claude CLI / Codex CLI / Kimi CLI…
  //      Флоу CTO 17.08: «подключить» → выбрать провайдера → получить
  //      ссылку → авторизовался в нужном браузере → копия доступна.
  //      Код со страницы — запасной путь (вход обычно завершается сам).
  //   2) реестр раннера — CLI-сессии, которыми владеет пульт (стоп/резюм);
  //   3) проекты машины (allowlist projects.json — пока читается как есть).
  import { onMount, getContext } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import { Button } from '$lib/ui/button/index.js';
  import { Badge } from '$lib/ui/badge/index.js';
  import { Input } from '$lib/ui/input/index.js';
  import * as Card from '$lib/ui/card/index.js';
  import { age } from '$lib/states.js';

  const st = getContext('morda');

  let data = $state(null);     // { sessions, slots, providers }
  let busy = $state(false);
  let error = $state(null);
  // формы подключения: id слота → { url, need_code, code, sent }
  let connect = $state({});
  // форма «подключить копию»
  let adding = $state(false);
  let addProvider = $state('claude');
  let addLabel = $state('');
  // форма «добавить проект»
  let addingProject = $state(false);
  let projName = $state('');
  let projRoot = $state('');

  async function refresh() {
    try {
      const r = await fetch('/api/runner');
      const next = await r.json();
      if (!r.ok) { error = next.error; return; }
      error = null;
      data = next;
    } catch { /* сервер перезапускается */ }
  }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  async function act(body) {
    busy = true; error = null;
    try {
      const r = await fetch('/api/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) { error = out.error || `HTTP ${r.status}`; return null; }
      return out;
    } catch (e) {
      error = String(e.message || e); return null;
    } finally {
      busy = false;
      refresh();
    }
  }

  // «подключить копию»: слот заводится и сразу начинается штатный логин
  async function addAndConnect() {
    const slot = await act({ action: 'slot_add', provider: addProvider, label: addLabel });
    if (!slot?.id) return;
    adding = false; addLabel = '';
    await startConnect(slot.id);
  }
  async function startConnect(id) {
    const out = await act({ action: 'slot_connect', id });
    if (out?.url) connect = { ...connect,
      [id]: { url: out.url, need_code: out.need_code, code: '', sent: false } };
  }
  async function sendCode(id) {
    const c = connect[id];
    if (!c?.code?.trim()) return;
    const out = await act({ action: 'slot_code', id, code: c.code.trim() });
    if (out?.sent) connect = { ...connect, [id]: { ...c, sent: true } };
  }

  // лимиты подписки (/usage со служебной сессии слота): id → данные
  let usage = $state({});
  let usageBusy = $state({});
  async function fetchUsage(id) {
    usageBusy = { ...usageBusy, [id]: true };
    const out = await act({ action: 'slot_usage', id });
    usageBusy = { ...usageBusy, [id]: false };
    if (out?.session || out?.week_all) usage = { ...usage, [id]: out };
  }
  const usageColor = (p) => p >= 90 ? 'var(--hot)' : p >= 70 ? 'var(--warn)' : 'var(--ok)';

  // Паспорт проекта (STOVP-59 шаг 2): прогон «проверить готовность» —
  // каждый пункт фактом, красный несёт шаг починки. Прогон долгий
  // (докерный MCP), поэтому явный спиннер на кнопке.
  let passport = $state({}); // имя проекта → { busy, items, at, error }
  let auditNote = $state({}); // имя проекта → строка после запуска аудитора
  async function verify(name) {
    passport = { ...passport, [name]: { busy: true } };
    try {
      const r = await fetch('/api/passport', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-morda': '1' },
        body: JSON.stringify({ project: name }),
      });
      const out = await r.json();
      passport = { ...passport, [name]: r.ok ? out : { error: out.error } };
    } catch (e) {
      passport = { ...passport, [name]: { error: String(e.message || e) } };
    }
  }

  const SLOT_RU = {
    ok: ['подключён', 'var(--ok)'],
    needs_auth: ['протух / не подключён', 'var(--warn)'],
    probing: ['проверяю…', 'var(--text-4)'],
    unknown: ['не проверялся', 'var(--text-4)'],
    not_installed: ['CLI не установлен', 'var(--hot)'],
  };
  const RUN_RU = {
    starting: ['стартует', 'var(--text-4)'],
    goal_sent: ['цель отправлена', 'var(--ok)'],
    running: ['работает', 'var(--ok)'],
    needs_auth: ['ждёт авторизации', 'var(--warn)'],
    permission: ['ждёт разрешения', 'var(--warn)'],
    stopped: ['запаркована', 'var(--text-4)'],
    died_on_start: ['умерла на старте', 'var(--hot)'],
  };
</script>

<svelte:head><title>Настройки — STOVP</title></svelte:head>

<header class="head">
  <h1>Настройки машины</h1>
  <p class="quiet">Копии подписок, раннер CLI-сессий, проекты. Паспорт машины —
    никуда не едет: доступы живут в Keychain и домашних каталогах CLI.</p>
</header>

{#if error}<p class="err">{error}</p>{/if}

<section>
  <div class="sec-h">
    <h2>Копии подписок</h2>
    <Button variant="outline" size="xs" disabled={busy}
      onclick={() => act({ action: 'slot_probe' })}>
      <Icon name="refresh-cw" size={13} /> проверить фактом
    </Button>
    <Button size="xs" disabled={busy} onclick={() => (adding = !adding)}>
      <Icon name="plus" size={13} /> подключить копию
    </Button>
  </div>

  {#if adding}
    <!-- Флоу: выбрать провайдера → имя аккаунта → «получить ссылку».
         Слот получает СВОЙ конфиг-каталог: копии не толкаются локтями. -->
    <Card.Root class="mb-4">
      <Card.Content class="add-form">
        <div class="prov-row">
          {#each data?.providers || [] as p (p.id)}
            <button class="prov" class:on={addProvider === p.id}
              disabled={!p.installed} title={p.installed ? p.kind : `${p.title} не установлен на машине`}
              onclick={() => (addProvider = p.id)}>
              <b>{p.title}</b>
              <span>{p.installed ? p.kind : 'не установлен'}</span>
            </button>
          {/each}
        </div>
        <div class="code-row">
          <Input placeholder="имя аккаунта (например: stovp3tt)" bind:value={addLabel} />
          <Button disabled={busy || !addLabel.trim()} onclick={addAndConnect}>
            получить ссылку
          </Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <div class="grid">
    {#each data?.slots || [] as s (s.id)}
      {@const [label, color] = SLOT_RU[s.status] || SLOT_RU.unknown}
      <Card.Root>
        <Card.Header>
          <Card.Title>{s.label}</Card.Title>
          <Card.Description>{s.kind || s.provider}</Card.Description>
          <Card.Action>
            <Badge variant="outline"><i class="dot" style="background:{color}"></i>{label}</Badge>
          </Card.Action>
        </Card.Header>
        <Card.Content class="slot-body">
          {#if s.hint}<p class="hint quiet">{s.hint}</p>{/if}
          {#if connect[s.id]?.url && s.status !== 'ok'}
            <div class="auth-flow">
              <p class="hint">Открой ссылку в браузере с профилем НУЖНОГО
                аккаунта — войдёт тот, кто там залогинен:</p>
              <a class="auth-url" href={connect[s.id].url} target="_blank" rel="noreferrer">
                <Icon name="external-link" size={13} /> ссылка авторизации
              </a>
              {#if connect[s.id].need_code}
                {#if connect[s.id].sent}
                  <p class="hint ok-note">код отправлен — статус обновится сам</p>
                {:else}
                  <p class="hint quiet">обычно вход завершается сам; если
                    страница показала код — вставь его сюда:</p>
                  <div class="code-row">
                    <Input placeholder="код со страницы (если показала)"
                      bind:value={connect[s.id].code} />
                    <Button variant="outline" disabled={busy || !connect[s.id].code?.trim()}
                      onclick={() => sendCode(s.id)}>отправить</Button>
                  </div>
                {/if}
              {:else}
                <p class="hint quiet">кода не нужно: вход в браузере завершит
                  подключение сам (callback на эту машину)</p>
              {/if}
            </div>
          {/if}
          {#if usage[s.id] && s.status === 'ok'}
            {@const u = usage[s.id]}
            <div class="usage">
              {#each [['5-часовой лимит', u.session], ['неделя, все модели', u.week_all], ['неделя, топ-модель', u.week_model]] as [label, v] (label)}
                {#if v}
                  <div class="u-row" title="сброс: {v.resets}">
                    <span class="u-label">{label}</span>
                    <span class="u-bar"><i style="width:{v.used_pct}%;background:{usageColor(v.used_pct)}"></i></span>
                    <span class="u-pct">{v.used_pct}%</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
          <p class="slot-home mono" title={s.home ? 'каталог слота' : 'домашний каталог CLI — общий, поэтому «основной» не отвязывается'}>{s.home_display}</p>
          <div class="slot-actions">
            {#if s.status !== 'ok' && s.status !== 'not_installed' && !connect[s.id]?.url}
              <Button variant="outline" size="xs" disabled={busy}
                onclick={() => startConnect(s.id)}>
                <Icon name="key-round" size={13} /> авторизовать
              </Button>
            {/if}
            {#if s.status === 'ok'}
              <Button variant="outline" size="xs" disabled={usageBusy[s.id]}
                title="снимает лимиты с живой сессии слота (5–10 секунд)"
                onclick={() => fetchUsage(s.id)}>
                <Icon name="gauge" size={13} /> {usage[s.id] ? 'обновить лимиты' : 'лимиты'}
              </Button>
            {/if}
            {#if s.home}
              <Button variant="ghost" size="xs" class="text-ink-4" disabled={busy}
                title="слот уйдёт из реестра; каталог с авторизацией останется — удалить руками: rm -rf {s.home}"
                onclick={async () => {
                  if (!confirm(`Отвязать копию «${s.label}»? Каталог ${s.home} останется на диске.`)) return;
                  await act({ action: 'slot_remove', id: s.id });
                }}>
                <Icon name="unlink" size={13} /> отвязать
              </Button>
            {/if}
          </div>
        </Card.Content>
      </Card.Root>
    {/each}
    {#if !data}
      <p class="quiet">читаю слоты…</p>
    {/if}
  </div>
</section>

<section>
  <div class="sec-h"><h2>Раннер: сессии пульта</h2></div>
  {#if data?.sessions?.length}
    <div class="runner-list">
      {#each data.sessions as r (r.name)}
        {@const [label, color] = RUN_RU[r.screen === 'permission' ? 'permission' : r.state] || ['?', 'var(--text-4)']}
        <div class="run-row">
          <i class="dot" style="background:{color}"></i>
          <b class="rname">{r.name}</b>
          <span class="quiet">{r.project}</span>
          <Badge variant="outline">{label}</Badge>
          {#if r.sessionId}
            <a class="quiet mono" href="/s/{encodeURIComponent(r.project)}/{r.sessionId}">
              {r.sessionId.slice(0, 8)}
            </a>
          {/if}
          <span class="age quiet">{age(r.startedAt)}</span>
          <span class="spacer"></span>
          {#if r.alive}
            <Button variant="outline" size="xs" disabled={busy}
              onclick={() => act({ action: 'stop', name: r.name })}>
              <Icon name="pause" size={13} /> стоп
            </Button>
          {:else if r.sessionId}
            <Button variant="outline" size="xs" disabled={busy}
              onclick={() => act({ action: 'resume', name: r.name })}>
              <Icon name="play" size={13} /> резюм
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <p class="quiet">Раннер ещё ничего не запускал. Первая сессия рождается из
      поля ввода на главной.</p>
  {/if}
</section>

<section>
  <div class="sec-h">
    <h2>Проекты машины</h2>
    <Button size="xs" disabled={busy} onclick={() => (addingProject = !addingProject)}>
      <Icon name="plus" size={13} /> добавить проект
    </Button>
  </div>
  {#if addingProject}
    <Card.Root class="mb-4">
      <Card.Content class="add-form">
        <div class="code-row">
          <Input placeholder="имя (строчные латиница/цифры/дефис)" bind:value={projName} />
          <Input placeholder="/абсолютный/путь/к/папке" bind:value={projRoot} class="flex-2" />
          <Button disabled={busy || !projName.trim() || !projRoot.trim()}
            onclick={async () => {
              const out = await act({ action: 'project_add',
                name: projName.trim(), root: projRoot.trim() });
              if (out?.added) { addingProject = false; projName = ''; projRoot = ''; }
            }}>подключить</Button>
        </div>
        <p class="hint quiet">Папка обязана существовать; пульт получит к ней
          доступ: сессии, файлы, будка (.nyron-hub заведётся внутри).</p>
      </Card.Content>
    </Card.Root>
  {/if}
  <div class="runner-list">
    {#each st.overview?.projects || [] as p (p.name)}
      {@const pv = passport[p.name]}
      <div class="proj-block">
        <div class="run-row">
          <Icon name="folder-tree" size={14} class="text-ink-4" />
          <b class="rname">{p.name}</b>
          <span class="quiet mono">{p.root}</span>
          <span class="spacer"></span>
          <Button variant="outline" size="xs" disabled={pv?.busy}
            title="паспорт проекта фактом: MCP отвечают, ключи в ключнице, плагин и скиллы стоят, забор режет"
            onclick={() => verify(p.name)}>
            <Icon name={pv?.busy ? 'loader-circle' : 'shield-check'} size={13} />
            {pv?.busy ? 'проверяю…' : 'проверить готовность'}
          </Button>
          <Button variant="outline" size="xs" disabled={busy}
            title="сессия-аудитор: карта проекта → секреты → сборка паспорта и ключницы → предложения по канону → аттестация; вопросы задаёт формами"
            onclick={async () => {
              const out = await act({ action: 'audit_start', project: p.name });
              if (out) auditNote = { ...auditNote, [p.name]: `аудитор запущен (${out.tmux || ''}) — сессия появится в списке слева и в разделе раннера` };
            }}>
            <Icon name="search-check" size={13} /> аудит проекта
          </Button>
          <Button variant="ghost" size="xs" class="text-ink-4" disabled={busy}
            title="уберёт из списка пульта; файлы папки не трогаются"
            onclick={async () => {
              if (!confirm(`Убрать проект «${p.name}» из пульта? Файлы не трогаются.`)) return;
              await act({ action: 'project_remove', name: p.name });
            }}>
            <Icon name="unlink" size={12} /> убрать
          </Button>
        </div>
        {#if auditNote[p.name]}<p class="hint ok-note">{auditNote[p.name]}</p>{/if}
        {#if pv?.error}<p class="err">{pv.error}</p>{/if}
        {#if pv?.items}
          <div class="checklist">
            {#each pv.items as c (c.id)}
              <div class="check-row" class:bad={!c.ok}>
                <Icon name={c.ok ? 'check' : 'x'} size={14}
                  class={c.ok ? 'text-ok' : 'text-hot'} />
                <div class="check-body">
                  <b>{c.title}</b>
                  <span class="check-fact">{c.fact}</span>
                  {#if c.fix}<span class="check-fix">починка: {c.fix}</span>{/if}
                </div>
              </div>
            {/each}
            {#if pv.items.every((c) => c.ok)}
              <p class="hint ok-note">проект готов к работе с плагином — все пункты зелёные фактом</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  .head { margin-bottom: var(--sp-7); }
  .head h1 { font-size: var(--fs-xl); margin: 0 0 var(--sp-2); }
  .head p { margin: 0; font-size: var(--fs-sm); }
  section { margin-bottom: var(--sp-8); }
  .sec-h {
    display: flex; align-items: center; gap: var(--sp-4);
    margin-bottom: var(--sp-4); flex-wrap: wrap;
  }
  .sec-h h2 { font-size: var(--fs-md); margin: 0; }
  .grid {
    display: grid; gap: var(--sp-5);
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }
  /* выбор провайдера: плитки, недоступный CLI — с честной причиной */
  :global(.add-form) { display: flex; flex-direction: column; gap: var(--sp-4); }
  .prov-row { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
  .prov {
    flex: 1; min-width: 140px; text-align: left;
    background: var(--bg-1); color: var(--text-1);
    border: 1px solid var(--border-soft); border-radius: var(--r-sm);
    padding: var(--sp-3) var(--sp-4); font: inherit; font-size: var(--fs-sm);
  }
  .prov.on { border-color: var(--accent); }
  .prov:disabled { opacity: 0.45; }
  .prov b { display: block; }
  .prov span { color: var(--text-3); font-size: var(--fs-xs); }
  .auth-flow { display: flex; flex-direction: column; gap: var(--sp-3); }
  .auth-url {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    color: var(--accent); font-size: var(--fs-sm); word-break: break-all;
  }
  .code-row { display: flex; gap: var(--sp-3); }
  /* лимиты подписки: строка = подпись, полоса, процент; цвет полосы —
     смысловой (зелёный/жёлтый/красный по близости к потолку) */
  .usage { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0; }
  .u-row { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); }
  .u-label { flex: none; width: 118px; color: var(--text-3); }
  .u-bar {
    flex: 1; height: 6px; border-radius: 3px; background: var(--bg-2);
    overflow: hidden; display: block;
  }
  .u-bar i { display: block; height: 100%; border-radius: 3px; }
  .u-pct { flex: none; width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
  .hint { font-size: var(--fs-xs); margin: 0 0 var(--sp-2); }
  .ok-note { color: var(--ok); }
  .runner-list { display: flex; flex-direction: column; gap: var(--sp-2); }
  .run-row {
    display: flex; align-items: center; gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-soft);
    border-radius: var(--r); font-size: var(--fs-sm); min-width: 0;
  }
  .rname { flex: none; }
  .run-row .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
</style>
