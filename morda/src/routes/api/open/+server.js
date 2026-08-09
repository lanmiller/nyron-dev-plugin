import { json } from '@sveltejs/kit';
import { openCopy } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const { app } = await request.json();
    return json(openCopy(app));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
