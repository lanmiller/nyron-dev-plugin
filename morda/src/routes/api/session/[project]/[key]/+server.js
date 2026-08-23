import os from 'node:os';
import { json } from '@sveltejs/kit';
import { session } from '$lib/server/fleet.js';
import { runnerBySessionId } from '$lib/server/runner.js';

// Окно сессии: полный транскрипт (с обрезкой хвостом на гигантах),
// состояние сторожа, ask этой сессии, tmux-кандидаты для ввода.
// runner — запись реестра раннера, если процессом владеет пульт:
// карточка тогда показывает кнопки стоп/резюм (этап 1 STOVP-58).
export async function GET({ params }) {
  try {
    const s = session(params.project, params.key);
    if (!s) return json({ error: 'сессия не найдена' }, { status: 404 });
    // boot_at — фоновые команды не переживают перезагрузку: всё, что
    // стартовало раньше, мертво по определению (вечные «в фоне · 20 ч»
    // после ребута — факт 23.08)
    return json({ ...s, runner: runnerBySessionId(params.key),
      boot_at: Date.now() - os.uptime() * 1000 });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
