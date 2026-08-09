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

function projects() {
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

export function overview() {
  const list = projects();
  if (!list) {
    return { error: 'нет morda/projects.json — скопируй projects.json.example и впиши корни проектов', projects: [] };
  }
  return {
    projects: list.map(({ name, root }) => {
      try {
        const hub = hubFor(root);
        return {
          name, root,
          asks: hub.asks({}).asks,          // живые: open + answered/delivered
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
  return hubFor(rootByName(project)).decide({ ask_id, decision, by: by || 'morda' });
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

/** Окно сессии: транскрипт + состояние + её ask (живые и решённые) + tmux. */
export function session(project, key) {
  const root = rootByName(project);
  const r = T.readSession(root, key);
  if (!r) return null;
  const hub = hubFor(root);
  const w = hub.watchStates().find((x) => x.key === key) || null;
  return {
    ...r,
    project,
    state: w?.state || null,
    reason: w?.reason || null,
    asks: hub.asks({ session: key }).asks,
    tmux: tmuxCandidates(root),
  };
}

export function agentTranscript(project, key, agentId) {
  return T.readAgent(rootByName(project), key, agentId);
}

// ---------- ввод в чат (спека, этап 4: tmux — мгновенно; Desktop — зеркало) ----------

// Панели tmux, где в корне проекта крутится claude. Привязать панель к
// КОНКРЕТНОМУ uuid сессии пока нечем (реестр сессия↔копия — исследование
// спеки); честное правило: одна панель-кандидат — пишем в неё, несколько —
// клиент выбирает явно из списка, ноль — только зеркало.
export function tmuxCandidates(root) {
  let out;
  try {
    // разделитель многосимвольный: таб tmux молча превращает в '_' (факт 09.08)
    out = execFileSync('tmux', ['list-panes', '-a', '-F',
      '#{pane_id}|;|#{session_name}|;|#{pane_current_path}|;|#{pane_current_command}'],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { return []; } // tmux не поднят — честно пусто
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const [pane, session, cwd, cmd] = l.split('|;|');
    return { pane, session, cwd, cmd };
  }).filter((p) => (p.cwd === root || p.cwd?.startsWith(root + path.sep))
    && /claude|node/.test(p.cmd || ''));
}

/** Отправить текст в панель tmux. pane обязан быть из tmuxCandidates —
 *  клиент не может писать в произвольную панель машины. */
export function say({ project, pane, text }) {
  const root = rootByName(project);
  if (!text || typeof text !== 'string') throw new Error('пустой текст');
  const ok = tmuxCandidates(root).some((c) => c.pane === pane);
  if (!ok) throw new Error(`панель ${pane} не найдена среди сессий проекта — ввод только в свои`);
  execFileSync('tmux', ['send-keys', '-t', pane, '-l', text], { timeout: 3000 });
  execFileSync('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 3000 });
  return { sent: true, pane };
}
