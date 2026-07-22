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
 *   messages(seq PK AUTOINCREMENT, id, ts, sender, recipient, ticket, wave, text)
 *   cursors(consumer PK, last_seq)                 — курсор чтения per-agent
 *   locks(path PK, agent, ticket, ts, expires_ts, exclusive)
 *   merge_queue(pos PK AUTOINCREMENT, repo, agent, branch, ticket, ts)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_TTL_MIN_DEFAULT = 240;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT,
  ts        TEXT,
  sender    TEXT,
  recipient TEXT,
  ticket    TEXT,
  wave      TEXT,
  text      TEXT
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
  return { id: r.id, ts: r.ts, from: r.sender, to: r.recipient,
    ticket: r.ticket, wave: r.wave, text: r.text };
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
    this.#migrateFromJsonl();
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

  post({ from, text, to, ticket, wave }) {
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(), from, to: to || 'all',
      ticket: ticket || null, wave: wave || null, text };
    this.db.prepare(
      'INSERT INTO messages(id,ts,sender,recipient,ticket,wave,text) VALUES(?,?,?,?,?,?,?)')
      .run(msg.id, msg.ts, msg.from, msg.to, msg.ticket, msg.wave, msg.text);
    return msg;
  }

  // agent задан → курсорное чтение (переживает смерть сессии, эхо отфильтровано);
  // без agent → legacy-режим по since_id (совместимость со старыми вызовами).
  read({ agent, since_id, to, from, wave, ticket, limit = 50 }) {
    let rows;
    if (agent) {
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
    if (to) rows = rows.filter((r) => r.recipient === to || r.recipient === 'all');
    if (from) rows = rows.filter((r) => r.sender === from);
    if (wave) rows = rows.filter((r) => r.wave === wave);
    if (ticket) rows = rows.filter((r) => r.ticket === ticket);
    const messages = rows.slice(-limit).map(fmtMsg);
    return { messages, last_id: messages.at(-1)?.id ?? since_id ?? null };
  }

  recent(limit = 15) {
    const rows = this.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(limit);
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
