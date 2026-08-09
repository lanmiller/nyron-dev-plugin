import { json } from '@sveltejs/kit';
import { decide, cancelAsk } from '$lib/server/fleet.js';

// CSRF-щит (ревью Sol 09.08): localhost не защищает — чужой сайт в браузере
// CTO может слать простые POST на 127.0.0.1. Требуем свой заголовок (его
// нельзя поставить простым cross-origin запросом без preflight) и
// same-origin по Sec-Fetch-Site, когда браузер его прислал.
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
    const body = await request.json();
    if (!body?.project || !body?.ask_id)
      return json({ error: 'нужны project и ask_id' }, { status: 400 });
    if (body.action === 'cancel') return json(cancelAsk(body));
    return json(decide(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
