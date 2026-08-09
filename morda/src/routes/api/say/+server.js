import { json } from '@sveltejs/kit';
import { say } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Ввод в чат tmux-сессии (спека, этап 4: tmux — мгновенно). Панель клиент
// НЕ выбирает: сервер сам доказывает привязку панель↔сессия (fleet.say),
// без привязки — отказ (ревью Sol r1: ввод не должен уйти в чужой чат).
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    if (!body?.project || !body?.key || !body?.text)
      return json({ error: 'нужны project, key и text' }, { status: 400 });
    return json(say(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
