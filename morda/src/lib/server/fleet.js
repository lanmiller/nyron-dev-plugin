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
import { execFile } from 'node:child_process';

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

// hub-db из плагина — единственная реализация будки, вторую не заводим
const { HubDb } = await import(/* @vite-ignore */ path.join(PLUGIN_HUB, 'hub-db.mjs'));

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

export function decide({ project, ask_id, decision, by }) {
  return hubFor(rootByName(project)).decide({ ask_id, decision, by: by || 'morda' });
}

export function cancelAsk({ project, ask_id, by, reason }) {
  return hubFor(rootByName(project)).cancelAsk({ ask_id, by: by || 'morda', reason });
}
