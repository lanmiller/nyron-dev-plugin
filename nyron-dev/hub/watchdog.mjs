#!/usr/bin/env node
/**
 * watchdog.mjs — надзиратель флота сессий (этап 2 морды, спека
 * docs/specs/2026-08-08-morda-pult.md; закрывает STOVP-42).
 *
 * Разделение труда — жёсткое (ревью Sol 08.08: «модель предлагает,
 * детерминированный слой решает»):
 *   • ФАКТЫ собирает код: хвосты транскриптов ~/.claude/projects/<проект>*,
 *     живые tmux-сессии, открытые ask будки;
 *   • КЛАССИФИЦИРУЕТ модель (Haiku, основная подписка машины — решение CTO
 *     09.08): работает / ждёт молча / замолчала — это задача чтения текста,
 *     эвристики по нему врут;
 *   • ЗАПИСЫВАЕТ снова код: состояния — в watch_states, заглушки за
 *     молчунов — hub_ask'ом с меткой wave=watchdog-inferred (дедуп будки
 *     не даёт плодить повторы), «сторож ослеп» — событием в канал ошибок.
 *
 * Детерминированные оверрайды ПОВЕРХ модели (модель не автор данных):
 *   • активность младше WATCHDOG_FRESH_MIN минут → working, что бы модель
 *     ни сказала (защита от ложных заглушек по свежим сессиям);
 *   • пустой/мусорный ответ модели → событие kind=error в будку, состояния
 *     НЕ трогаются (слепота видима, старые факты не портятся).
 *
 * Запуск: node watchdog.mjs [--dry]   (cwd = корень проекта — по нему
 * резолвятся будка и каталог транскриптов).
 *
 * Env (все — для тестируемости и переезда, дефолты боевые):
 *   NYRON_HUB_DIR        — явная будка (как у сервера);
 *   CLAUDE_PROJECTS_DIR  — где транскрипты (дефолт ~/.claude/projects);
 *   WATCHDOG_MODEL_CMD   — команда классификатора: payload на stdin, JSON
 *                          на stdout (дефолт: claude -p на Haiku; в тестах —
 *                          стаб, чтобы не жечь подписку и сеть);
 *   WATCHDOG_TAIL_KB     — сколько хвоста транскрипта читать (дефолт 48);
 *   WATCHDOG_IDLE_SKIP_H — транскрипты старше этого не смотрим (дефолт 48);
 *   WATCHDOG_FRESH_MIN   — младше этого = working без вопросов (дефолт 2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { resolveHubDir } from './hub-dir.mjs';
import { HubDb } from './hub-db.mjs';
import { transcriptDirs, tailOf } from './transcript.mjs';

const DRY = process.argv.includes('--dry');
const TAIL_KB = Number(process.env.WATCHDOG_TAIL_KB) || 48;
const IDLE_SKIP_H = Number(process.env.WATCHDOG_IDLE_SKIP_H) || 48;
const FRESH_MIN = Number(process.env.WATCHDOG_FRESH_MIN) || 2;
const MODEL_CMD = process.env.WATCHDOG_MODEL_CMD
  || 'claude -p --model claude-haiku-4-5-20251001';
// Фолбэк-классификатор (решение CTO 09.08): основной путь — подписка
// (бесплатно в её рамках); упёрлась в лимит — тик уходит сюда, если задан
// (например, claude -p с ANTHROPIC_API_KEY — платно за токены, зато
// автономно). Не задан — слепота остаётся видимой ошибкой, как раньше.
const FALLBACK_CMD = process.env.WATCHDOG_FALLBACK_MODEL_CMD || null;
const STATES = ['working', 'waiting_decision', 'waiting_silent', 'stalled', 'dead'];

// ---------- сбор фактов (без модели) ----------
// transcriptDirs/tailOf — из transcript.mjs (единственная реализация
// чтения транскриптов на плагин; этап 4 добавил туда и полный парс).

// хвост .jsonl → компактная выжимка для модели: когда последнее событие,
// какого рода, последние видимые тексты ассистента
function summarizeTranscript(file) {
  const st = fs.statSync(file);
  const ageMin = (Date.now() - st.mtimeMs) / 60000;
  if (ageMin > IDLE_SKIP_H * 60) return null;
  const lines = tailOf(file, TAIL_KB).split('\n').filter(Boolean);
  const events = [];
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
  if (!events.length) return null;
  const texts = [];
  let lastKind = 'unknown';
  let cwd = null;
  for (const e of events) {
    if (typeof e.cwd === 'string') cwd = e.cwd;
    const msg = e.message;
    if (!msg?.content) continue;
    lastKind = msg.role === 'assistant' ? 'assistant' : e.type || msg.role || 'other';
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const p of parts) {
      if (typeof p === 'string') texts.push(p);
      else if (p?.type === 'text' && p.text) texts.push(p.text);
      else if (p?.type === 'tool_use') { texts.push(`[tool: ${p.name}]`); lastKind = 'tool_use'; }
    }
  }
  return {
    file,
    key: path.basename(file, '.jsonl'),
    cwd,
    minutes_since_last: Math.round(ageMin),
    last_kind: lastKind,
    tail_text: texts.slice(-8).join('\n---\n').slice(-3000),
  };
}

function tmuxSessions() {
  try {
    return execSync("tmux list-sessions -F '#{session_name}'",
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim().split('\n').filter(Boolean);
  } catch { return []; } // tmux не поднят — честно пусто
}

// ---------- классификация (модель) ----------

function classifyWith(cmd, payload, promptText) {
  let out;
  try {
    out = execFileSync('sh', ['-c', cmd], {
      input: `${promptText}\n\nДАННЫЕ:\n${JSON.stringify(payload, null, 1)}`,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }).toString();
  } catch (e) {
    return { error: `модель не ответила: ${String(e.message || e).slice(0, 300)}` };
  }
  // из текстового ответа достаём ПЕРВЫЙ сбалансированный JSON-массив
  // (жадный regex ловил бы от первой [ до последней ] через весь мусор)
  const arr = extractJsonArray(out);
  if (arr === undefined)
    return { error: `в ответе модели нет валидного JSON-массива: ${out.slice(0, 200)}` };
  if (!Array.isArray(arr)) return { error: 'ответ модели — не массив' };
  return { verdicts: arr };
}

function classify(payload, promptText) {
  const first = classifyWith(MODEL_CMD, payload, promptText);
  if (!first.error || !FALLBACK_CMD) return first;
  const second = classifyWith(FALLBACK_CMD, payload, promptText);
  if (second.error)
    return { error: `основная: ${first.error} | фолбэк: ${second.error}` };
  second.used_fallback = first.error; // видно, что тик спасён фолбэком
  return second;
}

function extractJsonArray(text) {
  // перебираем ВСЕ стартовые '[': битый первый массив не должен прятать
  // валидный следующий (ревью Sol r2)
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return undefined;
}

// ---------- главный проход ----------

const root = fs.realpathSync(process.cwd()); // symlink /var→/private/var и т.п.
const hub = new HubDb(process.env.NYRON_HUB_DIR || resolveHubDir(root));

const sessions = [];
for (const dir of transcriptDirs(root)) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue; // подкаталоги субагентов — не сессии
      const s = summarizeTranscript(full);
      if (!s) continue;
      // Munged-префикс не различает '/' и '-': каталог проекта /a/b цепляет
      // и /a/b-2 (ревью Sol 09.08). Истина — поле cwd в самих событиях:
      // сессия с cwd вне корня проекта — чужая, выкидываем.
      if (s.cwd && s.cwd !== root && !s.cwd.startsWith(root + path.sep)) continue;
      sessions.push(s);
    } catch {}
  }
}

if (!sessions.length) {
  // Пустой снапшот тоже снапшот (ревью Sol r2): иначе последние состояния
  // зависли бы в watch навсегда после ухода всех сессий.
  if (!DRY) hub.setWatchStates([]);
  else console.log('живых транскриптов нет — watch очищен');
  process.exit(0);
}

const openAsks = hub.asks({ status: 'open' }).asks; // только open: answered/delivered — уже не «ждёт человека»
const payload = {
  sessions: sessions.map(({ file, ...rest }) => rest),
  open_asks: openAsks.map((a) => ({ session: a.session, question: a.question, status: a.status })),
  tmux: tmuxSessions(),
};

const promptText = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog-prompt.md'), 'utf8');

const res = classify(payload, promptText);
if (res.error) {
  // слепота сторожа — видимая: событие в канал ошибок, состояния не трогаем
  if (!DRY) hub.post({ from: 'watchdog', text: res.error, kind: 'error' });
  console.error(`watchdog: ${res.error}`);
  process.exit(0); // расписание не роняем — следующий тик попробует снова
}

// детерминированный слой: строгая схема, дедуп, оверрайды, запись.
// Модель — только предложение; всё, что не прошло проверку, молча падает
// (ревью Sol 09.08: null валил тик, дубль ключа плодил заглушки).
const byKey = new Map(sessions.map((s) => [s.key, s]));
const seenKeys = new Set();
const states = [];
const stubs = [];
for (const v of res.verdicts.slice(0, 500)) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
  const key = typeof v.key === 'string' ? v.key
    : path.basename(String(v.file || ''), '.jsonl');
  const s = byKey.get(key);
  if (!s) continue;                 // модель придумала сессию — игнор
  if (seenKeys.has(s.key)) continue; // один вердикт на сессию, первый выигрывает
  seenKeys.add(s.key);
  let state = STATES.includes(v.state) ? v.state : 'working';
  let reason = String(v.reason || '').slice(0, 300);
  if (s.minutes_since_last < FRESH_MIN) {
    // БЕЗУСЛОВНО (ревью Sol): свежая активность = working, ложная
    // «ожидающая» вреднее опоздавшей заглушки
    state = 'working'; reason = 'активность свежее порога (оверрайд кода)';
  }
  states.push({ key: s.key, state, reason });
  if (state === 'waiting_silent' && typeof v.question === 'string' && v.question.trim()) {
    stubs.push({
      session: s.key, question: v.question.trim().slice(0, 300),
      gist: typeof v.gist === 'string' ? v.gist.trim().slice(0, 400) : '',
    });
  }
}

if (DRY) {
  console.log(JSON.stringify({ states, stubs }, null, 2));
  process.exit(0);
}

if (res.used_fallback)
  hub.post({ from: 'watchdog', kind: 'error',
    text: `тик спасён фолбэком (основная модель: ${res.used_fallback})` });
hub.setWatchStates(states); // полный снапшот тика: пропавшие сессии уходят из watch
for (const st of stubs) {
  // Фингерпринт заглушки — СЕССИЯ, не текст вопроса (ревью Sol 09.08):
  // модель на каждом тике перефразирует, и дедуп по тексту плодил бы
  // blocking-заглушки. Инвариант: не больше одной живой inferred-заглушки
  // на сессию; отменённую человеком не пересоздаём, пока сессия не дала
  // НОВОЙ активности после отмены.
  try {
    const live = hub.asks({ session: st.session }).asks
      .filter((a) => a.wave === 'watchdog-inferred');
    if (live.length) continue;
    const cancelled = hub.asks({ session: st.session, status: 'cancelled' }).asks
      .filter((a) => a.wave === 'watchdog-inferred').at(-1);
    if (cancelled) {
      const s = byKey.get(st.session);
      const lastActivity = Date.now() - (s ? s.minutes_since_last * 60000 : 0);
      // момент ОТМЕНЫ, не создания ask (ревью Sol r2): активность между
      // созданием и отменой не должна воскрешать снятую человеком заглушку
      const cancelledAt = new Date(cancelled.cancelled_ts || cancelled.ts).getTime();
      if (cancelledAt >= lastActivity) continue;
    }
    hub.ask({
      session: st.session,
      question: st.question,
      type: 'text',
      // суть из хвоста транскрипта — вперёд, служебное примечание — хвостом:
      // человек должен понять вопрос из карточки, не открывая сессию
      // (разбор CTO 25.08: заглушки «нехуя не понятны»)
      context: (st.gist ? st.gist + '\n' : '')
        + '[надзиратель: сессия задала вопрос в чате, но ask не оформила — снято с хвоста транскрипта. Ответ доедет pull-ом или подъёмом новой сессии.]',
      wave: 'watchdog-inferred',
      urgency: 'blocking',
    });
  } catch {}
}
console.log(`watchdog: состояний ${states.length}, заглушек ${stubs.length}`);
