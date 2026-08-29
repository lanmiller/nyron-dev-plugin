/**
 * duty.js — дежурный-постановщик (решение CTO 29.08: «Desktop-сессия не
 * оркестрирует как положено»). Desktop-чат исполняется только в момент
 * хода: между сообщениями — ни таймеров, ни вотчеров, а длинный чат
 * суммаризуется и вымывает мандат. Доведение до конца переезжает на
 * ПОСТОЯННУЮ сессию пульта: раннер держит её живой (упала/убили — резюм с
 * контекстом), эскалатор пинает её напрямую injectSend (доставку дожимает
 * strandedSweep), человеку в Desktop уходит только непонятное — дайджест
 * шлёт сам дежурный (SendMessage), либо вопрос остаётся карточкой в пульте.
 *
 * Права дежурного = границы pult-MCP: смотреть, поднимать, писать сессиям,
 * отвечать на вопросы по мандату — да; мержи, снос веток, новые решения
 * бизнеса — нет. Простой дежурного токенов не жжёт: CLI-сессия без хода
 * ничего не считает. Отключение: MORDA_DUTY=0.
 */
import path from 'node:path';
import { projects, MORDA_ROOT } from './fleet.js';
import { runnerList, runnerStart, runnerResume, injectSend } from './runner.js';

export const DUTY_NAME = 'duty';

const MANDATE = [
  'Ты — ДЕЖУРНЫЙ ПОСТАНОВЩИК пульта: постоянная сессия; когда человек спит или занят, конвейер ведёшь ты.',
  'Работа приходит пинками эскалатора пульта. На КАЖДОМ пробуждении, по порядку:',
  '1. pult_asks — осознай каждый открытый вопрос: ответ следует из уже принятых решений → ответь сам (pult_answer mode:"answer"); вопрос непонятен → доуточни у автора (mode:"clarify") и добейся внятной формулировки; протух → сними (mode:"cancel", причина обязательна).',
  '2. pult_fleet — кто застрял/молчит/ждёт; спорную сессию смотри pult_screen, суди pult_judge; вставшую без причины пни pult_send «продолжай по своей роли».',
  '3. Новые решения бизнеса и архитектуры НЕ выдумывай — это вопросы человеку: вызови ListAgents, найди интерактивную Desktop-сессию (без пометки tmux, самую старшую) и отправь ей SendMessage: короткий дайджест своими словами + ссылку на карточку (link из pult_asks). Desktop-сессии нет — оставь вопрос открытым: карточка висит в пульте, человек увидит.',
  'Границы: мержи и снос веток — НЕ твои руки (это сессии по merge_rights или человек); код сам не пишешь; секреты (.secrets/) не читаешь.',
  'Между пинками поллинг-циклы НЕ крутить: разобрал пачку — короткая сводка в чат и заверши ход, следующий пинок придёт сам.',
].join('\n');

// Якорь — проект пульта с корнем в репо плагина (его паспорт держим
// зелёным); нет такого в реестре — первый проект. Дежурный один на машину:
// pult_* тулы видят все проекты, вопросы разбираются сквозно.
function anchorProject() {
  const list = projects() || [];
  const home = path.resolve(MORDA_ROOT, '..');
  return list.find((p) => path.resolve(p.root) === home) || list[0] || null;
}

function dutyRow() {
  const p = anchorProject();
  if (!p) return { p: null, row: null };
  let rows = [];
  try { rows = runnerList(p.name); } catch {}
  return { p, row: rows.find((r) => r.name === DUTY_NAME) || null };
}

/** Держать дежурного живым: нет записи — старт с мандатом; запаркован —
 *  резюм (контекст цел). Зовётся тикером пульта; ошибка — до следующего
 *  тика, не падение сервера. */
export function dutyEnsure() {
  if (process.env.MORDA_DUTY === '0') return null;
  const { p, row } = dutyRow();
  if (!p) return null;
  if (row?.alive) return { name: DUTY_NAME, state: 'alive' };
  if (row?.sessionId) {
    runnerResume({ name: DUTY_NAME });
    console.log('[duty] дежурный поднят резюмом');
    return { name: DUTY_NAME, state: 'resumed' };
  }
  // sonnet: разбор вопросов — обработка, не архитектура; bypass за забором —
  // иначе первый же MCP-вызов встанет на диалог разрешения без человека
  runnerStart({ project: p.name, name: DUTY_NAME, goal: MANDATE,
    model: 'sonnet', mode: 'bypass', effort: 'medium' });
  console.log('[duty] дежурный запущен с нуля');
  return { name: DUTY_NAME, state: 'started' };
}

/** Доставить пачку эскалатора дежурному напрямую в CLI. true — доставлено
 *  (или встало в очередь пульта при открытом диалоге), false — дежурного
 *  нет: вызывающий падает на курьера в Desktop. */
export function dutyDeliver(text) {
  const { row } = dutyRow();
  if (!row?.alive) return false;
  try { injectSend({ name: DUTY_NAME, text }); return true; }
  catch (e) { console.log(`[duty] доставка не удалась: ${e.message}`); return false; }
}
