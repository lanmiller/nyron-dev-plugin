import { json } from '@sveltejs/kit';
import { session } from '$lib/server/fleet.js';

// Окно сессии: полный транскрипт (с обрезкой хвостом на гигантах),
// состояние сторожа, ask этой сессии, tmux-кандидаты для ввода.
export async function GET({ params }) {
  try {
    const s = session(params.project, params.key);
    if (!s) return json({ error: 'сессия не найдена' }, { status: 404 });
    return json(s);
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
