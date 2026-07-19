#!/usr/bin/env node
/**
 * nyron-hub — «будка» координации агентов nyron-dev.
 *
 * Локальный MCP stdio-сервер (zero-deps, чистый Node 18+). Каждая сессия
 * Claude Code поднимает свой процесс, но состояние общее — файлы в
 * <PROJECT_ROOT>/.nyron-hub/ (или $NYRON_HUB_DIR). Джиру будка НЕ трогает:
 * долгоживущее (задачи, статусы, брифы, отчёты) — в Jira, быстрое и
 * служебное (сообщения «взял/готово», бронь файлов, очередь мержа) — здесь.
 *
 * Тулзы:
 *   hub_status        — сводка: сообщения, брони, очереди мержа
 *   hub_post          — отправить сообщение в шину
 *   hub_read          — прочитать сообщения (фильтры + курсор since_id)
 *   hub_lock          — забронировать файлы/каталоги
 *   hub_unlock        — снять свои брони
 *   hub_merge_join    — встать в очередь мержа репо
 *   hub_merge_leave   — выйти из очереди (после мержа или отказа)
 *
 * Конкурентность: read-modify-write JSON-файлов — под mkdir-спинлоком,
 * сообщения — append-only JSONL (атомарно для коротких строк с O_APPEND).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';

// Якорь будки — КОРЕНЬ ОСНОВНОГО чекаута проекта, не cwd: сессии в linked
// git-worktree (чипы «fresh worktree») иначе получают изолированную будку и
// сообщения расходятся по разным файлам (баг обкатки 19.07). git-common-dir
// у любого worktree указывает на .git основного чекаута.
function resolveHubDir() {
  if (process.env.NYRON_HUB_DIR) return process.env.NYRON_HUB_DIR;
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (common && path.basename(common) === '.git')
      return path.join(path.dirname(common), '.nyron-hub');
  } catch {}
  return path.join(process.cwd(), '.nyron-hub');
}

const HUB_DIR = resolveHubDir();
const MSG_FILE = path.join(HUB_DIR, 'messages.jsonl');
const LOCKS_FILE = path.join(HUB_DIR, 'locks.json');
const QUEUE_FILE = path.join(HUB_DIR, 'merge-queue.json');
const SPINLOCK = path.join(HUB_DIR, '.spinlock');
const LOCK_TTL_MIN_DEFAULT = 240;
const MSG_KEEP = 2000; // строк JSONL держим, старое обрезается

fs.mkdirSync(HUB_DIR, { recursive: true });

// ---------- примитивы состояния ----------

function withSpinlock(fn) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(SPINLOCK);
      break;
    } catch {
      // чужой спинлок старше 30с — умер, забираем
      try {
        const st = fs.statSync(SPINLOCK);
        if (Date.now() - st.mtimeMs > 30_000) { fs.rmdirSync(SPINLOCK); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('hub busy: спинлок не освободился за 10с');
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 100); // sleep 100ms без busy-loop
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(SPINLOCK); } catch {} }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function normPath(p) {
  return path.normalize(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
}

function pathsOverlap(a, b) {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function activeLocks() {
  const now = Date.now();
  const data = readJson(LOCKS_FILE, { locks: [] });
  const alive = data.locks.filter((l) => l.expires > now);
  if (alive.length !== data.locks.length) writeJson(LOCKS_FILE, { locks: alive });
  return alive;
}

// ---------- тулзы ----------

const tools = {
  hub_status: {
    description:
      'Сводка будки: последние сообщения, активные брони файлов, очереди мержа по репо. Вызывать первым делом при входе агента в работу.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      return withSpinlock(() => {
        const locks = activeLocks();
        const queues = readJson(QUEUE_FILE, { queues: {} }).queues;
        let messages = [];
        try {
          messages = fs.readFileSync(MSG_FILE, 'utf8').trim().split('\n').filter(Boolean)
            .slice(-15).map((l) => JSON.parse(l));
        } catch {}
        return { hub_dir: HUB_DIR, recent_messages: messages, locks, merge_queues: queues };
      });
    },
  },

  hub_post: {
    description:
      'Отправить сообщение в общую шину агентов («взял DEV-421», «ветка готова», «блокер: …»). Быстрый служебный канал МИМО Jira; долгоживущее (брифы, отчёты, вердикты) — по-прежнему комментами в Jira.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'кто пишет: wave-3, dispatcher, intake…' },
        text: { type: 'string', description: 'текст сообщения, коротко' },
        to: { type: 'string', description: 'адресат (опц.): dispatcher, wave-2, all' },
        ticket: { type: 'string', description: 'DEV-XXX (опц.)' },
        wave: { type: 'string', description: 'метка волны (опц.)' },
      },
      required: ['from', 'text'],
      additionalProperties: false,
    },
    handler({ from, text, to, ticket, wave }) {
      const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ts: new Date().toISOString(), from, to: to || 'all', ticket: ticket || null,
        wave: wave || null, text };
      fs.appendFileSync(MSG_FILE, JSON.stringify(msg) + '\n');
      // компакция: не даём файлу расти бесконечно
      withSpinlock(() => {
        try {
          const lines = fs.readFileSync(MSG_FILE, 'utf8').trim().split('\n');
          if (lines.length > MSG_KEEP * 1.2)
            fs.writeFileSync(MSG_FILE, lines.slice(-MSG_KEEP).join('\n') + '\n');
        } catch {}
      });
      return { posted: msg };
    },
  },

  hub_read: {
    description:
      'Прочитать сообщения шины. Курсор since_id — отдавать id последнего виденного сообщения, вернутся только новые. Фильтры: to (адресат, включая all), wave, ticket, from.',
    inputSchema: {
      type: 'object',
      properties: {
        since_id: { type: 'string', description: 'id последнего виденного сообщения' },
        to: { type: 'string' }, from: { type: 'string' },
        wave: { type: 'string' }, ticket: { type: 'string' },
        limit: { type: 'number', description: 'default 50' },
      },
      additionalProperties: false,
    },
    handler({ since_id, to, from, wave, ticket, limit = 50 }) {
      let lines = [];
      try { lines = fs.readFileSync(MSG_FILE, 'utf8').trim().split('\n').filter(Boolean); } catch {}
      let msgs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (since_id) {
        const i = msgs.findIndex((m) => m.id === since_id);
        if (i >= 0) msgs = msgs.slice(i + 1);
      }
      if (to) msgs = msgs.filter((m) => m.to === to || m.to === 'all');
      if (from) msgs = msgs.filter((m) => m.from === from);
      if (wave) msgs = msgs.filter((m) => m.wave === wave);
      if (ticket) msgs = msgs.filter((m) => m.ticket === ticket);
      return { messages: msgs.slice(-limit), last_id: msgs.at(-1)?.id ?? since_id ?? null };
    },
  },

  hub_lock: {
    description:
      'Забронировать файлы или каталоги перед правкой (пути от корня проекта, напр. ai-evolve-front/src/lib/stores). Конфликт с чужой активной бронью — отказ со списком: НЕ править эти файлы, договариваться через диспетчера. TTL по умолчанию 240 мин.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'кто бронирует (wave-3 и т.п.)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'файлы/каталоги от корня проекта' },
        ticket: { type: 'string' },
        ttl_min: { type: 'number' },
      },
      required: ['agent', 'paths'],
      additionalProperties: false,
    },
    handler({ agent, paths, ticket, ttl_min = LOCK_TTL_MIN_DEFAULT }) {
      return withSpinlock(() => {
        const locks = activeLocks();
        const want = paths.map(normPath);
        const conflicts = locks.filter(
          (l) => l.agent !== agent && want.some((p) => pathsOverlap(p, l.path)));
        if (conflicts.length) return { ok: false, conflicts };
        const now = Date.now();
        const fresh = want.map((p) => ({ agent, path: p, ticket: ticket || null,
          ts: new Date(now).toISOString(), expires: now + ttl_min * 60_000 }));
        // свои старые брони на те же пути заменяем
        const rest = locks.filter((l) => !(l.agent === agent && want.some((p) => pathsOverlap(p, l.path))));
        writeJson(LOCKS_FILE, { locks: [...rest, ...fresh] });
        return { ok: true, locked: fresh };
      });
    },
  },

  hub_unlock: {
    description: 'Снять свои брони: все (только agent) или точечно (agent + paths). Снимать сразу после пуша ветки.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['agent'],
      additionalProperties: false,
    },
    handler({ agent, paths }) {
      return withSpinlock(() => {
        const locks = activeLocks();
        const drop = (l) => l.agent === agent &&
          (!paths || paths.map(normPath).some((p) => pathsOverlap(p, l.path)));
        const removed = locks.filter(drop);
        writeJson(LOCKS_FILE, { locks: locks.filter((l) => !drop(l)) });
        return { removed };
      });
    },
  },

  hub_merge_join: {
    description:
      'Встать в очередь мержа репозитория. Мержится ТОЛЬКО голова очереди (position 0), остальные ждут и ребейзятся на свежую основу, когда становятся головой. Ветки вливаются по одной — никаких «десять веток разом».',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        repo: { type: 'string', description: 'ai-evolve-front | ai-evolve-back | n8n | …' },
        branch: { type: 'string' },
        ticket: { type: 'string' },
      },
      required: ['agent', 'repo', 'branch'],
      additionalProperties: false,
    },
    handler({ agent, repo, branch, ticket }) {
      return withSpinlock(() => {
        const data = readJson(QUEUE_FILE, { queues: {} });
        const q = (data.queues[repo] ||= []);
        if (!q.some((e) => e.branch === branch))
          q.push({ agent, branch, ticket: ticket || null, ts: new Date().toISOString() });
        writeJson(QUEUE_FILE, data);
        const position = q.findIndex((e) => e.branch === branch);
        return { repo, branch, position, is_head: position === 0, queue: q };
      });
    },
  },

  hub_merge_leave: {
    description: 'Выйти из очереди мержа (ветка влита или снята). Следующий в очереди становится головой.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['repo', 'branch'],
      additionalProperties: false,
    },
    handler({ repo, branch }) {
      return withSpinlock(() => {
        const data = readJson(QUEUE_FILE, { queues: {} });
        const q = data.queues[repo] || [];
        data.queues[repo] = q.filter((e) => e.branch !== branch);
        writeJson(QUEUE_FILE, data);
        const head = data.queues[repo][0] || null;
        return { repo, removed: branch, new_head: head };
      });
    },
  },
};

// ---------- MCP stdio (JSON-RPC 2.0) ----------

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nyron-hub', version: '0.2.0' },
      } });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification — ответа не требует
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(
        ([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    } else if (method === 'tools/call') {
      const t = tools[params?.name];
      if (!t) throw new Error(`unknown tool: ${params?.name}`);
      const result = t.handler(params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined)
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify({ error: String(e.message || e) }) }],
        isError: true } });
  }
});
rl.on('close', () => process.exit(0));
