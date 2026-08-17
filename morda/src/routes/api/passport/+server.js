import { json } from '@sveltejs/kit';
import { passportCheck } from '$lib/server/passport.js';
import { guarded } from '$lib/server/guard.js';

// Верификатор паспорта проекта (STOVP-59 шаг 2): POST { project } →
// { project, at, items: [{ id, title, ok, fact, fix }] }. Прогон долгий
// (докерный MCP отвечает секундами) — это цена проверки фактом.
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    return json(await passportCheck({ project: body?.project }));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
