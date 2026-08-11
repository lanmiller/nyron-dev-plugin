import { json } from '@sveltejs/kit';
import { askAuthor } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Встречный вопрос автору ask прямо с карточки: вопрос непонятен — уточнить,
// не разыскивая сессию и не закрывая сам вопрос (флоу CTO 11.08).
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    if (!body?.project || !body?.ask_id || !body?.text)
      return json({ error: 'нужны project, ask_id и text' }, { status: 400 });
    return json(askAuthor(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
