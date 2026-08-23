/**
 * fleet.js — тонкий слой доступа морды (канон спеки: морда НЕ читает
 * hub.db напрямую; в фазе 2 меняется только этот файл — на сетевой клиент).
 *
 * Проекты — morda/projects.json (gitignored, машинное):
 *   [{ "name": "nyron", "root": "/Users/x/ai-evolve" }, …]
 * Файла нет — пусто и понятная подсказка в overview.error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { lastActivityMs, checkinMs, checkinState, stalledCard } from './checkin.js';
import { MORDA_ROOT, PLUGIN_HUB, T } from './plugin-hub.js';

export { MORDA_ROOT };

// Где лежит плагин и его transcript.mjs — plugin-hub.js: тот же модуль
// нужен checkin.js, а вторая копия transcript.mjs в бандле означала бы
// второй набор вотчеров и второй кэш индекса сессий (STOVP-65).
const { HubDb } = await import(/* @vite-ignore */ path.join(PLUGIN_HUB, 'hub-db.mjs'));

// Реестр соединений — в globalThis: Vite HMR пересоздаёт модуль, и
// локальная Map копила бы открытые SQLite-дескрипторы (ревью Sol 09.08).
const dbs = (globalThis.__mordaHubs ??= new Map()); // root → HubDb

export function projects() {
  const p = path.join(MORDA_ROOT, 'projects.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Правка списка проектов — с страницы настроек (CTO 17.08: «нужна кнопка
// добавления, не у всех папка очевидна»). Путь проверяется фактом
// существования; удаление трогает только список, не файлы.
export function projectAdd({ name, root }) {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name || ''))
    throw new Error('имя проекта: строчные латиница/цифры/дефис');
  const full = path.resolve(String(root || ''));
  if (!path.isAbsolute(String(root || ''))) throw new Error('нужен абсолютный путь к папке');
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory())
    throw new Error(`папки нет: ${full}`);
  const list = projects() || [];
  if (list.some((p) => p.name === name)) throw new Error(`проект ${name} уже есть`);
  if (list.some((p) => path.resolve(p.root) === full))
    throw new Error(`эта папка уже подключена как «${list.find((p) => path.resolve(p.root) === full).name}»`);
  list.push({ name, root: full });
  const f = path.join(MORDA_ROOT, 'projects.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(f + '.tmp', f);
  return { added: name, root: full };
}

export function projectRemove({ name }) {
  const list = projects() || [];
  if (!list.some((p) => p.name === name)) throw new Error(`нет проекта ${name}`);
  const next = list.filter((p) => p.name !== name);
  const f = path.join(MORDA_ROOT, 'projects.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(f + '.tmp', f);
  return { removed: name };
}

// root НИКОГДА не приходит с клиента (ревью Sol: произвольный путь из POST
// создавал бы .nyron-hub где угодно) — только имя проекта, резолв по
// allowlist projects.json.
export function rootByName(name) {
  const p = (projects() || []).find((x) => x.name === name);
  if (!p) throw new Error(`неизвестный проект: ${name}`);
  return p.root;
}

/** Для судьи-триажа: доступ к будке проекта без второй базы. */
export function hubForJudge(root) { return hubFor(root); }

function hubFor(root) {
  if (!dbs.has(root)) dbs.set(root, new HubDb(path.join(root, '.nyron-hub')));
  return dbs.get(root);
}

// Автор ask зовётся логическим именем волны («wave-f3»), а окно сессии живёт
// под uuid — человеку иначе приходится глазами искать нужную строку в дереве
// (жалоба CTO 11.08). Сопоставляем по имени: волны у нас называются
// «Волна Ф3: …», то есть та же метка кириллицей.
const CYR2LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'j', з: 'z',
  и: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', ы: 'y', э: 'e', ю: 'u', я: 'ya' };
function normLabel(s) {
  return String(s || '').toLowerCase()
    .split(':')[0]                       // «Волна Ф3: CRDT…» → «волна ф3»
    .replace(/волна|wave|сессия/g, '')
    .replace(/[а-яё]/g, (c) => CYR2LAT[c] ?? c)
    .replace(/[^a-z0-9]/g, '');
}
// Входящие человеку: посты, адресованные ему поимённо (CTO@morda и прочие
// «…@morda»). Ответы на встречные вопросы приходят именно так.
function inboxFor(hub, sessions) {
  try {
    const all = hub.read({ limit: 200 }).messages || [];
    return all
      .filter((m) => /@morda$/i.test(String(m.to || '')))
      .slice(-12)
      .reverse()
      .map((m) => ({
        id: m.id, ts: m.ts, from: m.from, to: m.to, ticket: m.ticket || null,
        text: String(m.text || '').slice(0, 1200),
        from_key: matchAuthor(m.from, sessions)?.key || null,
        from_title: matchAuthor(m.from, sessions)?.title || null,
      }));
  } catch { return []; }
}

function matchAuthor(author, sessions) {
  const want = normLabel(author);
  if (want.length < 2) return null;      // «w», «f» — слишком общее, не гадаем
  // одноимённых обычно несколько (перезапуски волны) — ведём в самую свежую
  const hits = sessions.filter((s) => normLabel(s.title) === want)
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  return hits.length ? { key: hits[0].key, title: hits[0].title } : null;
}

// Трекер проекта из конфига плагина (.claude/nyron-dev.md): site+project_key
// → база для автолинковки тикетов в транскриптах (CTO 10.08: ссылки на Jira
// открывать наружу/попапом — юзер там уже залогинен).
const trackerCache = new Map(); // root → {base, keys} | null
function trackerFor(root) {
  if (trackerCache.has(root)) return trackerCache.get(root);
  let t = null;
  try {
    const cfg = fs.readFileSync(path.join(root, '.claude', 'nyron-dev.md'), 'utf8');
    const site = cfg.match(/^\s*site:\s*(\S+)/m)?.[1];
    const keys = [...cfg.matchAll(/^\s*(?:project_key|\w+):\s*([A-Z][A-Z0-9]{1,9})\s*(?:#.*)?$/gm)]
      .map((m) => m[1]);
    if (site && keys.length)
      t = { base: `https://${site}/browse/`, keys: [...new Set(keys)] };
  } catch {}
  trackerCache.set(root, t);
  return t;
}

// Сводку главной поллит каждая открытая вкладка раз в ~5 с; сборка стоит
// обхода лент всех проектов. Кэш 2 с схлопывает лавину параллельных вкладок
// в одну сборку (факт 22.08: overview ел 4.8 с на опрос под нагрузкой).
let ovCache = { at: 0, data: null };
export function overview() {
  if (ovCache.data && Date.now() - ovCache.at < 2000) return ovCache.data;
  const data = overviewRaw();
  ovCache = { at: Date.now(), data };
  return data;
}
function overviewRaw() {
  const list = projects();
  if (!list) {
    return { error: 'нет morda/projects.json — скопируй projects.json.example и впиши корни проектов', projects: [] };
  }
  return {
    projects: list.map(({ name, root }) => {
      try {
        const hub = hubFor(root);
        // uuid сессии человеку ничего не говорит — резолвим в заголовок
        // транскрипта («кто спрашивает» — UX-аудит impeccable 10.08)
        const sess = sessionList(root);
        const titles = new Map(sess.map((s) => [s.key, s.title]));
        const named = (a) => {
          const hit = titles.has(a.session)
            ? { key: a.session, title: titles.get(a.session) }
            : matchAuthor(a.session, sess);
          return { ...a, session_title: hit?.title || null, session_key: hit?.key || null };
        };
        return {
          name, root,
          // живые (open + answered/delivered) + хвост acknowledged: цепочка
          // доставки видна до конца, а не рвётся на ack (ревью Sol r1)
          asks: [...hub.asks({}).asks.map(named),
            ...hub.asks({ status: 'acknowledged' }).asks.slice(-3).map(named)],
          watch: hub.watchStates(),
          recent: hub.recent(8),
          tracker: trackerFor(root),
          // Ответы человеку: сессии пишут ему постом (например на встречный
          // вопрос по ask). Без этой ленты ответ уходил в будку и человек
          // его нигде не видел (дыра, найдена CTO 11.08 на живом цикле).
          inbox: inboxFor(hub, sess),
        };
      } catch (e) {
        return { name, root, error: String(e.message || e), asks: [], watch: [], recent: [] };
      }
    }),
    at: new Date().toISOString(),
    copies: copies(),
  };
}

// Копии приложения Claude на этой машине — сканируются СЕРВЕРОМ по
// /Applications (клиент не присылает имён, только выбирает из списка).
export function copies() {
  try {
    return fs.readdirSync('/Applications')
      .filter((f) => /^Claude( \(.+\))?\.app$/.test(f))
      .map((f) => f.replace(/\.app$/, ''));
  } catch { return []; }
}

export function openCopy(app) {
  if (!copies().includes(app)) throw new Error(`неизвестная копия: ${app}`);
  execFile('/usr/bin/open', ['-a', app]);
  return { opened: app };
}

/** Открыть сессию в приложении Claude диплинком claude://resume?session=…
 *  (формат снят с бинарника Claude.app 09.08.2026: импортирует CLI-сессию
 *  по uuid транскрипта). Ключ обязан существовать среди сессий проекта. */
export function openSession(project, key) {
  const root = rootByName(project);
  if (!sessionList(root).some((s) => s.key === key))
    throw new Error(`сессия ${key} не найдена в проекте ${project}`);
  execFile('/usr/bin/open', [`claude://resume?session=${encodeURIComponent(key)}`]);
  return { opened: key };
}

export function decide({ project, ask_id, decision, by }) {
  const hub = hubFor(rootByName(project));
  const r = hub.decide({ ask_id, decision, by: by || 'morda' });
  // Ответ на ask МЁРТВОЙ сессии никто не заберёт pull-ом (забирает только
  // сама сессия по своему id) — поэтому решение дублируется в шину
  // диспетчеру: живые сессии видят его сразу, не дожидаясь воскрешения
  // автора вопроса (вопрос CTO 10.08: «если я отвечу — что будет?»).
  if (!r.already_decided) {
    try {
      hub.post({
        from: by || 'morda', to: 'dispatcher', ticket: r.ask.ticket || undefined,
        text: `решение по ask сессии ${String(r.ask.session).slice(0, 12)}: «${String(r.ask.question).slice(0, 120)}» → «${String(decision).slice(0, 200)}». Исполнить и подтвердить: hub_ack ${ask_id}`,
      });
    } catch { /* шина недоступна — решение всё равно в asks */ }
  }
  return r;
}

/** Встречный вопрос автору ask прямо с карточки: «вопрос непонятен —
 *  доуточню» (флоу CTO 11.08). Адресат берётся из самого ask, поэтому
 *  человеку не нужно искать, чья это сессия: она читает будку по своему
 *  имени и обязана ответить, не закрывая свой вопрос. */
export function askAuthor({ project, ask_id, text, by }) {
  const root = rootByName(project);
  if (!text || !String(text).trim()) throw new Error('пустой текст');
  const hub = hubFor(root);
  const a = hub.asks({}).asks.find((x) => x.id === ask_id)
    || hub.asks({ status: 'acknowledged' }).asks.find((x) => x.id === ask_id);
  if (!a) throw new Error(`ask ${ask_id} не найден`);
  hub.post({
    from: by || 'CTO@morda', to: a.session, ticket: a.ticket || undefined,
    wave: a.wave || undefined,
    // адресат назван и в тексте: шину читают все, безадресное принимали
    // на свой счёт чужие диспетчеры (факт 10.08)
    text: `[встречный вопрос человека по твоему ask ${ask_id} — ТОЛЬКО для «${a.session}», остальным игнорировать] `
      + `Твой вопрос: «${String(a.question).slice(0, 160)}». Человек спрашивает: ${text}\n`
      + `Ответь постом в будку (hub_post to:"${by || 'CTO@morda'}"), свой ask НЕ снимай — он остаётся открытым до решения.`,
  });
  return { sent: true, to: a.session, ask_id };
}

/** Открыть файл системным приложением. Путь проверяется тем же резолвом,
 *  что и обозреватель: наружу корня проекта не выпускаем. */
export function openFileOutside(project, rel) {
  const root = rootByName(project);
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error('путь вне корня проекта');
  if (!fs.existsSync(full)) throw new Error('файла нет');
  execFile('open', [full], () => {});
  return { opened: rel };
}

export function cancelAsk({ project, ask_id, by, reason }) {
  return hubFor(rootByName(project)).cancelAsk({ ask_id, by: by || 'morda', reason });
}

// ---------- этап 4: сессии и окно ----------

/** Сессии проекта из индекса плагина: список держится в памяти и
 *  перечитывается, только когда файловая система сказала, что каталог
 *  изменился (transcript.mjs, STOVP-65). Свой отпечаток каталога здесь
 *  больше не считается: он читал ОДИН каталог по хардкоду ~/.claude/projects
 *  (мимо CLAUDE_PROJECTS_DIR и worktree-каталогов) и всё равно stat-ил
 *  сотни файлов на каждый опрос. */
function sessionList(root) {
  return T.sessionIndex(root).list();
}

/** Сессии проекта + состояние сторожа + счётчик открытых ask по сессии.
 *  Сайдбар — рабочий пул, не архив: свежие сутки-двое либо всё, за чем
 *  ещё смотрит сторож / по чему висит открытый ask. */
/** Кто в какой работе: имя агента из будки → эпик и роль.
 *  Пул сессий плоский, а работа — иерархия «эпик → диспетчер → волны»
 *  (требование CTO 12.08: в списке 22 сессии вперемешку, и непонятно, кто
 *  чей). Собираем из будки: метка `wave` группирует сессии одной работы,
 *  эпик берём из префикса метки («1289-block3» → DEV-1289), а если префикса
 *  нет — самый частый тикет группы. Гадать не пытаемся: агент без метки и
 *  без тикета остаётся вне эпика. */
// Тикет волны — задача, а не эпик («Волна Б3-1: паспорт v2 (DEV-1228)»),
// поэтому одной будки для дерева мало: нужна связь «задача → эпик». Её даёт
// трекер (поле parent), а морда читает готовый кэш — ходить в Jira из
// сервера пульта не нужно. Нет файла — дерево просто группирует по тикету.
let epicsCache = null, epicsAt = 0;
function epics() {
  if (epicsCache && Date.now() - epicsAt < 60_000) return epicsCache;
  try {
    epicsCache = JSON.parse(fs.readFileSync(path.join(MORDA_ROOT, 'epics.json'), 'utf8'));
  } catch { epicsCache = { tickets: {}, epics: {} }; }
  epicsAt = Date.now();
  return epicsCache;
}
function toEpic(ticket) {
  if (!ticket) return null;
  return epics().tickets?.[ticket] || ticket;
}
export function epicTitle(ticket) {
  return epics().epics?.[ticket] || null;
}

function rolesFromHub(hub, key) {
  // окно широкое: сторож пишет сотни служебных постов в сутки и вымывает
  // из выборки реальную переписку волн (проверено — при 500 волны эпика
  // теряли своего диспетчера)
  const msgs = hub.read({ limit: 4000 }).messages || [];
  const isDisp = (n) => /^disp|диспетч/i.test(n);
  const byAgent = new Map();               // имя → {wave, tickets:Map, peers:Map}
  const touch = (who) => {
    if (!byAgent.has(who))
      byAgent.set(who, { wave: null, tickets: new Map(), peers: new Map() });
    return byAgent.get(who);
  };
  for (const m of msgs) {
    const who = String(m.from || '');
    if (!who || who === 'watchdog' || who === 'reanimator') continue;
    const a = touch(who);
    if (m.wave && !a.wave) a.wave = String(m.wave);
    if (m.ticket) a.tickets.set(m.ticket, (a.tickets.get(m.ticket) || 0) + 1);
    const to = String(m.to || '');
    if (to && to !== 'all') {              // переписка: волна ↔ её диспетчер
      a.peers.set(to, (a.peers.get(to) || 0) + 1);
      const b = touch(to);
      b.peers.set(who, (b.peers.get(who) || 0) + 1);
    }
  }
  // эпик группы: цифры в начале метки («1289-block3»), иначе тикет, который
  // называет ДИСПЕТЧЕР группы (волна называет свою задачу, а не эпик)
  const groups = new Map();                // метка → {disp:Map, all:Map}
  for (const [who, a] of byAgent) {
    if (!a.wave) continue;
    const g = groups.get(a.wave) || { disp: new Map(), all: new Map() };
    for (const [t, n] of a.tickets) {
      g.all.set(t, (g.all.get(t) || 0) + n);
      if (isDisp(who)) g.disp.set(t, (g.disp.get(t) || 0) + n);
    }
    groups.set(a.wave, g);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const epicOfGroup = new Map();
  for (const [label, g] of groups) {
    const digits = label.match(/^(\d{2,6})\b/)?.[1];
    epicOfGroup.set(label, toEpic(digits && key ? `${key}-${digits}`
      : top(g.disp) || top(g.all)));
  }
  const out = new Map();                   // имя агента → {epic, group, role}
  for (const [who, a] of byAgent) {
    const role = isDisp(who) ? 'dispatcher'
      : /^wave|волна/i.test(who) ? 'wave' : null;
    let epic = a.wave ? epicOfGroup.get(a.wave) || null : null;
    if (!epic && isDisp(who)) epic = toEpic(top(a.tickets));
    out.set(normLabel(who), { epic, group: a.wave || null, role, agent: who, peers: a.peers });
  }
  // волна без метки достаёт эпик у своего диспетчера — по переписке в будке
  for (const [k, v] of out) {
    if (v.epic || v.role === 'dispatcher') continue;
    const peer = [...v.peers.entries()].sort((a, b) => b[1] - a[1])
      .map(([n]) => out.get(normLabel(n))).find((p) => p?.role === 'dispatcher' && p.epic);
    if (peer) out.set(k, { ...v, epic: peer.epic, group: v.group || peer.group });
  }
  return out;
}

export function sessions(project) {
  const root = rootByName(project);
  const hub = hubFor(root);
  const watch = new Map(hub.watchStates().map((w) => [w.key, w]));
  const open = new Map();
  for (const a of hub.asks({ status: 'open' }).asks)
    open.set(a.session, (open.get(a.session) || 0) + 1);
  const dayAgo = Date.now() - 48 * 3600 * 1000;
  const roles = rolesFromHub(hub, trackerFor(root)?.keys?.[0] || null);
  const owned = runnerOwned();
  const thresholdMs = checkinMs(root);
  // список берём ОДИН раз на запрос: он копирует по объекту на сессию
  // (тысячи на большом проекте), а звался дважды — здесь и в starting()
  const list = sessionList(root);
  return list
    .map(({ file, lastActivity, ...s }) => {
      const r = roles.get(normLabel(s.title)) || null;
      // заголовок сессии — второй источник: «DEV-1210 Блок 1 диспетчер»
      const named = String(s.title || '').match(/\b([A-Z]{2,10}-\d+)\b/)?.[1] || null;
      // раннерская и заглушенная = запаркована: это сильнее свежести
      // mtime (транскрипт дописан секунду назад самой парковкой) и сильнее
      // старого вердикта сторожа
      const parked = owned.get(s.key) && !owned.get(s.key).alive;
      // Чек-ин по лентам (STOVP-60): свежесть — максимум по транскрипту,
      // лентам субагентов и выводам фоновых команд, поэтому «думают
      // субагенты» больше не выглядит тишиной (серый psylia, факт 21.08),
      // а «CLI жив» больше не прикрывает тишину дольше порога (45-минутный
      // тупик psylia на фоновых товарищах, факт 21.08). Считает её индекс
      // сессий (STOVP-65) — обхода лент на каждый опрос здесь больше нет.
      const lastAct = lastActivity;
      const ck = parked ? null : checkinState({
        w: watch.get(s.key), lastAct,
        aliveOwned: owned.get(s.key)?.alive, thresholdMs,
      });
      if (ck?.state === 'stalled') {
        const card = stalledCard(hub, { key: s.key, title: s.title, reason: ck.reason,
          quietMs: Date.now() - lastAct, thresholdMs,
          aliveOwned: owned.get(s.key)?.alive });
        // свежая карточка — в счётчик ЭТОГО же опроса: бейдж не отставал бы
        // на опрос (долг cross-review STOVP-60 r4, закрыт 22.08)
        if (card && card.deduped === false)
          open.set(s.key, (open.get(s.key) || 0) + 1);
      }
      return {
        ...s,
        state: parked ? 'parked' : ck?.state || null,
        reason: parked
          ? 'CLI закрыт, транскрипт цел — поднимется от сообщения или кнопкой «резюм»'
          : ck?.reason || null,
        open_asks: open.get(s.key) || 0,
        epic: toEpic(r?.epic || named),
        epic_title: epicTitle(toEpic(r?.epic || named)),
        group: r?.group || null,
        role: r?.role
          || (/диспетч|dispatch/i.test(s.title || '') ? 'dispatcher'
            : /волна|wave/i.test(s.title || '') ? 'wave' : null),
      };
    })
    .filter((s) => s.open_asks || s.state
      || new Date(s.mtime).getTime() > dayAgo)
    // безымянные headless-прогоны (тики сторожа и прочие claude -p) — шум
    // рабочего пула; с открытым ask или заголовком остаются
    .filter((s) => !(s.entrypoint === 'sdk-cli'
      && s.title === '(без названия)' && !s.open_asks))
    .slice(0, 60)
    .concat(starting(project, new Set(list.map((s) => s.key))));
}

// Свежезапущенная сессия раннера до первой записи ленты была невидимкой в
// сайдбаре («запустил — а её нет», CTO 23.08): реестр знает о ней раньше
// транскрипта. Доклеиваем строку «стартует…»; эпик — тикет из цели, чтобы
// она сразу вставала под свой эпик, а не «вне эпиков».
// seen — ключи уже собранного списка сессий этого же запроса (второй
// sessionList на тот же опрос был лишней копией тысяч объектов).
function starting(project, seen) {
  const out = [];
  try {
    const reg = JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8'));
    for (const [name, rec] of Object.entries(reg.sessions || {})) {
      if (rec.project !== project) continue;
      if (rec.state === 'stopped' || rec.state === 'died_on_start') continue;
      if (rec.sessionId && seen.has(rec.sessionId)) continue;
      const tick = String(rec.goal || '').match(/\b([A-Z]{2,10}-\d+)\b/)?.[1] || null;
      const live = rec.state === 'running' || rec.state === 'goal_sent';
      const brief = String(rec.goal || '').replace(/\s+/g, ' ').slice(0, 60);
      out.push({
        key: 'n-' + name, file: null, mtime: rec.startedAt, size: 0,
        title: brief ? `${name} — ${brief}` : `${name} — стартует…`,
        entrypoint: 'cli',
        state: live ? 'working' : 'starting',
        reason: live ? 'работает под слотом подписки — лента в каталоге слота'
          : 'сессия поднимается, лента ещё не создана',
        open_asks: 0, epic: toEpic(tick), epic_title: epicTitle(toEpic(tick)),
        group: null,
        role: /^disp/.test(name) ? 'dispatcher' : /^wave/.test(name) ? 'wave' : null,
      });
    }
  } catch { /* реестра нет — нечего доклеивать */ }
  return out;
}

/** Окно сессии: транскрипт + состояние + её ask + режим ввода.
 *  Ask — живые ПЛЮС недавние acknowledged: без них цепочка доставки
 *  обрывалась на подтверждении (ревью Sol r1). */
// Транскрипт диспетчера — мегабайты; поллинг раз в 5 с перечитывал его
// целиком, и окно открывалось секундами (жалоба CTO 11.08 «на мобилке всё
// умерло»). Короткий кэш: свежесть 3 с достаточна для чтения ленты.
const sessCache = new Map(); // root|key → { sig, r }
const WINDOW_BYTES = 3 * 1024 * 1024;   // хвост разговора: старше — история
// Транскрипты сессии, запущенной под слотом, лежат в каталоге ЭТОГО слота
// (<home>/projects), а не в ~/.claude/projects — иначе окно не находит ленту
// (факт 20.08, слот «Мариха»). Подставляем каталог на время чтения.
function slotProjectsDir(key) {
  try {
    const reg = JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8'));
    const rec = Object.values(reg.sessions || {}).find((s) => s.sessionId === key);
    if (!rec?.slot) return null;
    const slots = JSON.parse(fs.readFileSync(path.join(MORDA_ROOT, 'slots.json'), 'utf8'));
    const home = (slots.slots || []).find((x) => x.id === rec.slot)?.home;
    return home ? path.join(home, 'projects') : null;
  } catch { return null; }
}
function withSlotDir(key, fn) {
  const dir = slotProjectsDir(key);
  if (!dir || !fs.existsSync(dir)) return fn();
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = dir;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
  }
}

function readSessionCached(root, key) {
  const k = `${root}|${key}`;
  const c = sessCache.get(k);
  // отпечаток файла дешевле перечитывания: молчащую сессию не читаем вовсе,
  // а живую перечитываем ровно когда она дописала строку
  let sig = null;
  if (c?.r?.file) {
    try {
      const st = fs.statSync(c.r.file);
      sig = `${st.size}:${st.mtimeMs}`;
      if (sig === c.sig) return c.r;
    } catch { /* файл переехал — перечитаем */ }
  }
  // читаем хвост, а не весь файл: у диспетчеров это мегабайты, а окно всё
  // равно показывает конец разговора (флаг truncated честно об этом говорит)
  const r = withSlotDir(key, () => T.readSession(root, key, { maxBytes: WINDOW_BYTES }));
  if (r?.file) {
    try { const st = fs.statSync(r.file); sig = `${st.size}:${st.mtimeMs}`; } catch {}
  }
  sessCache.set(k, { sig, r });
  if (sessCache.size > 40) sessCache.delete(sessCache.keys().next().value);
  return r;
}

export function session(project, key) {
  const root = rootByName(project);
  const r = readSessionCached(root, key);
  if (!r) return null;
  const hub = hubFor(root);
  let w = hub.watchStates().find((x) => x.key === key) || null;
  // запаркованная раннером — правда сильнее сторожа (та же логика, что в
  // sessions(): зелёное «работает» на заглушенном CLI путало человека)
  const ro = runnerOwned().get(key);
  if (ro && !ro.alive)
    w = { state: 'parked', reason: 'CLI закрыт, транскрипт цел — поднимется от сообщения или кнопкой «резюм»' };
  else {
    // Чек-ин по лентам — тот же расчёт, что в списке (STOVP-60): иначе
    // список говорил «застряла», а открытое окно той же сессии — «работает»
    // (кросс-ревью Sol r2). parked выше — сильнее всего.
    let mt = 0;
    try { mt = fs.statSync(r.file).mtimeMs; } catch { /* файл переехал */ }
    const thresholdMs = checkinMs(root);
    const lastAct = lastActivityMs(r.file, key, mt);
    const ck = checkinState({ w: w || undefined, lastAct,
      aliveOwned: ro?.alive, thresholdMs });
    if (ck?.state === 'stalled')
      stalledCard(hub, { key, title: r.title, reason: ck.reason,
        quietMs: Date.now() - lastAct, thresholdMs, aliveOwned: ro?.alive });
    w = ck;
  }
  const asks = [
    ...hub.asks({ session: key }).asks,
    ...hub.asks({ session: key, status: 'acknowledged' }).asks.slice(-3),
  ];
  const { file, ...rest } = r; // абсолютный путь клиенту не нужен
  // Живость фоновых команд — фактом, не по ленте: живой фон держит открытым
  // свой файл вывода (lsof), мёртвый — нет. Уведомление о конце в ленту
  // приходит не всегда (убитые перезапуском), и «в фоне · 19 ч» висело
  // вечно (факт 23.08). Отдаём список живых id — окно скрывает мёртвых.
  try {
    const cand = [];
    for (const it of rest.items || []) {
      if (it.kind !== 'tool' || it.name !== 'Bash') continue;
      const res = String(it.result || '');
      const id = res.match(/running in background with ID: (\w+)/)?.[1];
      const out = res.match(/written to: (\/[^\s]+\.output)/)?.[1];
      if (id && out) cand.push({ id, out });
    }
    if (cand.length) {
      let heldPaths = new Set();
      try {
        // один вызов на все файлы: -F n печатает строки «n<путь>» для
        // каждого открытого — чей путь в выводе, тот фон и жив
        const out = execFileSync('lsof', ['-F', 'n', '--', ...cand.map((c) => c.out)],
          { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        heldPaths = new Set(out.split('\n')
          .filter((l) => l.startsWith('n')).map((l) => l.slice(1)));
      } catch { /* никто не держит — все мертвы */ }
      rest.bg_alive = cand.filter((c) => heldPaths.has(c.out)).map((c) => c.id);
    } else rest.bg_alive = [];
  } catch { /* без списка окно живёт по старым правилам */ }
  // имя сессии знает список (он его выводит из первой реплики), а чтение
  // одной сессии — нет: окно писало «(без названия)» там, где сайдбар в той
  // же секунде показывал имя (факт 21.08). Берём из того же списка.
  if (!rest.title) {
    const inList = sessionList(root).find((s) => s.key === key);
    if (inList) { rest.title = inList.title; rest.short = rest.short || inList.short; }
  }
  const tracker = trackerFor(root);
  // незакрытый родной HITL (AskUserQuestion без tool_result) — форма ждёт
  // человека; гаснет, если ПОСЛЕ формы уже была реплика человека (ответ
  // доехал каналом приложения — сессия пошла дальше, форма лишь висит в UI)
  // Служебные вставки рантайма (текст скилла, системные напоминания) —
  // это НЕ реплика человека: CLI шлёт их как user-сообщение (isMeta), и
  // в ленте они разворачивались стеной на пол-экрана (жалоба CTO 19.08).
  // Помечаем их как служебные — окно рисует свёрнутой плашкой.
  for (const it of r.items) {
    if (it.kind !== 'user' || it.system) continue;
    const t = it.text || '';
    if (t.startsWith('Base directory for this skill')) {
      const name = t.match(/skills\/([\w-]+)/)?.[1]
        || t.match(/^#\s+([\w-]+)/m)?.[1] || 'скилл';
      it.system = `подключён скилл ${name}`;
    } else if (/^<(system-reminder|command-message|local-command)/.test(t.trim())) {
      it.system = 'служебная вставка рантайма';
    } else if (/^Another Claude session sent a message|<teammate-message/.test(t.trim())) {
      // переписка с агентами-товарищами вываливалась в ленту стеной XML
      // на пол-экрана (жалоба CTO 21.08) — сворачиваем в строку
      const who = [...t.matchAll(/teammate_id="([\w-]+)"/g)].map((m) => m[1]);
      const uniq = [...new Set(who)];
      it.system = uniq.length
        ? `сообщение от агентов: ${uniq.join(', ')}`
        : 'сообщение от другой сессии';
    }
  }
  const hitlIdx = r.items.findLastIndex((i) => i.kind === 'tool' && i.questions && !i.result);
  const answeredAfter = hitlIdx >= 0
    && r.items.slice(hitlIdx + 1).some((i) => i.kind === 'user');
  const pendingHitl = hitlIdx >= 0 && !answeredAfter ? r.items[hitlIdx] : null;
  return {
    ...rest,
    project,
    state: w?.state || null,
    reason: w?.reason || null,
    asks,
    tracker,
    pending_hitl: pendingHitl ? { ts: pendingHitl.ts, questions: pendingHitl.questions } : null,
    agents: sessionAgents(project, key),
    input: inputFor(root, file, r.entrypoint),
  };
}

export function agentTranscript(project, key, agentId) {
  return withSlotDir(key, () => T.readAgent(rootByName(project), key, agentId));
}

/** Агенты сессии из каталога subagents/ — ВСЕ, включая фоновых.
 *  Фоновый агент (Agent с run_in_background) в мете не несёт toolUseId,
 *  поэтому к строке ленты не привязывается и раньше был невидим совсем
 *  (факт 19.08: аудитор поднял троих, в пульте — ни одного). Статус —
 *  по свежести его jsonl: пишет прямо сейчас или уже закончил. */
export function sessionAgents(project, key) {
  const root = rootByName(project);
  const r = readSessionCached(root, key);
  if (!r?.file) return [];
  const dir = path.join(path.dirname(r.file), key, 'subagents');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); }
  catch { return []; }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {}
    let updatedAt = null, size = 0, failed = false;
    const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
    try {
      const st = fs.statSync(jsonl);
      updatedAt = st.mtimeMs; size = st.size;
      // упал ли: хвост его ленты несёт ошибку рантайма или API
      const fd = fs.openSync(jsonl, 'r');
      const len = Math.min(st.size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const tail = buf.toString('utf8');
      failed = /"isApiErrorMessage":true|"subtype":"error"|"is_error":true/.test(tail);
    } catch {}
    out.push({
      agentId, name: m.name || null, agentType: m.agentType || null,
      description: m.description || null, model: m.model || null,
      team: m.teamName || null, size,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      // пишет в последние полминуты — считаем живым
      busy: !!updatedAt && now - updatedAt < 30_000,
      failed,
    });
  }
  return out.sort((a, b) => (a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1);
}

/** Мета сессии для раннера: cwd — РОДНОЙ каталог сессии из транскрипта.
 *  Резюм обязан идти в нём: проекты-надмножества видят сессии подпапок
 *  (nyron видит stovp), и резюм в корне «их» проекта убивал сессию на
 *  старте — claude --resume ищет разговор по cwd (факт 17.08). */
/** Давно ли сессия дописывала свои ленты. Экран терминала врёт: зависший CLI
 *  продолжает крутить спиннер и счётчик, и пульт показывал бодрое «работает»
 *  на сессии, которая молчала 75 минут (факт 21.08, дважды за день). Рост
 *  лент — независимый признак; лент ТРИ (транскрипт, субагенты, фоновые
 *  команды — lastActivityMs, STOVP-60): пока думают субагенты, главная лента
 *  молчит законно — раннер красил такую сессию в «похоже, встала», и
 *  автосудья пинал работающую (факт 22.08, psylia на 8 агентах). */
export function transcriptQuietMs(project, key) {
  try {
    const act = T.sessionIndex(rootByName(project)).lastActivity(key);
    return act ? Date.now() - act : null;
  } catch { return null; }
}

export function sessionMeta(project, key) {
  const r = withSlotDir(key, () => T.readSession(rootByName(project), key, { maxBytes: 64 * 1024 }));
  return r ? { cwd: r.cwd, cwd_alive: r.cwd_alive, entrypoint: r.entrypoint } : null;
}

// ---------- ввод в чат (спека, этап 4: tmux — мгновенно; Desktop — зеркало) ----------

// Живые процессы claude этой машины: pid ↔ sessionId ↔ cwd. Это самое
// прямое доказательство «какая панель хостит какую сессию» — транскрипт
// CLI не держит открытым (факт 17.08: lsof пуст), а свой pid не врёт.
export const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude']
    .find((p) => fs.existsSync(p)) || 'claude';
// Абсолютный путь и для tmux: под launchd PATH минимальный (/usr/bin:/bin…),
// голое имя не находилось — боевой пульт видел все панели «мёртвыми»
// (факт 17.08 после перезагрузки приложения).
export const TMUX_BIN = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']
    .find((p) => fs.existsSync(p)) || 'tmux';
// PATH для спавна CLI: claude/codex — node-шимы, под launchd node в PATH
// нет («env: node: No such file or directory», факт 17.08). Каталог node
// самого сервера — первым; важно и для tmux: его сервер наследует env
// первого запуска, а из него — все будущие панели с claude.
// PATH сессий собираем явно: пульт живёт под launchd, а тот даёт голый
// /usr/bin:/bin. Без /usr/local/bin сессия не находила docker и спотыкалась
// на проверках стека (факт 21.08, аудитор psylia).
export const SPAWN_ENV = { ...process.env,
  PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'), process.env.PATH,
    '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter(Boolean).join(':') };

// Реестр раннера — единый файл для fleet и runner.js (runner импортирует
// путь отсюда). Сайдбару нужна правда «запаркована»: свежий mtime
// транскрипта только что заглушенной сессии рисовал зелёное «работает»
// (жалоба CTO 17.08 «почему точка зелёная»).
export const RUNNER_STATE_FILE = process.env.MORDA_RUNNER_STATE
  || path.join(MORDA_ROOT, 'runner.json');
// «Работает» проверяется тишиной ЛЕНТ, а не словом сторожа и не живостью
// процесса — расчёт вынесен в checkin.js (STOVP-60): сторож держал зелёное
// на сессии, молчащей час (CTO 21.08), а живой tmux прикрывал 45-минутный
// тупик psylia. Прочие вердикты сторожа не трогаем: «ждёт решения»,
// «застряла», «закончилась» от тишины не меняются.

export function runnerOwned() {
  const out = new Map(); // sessionId → { name, alive }
  let reg;
  try { reg = JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8')); }
  catch { return out; }
  let live = new Set();
  try {
    live = new Set(execFileSync(TMUX_BIN, ['list-sessions', '-F', '#{session_name}'],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: SPAWN_ENV })
      .toString().trim().split('\n'));
  } catch { /* tmux не поднят — все мертвы */ }
  for (const [name, s] of Object.entries(reg.sessions || {})) {
    if (s.sessionId) out.set(s.sessionId, { name, alive: live.has('stovp-' + name) });
  }
  return out;
}
// `claude agents --json` — синхронный и НЕ дешёвый (поднимает CLI, до 8 с),
// а зовётся по разу на каждый дом подписки на каждый опрос: сервер вставал
// на десятки секунд даже без нагрузки (факт 23.08 — висящий дочерний
// процесс держал весь пульт). Кэш 10 с: живые агенты меняются медленнее.
let liveAgentsCache = { at: 0, out: null };
export function liveAgents(...a) {
  if (liveAgentsCache.out && Date.now() - liveAgentsCache.at < 10_000)
    return liveAgentsCache.out;
  const out = liveAgentsRaw(...a);
  liveAgentsCache = { at: Date.now(), out };
  return out;
}
function liveAgentsRaw() {
  // Слоты с отдельным конфиг-каталогом (CLAUDE_CONFIG_DIR) — свои сессии:
  // без обхода каталогов сессия слота не привязывалась и окно вечно ждало
  // (факт 20.08, слот «Мариха»).
  const homes = [null];
  try {
    const slots = JSON.parse(fs.readFileSync(path.join(MORDA_ROOT, 'slots.json'), 'utf8'));
    for (const sl of slots.slots || [])
      if (sl.provider === 'claude' && sl.home) homes.push(sl.home);
  } catch {}
  const out = [];
  const seen = new Set();
  for (const home of homes) {
    try {
      const env = home ? { ...SPAWN_ENV, CLAUDE_CONFIG_DIR: home } : SPAWN_ENV;
      const rows = JSON.parse(execFileSync(CLAUDE_BIN, ['agents', '--json'],
        { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env }).toString());
      for (const r of rows) {
        if (seen.has(r.sessionId)) continue;
        seen.add(r.sessionId);
        out.push({ ...r, slotHome: home });
      }
    } catch { /* этот каталог не отвечает — остальные всё равно спросим */ }
  }
  return out;
}

// Панели tmux, где в корне проекта крутится claude.
export function tmuxCandidates(root) {
  let out;
  try {
    // разделитель многосимвольный: таб tmux молча превращает в '_' (факт 09.08)
    out = execFileSync(TMUX_BIN, ['list-panes', '-a', '-F',
      '#{pane_id}|;|#{pane_pid}|;|#{session_name}|;|#{pane_current_path}|;|#{pane_current_command}'],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { return []; } // tmux не поднят — честно пусто
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const [pane, pid, session, cwd, cmd] = l.split('|;|');
    return { pane, pid: Number(pid), session, cwd, cmd };
  }).filter((p) => (p.cwd === root || p.cwd?.startsWith(root + path.sep))
    && /claude|node/.test(p.cmd || ''));
}

// Дерево процессов панели: pane_pid + все потомки (ps один раз на вызов).
// Экспорт: раннер (runner.js) привязывает tmux-панель к sessionId через
// pid из `claude agents --json` — тот же механизм, вторую копию не заводим.
export function paneProcessTree(panePid) {
  let ps;
  try {
    ps = execFileSync('ps', ['-axo', 'pid=,ppid='],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { return [panePid]; }
  const kids = new Map(); // ppid → [pid]
  for (const l of ps.trim().split('\n')) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [];
  const stack = [panePid];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    for (const k of kids.get(p) || []) stack.push(k);
  }
  return out;
}

// Держит ли кто-то в дереве панели открытым ИМЕННО этот файл транскрипта.
// Это ЕДИНСТВЕННАЯ принимаемая привязка панель↔сессия (ревью Sol r1:
// ввод без привязки мог уйти в чужой чат; при неоднозначности — запрет).
// Сверка точная по n-строкам lsof, не подстрокой (ревью Sol r2:
// .jsonl.lock/.backup и дубль uuid ложно доказывали привязку).
function paneHoldsFile(panePid, file) {
  const pids = paneProcessTree(panePid);
  const wanted = new Set([file]);
  try { wanted.add(fs.realpathSync(file)); } catch {}
  try {
    const out = execFileSync('lsof', ['-p', pids.join(','), '-Fn'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split('\n').some((l) => l.startsWith('n') && wanted.has(l.slice(1)));
  } catch { return false; }
}

/** Режим ввода окна сессии:
 *  { mode: 'tmux', pane }    — панель однозначно хостит эту сессию;
 *  { mode: 'desktop' }       — сессия живёт в приложении, только зеркало;
 *  { mode: 'mirror', candidates } — привязка не доказана, ввод запрещён.
 *  Первичное доказательство — pid из `claude agents --json` в дереве
 *  процессов панели (сессия сама называет свой uuid). lsof по файлу —
 *  запасной путь: CLI транскрипт открытым не держит (факт 17.08). */
export function inputFor(root, file, entrypoint) {
  // file — ровно тот путь, который вернуло чтение (readSession().file):
  // повторный независимый выбор давал окно гонки на дублях uuid
  // (ревью Sol r3: показали транскрипт A — привязали ввод к B)
  const key = file ? path.basename(file, '.jsonl') : null;
  // pid-привязка ПЕРВОЙ, метка entrypoint — после: CLI-сессия с Remote
  // Control пишет в транскрипт entrypoint=claude-desktop (факт 17.08), и
  // проверка метки раньше панели отправляла живой tmux в «зеркало Desktop»
  if (key) {
    const agent = liveAgents().find((a) => a.sessionId === key);
    if (agent) {
      const hit = tmuxCandidates(root)
        .find((c) => paneProcessTree(c.pid).includes(agent.pid));
      if (hit) return { mode: 'tmux', pane: hit };
    }
  }
  if (entrypoint === 'claude-desktop') return { mode: 'desktop' };
  if (!file) return { mode: 'mirror', candidates: 0 };
  const cands = tmuxCandidates(root);
  const matches = cands.filter((c) => paneHoldsFile(c.pid, file));
  if (matches.length === 1) return { mode: 'tmux', pane: matches[0] };
  return { mode: 'mirror', candidates: cands.length };
}

/** Отправить текст в чат сессии. Панель НЕ приходит с клиента — сервер
 *  сам заново доказывает привязку панель↔сессия и шлёт только в неё.
 *  Без tmux-привязки (Desktop/headless) сообщение НЕ теряется: уходит
 *  адресным постом в будку (канон: сессии обязаны её читать; спящих
 *  добуживает почтальон через send_message приложения — вопрос CTO 10.08
 *  «почему не дать мне писать в неё в целом»). */
export function say({ project, key, text, by }) {
  const root = rootByName(project);
  if (!text || typeof text !== 'string') throw new Error('пустой текст');
  const r = T.readSession(root, key, { maxBytes: 64 * 1024 });
  if (!r) throw new Error(`сессия ${key} не найдена в проекте ${project}`);
  const input = inputFor(root, r.file, r.entrypoint);
  if (input.mode === 'tmux') {
    execFileSync(TMUX_BIN, ['send-keys', '-t', input.pane.pane, '-l', text], { timeout: 3000 });
    execFileSync(TMUX_BIN, ['send-keys', '-t', input.pane.pane, 'Enter'], { timeout: 3000 });
    return { sent: true, via: 'tmux', pane: input.pane.pane };
  }
  const hub = hubFor(root);
  hub.post({
    from: by || 'CTO@morda', to: key, wave: 'morda-inbox',
    // адресат — в самом тексте: шину читают все, и чужое сообщение без
    // явного «кому» диспетчеры принимали на свой счёт (факт 10.08)
    text: `[сообщение человека из морды — ТОЛЬКО для сессии ${key.slice(0, 8)}, остальным игнорировать] ${text}`,
  });
  return { sent: true, via: 'hub', note: 'адресный пост в будке: рабочая сессия заберёт при чтении, спящую добудит почтальон' };
}
