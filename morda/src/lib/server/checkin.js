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

// «пишет прямо сейчас» — короткое окно зелёного без вердикта сторожа,
// то же, что жило в fleet.js до выноса
const RECENT = 5 * 60 * 1000;
export const CHECKIN_MIN_DEFAULT = 15;

function maxMtime(dir) {
  let best = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    try { best = Math.max(best, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
  }
  return best;
}

/** Свежесть сессии по всем трём лентам, ms epoch.
 *  file — путь транскрипта, mtime — его ISO-время из списка сессий.
 *  tmpBase — корень скретчпадов (для тестов; по умолчанию машина). */
export function lastActivityMs(file, key, mtime, { tmpBase } = {}) {
  let best = new Date(mtime || 0).getTime() || 0;
  if (!file || !key) return best;
  const slugDir = path.dirname(file);
  best = Math.max(best, maxMtime(path.join(slugDir, key, 'subagents')));
  // Выводы фоновых команд: /private/tmp/claude-<uid>/<слаг>/<key>/tasks —
  // слаг тот же, что у каталога транскриптов (факт этой машины 21.08)
  const base = tmpBase ?? path.join('/private/tmp',
    `claude-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
  best = Math.max(best, maxMtime(path.join(base, path.basename(slugDir), key, 'tasks')));
  return best;
}

/** Порог чек-ина проекта в ms: env MORDA_CHECKIN_MIN сильнее ключа
 *  checkin_min в <root>/.claude/nyron-dev.md; дефолт 15 минут. */
const cfgCache = new Map(); // root → минуты
export function checkinMs(root) {
  const env = Number(process.env.MORDA_CHECKIN_MIN);
  if (env >= 1) return env * 60_000;
  if (!cfgCache.has(root)) {
    let min = CHECKIN_MIN_DEFAULT;
    try {
      const cfg = fs.readFileSync(path.join(root, '.claude', 'nyron-dev.md'), 'utf8');
      const m = cfg.match(/^\s*checkin_min:\s*(\d+)/m);
      if (m && Number(m[1]) >= 1) min = Number(m[1]);
    } catch { /* конфига нет — дефолт */ }
    cfgCache.set(root, min);
  }
  return cfgCache.get(root) * 60_000;
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
 *  карточку на эпизод (hub-db.mjs:281). Свежая тишина — признак перехода;
 *  древние застрявшие (квиет больше 4 порогов) карточку не плодят: это
 *  уже история, а не событие. */
export function stalledCard(hub, { key, title, reason, quietMs, thresholdMs }) {
  if (quietMs > thresholdMs * 4) return null;
  try {
    return hub.ask({
      session: key,
      type: 'choice',
      question: 'Сессия молчит: все ленты без записей дольше порога. Посмотреть или перезапустить?',
      options: ['вижу, разбираюсь'],
      context: `${title || key}: ${reason}`,
      urgency: 'active',
    });
  } catch { return null; } // будка недоступна — статус в списке всё равно виден
}
