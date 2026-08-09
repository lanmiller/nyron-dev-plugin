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
 *   hub_status        — сводка: ВИСЯЩИЕ РЕШЕНИЯ (open_asks), сообщения,
 *                       брони, очереди мержа
 *   hub_post          — отправить сообщение в шину (штамп базы — сам)
 *   hub_read          — прочитать сообщения (курсор per-agent + фильтры;
 *                       kind='error' — машинный канал ошибок хуков/скиллов)
 *   hub_ask           — запрос на решение человеку (автомат этапа 1 морды:
 *                       open → answered → delivered → acknowledged;
 *                       идемпотентный дедуп, штамп базы)
 *   hub_asks          — список запросов; pull своих answered = доставка
 *   hub_decide        — ответить (идемпотентно: первое решение неизменно)
 *   hub_ack           — подтвердить получение решения сессией
 *   hub_ask_cancel    — снять свой открытый вопрос (причина обязательна)
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

// Штамп базы (repo@sha[+dirty] @time) считается в слое записи (hub-db:
// computeStamp, кэш 5 с) — post() и ask() штампуют сами, любым producer'ом.

// ---------- тулзы ----------

const tools = {
  hub_status: {
    description:
      'Сводка будки: последние сообщения, активные брони файлов, очереди мержа по репо. Вызывать первым делом при входе агента в работу.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler() {
      return {
        hub_dir: HUB_DIR,
        open_asks: hub.openAsks(10),
        recent_messages: hub.recent(15),
        locks: hub.activeLocks(),
        merge_queues: hub.mergeQueues(),
        watch: hub.watchStates(),
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
        kind: { type: 'string', description: "'error' — машинное событие (упал хук/скилл): пишется с машиной и временем, вотчеры и обычное чтение его не видят; по умолчанию 'msg'" },
      },
      required: ['from', 'text'],
      additionalProperties: false,
    },
    handler({ from, text, to, ticket, wave, kind }) {
      return { posted: hub.post({ from, text, to, ticket, wave, kind }) };
    },
  },

  hub_ask: {
    description:
      'Запрос на решение человеку («мержить?», «какой вариант?»). ОБЯЗАТЕЛЕН, когда сессия задала вопрос в чате и ждёт: вопрос без ask в будке — потерянная работа (канон SYSTEM.md). Вопрос — одной строкой; варианты со следствиями (отвечать можно номером); штамп базы проставится сам. Повторный ask с тем же вопросом вернёт существующий (дедуп). Ответ забирается hub_asks({session:<я>, status:"answered"}) и подтверждается hub_ack.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'кто спрашивает: wave-3, dispatcher…' },
        question: { type: 'string', description: 'ЧТО решить — одной строкой' },
        type: { type: 'string', enum: ['choice', 'confirm', 'text', 'artifact'], description: 'choice (дефолт) | confirm | text | artifact' },
        options: { type: 'array', items: { type: 'object' }, description: 'для choice: [{n, label, effect}] — 2–4 варианта со следствием в строку' },
        context: { type: 'string', description: 'контекст на один экран: что сделано, что упёрлось, почему сейчас' },
        ticket: { type: 'string' }, wave: { type: 'string' },
        urgency: { type: 'string', enum: ['blocking', 'idle'], description: "'blocking' — работа стоит | 'idle' (дефолт) — может подождать" },
        supersedes: { type: 'string', description: 'id старого ask, который этот заменяет' },
      },
      required: ['from', 'question'],
      additionalProperties: false,
    },
    handler({ from, question, type, options, context, ticket, wave, urgency, supersedes }) {
      // Контракт валидируется здесь, а не «как получится» (ревью Sol 09.08):
      // кривой ask морде нечем отобразить — лучше отказ сессии сразу.
      type = type || 'choice';
      if (!['choice', 'confirm', 'text', 'artifact'].includes(type))
        throw new Error(`type: choice | confirm | text | artifact (получен «${type}»)`);
      urgency = urgency || 'idle';
      if (!['blocking', 'idle'].includes(urgency))
        throw new Error(`urgency: blocking | idle (получен «${urgency}»)`);
      if (typeof question !== 'string')
        throw new Error('question — строка (получен ' + typeof question + ')');
      question = question.trim();
      if (!question) throw new Error('question пуст — ЧТО решить?');
      if (/[\r\n]/.test(question))
        throw new Error('question — одной строкой; детали и предысторию — в context');
      if (type === 'choice') {
        if (!Array.isArray(options) || options.length < 2 || options.length > 4)
          throw new Error('choice требует 2–4 options: [{n, label, effect}]');
        for (const o of options) {
          if (typeof o?.n !== 'number' || !Number.isInteger(o.n))
            throw new Error('option.n — целое число (номер для ответа)');
          if (typeof o?.label !== 'string' || !o.label.trim())
            throw new Error('option.label — непустая строка');
          if (o.effect != null && typeof o.effect !== 'string')
            throw new Error('option.effect — строка, если задан');
        }
      }
      if (context != null && typeof context !== 'string')
        throw new Error('context — строка');
      return hub.ask({ session: from, question, type, options, context, ticket, wave,
        urgency, supersedes });
    },
  },

  hub_asks: {
    description:
      'Список запросов на решение. Без фильтров — живые (open + answered). Сессии забирают свои ответы: hub_asks({session:"<я>", status:"answered"}) → прочитать decision → hub_ack. Морда/диспетчер смотрят open.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'фильтр: чьи ask' },
        status: { type: 'string', description: 'open | answered | delivered | acknowledged | cancelled | superseded' },
        ticket: { type: 'string' },
        limit: { type: 'number', description: 'default 50' },
      },
      additionalProperties: false,
    },
    handler(args) { return hub.asks(args || {}); },
  },

  hub_decide: {
    description:
      'Ответить на ask (человек или его доверенная сессия). Идемпотентно: если решение уже есть — вернётся ПЕРВОЕ (already_decided: true), двойной клик и гонка двух людей второго решения не рождают.',
    inputSchema: {
      type: 'object',
      properties: {
        ask_id: { type: 'string' },
        decision: { type: 'string', description: 'номер варианта или текст решения' },
        by: { type: 'string', description: 'кто решил' },
      },
      required: ['ask_id', 'decision'],
      additionalProperties: false,
    },
    handler({ ask_id, decision, by }) { return hub.decide({ ask_id, decision, by }); },
  },

  hub_ack: {
    description:
      'Подтверждение сессией: решение получено и принято в работу (answered/delivered → acknowledged). Пока ask не acknowledged, доставка считается незавершённой и будет повторяться.',
    inputSchema: {
      type: 'object',
      properties: {
        ask_id: { type: 'string' },
        by: { type: 'string', description: 'кто подтверждает (сессия-автор ask)' },
      },
      required: ['ask_id'],
      additionalProperties: false,
    },
    handler({ ask_id, by }) { return hub.ack({ ask_id, by }); },
  },

  hub_ask_cancel: {
    description:
      'Снять свой ask: вопрос отпал (нашёлся обходной путь, тикет отменён). ТОЛЬКО из open: у решённого забирают ответ через hub_ack, отмена потеряла бы неврученное решение. Причина обязательна словами.',
    inputSchema: {
      type: 'object',
      properties: {
        ask_id: { type: 'string' },
        by: { type: 'string' },
        reason: { type: 'string', description: 'почему вопрос отпал — словами, обязательно' },
      },
      required: ['ask_id', 'by', 'reason'],
      additionalProperties: false,
    },
    handler({ ask_id, by, reason }) {
      if (!String(reason ?? '').trim()) throw new Error('reason обязателен: почему вопрос отпал');
      return hub.cancelAsk({ ask_id, by, reason });
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
        kind: { type: 'string', description: "'error' — машинный канал ошибок хуков/скиллов (from = источник, host = машина); курсор при таком чтении не двигается. Без параметра ошибки в выдачу не попадают." },
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
        serverInfo: { name: 'nyron-hub', version: '0.4.0' },
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
