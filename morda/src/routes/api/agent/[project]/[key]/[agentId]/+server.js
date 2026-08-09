import { json } from '@sveltejs/kit';
import { agentTranscript } from '$lib/server/fleet.js';

// Транскрипт субагента (дерево субагентов в окне сессии).
export async function GET({ params }) {
  try {
    const a = agentTranscript(params.project, params.key, params.agentId);
    if (!a) return json({ error: 'субагент не найден' }, { status: 404 });
    return json(a);
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
