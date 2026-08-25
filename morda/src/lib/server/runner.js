/**
 * runner.js — этап 1 переезда на CLI (STOVP-58): пульт ВЛАДЕЕТ исполнителями,
 * а не наблюдает за ними. Запуск CLI-сессии в tmux, стоп, подъём резюмом,
 * здоровье. tmux выбран на этапе 0: бесплатный терминал для ручного захода
 * (tmux attach) + уже доказанный канал ввода send-keys (fleet.say);
 * child-process со stream-json — кандидат на гибрид для headless-волн,
 * решение записано в docs/CLI-MIGRATION.md.
 *
 * Реестр — morda/runner.json (gitignored, машинное состояние). Имя записи =
 * имя tmux-сессии без префикса. Убитая сессия НЕ теряется: sessionId остаётся
 * в реестре, `claude --resume` поднимает с полным контекстом (парковка, не
 * убийство — канон последнего акта эпика в STOVP-58).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { rootByName, tmuxCandidates, paneProcessTree, MORDA_ROOT,
  CLAUDE_BIN, TMUX_BIN, SPAWN_ENV, liveAgents, sessionMeta,
  RUNNER_STATE_FILE as STATE_FILE, transcriptQuietMs } from './fleet.js';
import { parseDialog, parsePermission } from './tui.js';
import { passportQuick, passportGate, strictMcpProfile } from './passport.js';

// Префикс всех tmux-сессий раннера: чужие панели (ручной tmux человека)
// раннер не трогает НИКОГДА — только свои, со своим префиксом.
const TMUX_PREFIX = 'stovp-';

// ---------- реестр ----------

function loadReg() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { sessions: {} }; }
}
function saveReg(reg) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Пуллеры стартующих сессий — в globalThis: Vite HMR пересоздаёт модуль,
// а таймеры должны пережить пересоздание (тот же приём, что dbs в fleet.js).
const pollers = (globalThis.__mordaRunnerPollers ??= new Map()); // name → timer

// ---------- tmux-механика ----------

function tmux(args, opts = {}) {
  return execFileSync(TMUX_BIN, args,
    { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], env: SPAWN_ENV, ...opts }).toString();
}
// Живые сессии — ОДНИМ вызовом на опрос, а не по вызову на запись реестра:
// 35 записей давали 35 синхронных `tmux has-session`, и под нагрузкой
// (тестовый прогон волны в docker) опрос флота вставал на десятки секунд —
// сервер переставал отвечать целиком (факт 22.08).
let aliveCache = { at: 0, set: null };
function aliveSet() {
  if (aliveCache.set && Date.now() - aliveCache.at < 500) return aliveCache.set;
  let set = new Set();
  try {
    set = new Set(tmux(['list-sessions', '-F', '#S']).split('\n')
      .filter(Boolean).filter((n) => n.startsWith(TMUX_PREFIX))
      .map((n) => n.slice(TMUX_PREFIX.length)));
  } catch { /* tmux-сервера нет — живых сессий нет */ }
  aliveCache = { at: Date.now(), set };
  return set;
}
function tmuxAlive(name) {
  return aliveSet().has(name);
}
function pane(name) {
  // одна панель на сессию раннера — окно 0, панель 0
  return TMUX_PREFIX + name + ':0.0';
}
function capture(name, lines = 40) {
  try {
    return tmux(['capture-pane', '-t', pane(name), '-p', '-S', String(-lines)]);
  } catch { return ''; }
}
// ТОЛЬКО видимый экран, без скролл-истории: для классификации состояния.
// История затеняла текущее — «use the url below» из прожитого логина
// держал слот в needs_auth при готовом промпте (факт CTO 19.08, stovpe3tt)
function visible(name) {
  try { return tmux(['capture-pane', '-t', pane(name), '-p']); }
  catch { return ''; }
}
// с ANSI-кодами: по подсветке parseDialog находит текущий таб формы
function captureEsc(name, lines = 40) {
  try {
    return tmux(['capture-pane', '-t', pane(name), '-p', '-e', '-S', String(-lines)]);
  } catch { return ''; }
}
function sendLine(name, text) {
  // -l: литеральный текст (без интерпретации ; и клавиш), Enter отдельно —
  // тот же проверенный канал, что fleet.say
  execFileSync(TMUX_BIN, ['send-keys', '-t', pane(name), '-l', text], { timeout: 3000 });
  execFileSync(TMUX_BIN, ['send-keys', '-t', pane(name), 'Enter'], { timeout: 3000 });
  if (text.includes('\n')) {
    // многострочный ввод CLI принимает как вставку: первый Enter закрывает
    // вставку, отправляет второй (факт 19.08 — цель аудитора легла в поле
    // и не ушла); на уже отправленном лишний Enter безвреден
    execFileSync('sleep', ['0.4']);
    execFileSync(TMUX_BIN, ['send-keys', '-t', pane(name), 'Enter'], { timeout: 3000 });
  }
}

// ---------- привязка панель → sessionId ----------

// `claude agents --json` (fleet.liveAgents): pid ↔ sessionId ↔ cwd.
function bindSessionId(name, root) {
  const cand = tmuxCandidates(root)
    .find((c) => c.session === TMUX_PREFIX + name);
  if (!cand) return null;
  const pids = new Set(paneProcessTree(cand.pid));
  return liveAgents().find((a) => pids.has(a.pid))?.sessionId || null;
}

// ---------- машина состояний старта ----------

// Экраны старта CLI, которые раннер понимает. Порядок важен: авторизация
// проверяется раньше промпта (баннер «Run /login» висит НАД готовым промптом).
function classify(text) {
  if (/Select login method|Paste code here|use the url below/i.test(text)) return 'login_flow';
  if (/Login expired|Not logged in|Run \/login|OAuth session expired/i.test(text)) return 'needs_auth';
  if (/Select any you wish to enable/i.test(text)) return 'mcp_consent';
  if (/Do you trust the files|Quick safety check/i.test(text)) return 'trust';
  // согласие на браузерные инструменты у свежего профиля слота: сессия
  // стояла на нём вечно, окно показывало «поднимаю CLI-сессию…» (факт
  // 20.08, слот «Мариха»). Флоту браузер не нужен — отвечаем «нет».
  if (/use my browser|keep browser tools off/i.test(text)) return 'browser_consent';
  // предупреждение про режим без вопросов: человек УЖЕ выбрал этот режим
  // в композере пульта, повторно подтверждать в терминале незачем
  // (CTO 20.08: «не хочу как пользователь об этом париться»)
  if (/Bypass Permissions mode|accept all responsibility/i.test(text)) return 'bypass_warning';
  // онбординг свежего профиля (новый CLAUDE_CONFIG_DIR): четыре экрана
  // подряд, все проходятся Enter-ом (флоу снят живьём 17.08, слот «Мариха»)
  if (/Press Enter to continue|Try the new fullscreen renderer|Choose the text style/i
    .test(text)) return 'onboarding';
  // открытая панель настроек (/usage, /config…) — закрывается Escape-ом;
  // без этого слот с забытой панелью вечно «проверяю…» (факт 17.08)
  if (/Settings\s+Status\s+Config\s+Usage/i.test(text)) return 'dialog';
  // диалог разрешения на инструмент: сессия стоит и ждёт человека —
  // пульт обязан это показывать, а не считать «работает» (этап 2: карточка)
  if (/Do you want to proceed\?|requires approval/i.test(text)) return 'permission';
  // интерактивный TUI-пикер (AskUserQuestion, /model и любой выбор):
  // в транскрипт он НЕ пишется до ответа — форма живёт только на экране
  // (факт 17.08, сессия psylia: HITL стоял в tmux, пульт его не видел).
  // Submit-экран формы приходит БЕЗ футера пикера — ловится по заголовку.
  if (/Enter to select|keys to navigate|Esc to cancel|Ready to submit your answers|Review your answers/i
    .test(text)) return 'hitl';
  // футер промпта разный по режимам: «? for shortcuts» (manual),
  // «shift+tab to cycle» (bypass ⏵⏵, plan и др.) — признаём оба (факт 17.08).
  // Бейджи «1 shell / ← for agents / ↓ to manage» вытесняют подсказку из
  // футера — тогда промпт узнаём по «⏵⏵ bypass permissions on» или маркерам
  // бейджей при видимом ❯ (факт 25.08: очередь kan164-waves не дожималась —
  // экран с готовым промптом классифицировался как booting)
  if (/❯/.test(text) && /\? for shortcuts|shift\+tab to cycle|⏵⏵ bypass permissions on|← for agents|↓ to manage/
    .test(text)) return 'prompt';
  return 'booting';
}

// Работает ли модель прямо сейчас (вопрос CTO 19.08 «видим ли, что клод
// работает»): CLI во время ответа держит в футере «esc to interrupt» и
// крутит спиннер со счётчиком токенов. Признак железный — сам CLI его
// печатает, пока идёт запрос.
// Сколько молчания ленты при бодром спиннере считаем застреванием. Порог из
// фактов: живой долгий ход дописывает ленту каждые несколько минут, а оба
// зависания 21.08 молчали 45 и 75 минут.
const STUCK_MS = 10 * 60 * 1000;

function isBusy(text) {
  return /esc to interrupt|↓ \d+[\d.,]*k? tokens|\(\d+s\s*·/.test(text);
}

/** Пульс работы — та самая строка CLI «Собираю карту… (1m 19s · ↓ 4.6k tokens
 *  · thinking with high effort)». Пульт показывал вместо неё кусок JSON
 *  последнего тула — непонятно (CTO 21.08). Разбираем экран, а не выдумываем. */
function parsePulse(text) {
  const lines = String(text || '').split('\n');
  const line = [...lines].reverse().find((l) => /↓\s*[\d.,]+k?\s*tokens|\(\d+m?\s*\d*s\s*·/.test(l));
  if (!line) return null;
  const inside = line.match(/\(([^)]*)\)\s*$/)?.[1] || line;
  const what = line.replace(/^[^\wА-Яа-я]+/, '').split('…')[0].trim() || null;
  const elapsed = inside.match(/(\d+m\s*\d+s|\d+s)/)?.[1] || null;
  const tokens = inside.match(/↓\s*([\d.,]+k?)\s*tokens/)?.[1] || null;
  const note = inside.match(/(thinking[^·)]*|thought for [^·)]*)/)?.[1]?.trim() || null;
  if (!elapsed && !tokens) return null;
  return { what, elapsed, tokens, note };
}

/** Живые агенты сессии — из списка внизу экрана CLI («⏺ main», «◯ wave-kan84
 *  Бриф… 12m 25s · ↓ 109.6k tokens»): токены и время работы агентов видны
 *  только там, пульт их не выдумает (CTO 22.08: «не вижу движения»). */
function parseAgents(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = l.match(/^\s*(?:❯\s*)?([⏺◯])\s+(\S+)\s*(.*)$/u);
    if (!m || m[2] === 'main') continue;
    const tail = m[3];
    const elapsed = tail.match(/(\d+m\s*\d*s?|\d+s)\s*·/)?.[1]?.trim() || null;
    const tokens = tail.match(/↓\s*([\d.,]+k?)\s*tokens/)?.[1] || null;
    const brief = tail.replace(/(\d+m\s*\d*s?|\d+s)\s*·.*$/, '').trim() || null;
    // маркер ⏺ носят и строки транскрипта — агентом считаем только строку
    // со счётчиком (время/токены), это и есть живой список внизу экрана
    if (!elapsed && !tokens) continue;
    out.push({ name: m[2], active: m[1] === '⏺', brief, elapsed, tokens });
  }
  return out;
}

function step(name) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) return stopPoller(name);
  if (!tmuxAlive(name)) {
    s.state = s.sessionId ? 'stopped' : 'died_on_start';
    s.stoppedAt = new Date().toISOString();
    saveReg(reg); return stopPoller(name);
  }
  const kind = classify(visible(name));
  if (kind === 'browser_consent') {
    // «No, keep browser tools off» — второй пункт: браузер флоту не нужен
    try { tmux(['send-keys', '-t', pane(name), '2']); } catch {}
    return;
  }
  if (kind === 'bypass_warning') {
    // «Yes, I accept» — режим выбран человеком при запуске; забор на месте
    try { tmux(['send-keys', '-t', pane(name), '2']); } catch {}
    return;
  }
  if (kind === 'mcp_consent' || kind === 'trust' || kind === 'onboarding') {
    // MCP-серверы проекта, доверие корню (корень из allowlist projects.json)
    // и экраны онбординга нового профиля — подтверждаем сами
    try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
    return;
  }
  if (kind === 'needs_auth') {
    // протухший слот — не упираемся молча (риск №2 плана): карточку
    // «переавторизуй» показывает морда, ссылку достаёт runnerAuthStart
    if (s.state !== 'needs_auth') { s.state = 'needs_auth'; saveReg(reg); }
    return;
  }
  if (kind === 'login_flow') return; // человек в контуре — не мешаем
  if (kind === 'prompt') {
    if (!s.goalSent && s.goal) {
      sendLine(name, s.goal);
      s.goalSent = true; s.state = 'goal_sent'; saveReg(reg);
      return;
    }
    if (!s.sessionId) {
      const id = bindSessionId(name, s.root);
      if (id) { s.sessionId = id; s.state = 'running'; saveReg(reg); }
      return;
    }
    if (s.state !== 'running') { s.state = 'running'; saveReg(reg); }
    return stopPoller(name); // привязана и работает — дальше здоровье по факту
  }
}

function startPoller(name) {
  stopPoller(name);
  const t = setInterval(() => {
    try { step(name); } catch { /* следующий тик дотянется */ }
  }, 1500);
  // стартовая машина конечна: 3 минуты не собралась — оставляем как есть,
  // здоровье покажет фактическое состояние (needs_auth / booting / died)
  setTimeout(() => stopPoller(name), 180_000);
  pollers.set(name, t);
}
function stopPoller(name) {
  const t = pollers.get(name);
  if (t) clearInterval(t);
  pollers.delete(name);
}

// ---------- публичный API ----------

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Модель и режим разрешений — из формы запуска (референс — композер Claude
// Desktop, CTO 17.08: «режим работы и модель — это тоже важно»).
// bypassPermissions в списке НЕТ сознательно: канон эпика — «забор до
// свободы», без PreToolUse-хука-забора этот режим не включается.
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);
const MODES = new Set(['auto', 'acceptEdits', 'plan', 'bypass']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function checkParams({ model, mode, effort, mcp }) {
  if (model && !MODELS.has(model)) throw new Error(`модель: ${[...MODELS].join('|')}`);
  if (mode && !MODES.has(mode)) throw new Error(`режим: ${[...MODES].join('|')} (без диалогов — только после забора-хука)`);
  if (effort && !EFFORTS.has(effort)) throw new Error(`effort: ${[...EFFORTS].join('|')}`);
  if (mcp && mcp !== 'strict') throw new Error('mcp: strict|пусто (пусто = все серверы машины)');
}

// Строгий MCP-профиль сессии (разряды, 21.08): файл генерится на КАЖДЫЙ
// старт заново — паспорт и канон могли смениться, а реестр переносим.
// Файл per-имя: параллельные сессии разных проектов не толкаются.
function strictMcpFile(name, root) {
  const { servers, missing } = strictMcpProfile(root);
  if (missing.length)
    throw new Error(`строгий профиль: серверы паспорта не описаны в .mcp.json проекта: ${missing.join(', ')}`);
  if (!Object.keys(servers).length)
    throw new Error('строгий профиль пуст: ни паспорта с mcp, ни аккаунтных в каноне — запусти без строгого набора');
  const file = path.join(MORDA_ROOT, `runner-mcp-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

// Bypass — ТОЛЬКО за забором (канон «забор до свободы», порядок незыблем):
// раннер генерирует settings-файл с PreToolUse-хуком guard/pretooluse-guard.mjs
// и подкладывает его bypass-сессии. Файл пере-пишется на актуальный путь
// машины при каждом запуске — реестр переносим между машинами.
function guardSettingsFile() {
  const guard = path.join(MORDA_ROOT, 'guard', 'pretooluse-guard.mjs');
  if (!fs.existsSync(guard)) throw new Error('забор-хук не найден — bypass закрыт');
  const file = path.join(MORDA_ROOT, 'runner-guard-settings.json');
  fs.writeFileSync(file, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: `${process.execPath} ${guard}` }],
      }],
    },
  }, null, 2));
  return file;
}

/** Запуск CLI-сессии: tmux + claude, цель — вводом, когда промпт готов.
 *  Имя — только [a-z0-9-]: оно станет именем tmux-сессии.
 *  workdir (опция, только с сервера) — родной каталог сессии при резюме;
 *  обязан лежать в корне проекта (fail-closed, как openFileOutside). */
export function runnerStart({ project, goal, name, resumeId, workdir,
  model, mode, effort, slot, mcp }, opts = {}) {
  const root = rootByName(project); // бросит на чужом имени — allowlist
  if (!NAME_RE.test(name || '')) throw new Error('имя: строчные латиница/цифры/дефис');
  checkParams({ model, mode, effort, mcp });
  // slot 'auto' — пульт сам берёт наименее занятую подписку по /usage
  // (CTO 22.08: «не хочу думать, в какой подписке поднимать»); объяснение
  // выбора уезжает в ответ — оркестратор говорит его человеку
  let slotWhy = null;
  if (slot === 'auto') {
    const p = slotPick();
    slot = p.id === 'claude-main' ? null : p.id; // основной = без слота
    slotWhy = p.why;
  }
  let slotDef = null;
  if (slot) {
    slotDef = loadSlots().slots.find((x) => x.id === slot);
    if (!slotDef) throw new Error(`нет слота ${slot}`);
    if (slotDef.provider !== 'claude') throw new Error('сессию запускает только Claude-слот');
  }
  if (tmuxAlive(name)) throw new Error(`tmux-сессия ${TMUX_PREFIX + name} уже есть`);
  let dir = root;
  if (workdir) {
    const full = path.resolve(workdir);
    if (full !== root && !full.startsWith(root + path.sep))
      throw new Error('workdir вне корня проекта');
    if (!fs.existsSync(full)) throw new Error(`каталога сессии больше нет: ${full}`);
    dir = full;
  }
  const reg = loadReg();
  const prev = reg.sessions[name];
  if (prev && prev.state !== 'stopped' && prev.state !== 'died_on_start' && tmuxAlive(name))
    throw new Error(`запись ${name} уже в реестре`);
  // Гейт паспорта (STOVP-61): красный паспорт закрывает запуск в любом
  // режиме, отсутствие паспорта — только bypass (остальным предупреждение);
  // решение — passportGate, здесь только исполнение. passportlessOk —
  // СЛУЖЕБНЫЙ второй аргумент (клиент API передаёт только первый): аудитор
  // запускается ДО паспорта, его работа паспорт и собрать — но пропускается
  // только ОТСУТСТВИЕ паспорта; красный режет и аудит (кросс-ревью Sol:
  // краснота чинится кнопкой «проверить готовность», не bypass-сессией).
  const problems = passportQuick(root);
  const pgate = (problems === null && opts.passportlessOk)
    ? { block: null, warning: null }
    : passportGate(problems, mode);
  if (pgate.block) throw new Error(pgate.block);
  const args = (resumeId ? ` --resume ${resumeId}` : '')
    + (model ? ` --model ${model}` : '')
    + (mode === 'bypass'
      ? ` --permission-mode bypassPermissions --settings ${guardSettingsFile()}`
      : mode ? ` --permission-mode ${mode}` : '')
    + (effort ? ` --effort ${effort}` : '')
    // строгий набор: паспорт + аккаунтные из канона, остальное отсечено.
    // Профиль — от каталога сессии (dir): его .mcp.json и паспорт, и
    // относительные пути команд резолвятся от того же cwd, что у CLI
    + (mcp === 'strict'
      ? ` --strict-mcp-config --mcp-config ${strictMcpFile(name, dir)}` : '');
  const targs = ['new-session', '-d', '-s', TMUX_PREFIX + name];
  for (const [k, v] of Object.entries(slotEnv(slotDef || {}))) targs.push('-e', `${k}=${v}`);
  // метка «сессия раннера»: SessionStart-хук оркестратора по ней молчит —
  // режим постановщика получают только интерактивные окна человека, не волны
  targs.push('-e', 'NYRON_RUNNER=1');
  targs.push('-c', dir, CLAUDE_BIN + args);
  execFileSync(TMUX_BIN, targs, { timeout: 5000, env: SPAWN_ENV });
  reg.sessions[name] = {
    project, root: dir, goal: goal || null, goalSent: false,
    sessionId: resumeId || null,
    model: model || null, mode: mode || null,
    effort: effort || null, slot: slot || null, mcp: mcp || null,
    startedAt: new Date().toISOString(), state: 'starting',
    stoppedAt: null,
    // предупреждение гейта («паспорта нет») — в записи, чтобы было видно
    // по факту запуска, а не потеряно в ответе одного вызова
    passport_warning: pgate.warning || null,
  };
  saveReg(reg);
  startPoller(name);
  // имя — ключ реестра, внутри записи его нет; вызывающему оно нужно, чтобы
  // дать ссылку на сессию (без него ответ выглядел пустым — факт 21.08)
  return { name, ...reg.sessions[name], ...(slotWhy ? { slot_pick: slotWhy } : {}) };
}

/** Стоп = парковка, не убийство: транскрипт уже на диске, sessionId в
 *  реестре, `--resume` поднимет с контекстом (факт этапа 0). */
export function runnerStop({ name }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  // привязать sessionId до убийства, пока pid жив — иначе резюмить нечего
  if (!s.sessionId) s.sessionId = bindSessionId(name, s.root);
  stopPoller(name);
  if (tmuxAlive(name)) tmux(['kill-session', '-t', TMUX_PREFIX + name]);
  s.state = 'stopped';
  s.stoppedAt = new Date().toISOString();
  saveReg(reg);
  return s;
}

/** Вердикт автосудьи — в запись реестра: runnerList отдаёт его строкой
 *  флота (spread записи), человек видит суждение без нажатия кнопки. */
export function runnerJudgeSave({ name, judge }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  s.judge = judge; // { at, state, verdict } либо null — стереть
  saveReg(reg);
  return s.judge;
}

/** Отметка толкача финала (finisher.js): когда и о какой ветке пнули —
 *  чтобы живую сессию не дёргать чаще раза в 4 часа. */
export function runnerFinisherMark({ name, branch }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  s.finisher = { at: new Date().toISOString(), branch };
  saveReg(reg);
  return s.finisher;
}

/** Счётчик автопинков застрявшей (hooks.server.js): после двух безответных
 *  пинков — карточка человеку вместо третьего. count 0 — сброс (ожила).
 *  Третий однотипный сеттер поля реестра (judge/finisher/autopush) — при
 *  четвёртом объединить в один с белым списком полей. */
export function runnerAutopushMark({ name, count }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  s.autopush = count > 0 ? { at: new Date().toISOString(), count } : null;
  saveReg(reg);
  return s.autopush;
}

/** Подъём резюмом: новая tmux-сессия с тем же именем, claude --resume. */
export function runnerResume({ name, goal }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  if (!s.sessionId) throw new Error(`у ${name} нет sessionId — резюмить нечего`);
  if (tmuxAlive(name)) throw new Error(`${TMUX_PREFIX + name} ещё жива — сначала стоп`);
  return runnerStart({
    project: s.project, name,
    goal: goal || null,           // резюм без цели: контекст уже в сессии
    resumeId: s.sessionId,
    workdir: s.root,              // родной каталог записи, не корень проекта
    model: s.model || null, mode: s.mode || null,
    effort: s.effort || null, slot: s.slot || null, mcp: s.mcp || null,
  });
}

/** Реестр + здоровье по факту (не по памяти реестра): tmux жив? транскрипт
 *  пишется? Экран — needs_auth? Это ответ на «жив/молчит/упёрся». */
function runnerListRaw(project) {
  const reg = loadReg();
  const out = [];
  for (const [name, s] of Object.entries(reg.sessions)) {
    if (project && s.project !== project) continue;
    const alive = tmuxAlive(name);
    let screen = null, busy = false;
    if (alive) {
      const vis = visible(name);
      const kind = classify(vis);
      screen = kind;
      busy = isBusy(vis);
      // стартовые согласия двигаем и здесь: поллер старта конечен (3 минуты),
      // а сессия могла упереться в экран позже — тогда она висела «стартует»
      // навсегда (факт 20.08, слот «Мариха»: согласие про браузер)
      if (s.state === 'starting' || s.state === 'goal_sent') {
        if (kind === 'browser_consent' || kind === 'bypass_warning') {
          try { tmux(['send-keys', '-t', pane(name), '2']); } catch {}
        }
        else if (kind === 'mcp_consent' || kind === 'trust' || kind === 'onboarding') {
          try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
        } else if (kind === 'prompt' && !s.sessionId) {
          // промпт готов: досылаем цель и добиваем привязку
          if (!s.goalSent && s.goal) {
            try { sendLine(name, s.goal); s.goalSent = true; s.state = 'goal_sent'; saveReg(reg); } catch {}
          } else {
            const id = bindSessionId(name, s.root);
            if (id) { s.sessionId = id; s.state = 'running'; saveReg(reg); }
          }
        }
      }
      if (kind === 'needs_auth' && s.state !== 'needs_auth') {
        s.state = 'needs_auth'; saveReg(reg);
      }
    } else if (s.state !== 'stopped' && s.state !== 'died_on_start') {
      s.state = s.sessionId ? 'stopped' : 'died_on_start';
      s.stoppedAt = s.stoppedAt || new Date().toISOString();
      saveReg(reg);
    }
    // живая, а помечена стоп — реестр отстал от факта (рестарт сервера,
    // пока панель жила): правда — tmux, не память
    if (alive && (s.state === 'stopped' || s.state === 'died_on_start')) {
      s.state = 'running'; s.stoppedAt = null; saveReg(reg);
    }
    // «занята» подтверждаем ростом ленты: спиннер зависшего CLI крутится
    // вечно и держал сессию бодрой (факт 21.08 — 75 минут мнимой работы)
    const quiet = busy && s.sessionId ? transcriptQuietMs(s.project, s.sessionId) : null;
    out.push({ name, ...s, tmux: TMUX_PREFIX + name, alive, screen, busy,
      quiet_ms: quiet, stuck: quiet != null && quiet > STUCK_MS,
      pulse: busy ? parsePulse(visible(name)) : null });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

// Кэш опроса: список стоит десятки синхронных вызовов tmux (по вызову на
// запись реестра), а спрашивают его разом вкладки, автосудья и толкач
// финала. Под нагрузкой (тестовый прогон волны в docker) вызовы ползут, и
// сервер вставал целиком — порт слушает, ответить некому (факт 22.08).
// Полсекунды несвежести человеку незаметны, лавину опросов срезают.
const LIST_TTL = 500;
const listCache = new Map(); // project|'' → { at, rows }
export function runnerList(project) {
  const key = project || '';
  const c = listCache.get(key);
  if (c && Date.now() - c.at < LIST_TTL) return c.rows;
  const rows = runnerListRaw(project);
  listCache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Запись раннера по sessionId — карточка сессии показывает кнопки
 *  стоп/резюм только для СВОИХ процессов. Когда на экране CLI открыт
 *  диалог (HITL-пикер, /usage, разрешение) — отдаём и сам экран: в
 *  транскрипте его нет, человек должен видеть, на что отвечает. */
export function runnerBySessionId(key) {
  const reg = loadReg();
  for (const [name, s] of Object.entries(reg.sessions))
    if (s.sessionId === key) {
      const alive = tmuxAlive(name);
      const vis = alive ? visible(name) : '';
      const screen = alive ? classify(vis) : null;
      const busy = alive && isBusy(vis);
      const screen_text = ['hitl', 'dialog', 'permission'].includes(screen)
        ? capture(name, 45).replace(/\s+$/, '') : null;
      // нативный рендер формы: структура с экрана (с ANSI — там подсветка
      // текущего таба); не распарсилось — dialog=null, окно покажет сырой
      // экран (честный фолбэк)
      const dialog = screen === 'hitl' && screen_text
        ? parseDialog(captureEsc(name, 45)) : null;
      // что именно просят разрешить — в карточку, а не только кнопки
      const permission = screen === 'permission' && screen_text
        ? parsePermission(screen_text) : null;
      const slot = loadSlots().slots.find((x) => x.id === (s.slot || 'claude-main'));
      const quiet = busy && s.sessionId ? transcriptQuietMs(s.project, s.sessionId) : null;
      return { name, ...s, queue: s.queue || [], tmux: TMUX_PREFIX + name, alive, screen, busy,
        quiet_ms: quiet, stuck: quiet != null && quiet > STUCK_MS,
        pulse: busy ? parsePulse(vis) : null,
        screen_text, dialog, permission, slot_label: slot?.label || 'основной',
        agents_live: parseAgents(vis) };
    }
  return null;
}

// ---------- очередь сообщений занятой сессии ----------
//
// Очередь держит ПУЛЬТ, а не вкладка браузера (CTO 19.08: «что будет, если
// я отправил и сайт закрыл»): пока модель отвечает, текст ждёт в реестре на
// диске — переживает закрытие вкладки и перезапуск пульта, и его можно
// снять, пока он не ушёл. Освободилась сессия — отдаём по одному.

export function queueAdd({ name, text }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  if (!String(text || '').trim()) throw new Error('пустое сообщение');
  s.queue = [...(s.queue || []), {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: String(text), ts: new Date().toISOString(),
  }];
  saveReg(reg);
  return { queued: s.queue.length };
}

export function queueRemove({ name, id }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  s.queue = (s.queue || []).filter((q) => q.id !== id);
  saveReg(reg);
  return { queued: s.queue.length };
}

/** Отдать очередь, если сессия освободилась. Зовётся с каждым опросом
 *  окна и тикером — так очередь уходит даже с закрытой вкладкой. */
export function queueFlush(name) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s?.queue?.length || !tmuxAlive(name)) return;
  const screen = visible(name);
  if (isBusy(screen) || classify(screen) !== 'prompt') return;  // ещё занята
  const [next, ...rest] = s.queue;
  try { sendLine(name, next.text); } catch { return; }
  s.queue = rest;
  saveReg(reg);
}

/** Прямая доставка в CLI (решение CTO 25.08: «надо прям чтоб писало» —
 *  очередь-до-промпта как дефолт признана неудачной). Claude CLI принимает
 *  ввод И ВО ВРЕМЯ РАБОТЫ: напечатанное доезжает мид-тёрн, как сообщение
 *  человека в занятую сессию — ровно тот же канал send-keys, что fleet.say.
 *  tmux локален, границ подписок у него нет.
 *
 *  Единственное «нельзя» — открытый диалог (пикер HITL, разрешение, форма,
 *  логин): там текст уйдёт в форму и сломает её. Такой экран → текст встаёт
 *  в очередь пульта (queueAdd) и уходит после закрытия диалога; вызывающему
 *  честно говорим, почему. Экран booting без промпта — туда же: ввод в
 *  недопднятый CLI теряется молча. */
const DIALOG_SCREENS = new Set(['hitl', 'permission', 'dialog', 'mcp_consent',
  'trust', 'browser_consent', 'bypass_warning', 'onboarding', 'login_flow',
  'needs_auth']);
export function injectSend({ name, text }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  if (!String(text || '').trim()) throw new Error('пустое сообщение');
  if (!tmuxAlive(name))
    throw new Error(`сессия ${name} не живёт в tmux — печатать некуда, подними резюмом`);
  const vis = visible(name);
  const screen = classify(vis);
  const busy = isBusy(vis);
  if (DIALOG_SCREENS.has(screen) || (screen === 'booting' && !busy)) {
    queueAdd({ name, text });
    return { queued: true, screen,
      note: `на экране ${screen} печатать нельзя (сломает форму/потеряется) — встало в очередь пульта, уйдёт после закрытия` };
  }
  sendLine(name, String(text));
  return { delivered: name,
    mode: busy ? 'мид-тёрн: сессия занята, сообщение вошло в текущий ход' : 'в свободный промпт' };
}

// фоновый тикер: очередь уходит, даже если пульт никто не открывал
const flusher = (globalThis.__mordaQueueFlusher ??= setInterval(() => {
  try {
    const reg = loadReg();
    for (const [name, s] of Object.entries(reg.sessions))
      if (s.queue?.length) queueFlush(name);
  } catch { /* следующий тик дотянется */ }
}, 3000));

/** Экран и клавиши служебной сессии СЛОТА (карточка подписки): тот же
 *  терминал под рукой, что у рабочих сессий (CTO 20.08) — посмотреть, что
 *  происходит при входе, и дожать стрелками с телефона. */
export function slotScreen({ id, lines = 60 }) {
  const s = slotById(id);
  const name = authName(s.id);
  if (!tmuxAlive(name)) throw new Error('служебной сессии нет — нажми «проверить фактом»');
  const n = Math.min(Math.max(Number(lines) || 60, 10), 200);
  // с ANSI: панель приглушает серые подсказки CLI, чтобы они не читались
  // как набранный текст (CTO 21.08 — дважды жал Enter на подсказку)
  return { screen: captureEsc(name, n).replace(/\s+$/, ''), tmux: TMUX_PREFIX + name };
}

/** Раздать копии конфиг основного аккаунта (CTO 20.08: «нужно подкидывать
 *  один общий конфиг на все копии»). Копии должны ВЕСТИ СЕБЯ одинаково:
 *  те же MCP-серверы, скиллы, правила, плагины и настройки. НЕ трогаем
 *  авторизацию и историю копии — это её собственность:
 *    копируем: settings.json, mcp_config.json, skills/, rules/, agents/,
 *              commands/, plugins/ (маркетплейсы и реестр установленного);
 *    мержим:   mcpServers из ~/.claude.json (user-scope серверы);
 *    НЕ трогаем: projects/, sessions/, history, вход в аккаунт. */
export function slotSync({ id }) {
  const s = slotById(id);
  if (!s.home) throw new Error('основной слот сам себе источник — синхронизировать нечего');
  const src = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const copied = [];
  for (const item of ['settings.json', 'mcp_config.json', 'skills', 'rules',
    'agents', 'commands', 'plugins']) {
    const from = path.join(src, item);
    if (!fs.existsSync(from)) continue;
    const to = path.join(s.home, item);
    try {
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
      copied.push(item);
    } catch (e) { throw new Error(`не скопировал ${item}: ${e.message}`); }
  }
  // user-scope MCP живут в ~/.claude.json рядом с аккаунтом: вмерживаем
  // ТОЛЬКО секцию серверов, остальное (вход, история) — копии не трогаем
  let servers = 0;
  try {
    const mainCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const slotFile = path.join(s.home, '.claude.json');
    const slotCfg = fs.existsSync(slotFile)
      ? JSON.parse(fs.readFileSync(slotFile, 'utf8')) : {};
    slotCfg.mcpServers = { ...(slotCfg.mcpServers || {}), ...(mainCfg.mcpServers || {}) };
    servers = Object.keys(slotCfg.mcpServers).length;
    fs.writeFileSync(slotFile + '.tmp', JSON.stringify(slotCfg, null, 2));
    fs.renameSync(slotFile + '.tmp', slotFile);
  } catch (e) { throw new Error(`не смержил MCP-серверы: ${e.message}`); }
  return { copied, mcpServers: servers,
    note: 'перезапусти служебную сессию слота, чтобы конфиг подхватился' };
}

export function slotType({ id, text, enter = true }) {
  const s = slotById(id);
  const name = authName(s.id);
  if (!tmuxAlive(name)) throw new Error('служебной сессии нет');
  if (!String(text || '').length) throw new Error('пустой ввод');
  if (enter) sendLine(name, String(text));
  else tmux(['send-keys', '-t', pane(name), '-l', String(text)]);
  return { sent: true };
}

export function slotKey({ id, key }) {
  const s = slotById(id);
  const name = authName(s.id);
  if (!tmuxAlive(name)) throw new Error('служебной сессии нет');
  if (KEYS_DENIED.has(key)) throw new Error(KEYS_DENIED.get(key));
  if (!DIALOG_KEYS.has(key)) throw new Error(`клавиша: ${[...DIALOG_KEYS].join('|')}`);
  tmux(['send-keys', '-t', pane(name), key]);
  return { sent: key };
}

/** Живой экран tmux сессии — «показать настоящую консоль» (CTO 19.08).
 *  Читается по требованию окна: реальный терминал под рукой, без tmux attach. */
export function runnerScreen({ name, lines = 60 }) {
  if (!tmuxAlive(name)) throw new Error(`нет живой tmux-сессии ${name}`);
  const n = Math.min(Math.max(Number(lines) || 60, 10), 200);
  // с ANSI — см. slotScreen: серое на экране CLI должно остаться серым
  return { screen: captureEsc(name, n).replace(/\s+$/, ''), at: new Date().toISOString() };
}

/** Клавиша в живой диалог CLI (пикер HITL, /usage, /model). Семантика
 *  снята фактом (17.08, stovp-proto-hitl): цифра — выбрать/переключить,
 *  Tab/BTab — вперёд/назад по вопросам, Enter — выбрать, Esc — отмена. */
const DIALOG_KEYS = new Set(['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Tab', 'BTab', 'Space', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  // живой терминал в браузере (CTO 21.08: «на десктопе нужен нормальный
  // контроль, как в настоящем терминале»): правка строки, прокрутка, отмена
  'BSpace', 'DC', 'Home', 'End', 'PPage', 'NPage',
  'C-c', 'C-a', 'C-e', 'C-u', 'C-k', 'C-w', 'C-l', 'C-r']);

// C-d закрывает оболочку и убивает сессию — из браузера его не пропускаем:
// человек хотел прервать шаг, а получил бы гибель сессии (страх CTO 21.08
// «главное не уебать рабочий»). В настоящем терминале он ему доступен.
const KEYS_DENIED = new Map([['C-d', 'C-d закроет оболочку и убьёт сессию — прерывание это Escape, остановка — кнопка «остановить»']]);
export function runnerKey({ name, key, times = 1 }) {
  if (!tmuxAlive(name)) throw new Error(`нет живой tmux-сессии ${name}`);
  if (KEYS_DENIED.has(key)) throw new Error(KEYS_DENIED.get(key));
  if (!DIALOG_KEYS.has(key)) throw new Error(`клавиша: ${[...DIALOG_KEYS].join('|')}`);
  const n = Math.min(Math.max(Number(times) || 1, 1), 8); // прыжок по табам
  for (let i = 0; i < n; i++) {
    tmux(['send-keys', '-t', pane(name), key]);
    if (n > 1) execFileSync('sleep', ['0.15']);
  }
  return { sent: key, times: n };
}

/** Свой текст в форму: сфокусировать опцию свободного ответа цифрой,
 *  набрать текст литералом, Enter — выбрать. Всё одной операцией, чтобы
 *  между нажатиями не влез поллинг. */
export function runnerType({ name, digit, text, enter = true }) {
  if (!tmuxAlive(name)) throw new Error(`нет живой tmux-сессии ${name}`);
  if (digit !== undefined && digit !== null) {
    if (!/^[1-9]$/.test(String(digit))) throw new Error('digit: 1–9');
    tmux(['send-keys', '-t', pane(name), String(digit)]);
    execFileSync('sleep', ['0.4']);
  }
  if (text) tmux(['send-keys', '-t', pane(name), '-l', String(text)]);
  if (enter) {
    execFileSync('sleep', ['0.2']);
    tmux(['send-keys', '-t', pane(name), 'Enter']);
  }
  return { sent: true };
}

/** Смена параметров сессии из композера её окна (те же чипы, что на
 *  старте — запрос CTO 17.08). Живую перезапускаем резюмом с новыми
 *  аргументами (контекст цел — факт этапа 0), запаркованной параметры
 *  просто записываются до следующего подъёма. */
export function runnerRetune({ name, model, mode, effort, mcp }) {
  const reg = loadReg();
  const s = reg.sessions[name];
  if (!s) throw new Error(`нет записи ${name}`);
  checkParams({ model, mode, effort, mcp });
  if (model !== undefined) s.model = model || null;
  if (mode !== undefined) s.mode = mode || null;
  if (effort !== undefined) s.effort = effort || null;
  if (mcp !== undefined) s.mcp = mcp || null;
  saveReg(reg);
  if (!tmuxAlive(name)) return { ...s, restarted: false };
  runnerStop({ name });
  return { ...runnerResume({ name }), restarted: true };
}

/** Ввод в МЁРТВУЮ сессию поднимает её резюмом, и текст уезжает первым
 *  вводом (очередь цели стартовой машины — тот же механизм, что у goal).
 *  Требование CTO 17.08: «написал в мёртвую — поднялся нужный клод, и
 *  сообщение ушло туда», мера успеха STOVP-58 «ответ доезжает за секунды
 *  независимо от того, слушает ли сессия будку».
 *  Живую где-то ещё (Desktop, чужой tmux) НЕ трогаем — вернём null,
 *  пусть доставляет обычный канал: резюм живой сессии = форк разговора. */
export function resumeForInput({ project, key, text }) {
  if (liveAgents().some((a) => a.sessionId === key)) return null;
  const reg = loadReg();
  let name = Object.entries(reg.sessions)
    .find(([, s]) => s.sessionId === key)?.[0];
  if (name && tmuxAlive(name)) return null;  // панель жива — обычный канал
  if (!name) name = 'r-' + key.slice(0, 8);  // усыновление не-раннерской
  if (tmuxAlive(name)) return null;
  // родной cwd — из транскрипта: окно могло открыть сессию через
  // проект-надмножество (nyron видит подпапку stovp), и резюм в его корне
  // убивал сессию на старте — «No conversation found» (факт 17.08)
  const meta = sessionMeta(project, key);
  if (!meta) return null;                     // сессия не этого проекта
  return runnerStart({ project, name, goal: text, resumeId: key,
    workdir: meta.cwd || undefined });
}

/** Ответ на диалог разрешения с карточки: только «да» / «нет» — выбор
 *  «не спрашивать больше» человек делает лично в терминале. */
export function runnerApprove({ name, answer }) {
  if (!tmuxAlive(name)) throw new Error(`нет живой tmux-сессии ${name}`);
  if (classify(visible(name)) !== 'permission')
    throw new Error('сессия сейчас не ждёт разрешения');
  if (answer === 'yes') tmux(['send-keys', '-t', pane(name), '1']);
  else if (answer === 'no') tmux(['send-keys', '-t', pane(name), 'Escape']);
  else throw new Error('answer: yes|no');
  return { sent: answer };
}

// ---------- реестр слотов подписок (паспорт машины, STOVP-58 шаг 3) ----------
//
// Копий много: аккаунты Claude, аккаунт ревьюера OpenAI, дальше — кто угодно.
// Слот = провайдер + человеческое имя + СВОЙ конфиг-каталог CLI
// (CLAUDE_CONFIG_DIR / CODEX_HOME): авторизации не толкаются локтями.
// Дефолтные слоты «main» смотрят в домашние каталоги CLI (home: null).
// Подключение — человек в контуре: пульт поднимает служебную tmux-сессию
// логина, достаёт ссылку, человек входит в нужном браузере; Claude вернёт
// код (в карточку), Codex завершится сам callback-ом на localhost.

const CODEX_BIN = process.env.CODEX_BIN
  || [path.join(os.homedir(), '.local/bin/codex'), '/opt/homebrew/bin/codex']
    .find((p) => fs.existsSync(p)) || 'codex';

const SLOTS_FILE = process.env.MORDA_SLOTS
  || path.join(MORDA_ROOT, 'slots.json');
const SLOTS_HOME = path.join(os.homedir(), '.stovp-slots');

const KIMI_BIN = process.env.KIMI_BIN
  || [path.join(os.homedir(), '.local/bin/kimi'), '/opt/homebrew/bin/kimi']
    .find((p) => fs.existsSync(p)) || null;

const PROVIDERS = {
  claude: { bin: () => CLAUDE_BIN, envKey: 'CLAUDE_CONFIG_DIR',
    title: 'Claude CLI', kind: 'подписка Claude (флот)' },
  codex: { bin: () => CODEX_BIN, envKey: 'CODEX_HOME',
    title: 'Codex CLI', kind: 'аккаунт OpenAI (ревьюер cross-review)' },
  kimi: { bin: () => KIMI_BIN, envKey: 'KIMI_HOME',
    title: 'Kimi CLI', kind: 'аккаунт Moonshot (дешёвые массовые задачи)' },
};

/** Провайдеры для формы «подключить копию»: что вообще можно добавить и
 *  установлен ли CLI на машине. */
export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, title: p.title, kind: p.kind, installed: !!p.bin(),
  }));
}

function loadSlots() {
  let d;
  try { d = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8')); }
  catch { d = null; }
  if (!d?.slots?.length) {
    // первые два слота — домашние каталоги CLI, как жили до реестра
    d = { slots: [
      { id: 'claude-main', provider: 'claude', label: 'основной', home: null },
      { id: 'codex-main', provider: 'codex', label: 'основной', home: null },
    ] };
    saveSlots(d);
  }
  return d;
}
function saveSlots(d) {
  const tmp = SLOTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, SLOTS_FILE);
}
function slotById(id) {
  const s = loadSlots().slots.find((x) => x.id === id);
  if (!s) throw new Error(`нет слота ${id}`);
  return s;
}
/** env запуска CLI из слота: свой конфиг-каталог, если он не домашний. */
export function slotEnv(slot) {
  if (!slot?.home) return {};
  return { [PROVIDERS[slot.provider].envKey]: slot.home };
}
const authName = (id) => `auth-${id}`;    // tmux: stovp-auth-<id>

/** Копии подписки Claude (свой home) — адресаты раздачи и колонки матрицы
 *  конфигуратора; основной (home: null) копией не считается. */
export function claudeSlots() {
  return loadSlots().slots.filter((s) => s.provider === 'claude' && s.home);
}

// Служебные auth-сессии не живут вечно: постояв без дела полчаса, глушатся
// (поднимутся сами при следующей проверке/подключении). Иначе на машине
// копятся «висящие терминалы» с клодом — жалоба CTO 19.08: сессии от 17.08
// всё ещё держали по процессу.
const AUTH_IDLE_MS = 30 * 60 * 1000;
function reapIdleAuth() {
  let lines = [];
  try {
    lines = tmux(['ls', '-F', '#{session_name} #{session_activity}']).trim().split('\n');
  } catch { return; }
  for (const line of lines) {
    const [name, act] = line.split(' ');
    if (!name?.startsWith(TMUX_PREFIX + 'auth-')) continue;
    if (Date.now() - Number(act) * 1000 > AUTH_IDLE_MS) {
      try { tmux(['kill-session', '-t', name]); } catch {}
    }
  }
}

/** Статусы слотов: подключён / не подключён / протух — фактом, не памятью.
 *  codex отвечает мгновенно (login status); claude — экраном служебной
 *  сессии: probe=true поднимает её, probe=false только смотрит живую. */
export function slotList({ probe = false } = {}) {
  reapIdleAuth();
  return loadSlots().slots.map((s) => {
    const p = PROVIDERS[s.provider];
    if (!p) return { ...s, status: 'unknown', hint: `неизвестный провайдер ${s.provider}` };
    if (!p.bin()) return { ...s, kind: p.kind, status: 'not_installed',
      hint: `${p.title} не установлен на машине` };
    let status = 'unknown', hint = null;
    if (s.provider === 'codex') {
      // пишет в stderr (факт 17.08) — читаем оба потока
      const r = spawnSync(CODEX_BIN, ['login', 'status'],
        { timeout: 5000, env: { ...SPAWN_ENV, ...slotEnv(s) } });
      const st = String(r.stdout || '') + String(r.stderr || '');
      status = /logged in/i.test(st) ? 'ok' : 'needs_auth';
      hint = st.trim().split('\n')[0] || null;
    } else {
      const name = authName(s.id);
      if (!tmuxAlive(name)) {
        if (probe) {
          startAuthTmux(s, CLAUDE_BIN);
          status = 'probing'; hint = 'поднимаю служебную сессию — секунды';
        } else hint = 'нажми «проверить фактом»';
      } else {
        // классификация — ТОЛЬКО по видимому экрану (история затеняла:
        // прожитый «use the url below» держал needs_auth при готовом
        // промпте — факт CTO 19.08); почту для подсказки ищем и в истории
        const scr = capture(name, 50);
        const kind = classify(visible(name));
        // онбординг нового профиля и согласия двигаем сами: auth-сессию
        // никто не поллит, её продвигает каждый опрос страницы настроек
        // (иначе слот вечно висел в «проверяю…» — факт CTO 17.08, «Мариха»)
        if (kind === 'onboarding' || kind === 'mcp_consent' || kind === 'trust') {
          try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
        }
        // первый запуск нового профиля спрашивает про браузер и про режим —
        // человек подключает подписку, а не читает эти экраны (CTO 20.08)
        if (kind === 'browser_consent' || kind === 'bypass_warning') {
          try { tmux(['send-keys', '-t', pane(name), '2']); } catch {}
        }
        if (kind === 'dialog') {
          try { tmux(['send-keys', '-t', pane(name), 'Escape']); } catch {}
        }
        status = kind === 'needs_auth' || kind === 'login_flow' ? 'needs_auth'
          : kind === 'prompt' ? 'ok' : 'probing';
        // почта аккаунта видна прямо на экране приветствия — показываем,
        // ЧЕЙ это слот, а не «какой-то подключён»
        hint = scr.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0]
          || (kind === 'login_flow' ? 'логин начат: ссылка → вход → код' : null);
      }
    }
    // дом слота показываем всегда: у «основного» это домашний каталог
    // самого CLI, а не отдельная папка (вопрос CTO 17.08 «почему пути нет»)
    const home_display = s.home
      || (s.provider === 'claude'
        ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
        : path.join(os.homedir(), `.${s.provider}`));
    return { ...s, kind: p.kind, status, hint, home_display };
  });
}

function startAuthTmux(slot, cmd) {
  const args = ['new-session', '-d', '-s', TMUX_PREFIX + authName(slot.id)];
  for (const [k, v] of Object.entries(slotEnv(slot))) args.push('-e', `${k}=${v}`);
  args.push('-c', MORDA_ROOT, cmd);
  execFileSync(TMUX_BIN, args, { timeout: 5000 });
}

/** Добавить слот: свой конфиг-каталог под ~/.stovp-slots/<id> — авторизация
 *  ляжет туда и не столкнётся с другими копиями того же CLI. */
export function slotAdd({ provider, label }) {
  if (!PROVIDERS[provider]) throw new Error(`провайдер: ${Object.keys(PROVIDERS).join('|')}`);
  if (!label?.trim()) throw new Error('нужно имя слота (какой это аккаунт)');
  const slug = label.trim().toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    .replace(/[а-яё]/g, (c) => ({ а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'u', я: 'ya' }[c] ?? ''));
  const d = loadSlots();
  let id = `${provider}-${slug || 'slot'}`;
  while (d.slots.some((s) => s.id === id)) id += '2';
  const home = path.join(SLOTS_HOME, id);
  fs.mkdirSync(home, { recursive: true });
  const slot = { id, provider, label: label.trim(), home };
  d.slots.push(slot);
  saveSlots(d);
  return slot;
}

/** Отвязать слот. Два исхода, человек выбирает в карточке (CTO 19.08):
 *  purge=false — только из реестра, каталог с авторизацией остаётся
 *  (вернёшь слот тем же именем — войдёт без логина);
 *  purge=true — сносим и каталог: вход умирает, нужен новый логин.
 *  Сносим ТОЛЬКО внутри ~/.stovp-slots (fail-closed): чужой путь в поле
 *  home не должен превращаться в rm по произвольной папке. */
export function slotRemove({ id, purge = false }) {
  const d = loadSlots();
  const s = d.slots.find((x) => x.id === id);
  if (!s) throw new Error(`нет слота ${id}`);
  if (!s.home) throw new Error('основной слот не отвязывается — это домашний каталог CLI');
  d.slots = d.slots.filter((x) => x.id !== id);
  saveSlots(d);
  // служебную сессию логина глушим, чтобы не висела сиротой
  const name = authName(id);
  if (tmuxAlive(name)) { try { tmux(['kill-session', '-t', TMUX_PREFIX + name]); } catch {} }
  if (!purge) return { removed: id, home_kept: s.home };
  const full = path.resolve(s.home);
  if (full !== SLOTS_HOME && !full.startsWith(SLOTS_HOME + path.sep))
    throw new Error(`каталог слота вне ${SLOTS_HOME} — удаляй руками: ${full}`);
  fs.rmSync(full, { recursive: true, force: true });
  return { removed: id, home_purged: full };
}

/** Подключение слота: служебная tmux с CLI этого слота, ссылку — карточкой. */
export function slotConnect({ id }) {
  const s = slotById(id);
  // Основной слот делит домашний каталог с рабочим CLI и приложением:
  // /login в нём переустанавливает токен и рвёт Remote Control — так и
  // «выбило» main (факт 20.08). Логин основного — только руками человека.
  if (!s.home)
    throw new Error('основной аккаунт делит каталог с рабочим CLI: логинься в самом приложении/терминале, иначе рвётся Remote Control. Для флота заведи отдельную копию подписки');
  const name = authName(id);
  if (s.provider === 'codex') {
    if (!tmuxAlive(name)) startAuthTmux(s, CODEX_BIN + ' login');
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const scr = capture(name, 60).replace(/\n/g, '');
      const m = scr.match(/https:\/\/auth\.openai\.com\/\S+/);
      if (m) return { url: m[0], need_code: false };
      execFileSync('sleep', ['0.5']);
    }
    throw new Error(`ссылка codex login не появилась за 10с — tmux attach -t stovp-${name}`);
  }
  // claude: поднять, дождаться экрана, /login, выбрать подписку, снять ссылку
  if (!tmuxAlive(name)) startAuthTmux(s, CLAUDE_BIN);
  let kind = 'booting';
  const boot = Date.now() + 25_000;
  while (Date.now() < boot) {
    kind = classify(visible(name));
    if (kind !== 'booting') break;
    execFileSync('sleep', ['0.5']);
  }
  if (kind !== 'login_flow') sendLine(name, '/login');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const scr = capture(name, 50);
    if (/Select login method/i.test(scr)) {
      tmux(['send-keys', '-t', pane(name), 'Enter']);
      break;
    }
    if (/use the url below|Paste code here/i.test(scr)) break;
    execFileSync('sleep', ['0.5']);
  }
  // ссылка печатается с переносами — склеиваем
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const scr = capture(name, 60);
    const m = scr.replace(/\n/g, '').match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/);
    if (m) return { url: m[0].replace(/Paste code here.*$/, '').trim(), need_code: true };
    execFileSync('sleep', ['0.5']);
  }
  throw new Error(`ссылка не появилась за 8с — tmux attach -t stovp-${name}`);
}

/** Лимиты подписки слота — с экрана служебной сессии (память CTO: «/usage
 *  снимается через tmux», лимит общий на аккаунт). Claude — /usage;
 *  Codex — /status (лимиты приезжают только с ответом модели, поэтому
 *  при пустом статусе делается один мини-запрос). */
export function slotUsage({ id }) {
  const s = slotById(id);
  if (s.provider === 'codex') return codexUsage(s, authName(id));
  if (s.provider !== 'claude') throw new Error(`лимиты для ${s.provider} пока не умею`);
  const name = authName(id);
  if (!tmuxAlive(name)) startAuthTmux(s, CLAUDE_BIN);
  // дождаться промпта (свежая сессия может проходить онбординг)
  const boot = Date.now() + 30_000;
  while (Date.now() < boot) {
    const kind = classify(visible(name));
    if (kind === 'prompt') break;
    if (kind === 'onboarding' || kind === 'mcp_consent' || kind === 'trust')
      try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
    if (kind === 'needs_auth') throw new Error('слот не авторизован');
    execFileSync('sleep', ['0.5']);
  }
  sendLine(name, '/usage');
  const until = Date.now() + 8000;
  let scr = '';
  while (Date.now() < until) {
    scr = capture(name, 60);
    if (/% used/.test(scr)) break;
    execFileSync('sleep', ['0.5']);
  }
  // закрыть панель, вернуть сессию к промпту
  try { tmux(['send-keys', '-t', pane(name), 'Escape']); } catch {}
  const take = (label) => {
    const m = scr.match(new RegExp(label + String.raw`[\s\S]{0,200}?(\d+)% used[\s\S]{0,120}?Resets ([^\n]+)`));
    return m ? { used_pct: Number(m[1]), resets: m[2].trim() } : null;
  };
  const usage = {
    session: take('Current session'),
    week_all: take(String.raw`Current week \(all models\)`),
    week_model: take(String.raw`Current week \((?:Fable|Opus|Sonnet)[^)]*\)`),
    at: new Date().toISOString(),
  };
  if (!usage.session && !usage.week_all)
    throw new Error('не смог прочитать /usage — открой tmux attach -t stovp-' + name);
  return usage;
}

/** Автовыбор подписки (CTO 22.08: «не хочу думать, в какой подписке
 *  поднимать»; политика распределения — CTO 25.08): сначала ДОГРУЖАЕМ уже
 *  начатую подписку до 50% сессионного лимита — берём самую занятую из тех,
 *  что ещё ниже 50% (нетронутые 5-часовые окна не будим раньше времени);
 *  когда все перевалили 50% — распределяем по чуть-чуть: наименее занятая
 *  по сессии, при равенстве — по неделе. Лимиты меняются медленно — кеш
 *  10 минут, чтобы старт сессии не ждал три /usage подряд.
 *  Возвращает и объяснение выбора — оркестратор говорит его человеку. */
const usagePickCache = new Map(); // slot id → { at, usage }
export function slotPick() {
  const scored = [], failed = [];
  for (const s of loadSlots().slots.filter((x) => x.provider === 'claude')) {
    let c = usagePickCache.get(s.id);
    if (!c || Date.now() - c.at > 10 * 60_000) {
      try { c = { at: Date.now(), usage: slotUsage({ id: s.id }) }; usagePickCache.set(s.id, c); }
      catch (e) { failed.push(`${s.label}: ${e.message}`); continue; }
    }
    scored.push({
      id: s.id, label: s.label,
      session_pct: c.usage.session?.used_pct ?? c.usage.week_all?.used_pct ?? 100,
      week_pct: c.usage.week_all?.used_pct ?? 100,
    });
  }
  if (!scored.length)
    throw new Error(`ни один слот не отдал лимиты: ${failed.join('; ') || 'слотов нет'}`);
  const below50 = scored.filter((x) => x.session_pct < 50);
  let pick, rule;
  if (below50.length) {
    below50.sort((a, b) => b.session_pct - a.session_pct || a.week_pct - b.week_pct);
    pick = below50[0];
    rule = 'догружаю начатую до 50% сессии';
  } else {
    scored.sort((a, b) => a.session_pct - b.session_pct || a.week_pct - b.week_pct);
    pick = scored[0];
    rule = 'все выше 50% — ровняю по наименее занятой';
  }
  const why = scored.map((x) => `${x.label} — сессия ${x.session_pct}%, неделя ${x.week_pct}%`)
    .join('; ') + (failed.length ? `; без ответа: ${failed.join('; ')}` : '');
  return { id: pick.id, label: pick.label, why: `выбран «${pick.label}» (${rule}; ${why})`, scored };
}

// Codex: панель /status. «% left» нормализуем в «использовано», как у
// Claude. Формат снят живьём 17.08 (codex v0.147): «Weekly limit: […] 97%
// left / (resets 14:33 on 20 Aug)» + строка топ-модели с префиксом имени.
function codexUsage(s, name) {
  if (!tmuxAlive(name)) startAuthTmux(s, CODEX_BIN);
  const boot = Date.now() + 20_000;
  while (Date.now() < boot) {
    const scr = capture(name, 40);
    if (/Press enter to continue|Yes, continue/i.test(scr)) {
      try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
    } else if (/›/.test(scr)) break;
    execFileSync('sleep', ['0.5']);
  }
  const parse = (scr) => {
    const out = { session: null, week_all: null, week_model: null };
    const lines = scr.split('\n').map((l) => l.replace(/│/g, ' ').trim());
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(.*?)\s*Weekly limit:\s*\[[^\]]*\]\s*(\d+)% left/);
      if (!m) continue;
      const resets = (lines[i] + ' ' + (lines[i + 1] || '')).match(/resets ([^)]+)\)/)?.[1] || null;
      const entry = { used_pct: 100 - Number(m[2]), resets };
      if (m[1]) out.week_model = entry; else out.week_all = entry;
    }
    return out;
  };
  sendLine(name, '/status');
  execFileSync('sleep', ['3']);
  let u = parse(capture(name, 80));
  if (!u.week_all && !u.week_model) {
    // свежая сессия лимитов не знает — один мини-запрос, чтобы приехали
    sendLine(name, 'ответь одним словом: ок');
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      execFileSync('sleep', ['3']);
      sendLine(name, '/status');
      execFileSync('sleep', ['3']);
      u = parse(capture(name, 80));
      if (u.week_all || u.week_model) break;
    }
  }
  if (!u.week_all && !u.week_model)
    throw new Error('не смог прочитать /status — tmux attach -t stovp-' + name);
  return { ...u, at: new Date().toISOString() };
}

/** Аудит проекта (STOVP-59, «подключить проект»): запускает сессию-аудитора
 *  с промтом из канона (docs/specs — раздел «Сам промт»). Режим bypass —
 *  но ТОЛЬКО за забором (решение CTO 19.08): аудитор читает весь репозиторий
 *  и историю git, диалог на каждую команду делал его неработоспособным;
 *  опасное режет забор (снос вне проекта, силовой пуш, серверы, sudo,
 *  ключница), а правки канона промт требует нести списком предложений. */
export function auditStart({ project }) {
  const root = rootByName(project);
  const spec = path.join(MORDA_ROOT, '..', 'docs', 'specs', '2026-08-18-project-audit-prompt.md');
  const text = fs.readFileSync(spec, 'utf8');
  const m = text.match(/## Сам промт[^\n]*\n\n([\s\S]*?)\n\n## /);
  if (!m) throw new Error('в спеке не нашёлся раздел «Сам промт» — проверь docs/specs/2026-08-18-project-audit-prompt.md');
  const prompt = m[1].split('\n')
    .map((l) => l.replace(/^>\s?/, '')).join('\n').trim();
  const name = 'audit-' + Date.now().toString(36).slice(-5);
  return runnerStart({
    project, name,
    goal: `${prompt}\n\nПроект: «${project}», корень: ${root}. Вопросы человеку задавай формами AskUserQuestion (пульт показывает их нативно); каждую закрытую ступень — сообщением в чат.`,
    model: 'fable', mode: 'bypass', effort: 'high',
    // аудит идёт ДО паспорта: его работа — паспорт собрать (STOVP-61);
    // пропускается только отсутствие паспорта, красный режет и аудит
  }, { passportlessOk: true });
}

/** Код со страницы после входа (только Claude-флоу). */
export function slotCode({ id, code }) {
  const name = authName(slotById(id).id);
  if (!tmuxAlive(name)) throw new Error(`нет живой сессии логина — начни подключение заново`);
  if (!/^[\w#%-]{8,200}$/.test(code || '')) throw new Error('это не похоже на код');
  sendLine(name, code);
  return { sent: true };
}
