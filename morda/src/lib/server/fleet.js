/**
 * fleet.js — тонкий слой доступа морды (канон спеки: морда НЕ читает
 * hub.db напрямую; в фазе 2 меняется только этот файл — на сетевой клиент).
 *
 * Проекты — morda/projects.json (gitignored, машинное):
 *   [{ "name": "nyron", "root": "/Users/x/ai-evolve" }, …]
 * Файла нет — пусто и понятная подсказка в overview.error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Модуль переезжает между dev (morda/src/lib/server), сборкой
// (.svelte-kit/output/…) и прод-билдом (build/server/chunks) — жёсткий
// относительный путь ломается (ревью Sol 09.08 + факт: build падал).
// Резолв честный: env в приоритете, дальше перебор кандидатов по факту
// существования файла.
function firstExisting(cands, probe, envName) {
  for (const c of cands.filter(Boolean)) {
    if (fs.existsSync(path.join(c, probe))) return c;
  }
  throw new Error(
    `не нашёл ${probe}; задай env ${envName}; искал: ${cands.filter(Boolean).join(' | ')}`);
}
const MORDA_ROOT = firstExisting([
  process.env.MORDA_ROOT,
  path.resolve(HERE, '../../..'),      // dev: morda/src/lib/server → morda
  path.resolve(HERE, '../../../..'),   // build/server/chunks → morda
  process.cwd(),                        // npm запускается из morda/
], 'projects.json.example', 'MORDA_ROOT');
const PLUGIN_HUB = firstExisting([
  process.env.NYRON_PLUGIN_HUB,
  path.resolve(MORDA_ROOT, '../nyron-dev/hub'),
], 'hub-db.mjs', 'NYRON_PLUGIN_HUB');

// hub-db из плагина — единственная реализация будки, вторую не заводим;
// транскрипты — тоже реализацией плагина (transcript.mjs, общая со сторожем)
const { HubDb } = await import(/* @vite-ignore */ path.join(PLUGIN_HUB, 'hub-db.mjs'));
const T = await import(/* @vite-ignore */ path.join(PLUGIN_HUB, 'transcript.mjs'));

// Реестр соединений — в globalThis: Vite HMR пересоздаёт модуль, и
// локальная Map копила бы открытые SQLite-дескрипторы (ревью Sol 09.08).
const dbs = (globalThis.__mordaHubs ??= new Map()); // root → HubDb

export function projects() {
  const p = path.join(MORDA_ROOT, 'projects.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// root НИКОГДА не приходит с клиента (ревью Sol: произвольный путь из POST
// создавал бы .nyron-hub где угодно) — только имя проекта, резолв по
// allowlist projects.json.
function rootByName(name) {
  const p = (projects() || []).find((x) => x.name === name);
  if (!p) throw new Error(`неизвестный проект: ${name}`);
  return p.root;
}

function hubFor(root) {
  if (!dbs.has(root)) dbs.set(root, new HubDb(path.join(root, '.nyron-hub')));
  return dbs.get(root);
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

export function overview() {
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
        const titles = new Map(listSessionsCached(root).map((s) => [s.key, s.title]));
        const named = (a) => ({ ...a, session_title: titles.get(a.session) || null });
        return {
          name, root,
          // живые (open + answered/delivered) + хвост acknowledged: цепочка
          // доставки видна до конца, а не рвётся на ack (ревью Sol r1)
          asks: [...hub.asks({}).asks.map(named),
            ...hub.asks({ status: 'acknowledged' }).asks.slice(-3).map(named)],
          watch: hub.watchStates(),
          recent: hub.recent(8),
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
  if (!listSessionsCached(root).some((s) => s.key === key))
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

export function cancelAsk({ project, ask_id, by, reason }) {
  return hubFor(rootByName(project)).cancelAsk({ ask_id, by: by || 'morda', reason });
}

// ---------- этап 4: сессии и окно ----------

// Список сессий читает голову каждого транскрипта — при поллинге раз в 5с
// это лишние мегабайты; короткий TTL-кэш достаточен (окно свежести 10с).
const sessListCache = new Map(); // root → { at, list }
function listSessionsCached(root) {
  const c = sessListCache.get(root);
  if (c && Date.now() - c.at < 10_000) return c.list;
  const list = T.listSessions(root);
  sessListCache.set(root, { at: Date.now(), list });
  return list;
}

/** Сессии проекта + состояние сторожа + счётчик открытых ask по сессии.
 *  Сайдбар — рабочий пул, не архив: свежие сутки-двое либо всё, за чем
 *  ещё смотрит сторож / по чему висит открытый ask. */
export function sessions(project) {
  const root = rootByName(project);
  const hub = hubFor(root);
  const watch = new Map(hub.watchStates().map((w) => [w.key, w]));
  const open = new Map();
  for (const a of hub.asks({ status: 'open' }).asks)
    open.set(a.session, (open.get(a.session) || 0) + 1);
  const dayAgo = Date.now() - 48 * 3600 * 1000;
  return listSessionsCached(root)
    .map(({ file, ...s }) => ({
      ...s,
      state: watch.get(s.key)?.state || null,
      reason: watch.get(s.key)?.reason || null,
      open_asks: open.get(s.key) || 0,
    }))
    .filter((s) => s.open_asks || s.state
      || new Date(s.mtime).getTime() > dayAgo)
    // безымянные headless-прогоны (тики сторожа и прочие claude -p) — шум
    // рабочего пула; с открытым ask или заголовком остаются
    .filter((s) => !(s.entrypoint === 'sdk-cli'
      && s.title === '(без названия)' && !s.open_asks))
    .slice(0, 60);
}

/** Окно сессии: транскрипт + состояние + её ask + режим ввода.
 *  Ask — живые ПЛЮС недавние acknowledged: без них цепочка доставки
 *  обрывалась на подтверждении (ревью Sol r1). */
export function session(project, key) {
  const root = rootByName(project);
  const r = T.readSession(root, key);
  if (!r) return null;
  const hub = hubFor(root);
  const w = hub.watchStates().find((x) => x.key === key) || null;
  const asks = [
    ...hub.asks({ session: key }).asks,
    ...hub.asks({ session: key, status: 'acknowledged' }).asks.slice(-3),
  ];
  const { file, ...rest } = r; // абсолютный путь клиенту не нужен
  const tracker = trackerFor(root);
  // незакрытый родной HITL (AskUserQuestion без tool_result) — форма ждёт
  // человека; гаснет, если ПОСЛЕ формы уже была реплика человека (ответ
  // доехал каналом приложения — сессия пошла дальше, форма лишь висит в UI)
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
    input: inputFor(root, file, r.entrypoint),
  };
}

export function agentTranscript(project, key, agentId) {
  return T.readAgent(rootByName(project), key, agentId);
}

// ---------- ввод в чат (спека, этап 4: tmux — мгновенно; Desktop — зеркало) ----------

// Панели tmux, где в корне проекта крутится claude.
export function tmuxCandidates(root) {
  let out;
  try {
    // разделитель многосимвольный: таб tmux молча превращает в '_' (факт 09.08)
    out = execFileSync('tmux', ['list-panes', '-a', '-F',
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
function paneProcessTree(panePid) {
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
 *  { mode: 'tmux', pane }    — панель однозначно держит этот транскрипт;
 *  { mode: 'desktop' }       — сессия живёт в приложении, только зеркало;
 *  { mode: 'mirror', candidates } — привязка не доказана, ввод запрещён. */
export function inputFor(root, file, entrypoint) {
  if (entrypoint === 'claude-desktop') return { mode: 'desktop' };
  // file — ровно тот путь, который вернуло чтение (readSession().file):
  // повторный независимый выбор давал окно гонки на дублях uuid
  // (ревью Sol r3: показали транскрипт A — привязали ввод к B)
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
    execFileSync('tmux', ['send-keys', '-t', input.pane.pane, '-l', text], { timeout: 3000 });
    execFileSync('tmux', ['send-keys', '-t', input.pane.pane, 'Enter'], { timeout: 3000 });
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
