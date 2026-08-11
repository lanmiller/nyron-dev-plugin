import { json } from '@sveltejs/kit';
import { openFileOutside } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Открыть файл проекта системным просмотрщиком: встроенный браузер не умеет
// PDF и прочие форматы, а системный «Просмотр» умеет всё (CTO 11.08).
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const { project, path } = await request.json();
    if (!project || !path) return json({ error: 'нужны project и path' }, { status: 400 });
    return json(openFileOutside(project, path));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
