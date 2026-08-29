import { json } from '@sveltejs/kit';
import { say } from '$lib/server/fleet.js';
import { resumeForInput, runnerBySessionId, injectSend } from '$lib/server/runner.js';
import { guarded } from '$lib/server/guard.js';

// Ввод в чат сессии. Панель клиент НЕ выбирает: сервер сам доказывает
// привязку панель↔сессия (fleet.say). Мёртвую CLI-сессию сообщение
// ПОДНИМАЕТ резюмом и уезжает первым вводом (CTO 17.08); живую где-то ещё
// (Desktop) — доставляет будка-почтальон, как раньше.
export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    if (!body?.project || !body?.key || !body?.text)
      return json({ error: 'нужны project, key и text' }, { status: 400 });
    // Живая сессия раннера — прямой ввод через раннер (очередь на диалогах,
    // дожим Enter). Обязательный первый путь для сессий под слотом подписки:
    // их лента живёт в каталоге слота, fleet.say по транскриптам проекта их
    // не находит — «сессия не найдена» на живой сессии (факт CTO 30.08)
    const rec = runnerBySessionId(body.key);
    if (rec?.alive && rec.project === body.project)
      return json({ sent: true, via: 'runner', ...injectSend({ name: rec.name, text: body.text }) });
    const revived = resumeForInput(body);
    if (revived) return json({ sent: true, via: 'resume',
      note: `сессия была запаркована — поднимаю резюмом (${revived.project}/${body.key.slice(0, 8)}), сообщение уйдёт первым вводом` });
    return json(say(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
