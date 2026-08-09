import { json } from '@sveltejs/kit';
import { decide, cancelAsk } from '$lib/server/fleet.js';

export async function POST({ request }) {
  const body = await request.json();
  try {
    if (body.action === 'cancel') return json(cancelAsk(body));
    return json(decide(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
