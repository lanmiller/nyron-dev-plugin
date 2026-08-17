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
    return json({ ...s, runner: runnerBySessionId(params.key) });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
