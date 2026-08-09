import { json } from '@sveltejs/kit';
import { openSession } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Диплинк claude://resume?session=<uuid> — открыть сессию в приложении
// Claude (какая копия — решает системный обработчик схемы).
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const { project, key } = await request.json();
    if (!project || !key) return json({ error: 'нужны project и key' }, { status: 400 });
    return json(openSession(project, key));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
