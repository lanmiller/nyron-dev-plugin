/**
 * checkin.js — чек-ин сессии по лентам (STOVP-60).
 *
 * «Работает» доказывается записями в лентах, а не живостью процесса:
 * аудитор psylia 45 минут стоял в тупике на фоновых товарищах при живом
 * CLI, и пульт держал зелёное (факт 21.08; челлендж Sol, пункт 4).
 * Лент три: транскрипт главного потока, ленты субагентов
 * (subagents/agent-*.jsonl), выводы фоновых команд (tasks/*.output в
 * скретчпаде сессии). Пишет хотя бы одна — сессия работает; замолчали
 * все дольше порога — «застряла», даже если tmux/CLI жив.
 */
import fs from 'node:fs';
import path from 'node:path';
import { T } from './plugin-hub.js';

// «пишет прямо сейчас» — короткое окно зелёного без вердикта сторожа,
// то же, что жило в fleet.js до выноса
const RECENT = 5 * 60 * 1000;
export const CHECKIN_MIN_DEFAULT = 15;

/** Свежесть сессии по всем трём лентам, ms epoch.
 *  file — путь транскрипта, mtime — его ISO-время из списка сессий.
 *  tmpBase — корень скретчпадов (для тестов; по умолчанию машина). */
// Ленты субагентов и фоновых команд считает индекс сессий плагина
// (transcript.mjs, STOVP-65): он держит их свежесть на вотчерах fs.watch и
// отдаёт из памяти. Свой обход (readdir+stat по сотне файлов на каждый
// опрос) и TTL-кэш поверх него отсюда снесены — механизм один на пульт.
export function lastActivityMs(file, key, mtime, { tmpBase } = {}) {
  const best = new Date(mtime || 0).getTime() || 0;
  if (!file || !key) return best;
  return Math.max(best, T.activityOf(file, key, { scratchBase: tmpBase }));
}

/** Порог чек-ина проекта в ms: env MORDA_CHECKIN_MIN сильнее ключа
 *  checkin_min в <root>/.claude/nyron-dev.md; дефолт 15 минут.
 *  Кэш — по mtime конфига, не вечный: правка ключа действует со
 *  следующего опроса, без рестарта пульта (кросс-ревью Sol, блокер 2). */
const cfgCache = new Map(); // root → { mtime, min }
export function checkinMs(root) {
  const env = Number(process.env.MORDA_CHECKIN_MIN);
  if (env >= 1) return env * 60_000;
  const file = path.join(root, '.claude', 'nyron-dev.md');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* конфига нет */ }
  const c = cfgCache.get(root);
  if (c && c.mtime === mtime) return c.min * 60_000;
  let min = CHECKIN_MIN_DEFAULT;
  if (mtime) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(/^\s*checkin_min:\s*(\d+)/m);
      if (m && Number(m[1]) >= 1) min = Number(m[1]);
    } catch { /* не читается — дефолт */ }
  }
  cfgCache.set(root, { mtime, min });
  return min * 60_000;
}

/** Состояние сессии по чек-ину: {state, reason} либо null («вне надзора»).
 *  w — вердикт сторожа; parked решается снаружи, он сильнее.
 *  Вердикты «ждёт решения», «застряла», «закончилась» тишина не трогает —
 *  меняется только «working»: его надо доказывать записями. Живость
 *  процесса (aliveOwned) продлевает зелёное лишь ДО порога — долгую
 *  переднеплановую команду не гасим, но порог она не прикрывает. */
export function checkinState({ w, lastAct, aliveOwned, thresholdMs, now = Date.now() }) {
  if (w && w.state !== 'working') return w;
  const quiet = now - lastAct;
  // «Застряла» — только про ту, кого кто-то считал работающей (вердикт
  // сторожа или живой CLI пульта): просто закрытый вчерашний разговор
  // молчит законно и остаётся «вне надзора», а не застрявшим.
  if (quiet >= thresholdMs && (w || aliveOwned)) {
    return {
      state: 'stalled',
      reason: `ленты молчат ${Math.round(quiet / 60000)} мин`
        + (aliveOwned ? ' — CLI жив, но живость работой не считается'
          : w ? ' (сторож считал её работающей)' : ''),
    };
  }
  if (w) return w;
  if (quiet < RECENT)
    return { state: 'working', reason: 'пишет прямо сейчас (сторож молчит)' };
  if (aliveOwned)
    return { state: 'working', reason: 'CLI-сессия пульта жива (сторож молчит)' };
  return null;
}

/** Карточка «застряла» в ленту «ждут человека» — существующим ask будки:
 *  текст вопроса стабильный, дедуп по (session, question) держит одну
 *  карточку на эпизод (hub-db.mjs:281). Отсечка «тишина больше 4 порогов —
 *  история, не событие» действует только для НЕ-живых сессий (застрявший
 *  вердикт сторожа на давно закрытом разговоре): живой CLI получает
 *  карточку при любой длине тупика — там есть что спасать, и пульт могли
 *  открыть сильно позже перехода (кросс-ревью Sol, блокер 1). */
export function stalledCard(hub, { key, title, reason, quietMs, thresholdMs, aliveOwned }) {
  if (!aliveOwned && quietMs > thresholdMs * 4) return null;
  try {
    return hub.ask({
      session: key,
      type: 'choice',
      question: 'Сессия молчит: все ленты без записей дольше порога. Посмотреть или перезапустить?',
      // формат опции — {n, label}: AskCard шлёт o.n и рисует o.label
      // (AskCard.svelte:129; кросс-ревью Sol r3)
      options: [{ n: 1, label: 'вижу, разбираюсь' }],
      context: `${title || key}: ${reason}`,
      urgency: 'active',
    });
  } catch { return null; } // будка недоступна — статус в списке всё равно виден
}
