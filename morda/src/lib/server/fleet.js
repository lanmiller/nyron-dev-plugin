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
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MORDA_ROOT = path.resolve(HERE, '../../..');
const PLUGIN_HUB = path.resolve(MORDA_ROOT, '../nyron-dev/hub');

// hub-db из плагина — единственная реализация будки, вторую не заводим
const { HubDb } = await import(path.join(PLUGIN_HUB, 'hub-db.mjs'));

const dbs = new Map(); // root → HubDb (ленивые синглтоны на процесс)

function projects() {
  const p = path.join(MORDA_ROOT, 'projects.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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
  };
}

export function decide({ root, ask_id, decision, by }) {
  return hubFor(root).decide({ ask_id, decision, by: by || 'morda' });
}

export function cancelAsk({ root, ask_id, by, reason }) {
  return hubFor(root).cancelAsk({ ask_id, by: by || 'morda', reason });
}
