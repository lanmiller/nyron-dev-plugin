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
  RUNNER_STATE_FILE as STATE_FILE } from './fleet.js';

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
function tmuxAlive(name) {
  try { tmux(['has-session', '-t', TMUX_PREFIX + name]); return true; }
  catch { return false; }
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
function sendLine(name, text) {
  // -l: литеральный текст (без интерпретации ; и клавиш), Enter отдельно —
  // тот же проверенный канал, что fleet.say
  execFileSync(TMUX_BIN, ['send-keys', '-t', pane(name), '-l', text], { timeout: 3000 });
  execFileSync(TMUX_BIN, ['send-keys', '-t', pane(name), 'Enter'], { timeout: 3000 });
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
  // футер промпта разный по режимам: «? for shortcuts» (manual),
  // «shift+tab to cycle» (bypass ⏵⏵, plan и др.) — признаём оба (факт 17.08)
  if (/❯/.test(text) && /\? for shortcuts|shift\+tab to cycle/.test(text)) return 'prompt';
  return 'booting';
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
  const screen = capture(name);
  const kind = classify(screen);
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
  model, mode, effort, slot }) {
  const root = rootByName(project); // бросит на чужом имени — allowlist
  if (!NAME_RE.test(name || '')) throw new Error('имя: строчные латиница/цифры/дефис');
  if (model && !MODELS.has(model)) throw new Error(`модель: ${[...MODELS].join('|')}`);
  if (mode && !MODES.has(mode)) throw new Error(`режим: ${[...MODES].join('|')} (без диалогов — только после забора-хука)`);
  if (effort && !EFFORTS.has(effort)) throw new Error(`effort: ${[...EFFORTS].join('|')}`);
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
  const args = (resumeId ? ` --resume ${resumeId}` : '')
    + (model ? ` --model ${model}` : '')
    + (mode === 'bypass'
      ? ` --permission-mode bypassPermissions --settings ${guardSettingsFile()}`
      : mode ? ` --permission-mode ${mode}` : '')
    + (effort ? ` --effort ${effort}` : '');
  const targs = ['new-session', '-d', '-s', TMUX_PREFIX + name];
  for (const [k, v] of Object.entries(slotEnv(slotDef || {}))) targs.push('-e', `${k}=${v}`);
  targs.push('-c', dir, CLAUDE_BIN + args);
  execFileSync(TMUX_BIN, targs, { timeout: 5000, env: SPAWN_ENV });
  reg.sessions[name] = {
    project, root: dir, goal: goal || null, goalSent: false,
    sessionId: resumeId || null,
    model: model || null, mode: mode || null,
    effort: effort || null, slot: slot || null,
    startedAt: new Date().toISOString(), state: 'starting',
    stoppedAt: null,
  };
  saveReg(reg);
  startPoller(name);
  return reg.sessions[name];
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
    effort: s.effort || null, slot: s.slot || null,
  });
}

/** Реестр + здоровье по факту (не по памяти реестра): tmux жив? транскрипт
 *  пишется? Экран — needs_auth? Это ответ на «жив/молчит/упёрся». */
export function runnerList(project) {
  const reg = loadReg();
  const out = [];
  for (const [name, s] of Object.entries(reg.sessions)) {
    if (project && s.project !== project) continue;
    const alive = tmuxAlive(name);
    let screen = null;
    if (alive) {
      const kind = classify(capture(name));
      screen = kind;
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
    out.push({ name, ...s, tmux: TMUX_PREFIX + name, alive, screen });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Запись раннера по sessionId — карточка сессии показывает кнопки
 *  стоп/резюм только для СВОИХ процессов. */
export function runnerBySessionId(key) {
  const reg = loadReg();
  for (const [name, s] of Object.entries(reg.sessions))
    if (s.sessionId === key) {
      const alive = tmuxAlive(name);
      return { name, ...s, tmux: TMUX_PREFIX + name, alive,
        screen: alive ? classify(capture(name)) : null };
    }
  return null;
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
  if (classify(capture(name)) !== 'permission')
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

/** Статусы слотов: подключён / не подключён / протух — фактом, не памятью.
 *  codex отвечает мгновенно (login status); claude — экраном служебной
 *  сессии: probe=true поднимает её, probe=false только смотрит живую. */
export function slotList({ probe = false } = {}) {
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
        const scr = capture(name, 50);
        const kind = classify(scr);
        // онбординг нового профиля и согласия двигаем сами: auth-сессию
        // никто не поллит, её продвигает каждый опрос страницы настроек
        // (иначе слот вечно висел в «проверяю…» — факт CTO 17.08, «Мариха»)
        if (kind === 'onboarding' || kind === 'mcp_consent' || kind === 'trust') {
          try { tmux(['send-keys', '-t', pane(name), 'Enter']); } catch {}
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

export function slotRemove({ id }) {
  const d = loadSlots();
  const s = d.slots.find((x) => x.id === id);
  if (!s) throw new Error(`нет слота ${id}`);
  if (!s.home) throw new Error('основной слот не отвязывается — это домашний каталог CLI');
  d.slots = d.slots.filter((x) => x.id !== id);
  saveSlots(d);
  // служебную сессию логина глушим, чтобы не висела сиротой
  const name = authName(id);
  if (tmuxAlive(name)) { try { tmux(['kill-session', '-t', TMUX_PREFIX + name]); } catch {} }
  // конфиг-каталог НЕ сносим: там авторизация; удаление — руками
  return { removed: id, home_kept: s.home };
}

/** Подключение слота: служебная tmux с CLI этого слота, ссылку — карточкой. */
export function slotConnect({ id }) {
  const s = slotById(id);
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
    kind = classify(capture(name, 50));
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
    const kind = classify(capture(name, 50));
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

/** Код со страницы после входа (только Claude-флоу). */
export function slotCode({ id, code }) {
  const name = authName(slotById(id).id);
  if (!tmuxAlive(name)) throw new Error(`нет живой сессии логина — начни подключение заново`);
  if (!/^[\w#%-]{8,200}$/.test(code || '')) throw new Error('это не похоже на код');
  sendLine(name, code);
  return { sent: true };
}
