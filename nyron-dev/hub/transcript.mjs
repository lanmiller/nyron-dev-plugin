/**
 * transcript.mjs — чтение транскриптов Claude Code (~/.claude/projects/*)
 * в структуру для окна сессии морды (этап 4 спеки
 * docs/specs/2026-08-08-morda-pult.md) и для надзирателя.
 *
 * Единственная реализация на плагин: watchdog.mjs импортирует
 * transcriptDirs/tailOf отсюда, морда — listSessions/readSession/readAgent
 * (лестница §0-б: не дублировать существующий механизм).
 *
 * Раскладка на диске (сверено фактом 09.08.2026):
 *   <projects>/<munged-root>/<uuid>.jsonl                — транскрипт сессии
 *   <projects>/<munged-root>/<uuid>/subagents/agent-<id>.jsonl + .meta.json
 *   <projects>/<munged-root>/<uuid>/tool-results/*.txt   — большие выводы
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectsDir = () => process.env.CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

// Ключи — только безопасные имена: транскрипт приходит с клиента морды,
// точка/слэш открывали бы обход пути.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

// Лимиты рендера: плашка не должна тащить мегабайты в браузер.
const INPUT_CAP = 700;
const RESULT_CAP = 4000;
const TEXT_CAP = 40_000;

// ---------- низкоуровневое (общие с надзирателем) ----------

// имя каталога транскриптов = путь корня с [/.] → '-' (так их кладёт
// Claude Code; worktree-варианты попадают тем же префиксом)
const slugPrefix = (root) => root.replace(/[/.]/g, '-');

// каталоги транскриптов проекта: корень + его worktree-копии.
// Внутренний вариант отдаёт ещё и ошибку readdir: пустой список при
// EACCES/EIO/EMFILE — это «сейчас не видно», а не «каталогов не стало», и
// индекс не имеет права принимать его за удаление (ревью: пульт временно
// терял ВСЕ сессии проекта). ENOENT/ENOTDIR — каталога правда нет.
function transcriptDirsOf(root) {
  const prefix = slugPrefix(root);
  let entries;
  try { entries = fs.readdirSync(projectsDir()); } catch (err) { return { dirs: [], err }; }
  return {
    dirs: entries.filter((e) => e.startsWith(prefix))
      .map((e) => path.join(projectsDir(), e)),
    err: null,
  };
}

/** Контракт для надзирателя (watchdog.mjs) неизменен: любая ошибка → []. */
export function transcriptDirs(root) {
  return transcriptDirsOf(root).dirs;
}

export function tailOf(file, kb) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, kb * 1024);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.subarray(0, got).toString('utf8');
    // читали не с начала файла → первая строка почти наверняка разрезана
    // границей хвоста: отбрасываем до первого перевода строки
    if (size > len) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally { fs.closeSync(fd); }
}

function headOf(file, kb) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, kb * 1024);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, 0);
    let text = buf.subarray(0, got).toString('utf8');
    // последняя строка может быть разрезана — отбрасываем хвост без \n
    if (size > len) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return text;
  } finally { fs.closeSync(fd); }
}

function parseLines(text) {
  const events = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { events.push(JSON.parse(l)); } catch {}
  }
  return events;
}

// Сессия принадлежит проекту, если её cwd внутри корня (munged-префикс
// не различает '/' и '-': /a/b цепляет и /a/b-2 — правило надзирателя).
function cwdForeign(cwd, root) {
  return cwd && cwd !== root && !cwd.startsWith(root + path.sep);
}

// ---------- список сессий проекта ----------

/**
 * listSessions(root) → [{ key, file, mtime, size, title }] новые сверху.
 * Заголовок — последний custom-title; фолбэк — первая реплика человека.
 * Файлы читаются головой и хвостом (транскрипты бывают в десятки МБ).
 */
// Пофайловый кэш разбора: заголовок и хост сессии меняются редко, а лента
// дописывается непрерывно. Раньше кэш держался на сигнатуре ВСЕГО каталога —
// любая запись в любую ленту сбрасывала его целиком, и морда на каждый опрос
// заново парсила сотню файлов (~20 МБ JSON), захлёбываясь при живом флоте
// (факт 22.08: сервер вставал под тестовым прогоном волны). Теперь
// перечитывается только то, что реально изменилось.
const metaCache = new Map(); // full → { mtimeMs, size, meta }

/** Разбор ОДНОГО транскрипта → мета для списка (null — сессия чужая).
 *  Вынесено из listSessions, чтобы список и индекс сессий разбирали файл
 *  одним кодом и одним кэшем (лестница §0-б: механизм не дублируем). */
function metaOf(full, name, root, st) {
  // хвост широкий (128К): custom-title обновляется по ходу сессии и на
  // многомегабайтных транскриптах живёт в десятках КБ от конца (факт 09.08)
  const cached = metaCache.get(full);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
    return { ...cached.meta, mtime: st.mtime.toISOString(), size: st.size };
  const head = parseLines(headOf(full, 64));
  const tail = st.size > 64 * 1024 ? parseLines(tailOf(full, 128)) : [];
  const events = [...head, ...tail];
  const cwd = events.find((e) => typeof e.cwd === 'string')?.cwd || null;
  if (cwdForeign(cwd, root)) return null;
  // кто хостит сессию: claude-desktop | cli | sdk-cli — от этого зависит
  // режим ввода в окне морды (tmux-мгновенно vs зеркало Desktop)
  const entrypoint = events.find((e) => typeof e.entrypoint === 'string')?.entrypoint || null;
  let title = null;
  for (const e of events) if (e.type === 'custom-title' && titleOf(e)) title = titleOf(e);
  if (!title) {
    for (const e of head) {
      if (e.type !== 'user' || !e.message) continue;
      // XML-обёртки команд (<command-name>…) — не заголовок
      const t = firstText(e.message.content)
        ?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) { title = t.slice(0, 100); break; }
    }
  }
  const meta = {
    key: path.basename(name, '.jsonl'),
    file: full,
    mtime: st.mtime.toISOString(),
    size: st.size,
    title: title || '(без названия)',
    entrypoint,
  };
  // Ни одной разобранной строки — лента битая (или ещё не дописана): без
  // пометки такой файл неотличим от честной сессии без заголовка. Поле
  // ставим ТОЛЬКО когда true, чтобы не менять форму меты у нормальных лент.
  if (!events.length) meta.broken = true;
  metaCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, meta });
  // наружу — копия: кэшированный объект правит только этот модуль
  return { ...meta };
}

/** Одна лента каталога → мета в Map (или снятие, если файл исчез/чужой).
 *  Точечный вход: индекс перечитывает ровно тронутый файл, а не каталог. */
function updateFile(dir, name, root, files) {
  const full = path.join(dir, name);
  let st;
  try { st = fs.statSync(full); } catch (e) {
    // файла действительно нет — снимаем; прочая ошибка (EACCES/EIO) —
    // временная слепота, прежнюю мету не выбрасываем (ревью Sol S5)
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') files.delete(name);
    return;
  }
  if (!st.isFile()) { files.delete(name); return; } // подкаталоги субагентов — не сессии
  const meta = metaOf(full, name, root, st);
  if (meta) files.set(name, meta); else files.delete(name);
}

/** Сессии ОДНОГО каталога слага одним куском: Map(имя файла → мета).
 *  Разовый вход listSessions (у индекса свой обход — порциями, см.
 *  rescanJobs: там тот же updateFile, механизм не дублируется). */
function scanDir(dir, root) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return new Map(); }
  const files = new Map();
  for (const f of names) updateFile(dir, f, root, files);
  return files;
}

// один uuid может лежать в двух munged-каталогах (корень + worktree после
// resume) — дубль ключа валит keyed-рендер; оставляем свежайший
function newestByKey(list) {
  const byKey = new Map();
  for (const s of list.sort((a, b) => (a.mtime < b.mtime ? 1 : -1)))
    if (!byKey.has(s.key)) byKey.set(s.key, s);
  return [...byKey.values()];
}

export function listSessions(root) {
  const out = [];
  for (const dir of transcriptDirs(root)) out.push(...scanDir(dir, root).values());
  return newestByKey(out);
}

// поле заголовка в реальных транскриптах — customTitle (факт 09.08);
// title поддержан на случай старого формата
function titleOf(e) {
  return (typeof e.customTitle === 'string' && e.customTitle)
    || (typeof e.title === 'string' && e.title) || null;
}

function firstText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const p of content) {
    if (typeof p === 'string' && p.trim()) return p.trim();
    if (p?.type === 'text' && p.text?.trim()) return p.text.trim();
  }
  return null;
}

// ---------- полное чтение сессии ----------

/**
 * Файл транскрипта по ключу — единый выбор для чтения и привязки ввода.
 * Ревью Sol r1/r2 (этап 4): (а) munged-префикс цепляет и соседний проект
 * /a/b-2 — валидный uuid чужого проекта читался бы напрямую; (б) дубль
 * uuid в root/worktree-каталогах открывал не тот файл, что показан в
 * списке; (в) файл БЕЗ cwd в голове/хвосте не принимается (fail-closed:
 * принадлежность проекту обязана быть доказана, отсутствие улик ≠ свой).
 */
export function sessionFile(root, key) {
  if (!KEY_RE.test(key)) return null;
  const cands = [];
  for (const dir of transcriptDirs(root)) {
    const full = path.join(dir, `${key}.jsonl`);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) cands.push({ full, mtime: st.mtimeMs });
    } catch {}
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) {
    const events = [...parseLines(headOf(c.full, 64)), ...parseLines(tailOf(c.full, 16))];
    const cwd = events.find((e) => typeof e.cwd === 'string')?.cwd || null;
    if (cwd && !cwdForeign(cwd, root)) return c.full;
  }
  return null;
}

/**
 * readSession(root, key, { maxBytes }) →
 *   { key, size, truncated, title, items } | null.
 * items: { kind: user|assistant|thinking|tool, ts, text?, ... };
 * tool: { id, name, input, result, is_error, agent? } — result сшит из
 * tool_result по id, agent — мета субагента (subagents/*.meta.json).
 */
export function readSession(root, key, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const file = sessionFile(root, key);
  if (!file) return null;
  const size = fs.statSync(file).size;
  const truncated = size > maxBytes;
  const text = truncated ? tailOf(file, Math.floor(maxBytes / 1024)) : fs.readFileSync(file, 'utf8');
  const events = parseLines(text);
  const { items, title: bodyTitle } = toItems(events);
  let title = bodyTitle;
  let entrypoint = events.find((e) => typeof e.entrypoint === 'string')?.entrypoint || null;
  let cwd = events.find((e) => typeof e.cwd === 'string')?.cwd || null;
  if ((!title || !entrypoint || !cwd) && truncated) {
    // заголовок/entrypoint/cwd обычно в голове файла — при обрезке хвостом
    // добираем оттуда
    for (const e of parseLines(headOf(file, 64))) {
      if (e.type === 'custom-title' && titleOf(e)) title = titleOf(e);
      if (!entrypoint && typeof e.entrypoint === 'string') entrypoint = e.entrypoint;
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    }
  }
  attachAgents(path.join(path.dirname(file), key), items);
  // file отдаём наружу: привязка ввода обязана проверяться по ТОМУ ЖЕ
  // файлу, что прочитан (ревью Sol r3: независимый повторный выбор давал
  // окно гонки на дублях uuid — показали A, привязали B).
  // cwd — рабочая папка сессии (воркtree-кодонимы вида suspicious-bose
  // без неё нечитаемы) + существует ли она ещё.
  return {
    key, file, size, truncated, title: title || null, entrypoint, items,
    cwd, cwd_alive: cwd ? fs.existsSync(cwd) : null,
  };
}

/** readAgent(root, key, agentId) → { agentId, meta, items } | null */
export function readAgent(root, key, agentId, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const file = sessionFile(root, key);
  if (!file || !KEY_RE.test(agentId)) return null;
  const sub = path.join(path.dirname(file), key, 'subagents', `agent-${agentId}.jsonl`);
  let size;
  try { size = fs.statSync(sub).size; } catch { return null; }
  const truncated = size > maxBytes;
  const text = truncated ? tailOf(sub, Math.floor(maxBytes / 1024)) : fs.readFileSync(sub, 'utf8');
  const { items } = toItems(parseLines(text));
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(sub.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
  return { key, agentId, meta, size, truncated, items };
}

// ---------- события → элементы рендера ----------

function toItems(events) {
  const items = [];
  const toolById = new Map();
  let title = null;
  for (const e of events) {
    if (e.type === 'custom-title') { title = titleOf(e) || title; continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const msg = e.message;
    if (!msg?.content) continue;
    const ts = e.timestamp || null;

    if (e.type === 'user') {
      if (typeof msg.content === 'string') {
        const t = msg.content.trim();
        if (t) items.push({ kind: 'user', ts, text: cap(t, TEXT_CAP), images: [], system: systemNote(t) });
        continue;
      }
      let text = '';
      const images = [];
      for (const p of msg.content) {
        if (typeof p === 'string') text += p;
        else if (p?.type === 'text') text += p.text || '';
        else if (p?.type === 'image') {
          // base64 → data-URI для инлайна в окне (кап 8 картинок и ~4МБ на
          // штуку, чтоб не раздуть ответ); чужие форматы источника — счётчик
          const s = p.source || {};
          if (s.type === 'base64' && s.data && s.data.length < 4_000_000 && images.length < 8)
            images.push(`data:${s.media_type || 'image/png'};base64,${s.data}`);
          else images.push(null); // была картинка, но не инлайним
        }
        else if (p?.type === 'tool_result') {
          const t = toolById.get(p.tool_use_id);
          if (t) {
            t.result = cap(resultText(p.content), RESULT_CAP);
            t.is_error = Boolean(p.is_error);
          }
        }
      }
      if (text.trim() || images.length) {
        const t = text.trim();
        items.push({ kind: 'user', ts, text: cap(t, TEXT_CAP), images, system: systemNote(t) });
      }
      continue;
    }

    // assistant: каждый содержательный кусок — отдельный элемент ленты
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
    for (const p of parts) {
      if (p?.type === 'thinking') {
        if (p.thinking?.trim())
          items.push({ kind: 'thinking', ts, text: cap(p.thinking, TEXT_CAP) });
      } else if (p?.type === 'text') {
        if (p.text?.trim()) items.push({ kind: 'assistant', ts, text: cap(p.text, TEXT_CAP) });
      } else if (p?.type === 'tool_use') {
        const item = {
          kind: 'tool', ts, id: p.id, name: p.name || '?',
          input: toolInputLabel(p.name, p.input), result: '', is_error: false,
        };
        // родной HITL приложения: пока tool_result не пришёл, форма ждёт
        // человека — морда обязана показать её карточкой (CTO 10.08:
        // «в сессии висит HITL для меня, но я не вижу в морде этого»)
        if (p.name === 'AskUserQuestion' && Array.isArray(p.input?.questions))
          item.questions = p.input.questions;
        toolById.set(p.id, item);
        items.push(item);
      }
    }
  }
  return { items, title };
}

// Служебные XML-обёртки рантайма (завершение фонового субагента, эхо
// слэш-команды, системные напоминания, межсессионное сообщение) — это НЕ
// реплика человека: помечаем, UI рисует свёрнутой плашкой (CTO 10.08:
// «вот это что?» на сыром <task-notification> посреди чата)
function systemNote(t) {
  return t.startsWith('<task-notification>') ? 'субагент завершил работу'
    : t.startsWith('<command-name>') ? 'слэш-команда'
    : t.startsWith('<system-reminder>') ? 'системное напоминание'
    : t.startsWith('<cross-session-message') ? 'сообщение из другой сессии'
    : t.startsWith('<local-command') ? 'локальная команда'
    : null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
    .filter(Boolean).join('\n');
}

// человекочитаемая шапка плашки: для ходовых инструментов — главный
// аргумент, для остальных — компактный JSON
function toolInputLabel(name, input) {
  if (!input || typeof input !== 'object') return '';
  const main = input.command ?? input.file_path ?? input.path ?? input.pattern
    ?? input.skill ?? input.url ?? input.query
    ?? (name === 'Agent' ? input.description : undefined);
  if (typeof main === 'string') return cap(main, INPUT_CAP);
  try { return cap(JSON.stringify(input), INPUT_CAP); } catch { return ''; }
}

function attachAgents(sessionDir, items) {
  let metas = [];
  try {
    metas = fs.readdirSync(path.join(sessionDir, 'subagents'))
      .filter((f) => f.endsWith('.meta.json'));
  } catch { return; }
  const byToolUse = new Map();
  for (const f of metas) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(sessionDir, 'subagents', f), 'utf8'));
      const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      if (m.toolUseId) byToolUse.set(m.toolUseId, { agentId, ...m });
    } catch {}
  }
  for (const i of items) {
    if (i.kind !== 'tool') continue;
    const m = byToolUse.get(i.id);
    if (m) i.agent = {
      agentId: m.agentId, name: m.name || null,
      agentType: m.agentType || null, description: m.description || null,
      model: m.model || null,
    };
  }
}

function cap(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… [обрезано, всего ${s.length} симв.]` : s;
}

// ---------- индекс сессий: список и свежесть без обхода диска (STOVP-65) ----------

/*
 * Пульт опрашивает флот раз в 2–5 с, и КАЖДЫЙ опрос перечитывал каталоги
 * транскриптов: readdir + stat по тысячам .jsonl (1.7 ГБ) плюс readdir по
 * лентам субагентов и фоновых команд на каждую сессию. Диск отвечал
 * секундами, сервер вставал (факты 22–23.08). Индекс переворачивает схему:
 * диск читается, только когда файловая система сказала, что он изменился
 * (fs.watch), а редкий обход-страховка идёт ТАЙМЕРОМ в фоне — fs.watch
 * «не 100% консистентен между платформами» (док Node), а на macOS
 * пересозданный каталог получает новый inode, за которым вотчер не идёт.
 *
 * Главное правило слоя: в пути запроса (list/lastActivity) допустимы только
 * точечные чтения того, о чём сказали события. Всё слепое — в фон.
 */

const RESYNC_MS = 10_000;   // страховка: как часто обходить диск фоном
const RETRY_MS = 100;       // как часто пробовать поднять упавший вотчер
const SETTLE_MS = 150;      // слепое окно вотчера при подъёме (см. treeOf)
const SWEEP_CHUNK = 200;    // сколько лент за одну порцию фонового обхода

// Корень скретчпадов сессий (<base>/<слаг>/<key>/tasks). На маке /tmp —
// симлинк на /private/tmp, os.tmpdir() НЕ годится (там /var/folders, CLI
// пишет не туда); иное окружение — env MORDA_SCRATCH_BASE.
function scratchDefault() {
  return process.env.MORDA_SCRATCH_BASE ?? path.join('/tmp',
    `claude-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
}

/** Самая свежая правка среди файлов каталога, 0 — каталога нет. */
function maxMtime(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  let best = 0;
  for (const f of files) {
    try { best = Math.max(best, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
  }
  return best;
}

/*
 * Фоновый обход-страховка: перечитать то, о чём события могли не сказать.
 *
 * Раньше он жил ВНУТРИ list() и стоил 2833 statSync в обработчике HTTP на
 * большом проекте (замер 23.08) — ровно та беда, ради которой затевался
 * индекс. Теперь это ОДИН таймер на модуль (unref, процесс не держит):
 * задания даёт каждый индекс и каждый наблюдатель, порция ограничена
 * SWEEP_CHUNK лент, между порциями цикл событий свободен, результат
 * применяется по мере обхода. Потребителей у механизма два с рождения:
 * индексы (состав каталогов и лент) и наблюдатели чек-ина (свежесть
 * фоновых лент там, где вотчер не поднялся).
 */
let sweepTimer = null;
let sweeping = false;
let sweepAgain = false;     // просили обойти раньше срока прямо во время обхода

function sweepArm(ms) {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweepRun, ms);
  sweepTimer.unref?.();
}
/** Завести таймер, если он ещё не заведён (новый индекс/наблюдатель). */
function sweepEnsure() { if (!sweepTimer && !sweeping) sweepArm(RESYNC_MS); }
/** Обойти раньше срока: поднялся вотчер (слепое окно FSEvents) или умер. */
function sweepSoon() { if (sweeping) sweepAgain = true; else sweepArm(0); }

function* sweepJobs() {
  for (const idx of [...indexes.values()]) yield* idx.sweepJobs();
  for (const o of [...observers.values()]) yield* o.sweepJobs();
}
function sweepRun() {
  sweepTimer = null;
  sweeping = true;
  sweepAgain = false;
  sweepStep(sweepJobs());
}
// Задание возвращает свою цену в лентах (оценка числа обращений к диску) —
// по ней и режется порция.
function sweepStep(jobs) {
  let budget = SWEEP_CHUNK;
  while (budget > 0) {
    const { value, done } = jobs.next();
    if (done) {
      sweeping = false;
      if (indexes.size || observers.size) sweepArm(sweepAgain ? 0 : RESYNC_MS);
      return;
    }
    try { budget -= Math.max(1, value()); } catch { budget -= 1; }
  }
  setTimeout(() => sweepStep(jobs), 0).unref?.();
}

// fs.watch падает на отсутствующем каталоге (ENOENT) и на исчерпании
// дескрипторов (EMFILE) — сервер от этого падать не должен: возвращаем null,
// наверху живёт обход-страховка. unref/persistent:false — чтобы вотчер не
// держал процесс (иначе не завершится ни тест, ни CLI-скрипт).
//
// Ошибка и закрытие делают FSWatcher непригодным («no longer usable», док
// Node): глотать error молча нельзя — событий больше не будет, а наверху
// вотчер числится живым, и страховка выключена навсегда (ревью Sol S4).
function watchDir(dir, recursive, onEvent, onDead) {
  let w;
  try {
    w = fs.watch(dir, { recursive, persistent: false }, (_e, name) => {
      try { onEvent(name); } catch {}
    });
  } catch { return null; }
  w.on('error', () => { onDead(w); try { w.close(); } catch {} });
  w.on('close', () => onDead(w));
  w.unref?.();
  return w;
}

/*
 * Один рекурсивный вотчер на ДЕРЕВО (каталог projects целиком, корень
 * скретчпадов целиком), а не на каждый каталог слага: у большого проекта
 * каталогов слага под тысячу (корень + worktree-копии), и вотчер на
 * каждый — это тысяча потоков FSEvents и тысяча подписок ради того же
 * потока событий. Подписчик приходит с именем своей ветки, событие
 * разводится по первому сегменту пути; branch === null — подписка на всё
 * дерево (индекс ждёт появления новых каталогов слага; каталог слага вне
 * projects сам себе дерево).
 */
const trees = new Map(); // каталог → { w, at, gen, byName: Map(имя → Set), all: Set }
function treeOf(dir) {
  let rec = trees.get(dir);
  if (!rec) {
    // gen — номер подъёма вотчера: по его смене подписчики понимают, что
    // было слепое окно и их данные надо перечитать один раз (см. sweepJobs)
    rec = { w: null, at: 0, gen: 0, byName: new Map(), all: new Set() };
    trees.set(dir, rec);
  }
  if (!rec.w && Date.now() - rec.at >= RETRY_MS) {
    // Каталога может ещё не быть (пульт из launchd поднялся раньше первой
    // сессии CLI — корня скретчпадов на машине нет вовсе) — пробуем поднять
    // коротким повтором ПОКА не поднимется: попытка идёт из sync(),
    // activity() и фонового обхода, то есть из любого живого пути.
    rec.at = Date.now();
    rec.w = watchDir(dir, true, (name) => treeFanout(rec, name), (w) => {
      if (trees.get(dir) !== rec || rec.w !== w) return;   // закрыли сами
      rec.w = null;
      rec.at = Date.now();
      treeFanout(rec, null);    // событий больше не будет — всё грязное
      sweepSoon();              // и страховка обходит диск, не дожидаясь срока
    });
    // FSEvents поднимает поток асинхронно и события первых миллисекунд
    // теряет. Окно закрываем фоновым обходом, а НЕ грязными флагами: иначе
    // ближайший list() платит полным сканом за изменение, которого не было
    // (DoD 3 — «повтор без изменений не читает диск», ревью Sol S1).
    if (rec.w) {
      rec.gen += 1;
      setTimeout(() => { if (trees.get(dir) === rec) sweepSoon(); }, SETTLE_MS).unref?.();
    }
  }
  return rec;
}
function treeFanout(rec, name) {
  if (name === null) {
    for (const set of rec.byName.values()) for (const s of set) s.treeEvent(null);
    for (const s of rec.all) s.treeEvent(null);
    return;
  }
  const i = name.indexOf(path.sep);
  const set = rec.byName.get(i < 0 ? name : name.slice(0, i));
  if (set) for (const s of set) s.treeEvent(name);
  for (const s of rec.all) s.treeEvent(name);
}
function treeJoin(dir, branch, sub) {
  const rec = treeOf(dir);
  if (branch === null) { rec.all.add(sub); return rec; }
  let set = rec.byName.get(branch);
  if (!set) { set = new Set(); rec.byName.set(branch, set); }
  set.add(sub);
  return rec;
}
function treeLeave(dir, branch, sub) {
  const rec = trees.get(dir);
  if (!rec) return;
  if (branch === null) rec.all.delete(sub);
  else {
    const set = rec.byName.get(branch);
    if (set) { set.delete(sub); if (!set.size) rec.byName.delete(branch); }
  }
  // Дерево без подписчиков закрываем: иначе рекурсивный FSEvents на каталог
  // projects жил бы до конца процесса даже после close() индекса (замер
  // критика: 5 вотчеров до close → 5 после).
  if (!rec.byName.size && !rec.all.size) {
    trees.delete(dir);
    const w = rec.w;
    rec.w = null;
    try { w?.close(); } catch {}
  }
}

/**
 * Наблюдатель за одним каталогом слага. Держит два признака:
 *  • для списка — что в каталоге изменилось (какие .jsonl трогали, надо ли
 *    перечитывать состав каталога целиком);
 *  • для чек-ина — свежесть фоновых лент сессии (subagents + tasks).
 * События берёт из деревьев (каталог projects и корень скретчпадов).
 * Общий для индекса и для чек-ина морды — второй реализации не заводим.
 */
const observers = new Map(); // слаг + корень скретчпадов → наблюдатель
function observeSlug(slugDir, scratchBase) {
  const ck = `${slugDir}\t${scratchBase}`;
  const have = observers.get(ck);
  if (have) { have.ensure(); return have; }

  const slugName = path.basename(slugDir);
  // Каталог слага почти всегда лежит в projects — тогда события берём из
  // общего дерева projects. Но чек-ин морды знает путь ФАЙЛА, а не корень
  // проекта, и каталог может оказаться где угодно (в тестах — mkdtemp в
  // /var/folders). Рекурсивный вотчер на РОДИТЕЛЯ такого каталога — это
  // подписка на весь временный каталог машины, и снять её нечем (ревью A3):
  // чужой каталог слага наблюдаем сам, рекурсивно (ленты субагентов лежат
  // в <slugDir>/<key>/subagents/).
  const inProjects = path.dirname(slugDir) === projectsDir();
  const txDir = inProjects ? projectsDir() : slugDir;
  const txBranch = inProjects ? slugName : null;
  const o = {
    slugDir, scratchBase, slugName,
    act: new Map(),       // key → { sub, tasks, subDirty, tasksDirty }
    dirSubs: new Set(),   // подписки списка: { dirDirty, names:Set }
  };
  const entry = (key) => {
    let a = o.act.get(key);
    if (!a) { a = { sub: 0, tasks: 0, subDirty: true, tasksDirty: true }; o.act.set(key, a); }
    return a;
  };
  const touchDir = () => { for (const s of o.dirSubs) s.dirDirty = true; };
  const touchFile = (name) => { for (const s of o.dirSubs) s.names.add(name); };

  o.markAll = () => {
    touchDir();
    for (const a of o.act.values()) { a.subDirty = true; a.tasksDirty = true; }
  };
  // Путь события внутри каталога слага: из дерева projects имя приходит с
  // веткой (<слаг>/…), из собственного дерева — уже без неё.
  const relOf = (name) => {
    if (!inProjects) return name;
    const i = name.indexOf(path.sep);
    return i < 0 ? '' : name.slice(i + 1);
  };
  // <слаг>/<key>.jsonl — лента сессии, <слаг>/<key>/subagents/… — лента
  // субагента. Имя файла в событии не гарантировано (док Node) — без него
  // считаем грязным всё.
  o.txSub = { treeEvent: (name) => {
    if (name === null) { o.markAll(); return; }
    const rel = relOf(name);
    if (!rel) { touchDir(); return; }          // сам каталог слага
    const j = rel.indexOf(path.sep);
    if (j < 0) { rel.endsWith('.jsonl') ? touchFile(rel) : touchDir(); return; }
    entry(rel.slice(0, j)).subDirty = true;
  } };
  // <слаг>/<key>/tasks/… — вывод фоновой команды
  o.taskSub = { treeEvent: (name) => {
    if (name === null) { for (const a of o.act.values()) a.tasksDirty = true; return; }
    const parts = name.split(path.sep);
    if (parts.length > 1) entry(parts[1]).tasksDirty = true;
  } };
  o.ensure = () => {
    treeJoin(txDir, txBranch, o.txSub);
    treeJoin(scratchBase, slugName, o.taskSub);
  };
  const deaf = () => !trees.get(txDir)?.w || !trees.get(scratchBase)?.w;
  o.activity = (key) => {
    if (!KEY_RE.test(key)) return 0;   // ключ идёт в путь — обход запрещён
    if (deaf()) o.ensure();            // вотчер не встал/умер — пробуем поднять
    const a = entry(key);
    if (a.subDirty) {
      a.sub = maxMtime(path.join(o.slugDir, key, 'subagents'));
      a.subDirty = false;
    }
    if (a.tasksDirty) {
      a.tasks = maxMtime(path.join(o.scratchBase, slugName, key, 'tasks'));
      a.tasksDirty = false;
    }
    return Math.max(a.sub, a.tasks);
  };
  // Страховка наблюдателя: пока вотчеры живы и не перезапускались, событий
  // достаточно и обходить нечего. Перечитываем свежесть фоновых лент, если
  // (а) вотчер не поднялся — событий не будет вовсе, либо (б) он только что
  // поднялся: FSEvents теряет события первых миллисекунд, и запись, сделанная
  // в это окно, иначе не видна до следующей (гонка теста чек-ина, 1 из 10).
  // Делаем это ЗДЕСЬ, а не в list(): иначе на большом проекте это 2 readdir ×
  // 2831 сессию прямо в обработчике запроса (ревью Sol S2/S3).
  o.txGen = 0;
  o.taskGen = 0;
  o.sweepJobs = function* () {
    o.ensure();
    const tx = trees.get(txDir);
    const tasks = trees.get(scratchBase);
    const doTx = !tx?.w || tx.gen !== o.txGen;
    const doTasks = !tasks?.w || tasks.gen !== o.taskGen;
    if (!doTx && !doTasks) return;
    o.txGen = tx?.gen ?? 0;
    o.taskGen = tasks?.gen ?? 0;
    for (const key of [...o.act.keys()]) yield () => {
      const a = o.act.get(key);
      if (!a) return 1;
      if (doTx) { a.sub = maxMtime(path.join(o.slugDir, key, 'subagents')); a.subDirty = false; }
      if (doTasks) {
        a.tasks = maxMtime(path.join(o.scratchBase, slugName, key, 'tasks'));
        a.tasksDirty = false;
      }
      return 2;
    };
  };
  /** Подписка списка на изменения каталога (у каждого индекса своя: один
   *  каталог слага виден из двух проектов, если один вложен в другой). */
  o.follow = () => {
    const sub = { dirDirty: true, names: new Set() };
    o.dirSubs.add(sub);
    return sub;
  };
  o.unfollow = (sub) => o.dirSubs.delete(sub);
  o.close = () => {
    treeLeave(txDir, txBranch, o.txSub);
    treeLeave(scratchBase, slugName, o.taskSub);
    observers.delete(ck);
  };
  observers.set(ck, o);
  o.ensure();
  sweepEnsure();
  return o;
}

/** Свежесть фоновых лент сессии (субагенты + выводы фоновых команд), ms
 *  epoch, 0 — их нет. Транскрипт сюда НЕ входит: его mtime знает вызывающий.
 *  Вход для чек-ина морды, которому известен файл, а не корень проекта. */
export function activityOf(file, key, { scratchBase } = {}) {
  if (!file || !key || !KEY_RE.test(key)) return 0;
  return observeSlug(path.dirname(file), scratchBase ?? scratchDefault()).activity(key);
}

/**
 * sessionIndex(root, { scratchBase }) → { list, lastActivity, close }.
 * Синглтон на пару «каталог projects + корень проекта»: вотчеры и кэш
 * общие для всех потребителей морды. close() снимает подписки, закрывает
 * осиротевших наблюдателей и вотчеры деревьев, на которых не осталось
 * подписчиков, и убирает индекс из реестра (следующий вызов соберёт новый).
 *
 * scratchBase действует ТОЛЬКО при создании индекса для root: повторный
 * вызов отдаёт уже собранный индекс и опцию молча игнорирует (так и
 * зафиксировано тестом «синглтон до close»). Сменить корень скретчпадов
 * можно лишь через close().
 *
 * list() → то же, что listSessions(root), плюс lastActivity — максимум по
 * трём лентам (транскрипт, субагенты, выводы фоновых команд).
 */
const indexes = new Map(); // каталог projects + корень проекта → индекс
export function sessionIndex(root, { scratchBase } = {}) {
  const ck = `${projectsDir()}\t${root}`;
  const have = indexes.get(ck);
  if (have) return have;
  const idx = createIndex(root, scratchBase ?? scratchDefault(), ck);
  indexes.set(ck, idx);
  return idx;
}

// Сравнение меты по видимым полям: перечитывание строит НОВЫЙ объект даже
// для нетронутой ленты, и без сверки список пересобирался бы (сортировка
// тысяч сессий) на каждый фоновый обход, хотя на диске ничего не менялось.
function sameMeta(a, b) {
  if (!a || !b) return !a && !b;
  return a.mtime === b.mtime && a.size === b.size && a.title === b.title;
}

/**
 * Обход каталога слага ПОРЦИЯМИ: readdir один раз, затем stat порциями по
 * SWEEP_CHUNK лент, результат применяется по ходу (точечный updateFile).
 *
 * Раньше это было одно задание фонового обхода на весь каталог: readdir +
 * stat по всем лентам подряд, и бюджет SWEEP_CHUNK списывался уже ПОСЛЕ
 * скана — цикл событий стоял всё это время, запросы к пульту ждали (замер
 * на /Users/stovp/ai-evolve, 2692 ленты: 18 мс одним куском, 4,5 мс после
 * дробления). Теперь порция стоит не больше бюджета, а между порциями
 * sweepStep отдаёт цикл через setTimeout(0).
 *
 * Тот же генератор — единственный обход каталога у индекса: sync()
 * вычерпывает его целиком (событие о составе каталога надо отработать
 * сразу), фоновый обход — по порциям.
 */
function* rescanJobs(rec, root, onChange) {
  const dir = rec.obs.slugDir;
  let names = null;
  let err = null;
  yield () => {
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
    catch (e) { err = e; return 1; }
    // Флаги гасим по СНИМКУ каталога: события, пришедшие после readdir,
    // должны пережить обход — иначе правка в середине порции потерялась бы.
    rec.sub.dirDirty = false;
    rec.sub.names.clear();
    return 1;
  };
  if (!names) {
    // ENOENT/ENOTDIR — каталога нет, сессий нет; прочая ошибка (EACCES/EIO/
    // EMFILE) — временная слепота, прежний состав держим до следующего раза
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return;
    rec.sub.dirDirty = false;
    rec.sub.names.clear();
    if (rec.files.size) { rec.files.clear(); onChange(); }
    return;
  }
  // исчезнувшие ленты видны уже по составу каталога — снимаем без stat
  const known = new Set(names);
  for (const name of [...rec.files.keys()]) {
    if (!known.has(name)) { rec.files.delete(name); onChange(); }
  }
  for (let i = 0; i < names.length; i += SWEEP_CHUNK) {
    const part = names.slice(i, i + SWEEP_CHUNK);
    yield () => {
      for (const name of part) {
        const было = rec.files.get(name);
        updateFile(dir, name, root, rec.files);
        if (!sameMeta(было, rec.files.get(name))) onChange();
      }
      return part.length;
    };
  }
}

function createIndex(root, scratchBase, ck) {
  const prefix = slugPrefix(root);
  const dirs = new Map();       // slugDir → { files: Map(имя → мета), obs, sub }
  let dirsDirty = true;         // состав каталогов слага (root + worktree)
  let listStale = true;
  let cached = [];              // мета без lastActivity, в порядке выдачи
  let byKey = new Map();
  let emptyAt = 0;

  // Появление НОВОГО каталога слага (сессия в worktree, первый запуск в
  // проекте) — событие того же дерева: своего вотчера индексу не нужно.
  const treeSub = { treeEvent: (name) => {
    if (name === null) { dirsDirty = true; return; }
    const i = name.indexOf(path.sep);
    const slug = i < 0 ? name : name.slice(0, i);
    if (slug.startsWith(prefix) && !dirs.has(path.join(projectsDir(), slug)))
      dirsDirty = true;
  } };

  /** Состав каталогов слага проекта (корень + worktree-копии). */
  function recompose() {
    const { dirs: found, err } = transcriptDirsOf(root);
    // Каталог projects временно нечитаем (EACCES/EIO/EMFILE) — пустой ответ
    // за удаление каталогов НЕ принимаем: прежний состав держим, dirsDirty
    // оставляем взведённым и пробуем на следующем обходе (ревью).
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return 1;
    dirsDirty = false;
    for (const [d, rec] of dirs) {
      if (found.includes(d)) continue;
      rec.obs.unfollow(rec.sub);
      if (!rec.obs.dirSubs.size) rec.obs.close();
      dirs.delete(d);
      listStale = true;
    }
    for (const d of found) {
      if (dirs.has(d)) continue;
      const obs = observeSlug(d, scratchBase);
      dirs.set(d, { files: new Map(), obs, sub: obs.follow() });
    }
    return found.length + 1;
  }

  const markStale = () => { listStale = true; };

  /** Полное перечитывание каталога слага одним куском — путь события о
   *  составе каталога (list() обязан отдать актуальный ответ сразу).
   *  Фоновый обход вычерпывает тот же генератор порциями. */
  function rescan(rec) {
    let cost = 0;
    for (const job of rescanJobs(rec, root, markStale)) cost += job();
    return cost;
  }

  function sync() {
    // Пока у проекта нет ни одного каталога слага, перечитываем projects на
    // каждый опрос: это ОДИН readdir, а не обход лент. Событие о появлении
    // каталога macOS теряет в первые миллисекунды жизни вотчера, и первая
    // сессия проекта иначе ждала бы фонового обхода (10 с).
    const now = Date.now();
    if (!dirs.size && now - emptyAt >= RETRY_MS) { emptyAt = now; dirsDirty = true; }
    // заодно повтор подъёма вотчера дерева projects, если он не встал
    treeJoin(projectsDir(), null, treeSub);
    if (dirsDirty) recompose();
    for (const rec of dirs.values()) {
      const { sub } = rec;
      if (sub.dirDirty) {
        // состав каталога мог измениться (новый файл, удаление) — readdir
        rescan(rec);
      } else if (sub.names.size) {
        // тронули конкретные ленты — перечитываем ровно их (одна активная
        // сессия стоит одного stat, а не обхода каталога)
        for (const name of sub.names) updateFile(rec.obs.slugDir, name, root, rec.files);
        sub.names.clear();
        listStale = true;
      }
    }
    if (listStale) {
      listStale = false;
      const all = [];
      for (const rec of dirs.values()) all.push(...rec.files.values());
      cached = newestByKey(all);
      byKey = new Map(cached.map((s) => [s.key, s]));
    }
  }

  // наблюдатель берётся из уже собранного каталога: на проекте с тысячами
  // сессий даже поиск наблюдателя по строке заметен на каждом опросе
  const actOf = (s) => {
    const dir = path.dirname(s.file);
    const obs = dirs.get(dir)?.obs || observeSlug(dir, scratchBase);
    return Math.max(new Date(s.mtime).getTime() || 0, obs.activity(s.key));
  };

  sweepEnsure();
  return {
    list() {
      sync();
      // копия на каждый вызов: кэш индекса потребители не правят
      return cached.map((s) => ({ ...s, lastActivity: actOf(s) }));
    },
    lastActivity(key) {
      sync();
      const s = byKey.get(key);
      return s ? actOf(s) : 0;
    },
    /** Внутреннее: работа для фонового обхода-страховки (см. sweepStep).
     *  Состав каталогов и лент перечитывается ЗДЕСЬ, вне пути запроса. */
    * sweepJobs() {
      yield () => recompose();
      // каталог отдаётся порциями: одно задание на весь каталог держало бы
      // цикл событий десятки миллисекунд (ревью, см. rescanJobs)
      for (const rec of dirs.values()) yield* rescanJobs(rec, root, markStale);
    },
    close() {
      treeLeave(projectsDir(), null, treeSub);
      for (const rec of dirs.values()) {
        rec.obs.unfollow(rec.sub);
        // наблюдатель без подписчиков держал бы вотчеры деревьев вечно
        if (!rec.obs.dirSubs.size) rec.obs.close();
      }
      dirs.clear();
      indexes.delete(ck);
    },
  };
}
