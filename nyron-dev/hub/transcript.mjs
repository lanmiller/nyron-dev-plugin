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

// каталоги транскриптов проекта: имя = путь корня с [/.] → '-'
// (так их кладёт Claude Code; worktree-варианты попадают префиксом)
export function transcriptDirs(root) {
  const prefix = root.replace(/[/.]/g, '-');
  let entries = [];
  try { entries = fs.readdirSync(projectsDir()); } catch { return []; }
  return entries.filter((e) => e.startsWith(prefix))
    .map((e) => path.join(projectsDir(), e));
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
export function listSessions(root) {
  const out = [];
  for (const dir of transcriptDirs(root)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue; // подкаталоги субагентов — не сессии
      // хвост широкий (128К): custom-title обновляется по ходу сессии и на
      // многомегабайтных транскриптах живёт в десятках КБ от конца (факт 09.08)
      const head = parseLines(headOf(full, 64));
      const tail = st.size > 64 * 1024 ? parseLines(tailOf(full, 128)) : [];
      const events = [...head, ...tail];
      const cwd = events.find((e) => typeof e.cwd === 'string')?.cwd || null;
      if (cwdForeign(cwd, root)) continue;
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
      out.push({
        key: path.basename(f, '.jsonl'),
        file: full,
        mtime: st.mtime.toISOString(),
        size: st.size,
        title: title || '(без названия)',
        entrypoint,
      });
    }
  }
  // один uuid может лежать в двух munged-каталогах (корень + worktree после
  // resume) — дубль ключа валит keyed-рендер; оставляем свежайший
  const byKey = new Map();
  for (const s of out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1)))
    if (!byKey.has(s.key)) byKey.set(s.key, s);
  return [...byKey.values()];
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
        if (msg.content.trim()) items.push({ kind: 'user', ts, text: cap(msg.content, TEXT_CAP) });
        continue;
      }
      let text = '';
      let images = 0;
      for (const p of msg.content) {
        if (typeof p === 'string') text += p;
        else if (p?.type === 'text') text += p.text || '';
        else if (p?.type === 'image') images++;
        else if (p?.type === 'tool_result') {
          const t = toolById.get(p.tool_use_id);
          if (t) {
            t.result = cap(resultText(p.content), RESULT_CAP);
            t.is_error = Boolean(p.is_error);
          }
        }
      }
      if (text.trim() || images)
        items.push({ kind: 'user', ts, text: cap(text.trim(), TEXT_CAP), images });
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
        toolById.set(p.id, item);
        items.push(item);
      }
    }
  }
  return { items, title };
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
