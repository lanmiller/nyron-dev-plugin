/**
 * plugin-hub.js — где лежит плагин nyron-dev и его модули.
 *
 * Резолв каталога жил в fleet.js, но с индексом сессий (STOVP-65) к
 * transcript.mjs пошёл и checkin.js: индекс держит вотчеры и кэш в
 * модульном состоянии, а статический импорт из morda/src дал бы ВТОРУЮ
 * копию модуля в сборке (Vite инлайнит её в бандл сервера) — второй набор
 * вотчеров и второй кэш на те же каталоги. Поэтому точка входа одна и
 * рантаймовая: динамический импорт по абсолютному пути.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const MORDA_ROOT = firstExisting([
  process.env.MORDA_ROOT,
  path.resolve(HERE, '../../..'),      // dev: morda/src/lib/server → morda
  path.resolve(HERE, '../../../..'),   // build/server/chunks → morda
  process.cwd(),                        // npm запускается из morda/
], 'projects.json.example', 'MORDA_ROOT');

export const PLUGIN_HUB = firstExisting([
  process.env.NYRON_PLUGIN_HUB,
  path.resolve(MORDA_ROOT, '../nyron-dev/hub'),
], 'hub-db.mjs', 'NYRON_PLUGIN_HUB');

// Транскрипты — реализацией плагина (общая со сторожем): список сессий,
// окно, индекс и свежесть лент.
export const T = await import(/* @vite-ignore */ path.join(PLUGIN_HUB, 'transcript.mjs'));
