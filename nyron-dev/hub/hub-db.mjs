/**
 * hub-db.mjs — хранилище будки на SQLite (node:sqlite, zero-deps).
 *
 * Замена связки messages.jsonl + locks.json + merge-queue.json + mkdir-спинлок.
 * SQLite = single-writer, транзакции атомарны — спинлок не нужен. База лежит в
 * <HUB_DIR>/hub.db (WAL: параллельные сессии читают, не блокируя писателя).
 *
 * Ключевое отличие от JSONL: курсор чтения ЖИВЁТ В БАЗЕ (таблица cursors), а
 * не в памяти сессии. Поэтому «смерть» консьюмера курсор не теряет — новый
 * процесс с тем же именем дочитывает ровно с того места, где встал прежний.
 * Эхо (свои сообщения отправитель не видит) реализовано архитектурно фильтром
 * `sender != agent` прямо в SELECT.
 *
 * Схема:
 *   messages(seq PK AUTOINCREMENT, id, ts, sender, recipient, ticket, wave, text,
 *            kind, host)                           — kind='error' — машинный канал
 *   cursors(consumer PK, last_seq)                 — курсор чтения per-agent
 *   locks(path PK, agent, ticket, ts, expires_ts, exclusive)
 *   merge_queue(pos PK AUTOINCREMENT, repo, agent, branch, ticket, ts)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Штамп базы (repo@sha[+dirty] @time) — считается ЗДЕСЬ, в слое записи,
// чтобы КАЖДЫЙ producer (сервер, error-report, будущие) штамповал сообщения
// автоматически (ревью Sol 09.08: канал ошибок ходил мимо штампа). Дорогая
// часть (git) кэшируется на 5 с и укладывается в два коротких вызова с
// таймаутом: подвисший git не блокирует stdio-сервер. Имя репо — по
// git-common-dir: у linked worktree это основной чекаут, а не каталог
// worktree, иначе сессии одного репо получали бы разные метки.
let stampCache = { at: 0, prefix: null };
export function computeStamp() {
  const now = Date.now();
  if (now - stampCache.at >= 5000) {
    let prefix = null;
    try {
      const opts = { stdio: ['ignore', 'pipe', 'ignore'], timeout: 800 };
      const [top, common, sha] = execSync(
        'git rev-parse --show-toplevel --git-common-dir --short HEAD', opts)
        .toString().trim().split('\n');
      const commonAbs = path.resolve(top, common);
      const repo = path.basename(
        path.basename(commonAbs) === '.git' ? path.dirname(commonAbs) : commonAbs);
      let dirty = '';
      try {
        dirty = execSync('git status --porcelain', opts).toString().trim() ? '+dirty' : '';
      } catch { /* dirty неизвестен — не срываем штамп */ }
      prefix = `${repo}@${sha}${dirty}`;
    } catch { prefix = null; } // не git-репо / git недоступен — честный null
    stampCache = { at: now, prefix };
  }
  return stampCache.prefix ? `${stampCache.prefix} @${new Date().toISOString()}` : null;
}

const LOCK_TTL_MIN_DEFAULT = 240;

// Типы сообщений. Обычный трафик агентов — KIND_MSG; KIND_ERROR — машинный
// канал ошибок хуков и скиллов (STOVP-41): те же сообщения, но адресованы не
// агентам, а разбору процесса, и в обычное чтение шины не примешиваются.
const KIND_MSG = 'msg';
const KIND_ERROR = 'error';
const ERROR_RECIPIENT = 'errors';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT,
  ts        TEXT,
  sender    TEXT,
  recipient TEXT,
  ticket    TEXT,
  wave      TEXT,
  text      TEXT,
  kind      TEXT,
  host      TEXT
);
CREATE TABLE IF NOT EXISTS cursors (
  consumer TEXT PRIMARY KEY,
  last_seq INTEGER
);
CREATE TABLE IF NOT EXISTS locks (
  path       TEXT PRIMARY KEY,
  agent      TEXT,
  ticket     TEXT,
  ts         TEXT,
  expires_ts INTEGER,
  exclusive  INTEGER
);
CREATE TABLE IF NOT EXISTS merge_queue (
  pos    INTEGER PRIMARY KEY AUTOINCREMENT,
  repo   TEXT,
  agent  TEXT,
  branch TEXT,
  ticket TEXT,
  ts     TEXT
);
CREATE TABLE IF NOT EXISTS watch_states (
  key         TEXT PRIMARY KEY,
  state       TEXT,
  reason      TEXT,
  observed_at TEXT
);
CREATE TABLE IF NOT EXISTS asks (
  id            TEXT PRIMARY KEY,
  ts            TEXT,
  session       TEXT,
  ask_type      TEXT,
  question      TEXT,
  options       TEXT,
  context       TEXT,
  ticket        TEXT,
  wave          TEXT,
  stamp         TEXT,
  urgency       TEXT,
  status        TEXT,
  decision      TEXT,
  decided_by    TEXT,
  decided_ts    TEXT,
  delivered_ts  TEXT,
  acked_ts      TEXT,
  superseded_by TEXT,
  cancel_reason TEXT
);
`;

// ---------- пути (та же семантика, что была в server.mjs) ----------

function normPath(p) {
  return path.normalize(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
}
function pathsOverlap(a, b) {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

// строка messages → внешний формат сообщения (sender→from, recipient→to),
// чтобы ответ тулзов совпадал со старым JSONL-форматом (волны на нём)
function fmtMsg(r) {
  const m = { id: r.id, ts: r.ts, from: r.sender, to: r.recipient,
    ticket: r.ticket, wave: r.wave, text: r.text };
  // kind/host отдаём только у машинных событий: у обычных сообщений форма
  // ответа остаётся прежней (волны разбирают её как раньше)
  if (r.kind && r.kind !== KIND_MSG) { m.kind = r.kind; m.host = r.host || null; }
  if (r.stamp) m.stamp = r.stamp;
  return m;
}
// строка asks → внешний формат (options из JSON обратно в массив)
function fmtAsk(r) {
  if (!r) return null;
  const a = { id: r.id, ts: r.ts, session: r.session, type: r.ask_type,
    question: r.question, context: r.context, ticket: r.ticket, wave: r.wave,
    stamp: r.stamp, urgency: r.urgency, status: r.status };
  try { a.options = r.options ? JSON.parse(r.options) : null; } catch { a.options = null; }
  if (r.decision != null) { a.decision = r.decision; a.decided_by = r.decided_by; a.decided_ts = r.decided_ts; }
  if (r.delivered_ts) a.delivered_ts = r.delivered_ts;
  if (r.acked_ts) a.acked_ts = r.acked_ts;
  if (r.superseded_by) a.superseded_by = r.superseded_by;
  if (r.cancel_reason) a.cancel_reason = r.cancel_reason;
  return a;
}
function fmtLock(l) {
  return { agent: l.agent, path: l.path, ticket: l.ticket, ts: l.ts, expires: l.expires_ts };
}

export class HubDb {
  constructor(hubDir) {
    fs.mkdirSync(hubDir, { recursive: true });
    this.hubDir = hubDir;
    this.dbPath = path.join(hubDir, 'hub.db');
    // timeout — ждать освобождения блокировки, а не падать SQLITE_BUSY: под
    // конкурентной записью из нескольких сессий иначе теряются вставки.
    this.db = new DatabaseSync(this.dbPath, { timeout: 8000 });
    // busy_timeout — ПЕРВЫМ, до любых прагм.
    this.db.exec('PRAGMA busy_timeout = 8000');
    // Конверсия delete→WAL на свежесозданной базе гонится между процессами, и
    // busy-handler эту ветку НЕ покрывает: параллельный старт двух сессий ронял
    // один из процессов SQLITE_BUSY (терялась вставка; баг пойман psylia на
    // 0.6.0). Ретраим конверсию сами; после первого успеха journal_mode
    // персистентен и ветка становится no-op.
    for (let attempt = 0; ; attempt++) {
      try { this.db.exec('PRAGMA journal_mode = WAL'); break; }
      catch (e) {
        if (attempt >= 40) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    this.db.exec(SCHEMA);
    // База могла быть создана прежней версией плагина — дотягиваем колонки
    // (у SQLite нет ADD COLUMN IF NOT EXISTS, смотрим pragma).
    this.#ensureColumn('messages', 'kind');
    this.#ensureColumn('messages', 'host');
    this.#ensureColumn('messages', 'stamp');
    this.#migrateFromJsonl();
  }

  #ensureColumn(table, col) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) {
      // check-then-ALTER гонится между параллельно стартующими процессами
      // (обновление плагина под живыми сессиями): второй получает
      // duplicate column — это НЕ ошибка, колонка уже есть (ревью Sol 09.08).
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`); }
      catch (e) { if (!/duplicate column/i.test(String(e?.message || e))) throw e; }
    }
  }

  // Одноразовый импорт из старого JSONL-формата: если база пуста И рядом лежит
  // messages.jsonl — тянем последние 500 строк (sender = поле from старого
  // формата), затем старые файлы НЕ удаляем, а переименовываем в *.legacy.
  #migrateFromJsonl() {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    const jsonl = path.join(this.hubDir, 'messages.jsonl');
    if (count > 0 || !fs.existsSync(jsonl)) return;

    let lines = [];
    try {
      lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean).slice(-500);
    } catch { return; }

    const ins = this.db.prepare(
      'INSERT INTO messages(id,ts,sender,recipient,ticket,wave,text) VALUES(?,?,?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const l of lines) {
        try {
          const m = JSON.parse(l);
          ins.run(m.id || `${Date.now()}-mig`, m.ts || new Date().toISOString(),
            m.from || m.sender || 'unknown', m.to || m.recipient || 'all',
            m.ticket || null, m.wave || null, m.text ?? '');
        } catch {}
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // legacy-переименование (не удаляем)
    for (const f of ['messages.jsonl', 'locks.json', 'merge-queue.json']) {
      const p = path.join(this.hubDir, f);
      try { if (fs.existsSync(p)) fs.renameSync(p, p + '.legacy'); } catch {}
    }
  }

  // ---------- сообщения ----------

  // kind='error' — машинное событие: адресат по умолчанию не 'all', а
  // 'errors' (иначе ошибка разбудила бы вотчеры всех сессий), и в запись
  // добавляется машина — по ней в разборе видно, у кого именно ломается.
  post({ from, text, to, ticket, wave, kind, host, stamp }) {
    if (stamp === undefined) stamp = computeStamp();
    const isErr = kind === KIND_ERROR;
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(), from, to: to || (isErr ? ERROR_RECIPIENT : 'all'),
      ticket: ticket || null, wave: wave || null, text };
    const rowKind = kind || KIND_MSG;
    const rowHost = host || (isErr ? os.hostname() : null);
    this.db.prepare(
      'INSERT INTO messages(id,ts,sender,recipient,ticket,wave,text,kind,host,stamp) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(msg.id, msg.ts, msg.from, msg.to, msg.ticket, msg.wave, msg.text, rowKind, rowHost, stamp || null);
    if (isErr) { msg.kind = rowKind; msg.host = rowHost; }
    if (stamp) msg.stamp = stamp;
    return msg;
  }

  // ---------- ask/decision — автомат запросов на решение ----------
  //
  // Спека: docs/specs/2026-08-08-morda-pult.md («Правки по ревью Sol»).
  // Состояния: open → answered → (delivered) → acknowledged; выходы —
  // cancelled (автор снял) и superseded (заменён новым). Идемпотентность:
  // повторный decide НЕ перезаписывает первое решение (двойной клик, гонка
  // двух людей); повторный ask с тем же вопросом НЕ плодит второй open.
  // delivered — шаг будильника (этап 3): при pull-заборе сессия ack'ает
  // прямо из answered, оба пути легальны.

  ask({ session, question, type, options, context, ticket, wave, urgency, stamp, supersedes }) {
    if (stamp === undefined) stamp = computeStamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Дедуп по ЖИВЫМ статусам, не только open (ревью Sol 09.08):
      // воскресшая сессия переспрашивает тот же вопрос — она должна получить
      // СУЩЕСТВУЮЩИЙ ask (с решением, если оно уже есть) и забрать его через
      // ack, а не плодить второй open. Новый цикл начинается только после
      // acknowledged/cancelled/superseded.
      const dup = this.db.prepare(
        "SELECT * FROM asks WHERE session=? AND question=? AND status IN ('open','answered','delivered') ORDER BY ts DESC")
        .get(session, question);
      if (dup) { this.db.exec('COMMIT'); return { ask: fmtAsk(dup), deduped: true }; }
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const ts = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO asks(id,ts,session,ask_type,question,options,context,ticket,wave,stamp,urgency,status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'open')`)
        .run(id, ts, session, type || 'choice', question,
          options ? JSON.stringify(options) : null, context || null,
          ticket || null, wave || null, stamp || null, urgency || 'idle');
      let superseded_applied;
      if (supersedes) {
        // Гасится ТОЛЬКО свой открытый ask: answered/delivered несут
        // неврученное решение — их терять нельзя (ревью Sol 09.08), чужие —
        // не наша собственность. Не применилось — честный флаг, не молчание.
        superseded_applied = this.db.prepare(
          "UPDATE asks SET status='superseded', superseded_by=? WHERE id=? AND status='open' AND session=?")
          .run(id, supersedes, session).changes > 0;
      }
      const row = this.db.prepare('SELECT * FROM asks WHERE id=?').get(id);
      this.db.exec('COMMIT');
      const out = { ask: fmtAsk(row), deduped: false };
      if (supersedes) out.superseded_applied = superseded_applied;
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  asks({ session, status, ticket, limit = 50 } = {}) {
    limit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    // Pull сессией своих решённых = ФАКТ ДОСТАВКИ (ревью Sol 09.08: pull
    // фиксируется явно, а не размывает автомат): answered атомарно →
    // delivered, и выдаются оба статуса — повторный pull после смерти
    // сессии видит то же решение, пока не ack'нет.
    if (session && status === 'answered') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const ts = new Date().toISOString();
        this.db.prepare(
          "UPDATE asks SET status='delivered', delivered_ts=? WHERE session=? AND status='answered'")
          .run(ts, session);
        const rows = this.db.prepare(
          "SELECT * FROM asks WHERE session=? AND status='delivered' ORDER BY ts").all(session);
        this.db.exec('COMMIT');
        return { asks: rows.slice(-limit).map(fmtAsk) };
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    let rows = this.db.prepare('SELECT * FROM asks ORDER BY ts').all();
    if (session) rows = rows.filter((r) => r.session === session);
    if (ticket) rows = rows.filter((r) => r.ticket === ticket);
    // без явного статуса отдаём живые: ждут человека (open) или сессию
    // (answered/delivered — решено, не подтверждено)
    rows = status
      ? rows.filter((r) => r.status === status)
      : rows.filter((r) => ['open', 'answered', 'delivered'].includes(r.status));
    return { asks: rows.slice(-limit).map(fmtAsk) };
  }

  decide({ ask_id, decision, by }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      if (!row) throw new Error(`ask не найден: ${ask_id}`);
      if (row.status === 'cancelled' || row.status === 'superseded')
        throw new Error(`ask ${ask_id} в статусе ${row.status} — решать нечего`);
      if (row.status !== 'open') {
        // идемпотентность: решение уже есть — возвращаем ПЕРВОЕ, не трогая
        this.db.exec('COMMIT');
        return { ask: fmtAsk(row), already_decided: true };
      }
      this.db.prepare(
        "UPDATE asks SET status='answered', decision=?, decided_by=?, decided_ts=? WHERE id=?")
        .run(String(decision), by || 'unknown', new Date().toISOString(), ask_id);
      const upd = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      this.db.exec('COMMIT');
      return { ask: fmtAsk(upd), already_decided: false };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  markDelivered({ ask_id }) {
    const n = this.db.prepare(
      "UPDATE asks SET status='delivered', delivered_ts=? WHERE id=? AND status='answered'")
      .run(new Date().toISOString(), ask_id).changes;
    const row = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
    if (!row) throw new Error(`ask не найден: ${ask_id}`);
    return { ask: fmtAsk(row), delivered_now: n > 0 };
  }

  ack({ ask_id, by }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      if (!row) throw new Error(`ask не найден: ${ask_id}`);
      if (row.status === 'acknowledged') {
        this.db.exec('COMMIT');
        return { ask: fmtAsk(row), already_acked: true };
      }
      if (row.status !== 'answered' && row.status !== 'delivered')
        throw new Error(`ack из статуса ${row.status} невозможен — решения ещё нет`);
      this.db.prepare(
        "UPDATE asks SET status='acknowledged', acked_ts=? WHERE id=?")
        .run(new Date().toISOString(), ask_id);
      const upd = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      this.db.exec('COMMIT');
      return { ask: fmtAsk(upd), already_acked: false };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  cancelAsk({ ask_id, by, reason }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      if (!row) throw new Error(`ask не найден: ${ask_id}`);
      if (row.status !== 'open')
        throw new Error(`cancel из статуса ${row.status} невозможен: решение уже есть — забери его hub_ack (отмена решённого теряла бы неврученный ответ)`);
      this.db.prepare(
        "UPDATE asks SET status='cancelled', cancel_reason=? WHERE id=?")
        .run(reason ? `${by || 'unknown'}: ${reason}` : (by || 'unknown'), ask_id);
      const upd = this.db.prepare('SELECT * FROM asks WHERE id=?').get(ask_id);
      this.db.exec('COMMIT');
      return { ask: fmtAsk(upd) };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- состояния сессий (пишет надзиратель, этап 2 морды) ----------

  setWatchStates(list) {
    const up = this.db.prepare(
      `INSERT INTO watch_states(key,state,reason,observed_at) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET state=excluded.state, reason=excluded.reason, observed_at=excluded.observed_at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ts = new Date().toISOString();
      for (const s of list) up.run(String(s.key), String(s.state), s.reason || null, ts);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  watchStates() {
    return this.db.prepare('SELECT * FROM watch_states ORDER BY state, key').all();
  }

  openAsks(limit = 10) {
    // блокирующие первыми, внутри — старые сверху (дольше всех ждут)
    const rows = this.db.prepare(
      "SELECT * FROM asks WHERE status='open' ORDER BY CASE urgency WHEN 'blocking' THEN 0 ELSE 1 END, ts LIMIT ?")
      .all(limit);
    return rows.map(fmtAsk);
  }

  // agent задан → курсорное чтение (переживает смерть сессии, эхо отфильтровано);
  // без agent → legacy-режим по since_id (совместимость со старыми вызовами).
  // kind задан (чтение машинного канала) → курсор НЕ трогаем и читаем всю
  // историю: разбор ошибок не имеет права съесть непрочитанные сообщения волны.
  read({ agent, since_id, to, from, wave, ticket, kind, limit = 50 }) {
    let rows;
    if (agent && !kind) {
      // SELECT кандидатов и сдвиг курсора — в одной транзакции: снапшот WAL
      // даёт согласованность, чужой INSERT между шагами курсор не проскочит.
      this.db.exec('BEGIN');
      try {
        const cur = this.db.prepare('SELECT last_seq FROM cursors WHERE consumer=?').get(agent);
        const last = cur ? cur.last_seq : 0;
        rows = this.db.prepare(
          "SELECT * FROM messages WHERE seq > ? AND sender != ? AND recipient IN ('all', ?) ORDER BY seq")
          .all(last, agent, agent);
        const maxRow = this.db.prepare('SELECT MAX(seq) AS m FROM messages').get();
        const newMax = maxRow.m ?? last;
        this.db.prepare(
          'INSERT INTO cursors(consumer,last_seq) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET last_seq=excluded.last_seq')
          .run(agent, newMax);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } else {
      rows = this.db.prepare('SELECT * FROM messages ORDER BY seq').all();
      if (since_id) {
        const i = rows.findIndex((r) => r.id === since_id);
        if (i >= 0) rows = rows.slice(i + 1);
      }
    }
    // Без явного kind машинные ошибки в выдачу не попадают — старые вызовы
    // видят ровно то же, что видели раньше.
    rows = kind
      ? rows.filter((r) => (r.kind || KIND_MSG) === kind)
      : rows.filter((r) => (r.kind || KIND_MSG) !== KIND_ERROR);
    if (to) rows = rows.filter((r) => r.recipient === to || r.recipient === 'all');
    if (from) rows = rows.filter((r) => r.sender === from);
    if (wave) rows = rows.filter((r) => r.wave === wave);
    if (ticket) rows = rows.filter((r) => r.ticket === ticket);
    const messages = rows.slice(-limit).map(fmtMsg);
    return { messages, last_id: messages.at(-1)?.id ?? since_id ?? null };
  }

  // Сводка — только трафик агентов: машинные ошибки в чат сессии не лезут,
  // их читают отдельным hub_read(kind='error').
  recent(limit = 15) {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE kind IS NULL OR kind != ? ORDER BY seq DESC LIMIT ?")
      .all(KIND_ERROR, limit);
    return rows.reverse().map(fmtMsg);
  }

  // ---------- брони ----------

  activeLocks() {
    const now = Date.now();
    this.db.prepare('DELETE FROM locks WHERE expires_ts <= ?').run(now);
    return this.db.prepare('SELECT * FROM locks').all().map(fmtLock);
  }

  lock({ agent, paths, ticket, ttl_min = LOCK_TTL_MIN_DEFAULT }) {
    const now = Date.now();
    this.db.prepare('DELETE FROM locks WHERE expires_ts <= ?').run(now);
    const active = this.db.prepare('SELECT * FROM locks').all();
    const want = paths.map(normPath);
    const conflicts = active.filter(
      (l) => l.agent !== agent && want.some((p) => pathsOverlap(p, l.path)));
    if (conflicts.length) return { ok: false, conflicts: conflicts.map(fmtLock) };
    // свои старые брони на пересекающиеся пути заменяем
    const del = this.db.prepare('DELETE FROM locks WHERE path = ?');
    for (const l of active)
      if (l.agent === agent && want.some((p) => pathsOverlap(p, l.path))) del.run(l.path);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO locks(path,agent,ticket,ts,expires_ts,exclusive) VALUES(?,?,?,?,?,1)');
    const tsIso = new Date(now).toISOString();
    const expires = now + ttl_min * 60_000;
    const locked = [];
    for (const p of want) {
      ins.run(p, agent, ticket || null, tsIso, expires);
      locked.push({ agent, path: p, ticket: ticket || null, ts: tsIso, expires });
    }
    return { ok: true, locked };
  }

  unlock({ agent, paths }) {
    const mine = this.db.prepare('SELECT * FROM locks WHERE agent = ?').all(agent);
    const norm = paths ? paths.map(normPath) : null;
    const removed = mine.filter((l) => !norm || norm.some((p) => pathsOverlap(p, l.path)));
    const del = this.db.prepare('DELETE FROM locks WHERE path = ?');
    for (const l of removed) del.run(l.path);
    return { removed: removed.map(fmtLock) };
  }

  // ---------- очередь мержа ----------

  #queueOf(repo) {
    return this.db.prepare(
      'SELECT agent,branch,ticket,ts FROM merge_queue WHERE repo=? ORDER BY pos').all(repo);
  }

  mergeJoin({ agent, repo, branch, ticket }) {
    const exists = this.db.prepare(
      'SELECT 1 FROM merge_queue WHERE repo=? AND branch=?').get(repo, branch);
    if (!exists)
      this.db.prepare(
        'INSERT INTO merge_queue(repo,agent,branch,ticket,ts) VALUES(?,?,?,?,?)')
        .run(repo, agent, branch, ticket || null, new Date().toISOString());
    const queue = this.#queueOf(repo);
    const position = queue.findIndex((e) => e.branch === branch);
    return { repo, branch, position, is_head: position === 0, queue };
  }

  mergeLeave({ repo, branch }) {
    this.db.prepare('DELETE FROM merge_queue WHERE repo=? AND branch=?').run(repo, branch);
    const queue = this.#queueOf(repo);
    return { repo, removed: branch, new_head: queue[0] || null };
  }

  mergeQueues() {
    const rows = this.db.prepare(
      'SELECT repo,agent,branch,ticket,ts FROM merge_queue ORDER BY pos').all();
    const queues = {};
    for (const r of rows)
      (queues[r.repo] ||= []).push({ agent: r.agent, branch: r.branch, ticket: r.ticket, ts: r.ts });
    return queues;
  }
}
