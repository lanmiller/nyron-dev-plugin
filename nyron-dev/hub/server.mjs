#!/usr/bin/env node
/**
 * nyron-hub — «будка» координации агентов nyron-dev.
 *
 * Локальный MCP stdio-сервер (zero-deps, чистый Node 22+). Каждая сессия
 * Claude Code поднимает свой процесс, но состояние общее — SQLite-база
 * <PROJECT_ROOT>/.nyron-hub/hub.db (или $NYRON_HUB_DIR). Джиру будка НЕ трогает:
 * долгоживущее (задачи, статусы, брифы, отчёты) — в Jira, быстрое и
 * служебное (сообщения «взял/готово», бронь файлов, очередь мержа) — здесь.
 *
 * Тулзы:
 *   hub_status        — сводка: сообщения, брони, очереди мержа
 *   hub_post          — отправить сообщение в шину
 *   hub_read          — прочитать сообщения (курсор per-agent + фильтры)
 *   hub_lock          — забронировать файлы/каталоги
 *   hub_unlock        — снять свои брони
 *   hub_merge_join    — встать в очередь мержа репо
 *   hub_merge_leave   — выйти из очереди (после мержа или отказа)
 *
 * Хранение и конкурентность — hub-db.mjs (SQLite single-writer, транзакции;
 * mkdir-спинлок и JSONL/JSON-файлы больше не используются).
 */
import { resolveHubDir } from './hub-dir.mjs';
import { HubDb } from './hub-db.mjs';

// Якорь будки — КОРЕНЬ ПРОЕКТА (каталог с .claude/nyron-dev.md), не cwd и не
// корень саб-репо: иначе сессии в независимых репо зонтика и в linked
// git-worktree получают изолированные будки и расходятся по разным файлам.
// Лестница разрешения и её обоснование — hub-dir.mjs.
const HUB_DIR = resolveHubDir();
const hub = new HubDb(HUB_DIR);

// ---------- тулзы ----------

const tools = {
  hub_status: {
    description:
      'Сводка будки: последние сообщения, активные брони файлов, очереди мержа по репо. Вызывать первым делом при входе агента в работу.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      return {
        hub_dir: HUB_DIR,
        recent_messages: hub.recent(15),
        locks: hub.activeLocks(),
        merge_queues: hub.mergeQueues(),
      };
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
      return { posted: hub.post({ from, text, to, ticket, wave }) };
    },
  },

  hub_read: {
    description:
      'Прочитать сообщения шины. Курсор per-agent: передать своё имя в agent — вернутся только НОВЫЕ с прошлого чтения (курсор в базе, переживает смерть сессии), свои сообщения отфильтрованы. Доп.фильтры: to, wave, ticket, from. Legacy: без agent — по курсору since_id.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'имя консьюмера — курсор чтения per-agent' },
        since_id: { type: 'string', description: 'legacy-курсор: id последнего виденного сообщения' },
        to: { type: 'string' }, from: { type: 'string' },
        wave: { type: 'string' }, ticket: { type: 'string' },
        limit: { type: 'number', description: 'default 50' },
      },
      additionalProperties: false,
    },
    handler(args) {
      return hub.read(args || {});
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
    handler({ agent, paths, ticket, ttl_min }) {
      return hub.lock({ agent, paths, ticket, ttl_min });
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
      return hub.unlock({ agent, paths });
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
      return hub.mergeJoin({ agent, repo, branch, ticket });
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
      return hub.mergeLeave({ repo, branch });
    },
  },
};

// ---------- MCP stdio (JSON-RPC 2.0) ----------

import readline from 'node:readline';

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
        serverInfo: { name: 'nyron-hub', version: '0.3.0' },
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
