import { json } from '@sveltejs/kit';
import { runnerList, runnerStart, runnerStop, runnerResume, runnerApprove,
  runnerRetune, runnerKey, runnerType, runnerScreen, auditStart,
  slotScreen, slotKey, slotType, slotSync,
  queueAdd, queueRemove,
  slotList, slotAdd, slotRemove, slotConnect, slotCode, slotUsage,
  providerList } from '$lib/server/runner.js';
import { projectAdd, projectRemove } from '$lib/server/fleet.js';
import { keysStatus, keysImport, keysAdopt, keysReveal, keysRemove } from '$lib/server/keys.js';
import { passportLast } from '$lib/server/passport.js';
import { judgeStuck } from '$lib/server/judge.js';
import { guarded } from '$lib/server/guard.js';

// Раннер (этап 1 STOVP-58): пульт владеет CLI-сессиями. Одна ручка,
// действие в теле — реестр маленький, дробить на роуты нечего.
export async function GET({ url }) {
  try {
    return json({
      sessions: runnerList(url.searchParams.get('project') || null),
      // слоты без probe: GET поллится и не должен плодить tmux-сессии
      slots: slotList({ probe: false }),
      providers: providerList(),
      passport: passportLast(),
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}

const ACTIONS = {
  start: runnerStart,
  stop: runnerStop,
  resume: runnerResume,
  approve: runnerApprove,
  retune: runnerRetune,
  key: runnerKey,
  screen: runnerScreen,
  slot_screen: slotScreen,
  slot_key: slotKey,
  slot_type: slotType,
  slot_sync: slotSync,
  queue_add: queueAdd,
  queue_remove: queueRemove,
  type: runnerType,
  audit_start: auditStart,
  slot_probe: () => ({ slots: slotList({ probe: true }) }),
  slot_add: slotAdd,
  slot_remove: slotRemove,
  slot_connect: slotConnect,
  slot_code: slotCode,
  slot_usage: slotUsage,
  judge: judgeStuck,
  keys_status: keysStatus,
  keys_reveal: keysReveal,
  keys_remove: keysRemove,
  keys_import: keysImport,
  keys_adopt: keysAdopt,
  project_add: projectAdd,
  project_remove: projectRemove,
};

export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const body = await request.json();
    const fn = ACTIONS[body?.action];
    if (!fn) return json({ error: `действие: ${Object.keys(ACTIONS).join('|')}` }, { status: 400 });
    return json(await fn(body));   // judge — асинхронный, остальным await безвреден
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
