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

  const SLOT_RU = {
    ok: ['подключён', 'var(--ok)'],
    needs_auth: ['протух / не подключён', 'var(--warn)'],
    probing: ['проверяю…', 'var(--text-4)'],
    unknown: ['не проверялся', 'var(--text-4)'],
    not_installed: ['CLI не установлен', 'var(--err)'],
  };
  const RUN_RU = {
    starting: ['стартует', 'var(--text-4)'],
    goal_sent: ['цель отправлена', 'var(--ok)'],
    running: ['работает', 'var(--ok)'],
    needs_auth: ['ждёт авторизации', 'var(--warn)'],
    permission: ['ждёт разрешения', 'var(--warn)'],
    stopped: ['запаркована', 'var(--text-4)'],
    died_on_start: ['умерла на старте', 'var(--err)'],
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
        <Card.Content>
          {#if s.hint}<p class="hint quiet">{s.hint}</p>{/if}
          {#if connect[s.id]?.url}
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
          {:else if s.status !== 'ok' && s.status !== 'not_installed'}
            <Button variant="outline" size="sm" disabled={busy}
              onclick={() => startConnect(s.id)}>
              <Icon name="key-round" size={13} /> авторизовать
            </Button>
          {/if}
          {#if s.home}
            <p class="hint quiet mono">{s.home}</p>
          {/if}
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
  <div class="sec-h"><h2>Проекты машины</h2></div>
  <div class="runner-list">
    {#each st.overview?.projects || [] as p (p.name)}
      <div class="run-row">
        <Icon name="folder-tree" size={14} class="text-ink-4" />
        <b class="rname">{p.name}</b>
        <span class="quiet mono">{p.root}</span>
      </div>
    {/each}
  </div>
  <p class="hint quiet">Список — morda/projects.json (allowlist корней;
    редактирование со страницы — следующим шагом вместе с паспортом проекта).</p>
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
