import { json } from '@sveltejs/kit';
import { openCopy } from '$lib/server/fleet.js';

// Тот же CSRF-щит, что у /api/decide: открытие приложений — тоже руки.
function guarded(request) {
  if (request.headers.get('x-morda') !== '1') return 'нет заголовка x-morda';
  const sfs = request.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return `sec-fetch-site: ${sfs}`;
  return null;
}

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
