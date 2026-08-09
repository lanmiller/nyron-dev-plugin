import { json } from '@sveltejs/kit';
import { sessions } from '$lib/server/fleet.js';

// Сессии проекта для сайдбара: транскрипты + состояния сторожа + открытые ask.
export async function GET({ params }) {
  try {
    return json({ sessions: sessions(params.project) });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
