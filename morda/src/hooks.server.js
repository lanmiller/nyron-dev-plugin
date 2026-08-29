/**
 * hooks.server.js — вход по паролю для пульта, выставленного наружу
 * (туннель tuna и т.п., CTO 19.08). Локальная работа не меняется: без
 * заданного пароля щит выключен и пульт открыт, как и был.
 *
 * Логин и пароль живут в КЛЮЧНИЦЕ проекта (.secrets/env — общая ключница проекта), не в
 * коде и не в git: тот же дом, что у токенов Jira. Механика простая —
 * HTTP Basic: браузер сам покажет окно ввода и запомнит на сессию.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MORDA_ROOT } from '$lib/server/fleet.js';

const ENV_FILE = process.env.MORDA_AUTH_FILE
  || path.join(MORDA_ROOT, '..', '.secrets', 'env');

// читаем ключницу один раз на старт: смена пароля = перезапуск пульта
function loadAuth() {
  try {
    const vars = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    if (vars.MORDA_USER && vars.MORDA_PASSWORD)
      return { user: vars.MORDA_USER, pass: vars.MORDA_PASSWORD };
  } catch { /* файла нет — щит выключен */ }
  return null;
}
const auth = loadAuth();

// сравнение без утечки по времени: длина + побайтовое ИЛИ
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Локальный заход (сам мак) пароля не требует: пульт слушает 127.0.0.1, и
// снаружи туда попасть нельзя иначе как через туннель — а туннель приходит
// с чужим Host. Так вход спрашивают ровно там, где он нужен (CTO 20.08).
function isLocal(event) {
  const host = (event.request.headers.get('host') || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

export async function handle({ event, resolve }) {
  if (!auth) return resolve(event);           // пароля нет — локальный режим
  if (isLocal(event)) return resolve(event);  // свой мак — без пароля
  const header = event.request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let user = '', pass = '';
    try {
      const [u, ...rest] = atob(header.slice(6)).split(':');
      user = u; pass = rest.join(':');
    } catch { /* мусорный заголовок — просим заново */ }
    if (same(user, auth.user) && same(pass, auth.pass)) return resolve(event);
  }
  return new Response('нужен вход', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="STOVP", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

// Триаж хвостов — сам, раз в опрос: ответы мёртвым адресатам закрываются
// без человека (CTO 22.08: «висит 11 напоминаний — почему судья не поймёт»).
// Правило кодом, модели не нужно; ошибка одного проекта не роняет остальные.
import { projects } from '$lib/server/fleet.js';
import { judgeTriage } from '$lib/server/judge.js';
const TRIAGE_EVERY = 6 * 3600 * 1000;
if (!globalThis.__mordaTriage) {
  globalThis.__mordaTriage = setInterval(() => {
    for (const p of projects() || []) {
      try {
        const r = judgeTriage({ project: p.name });
        if (r.closed.length) console.log(`[triage] ${p.name}: закрыто ${r.closed.length}`);
      } catch { /* проект без будки — пропускаем */ }
    }
  }, TRIAGE_EVERY);
  globalThis.__mordaTriage.unref?.();
}

// Автосудья застрявших (план 22.08 п.7) + автопинок (решение CTO 22.08:
// «почему на автомате не сделать — застряло → написали „продолжай, если
// сдал — передай диспетчеру“»). Улики собирает код, deepseek судит, вердикт
// ложится в реестр; при вердикте «встала» сессии сразу уходит текстовый
// пинок. Пинок — это ввод в промпт, НЕ руки в git: мерж по-прежнему делает
// только сессия по merge_rights или человек. Два пинка без результата —
// карточка человеку вместо третьего; ожила — счётчик сбрасывается.
import { judgeReady, judgeStuck } from '$lib/server/judge.js';
import { runnerList, runnerJudgeSave, runnerType, runnerAutopushMark }
  from '$lib/server/runner.js';
import { hubForJudge, rootByName } from '$lib/server/fleet.js';
const AUTOJUDGE_EVERY = 10 * 60 * 1000;
const REJUDGE_MS = 60 * 60 * 1000;
// на этих экранах CLI ждёт выбора — ввод туда сломал бы диалог
const NO_PUSH_SCREENS = new Set(['dialog', 'permission', 'hitl', 'needs_auth',
  'mcp_consent', 'trust', 'browser_consent', 'bypass_warning', 'login_flow']);
function autoPush(p, s, v) {
  if (v.state !== 'stuck' || NO_PUSH_SCREENS.has(s.screen)) return;
  const n = s.autopush?.count || 0;
  if (n < 2) {
    runnerType({ name: s.name, enter: true,
      text: `[автосудья] Похоже, ты застряла: ${String(v.verdict).split('\n')[0]}. `
        + 'Если работа сделана — сдай её: влей по своим merge_rights или передай '
        + 'диспетчеру и запаркуйся. Если не закончена — продолжай с места остановки. '
        + 'Если чего-то ждёшь — напиши одной строкой, чего именно.' });
    runnerAutopushMark({ name: s.name, count: n + 1 });
    console.log(`[autopush] ${s.name}: пинок ${n + 1}/2`);
  } else {
    // третьего пинка нет — эскалация человеку; дедуп будки держит одну карточку
    hubForJudge(rootByName(p)).ask({
      session: s.sessionId || s.name, type: 'choice',
      question: `Автопинки не помогли: ${s.name}`,
      options: [{ n: 1, label: 'вижу, разбираюсь' }],
      context: String(v.verdict).slice(0, 300), urgency: 'active',
    });
    console.log(`[autopush] ${s.name}: два пинка без ответа — карточка человеку`);
  }
}
if (!globalThis.__mordaAutoJudge) {
  globalThis.__mordaAutoJudge = setInterval(async () => {
    if (!judgeReady()) return; // ключей нет — механика живёт без судьи
    for (const p of projects() || []) {
      let rows = [];
      try { rows = runnerList(p.name); } catch { continue; }
      for (const s of rows) {
        if (!s.stuck) {
          // ожила после пинков — счётчик обнуляется, эпизод закрыт
          if (s.autopush) try { runnerAutopushMark({ name: s.name, count: 0 }); } catch {}
          continue;
        }
        const fresh = s.judge && Date.now() - new Date(s.judge.at).getTime() < REJUDGE_MS;
        if (fresh) continue;
        try {
          const v = await judgeStuck({ name: s.name, project: s.project, sessionId: s.sessionId });
          runnerJudgeSave({ name: s.name,
            judge: { at: new Date().toISOString(), state: v.state, verdict: v.verdict } });
          console.log(`[autojudge] ${s.name}: ${v.state || 'вердикт'}`);
          try { autoPush(p.name, s, v); } catch (e) { console.log(`[autopush] ${s.name}: ${e.message}`); }
        } catch (e) { console.log(`[autojudge] ${s.name}: ${e.message}`); }
      }
    }
  }, AUTOJUDGE_EVERY);
  globalThis.__mordaAutoJudge.unref?.();
}

// Ночной держатель (KAN-209, ночь 29.08: мак уснул — у оркестратора умерли
// таймеры и вотчеры, tmux-волны молча стояли 6.5 часов): пока во флоте есть
// живая сессия, пульт держит систему от idle-сна caffeinate'ом сам, а не
// памятью человека «запустить перед уходом». Закрытую крышку caffeinate не
// спасает — это остаётся строкой ночного чек-листа оркестратора.
import { spawn } from 'node:child_process';
const CAFFEINATE_EVERY = 60 * 1000;
if (!globalThis.__mordaCaffeinate) {
  const st = (globalThis.__mordaCaffeinate = { child: null, timer: null });
  st.timer = setInterval(() => {
    try {
      const anyAlive = runnerList().some((s) => s.alive);
      if (anyAlive && !st.child) {
        st.child = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
        st.child.on('exit', () => { st.child = null; });
        st.child.on('error', () => { st.child = null; });
        console.log('[caffeinate] флот жив — держу мак от idle-сна');
      } else if (!anyAlive && st.child) {
        st.child.kill();
        st.child = null;
        console.log('[caffeinate] живых сессий нет — отпускаю сон');
      }
    } catch { /* следующий тик дотянется */ }
  }, CAFFEINATE_EVERY);
  st.timer.unref?.();
}

// Дежурный-постановщик (решение CTO 29.08: «Desktop-сессия не оркестрирует
// как положено» — чат исполняется только в момент хода, между сообщениями
// у него нет ни таймеров, ни вотчеров). Пульт держит постоянную сессию
// дежурного живой; пачки эскалатора идут ей напрямую, Desktop — только
// дайджест человеку. Отключение: MORDA_DUTY=0.
import { dutyEnsure } from '$lib/server/duty.js';
const DUTY_EVERY = 5 * 60 * 1000;
if (!globalThis.__mordaDuty) {
  globalThis.__mordaDuty = setInterval(() => {
    try { dutyEnsure(); } catch (e) { console.log(`[duty] ${e.message}`); }
  }, DUTY_EVERY);
  globalThis.__mordaDuty.unref?.();
  // первый подъём — вскоре после старта пульта, не через 5 минут
  setTimeout(() => {
    try { dutyEnsure(); } catch (e) { console.log(`[duty] ${e.message}`); }
  }, 20_000).unref?.();
}

// Эскалатор (мандат CTO 25.08): новые вопросы будок и HITL-экраны пинком
// уезжают в Desktop-сессию постановщика — курьер claude -p с ListAgents+
// SendMessage (постановщик и курьер живут на основной подписке; события
// со всех подписок собираются через будку/пульт, поэтому доставка не
// зависит от того, под каким слотом работала сессия-автор).
import { escalatorScan } from '$lib/server/escalator.js';
const ESCALATOR_EVERY = 5 * 60 * 1000;
if (!globalThis.__mordaEscalator) {
  globalThis.__mordaEscalator = setInterval(() => {
    try {
      const n = escalatorScan();
      if (n) console.log(`[escalator] пачек к доставке: ${n}`);
    } catch (e) { console.log(`[escalator] ${e.message}`); }
  }, ESCALATOR_EVERY);
  globalThis.__mordaEscalator.unref?.();
}

// Толкач финала (STOVP-57, план 22.08 п.9): «закончила, ветка не влита» —
// живой пинок в промпт, мёртвой — карточка. Правило кодом; мерж руками
// пульта — никогда. Частота пинков ограничена внутри finisherScan (4 часа).
import { finisherScan } from '$lib/server/finisher.js';
const FINISHER_EVERY = 30 * 60 * 1000;
if (!globalThis.__mordaFinisher) {
  globalThis.__mordaFinisher = setInterval(() => {
    for (const p of projects() || []) {
      try {
        for (const a of finisherScan(p.name))
          console.log(`[finisher] ${p.name}/${a.name}: ${a.did} (${a.branch})`);
      } catch { /* проект без git/будки — пропускаем */ }
    }
  }, FINISHER_EVERY);
  globalThis.__mordaFinisher.unref?.();
}
