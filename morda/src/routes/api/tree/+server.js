import { json } from '@sveltejs/kit';
import { projects, sessions } from '$lib/server/fleet.js';

// Дерево «проект → его сессии» одним запросом: слева одна навигация вместо
// переключателя проектов и отдельного списка (эталон Claude Desktop,
// требование CTO 11.08 «слева группировка проекта»).
export async function GET() {
  const out = [];
  for (const { name } of projects()) {
    try {
      out.push({ name, sessions: sessions(name) });
    } catch (e) {
      out.push({ name, sessions: [], error: String(e.message || e) });
    }
  }
  return json({ at: new Date().toISOString(), projects: out });
}
