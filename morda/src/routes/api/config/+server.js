import { json } from '@sveltejs/kit';
import { configMatrix, configRequire, configSmoke, configInstall,
  configSync, syncPreview } from '$lib/server/configurator.js';
import { guarded } from '$lib/server/guard.js';

// Конфигуратор инструментов (docs/specs/2026-08-20-configurator.md):
// GET — матрица «инструмент × копия × проект», POST — действия карточек.
// Раздача (sync) идёт через существующий slotSync за гейтом «основной
// зелёный»; смоук — реальный вызов, поэтому POST, а не часть GET.
export async function GET() {
  try { return json(configMatrix()); }
  catch (e) { return json({ error: String(e.message || e) }, { status: 400 }); }
}

const ACTIONS = {
  require: configRequire,
  smoke: configSmoke,
  install: configInstall,
  sync_preview: syncPreview,
  sync: configSync,
};

export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    const fn = ACTIONS[body?.action];
    if (!fn) return json({ error: `действие: ${Object.keys(ACTIONS).join('|')}` }, { status: 400 });
    return json(await fn(body));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
