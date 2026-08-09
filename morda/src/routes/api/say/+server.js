import { json } from '@sveltejs/kit';
import { say } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Ввод в чат tmux-сессии (спека, этап 4: tmux — мгновенно). Панель обязана
// быть из списка кандидатов проекта — проверяет fleet.say.
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    if (!body?.project || !body?.pane || !body?.text)
      return json({ error: 'нужны project, pane и text' }, { status: 400 });
    return json(say(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
