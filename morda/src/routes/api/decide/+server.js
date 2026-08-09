import { json } from '@sveltejs/kit';
import { decide, cancelAsk } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    if (!body?.project || !body?.ask_id)
      return json({ error: 'нужны project и ask_id' }, { status: 400 });
    if (body.action === 'cancel') return json(cancelAsk(body));
    return json(decide(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
