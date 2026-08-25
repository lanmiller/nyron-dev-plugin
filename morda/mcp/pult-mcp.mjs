#!/usr/bin/env node
/**
 * pult-mcp — MCP-коннектор пульта (решение CTO 22.08: «Клод Десктоп —
 * оркестратор: попиздел — и он сам диспетчеров запускает»).
 *
 * Тонкий stdio-прокси к живому пульту http://127.0.0.1:4747 (launchd).
 * Zero-deps, каркас — nyron-dev/hub/server.mjs (вторую реализацию
 * JSON-RPC-цикла не заводим, этот — его прямой форк под async-тулы).
 *
 * ГРАНИЦЫ РУК (разбор 22.08, принято CTO; расширено 25.08):
 *  - смотреть (флот, экран), поднимать (через раннер — с гейтом паспорта),
 *    писать сессии (очередь), судить — ДА;
 *  - разбирать очередь вопросов будок (pult_asks) и отвечать/уточнять/
 *    снимать (pult_answer) — ДА (мандат CTO 25.08: постановщик осознаёт
 *    каждый вопрос, до человека доходят только понятные);
 *  - stop, резюм чужих, мерж — НЕТ: это право человека и сессий по
 *    merge_rights, модели через коннектор такие руки не выдаются;
 *  - в канон коннектор НЕ вносится аккаунтным: строгие сессии (волны,
 *    исполнители) его не видят — иерархия «постановщик → диспетчер →
 *    волны» держится механизмом strict-профиля, а не уговором.
 *
 * Регистрация (user-scope, одна на машину):
 *   claude mcp add pult -- sh <репо>/morda/mcp/run-pult.sh
 */
const PULT = process.env.MORDA_PULT_URL || 'http://127.0.0.1:4747';

async function api(method, path, body) {
  let r;
  try {
    r = await fetch(PULT + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-morda': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new Error(`пульт не отвечает на ${PULT} — подними: bash morda/install-launchd.sh (${e.message})`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `пульт ответил HTTP ${r.status}`);
  return d;
}

// сессии в ответах — только нужное оркестратору, без внутренностей реестра
function brief(s) {
  return {
    name: s.name, project: s.project, state: s.state, alive: s.alive,
    busy: s.busy, stuck: s.stuck || false, screen: s.screen,
    goal: String(s.goal || '').slice(0, 160) || null,
    mode: s.mode, mcp: s.mcp, slot: s.slot || 'основной',
    quiet_min: s.quiet_ms != null ? Math.round(s.quiet_ms / 60000) : null,
    pulse: s.pulse || null, queue: (s.queue || []).length,
    judge: s.judge?.verdict ? String(s.judge.verdict).split('\n')[0] : null,
    sessionId: s.sessionId || null,
  };
}

const tools = {
  pult_fleet: {
    description:
      'Флот CLI-сессий пульта: кто жив, занят, застрял, ждёт человека; слоты подписок. Первый вызов оркестратора — посмотреть, что уже идёт, прежде чем плодить новое.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'имя проекта пульта (psylia, nyron, stovp…); пусто — все' },
    }, additionalProperties: false },
    async handler({ project }) {
      const d = await api('GET', `/api/runner${project ? `?project=${encodeURIComponent(project)}` : ''}`);
      return {
        sessions: (d.sessions || []).map(brief),
        slots: (d.slots || []).map((s) => ({ id: s.id, label: s.label, provider: s.provider })),
      };
    },
  },

  pult_start: {
    description:
      'Поднять новую CLI-сессию через раннер пульта — с гейтом паспорта, судьёй и автопинками. Для эпика поднимай ОДНОГО диспетчера со скиллом nyron-waves — волны дальше плодит он. Слот подписки задавай, когда нужен параллельный лимит (Мариха, stovpe3tt).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'проект пульта: psylia, nyron, stovp…' },
        name: { type: 'string', description: 'имя сессии: строчные латиница/цифры/дефис' },
        goal: { type: 'string', description: 'задача первым сообщением' },
        mode: { type: 'string', description: 'auto | acceptEdits | plan | bypass (bypass — только за забором, его ставит раннер)' },
        mcp: { type: 'string', description: "'strict' — только серверы паспорта + аккаунтные канона; пусто — все серверы машины" },
        model: { type: 'string', description: 'fable | opus | sonnet | haiku (пусто — дефолт)' },
        effort: { type: 'string', description: 'low | medium | high | xhigh | max (пусто — дефолт)' },
        slot: { type: 'string', description: 'id слота подписки из pult_fleet; ПУСТО — пульт выберет сам по /usage (сначала догружает начатую подписку до 50% сессии, потом ровняет по наименее занятой) и объяснит выбор (slot_pick в ответе — перескажи его человеку)' },
      },
      required: ['project', 'name', 'goal'],
      additionalProperties: false,
    },
    async handler(a) {
      // без слота — автовыбор подписки: человек не должен думать, где лимит
      const s = await api('POST', '/api/runner', { action: 'start', slot: 'auto', ...a });
      const out = { started: s.name, state: s.state, slot: s.slot || 'основной',
        slot_pick: s.slot_pick || null, passport_warning: s.passport_warning || null };
      // режим не задан — сессия стартует С ДИАЛОГАМИ разрешений: для волн и
      // диспетчеров это простой на первом же запросе (факт 23.08 — волны
      // nyron поднялись без bypass). Говорим вызывающему прямо в ответе.
      if (!a.mode) out.warning =
        'режим не задан — сессия будет спрашивать разрешения; для волны/диспетчера передавай mode:"bypass" (+mcp:"strict")';
      return out;
    },
  },

  pult_send: {
    description:
      'Написать сессии: печатает ПРЯМО в её CLI — доезжает сразу, даже когда сессия занята (входит в текущий ход, как сообщение человека). Исключение: на экране открыт диалог/пикер — тогда текст встаёт в очередь пульта и уходит после закрытия (ответ скажет, что случилось).',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'имя сессии из pult_fleet' },
      text: { type: 'string', description: 'сообщение' },
    }, required: ['name', 'text'], additionalProperties: false },
    async handler({ name, text }) { return api('POST', '/api/runner', { action: 'inject', name, text }); },
  },

  pult_screen: {
    description: 'Живой экран tmux сессии — что она видит прямо сейчас (последние строки терминала).',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' },
      lines: { type: 'number', description: 'сколько строк снизу (дефолт 40)' },
    }, required: ['name'], additionalProperties: false },
    async handler({ name, lines }) { return api('POST', '/api/runner', { action: 'screen', name, lines }); },
  },

  pult_asks: {
    description:
      'Очередь «ждут человека»: открытые вопросы будок по всем проектам пульта (+ недоставленные решения). Постановщик разбирает её регулярно: осознай каждый вопрос, реши сам через pult_answer или донеси человеку понятным — с ссылкой на карточку в пульте.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'имя проекта пульта; пусто — все' },
    }, additionalProperties: false },
    async handler({ project }) {
      const d = await api('GET', '/api/overview');
      const projects = (d.projects || [])
        .filter((p) => !project || p.name === project)
        .map((p) => ({
          project: p.name,
          link: `http://127.0.0.1:4747/?p=${encodeURIComponent(p.name)}`,
          asks: (p.asks || [])
            .filter((a) => a.status === 'open' || a.status === 'answered' || a.status === 'delivered')
            .map((a) => ({
              id: a.id, status: a.status, urgency: a.urgency || null, ts: a.ts,
              question: a.question, context: String(a.context || '').slice(0, 400) || null,
              options: a.options || null,
              author: a.session_title || a.session || null, session: a.session || null,
              ticket: a.ticket || null,
            })),
          // ответы сессий человеку (например на встречный вопрос) — тоже входящие
          inbox: (p.inbox || []).slice(0, 10),
        }))
        .filter((p) => p.asks.length || (p.inbox && p.inbox.length));
      return { projects, note: 'status open — ждёт решения; answered/delivered — решение есть, но автор ещё не подтвердил' };
    },
  },

  pult_answer: {
    description:
      'Действие по вопросу из pult_asks: mode "answer" — дать решение (текст или номер варианта; уедет автору и продублируется диспетчеру), "clarify" — встречный вопрос автору (вопрос непонятен — доуточни, карточка остаётся открытой), "cancel" — снять протухший вопрос (причина обязательна).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'проект из pult_asks' },
        ask_id: { type: 'string', description: 'id вопроса из pult_asks' },
        mode: { type: 'string', description: 'answer | clarify | cancel' },
        text: { type: 'string', description: 'решение / встречный вопрос / причина снятия' },
        by: { type: 'string', description: 'кто отвечает (пусто — «постановщик@pult-mcp»)' },
      },
      required: ['project', 'ask_id', 'mode', 'text'],
      additionalProperties: false,
    },
    async handler({ project, ask_id, mode, text, by }) {
      const who = by || 'постановщик@pult-mcp';
      if (mode === 'answer')
        return api('POST', '/api/decide', { project, ask_id, decision: text, by: who });
      if (mode === 'clarify')
        return api('POST', '/api/ask-author', { project, ask_id, text, by: who });
      if (mode === 'cancel')
        return api('POST', '/api/decide', { project, ask_id, action: 'cancel', reason: text, by: who });
      throw new Error(`неизвестный mode: ${mode} (answer | clarify | cancel)`);
    },
  },

  pult_judge: {
    description:
      'Вердикт независимого судьи (deepseek) по сессии: встала / работает / ждёт человека, с причиной и действием. Зови при подозрении, что сессия залипла.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' },
      project: { type: 'string' },
      sessionId: { type: 'string', description: 'из pult_fleet (для чтения ленты)' },
    }, required: ['name', 'project'], additionalProperties: false },
    async handler(a) {
      const v = await api('POST', '/api/runner', { action: 'judge', ...a });
      return { verdict: v.verdict, state: v.state, confidence: v.confidence };
    },
  },
};

// ---------- MCP stdio (JSON-RPC 2.0) — форк цикла nyron-dev/hub/server.mjs,
// отличие одно: handler'ы асинхронные (HTTP к пульту) ----------

import readline from 'node:readline';

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
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
        serverInfo: { name: 'pult', version: '0.2.0' },
        // Канон постановщика — приезжает В ЛЮБОЙ клиент с этим коннектором
        // (Claude Desktop в т.ч.): у Desktop нет SessionStart-хуков Claude
        // Code, поэтому оркестратор-контекст он получает только отсюда.
        instructions: [
          'Ты — постановщик: флотом CLI-сессий на этой машине владеет пульт',
          '(веб: http://127.0.0.1:4747, страница проекта — /?p=<имя>). С',
          'человеком думаешь и решаешь, работу ИСПОЛНЯЮТ сессии пульта.',
          '',
          '- Кодовые задачи сам не делай — поднимай сессию через pult_start.',
          '  Эпик — ОДИН диспетчер со скиллом nyron-waves (mode:"bypass",',
          '  mcp:"strict"); волны дальше плодит он сам /goal-чипами.',
          '- Подписку пульт выбирает сам (slot_pick в ответе — перескажи',
          '  человеку): сначала догружает начатую до 50% сессионного лимита,',
          '  потом ровняет нагрузку по чуть-чуть по наименее занятой.',
          '- ДОВЕДЕНИЕ ДО КОНЦА: обратного пуша в этот чат нет — пока работа',
          '  идёт, периодически сам опрашивай pult_fleet (кто жив/застрял,',
          '  ждёт ли человека), спорную сессию смотри pult_screen и суди',
          '  pult_judge. Финал — по факту в pult_fleet/Jira, не по обещанию.',
          '- ВОПРОСЫ (мандат CTO 25.08): ты контролируешь диспетчеров и весь',
          '  поток. Регулярно разбирай pult_asks и ОСОЗНАЙ каждый вопрос:',
          '  знаешь ответ в рамках уже принятых решений — отвечай сам',
          '  (pult_answer mode:"answer"); непонятен — доуточни у автора',
          '  (mode:"clarify") и добейся внятной формулировки; протух —',
          '  снимай с причиной (mode:"cancel"). До человека доноси ТОЛЬКО',
          '  понятные вопросы: перескажи суть своими словами + дай ссылку',
          '  на карточку (link из pult_asks). Огрызок «как есть» человеку',
          '  не пересылать. Новые решения бизнеса/архитектуры сам не выдумывай',
          '  — это как раз вопросы человеку.',
          '- Мержи и снос веток — не твои руки: это сессии по merge_rights',
          '  или человек кнопками git-панели пульта.',
        ].join('\n'),
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
      const result = await t.handler(params?.arguments || {});
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
// НЕ exit(0): async-вызов мог быть в полёте, ответ обязан долететь в stdout;
// когда ответы отданы, процесс завершится сам — держать его нечему
rl.on('close', () => {});
