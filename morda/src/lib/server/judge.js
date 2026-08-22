/**
 * judge.js — дежурный судья флота: короткое суждение о застрявшей сессии.
 *
 * Почему НЕ headless claude: судья не имеет права жить в том же стеке, что
 * подсудимые — CLI виснет теми же хуками, что и сессии (stop-хук 22.08 висел
 * три часа; вердикт CTO). Поэтому прямой HTTP к OpenAI-совместимому API.
 *
 * Улики собирает КОД (экран, тишина ленты, висящие хуки) — модель только
 * судит. Провайдер задаётся ключницей .secrets/env:
 *   JUDGE_API_URL   — например https://api.deepseek.com/v1
 *   JUDGE_API_KEY   — ключ провайдера
 *   JUDGE_MODEL     — например deepseek-chat
 * Ключей нет — судья честно недоступен, механика пульта живёт без него.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MORDA_ROOT, TMUX_BIN, SPAWN_ENV, transcriptQuietMs, session as readSession } from './fleet.js';
import { checkinMs } from './checkin.js';

function keysEnv() {
  const out = {};
  try {
    const f = path.join(MORDA_ROOT, '..', '.secrets', 'env');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#'))
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {}
  return out;
}

export function judgeReady() {
  const k = keysEnv();
  return !!(k.JUDGE_API_URL && k.JUDGE_API_KEY && k.JUDGE_MODEL);
}

/** Улики по сессии раннера — только факты, собранные кодом. */
function evidence({ name, project, sessionId }) {
  let screen = '';
  try {
    screen = execFileSync(TMUX_BIN, ['capture-pane', '-t', `stovp-${name}:0.0`, '-p'],
      { timeout: 3000, env: SPAWN_ENV }).toString().split('\n')
      .filter((l) => l.trim()).slice(-14).join('\n');
  } catch {}
  const quiet = sessionId ? transcriptQuietMs(project, sessionId) : null;
  let hooks = '';
  try {
    hooks = execFileSync('pgrep', ['-fl', 'hub-rearm.sh hook'], { timeout: 2000 })
      .toString().trim();
  } catch {}
  // цель и очередь — из реестра раннера; хвост ленты — последние ходы сессии
  // (совет CTO 22.08: судье больше вводных — суждение точнее)
  let goal = null, queue = 0;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(MORDA_ROOT, 'runner.json'), 'utf8'));
    const rec = reg.sessions?.[name];
    goal = String(rec?.goal || '').slice(0, 300) || null;
    queue = (rec?.queue || []).length;
  } catch {}
  let tail = '';
  try {
    const sess = readSession(project, sessionId);
    tail = (sess?.items || []).slice(-6).map((it) => {
      const what = it.kind === 'tool' ? `→ ${it.name}: ${String(it.input || '').slice(0, 100)}`
        : String(it.text || '').slice(0, 160);
      return `[${it.kind}] ${what.replace(/\s+/g, ' ')}`;
    }).join('\n');
  } catch {}
  return { screen, quietMin: quiet != null ? Math.round(quiet / 60000) : null,
    hooks, goal, queue, tail };
}

// один запрос к провайдеру с таймаутом — общий для стартового и следственных
async function judgeCall(k, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(`${k.JUDGE_API_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k.JUDGE_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`судья ответил HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Следственные инструменты судьи (план 22.08 п.8) — СТРОГО read-only:
// модель выбирает, ЧТО дозапросить, но исполняет всё код с прибитыми
// командами; аргументы модели — только числа, зажатые в границы.
function judgeTools({ name, project, sessionId }) {
  const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number(v) || d));
  const defs = [
    { type: 'function', function: { name: 'screen',
      description: 'полный экран tmux сессии (по умолчанию 40 строк, до 60)',
      parameters: { type: 'object', properties: { lines: { type: 'number' } } } } },
    { type: 'function', function: { name: 'tail',
      description: 'больше последних ходов ленты сессии (по умолчанию 15, до 30)',
      parameters: { type: 'object', properties: { count: { type: 'number' } } } } },
    { type: 'function', function: { name: 'hung_hooks',
      description: 'висящие процессы Stop-хука на машине',
      parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_state',
      description: 'ветка, незакоммиченное и последние коммиты репозитория проекта',
      parameters: { type: 'object', properties: {} } } },
  ];
  function run(tool, args = {}) {
    if (tool === 'screen') {
      const out = execFileSync(TMUX_BIN, ['capture-pane', '-t', `stovp-${name}:0.0`, '-p'],
        { timeout: 3000, env: SPAWN_ENV }).toString();
      return out.split('\n').filter((l) => l.trim()).slice(-clamp(args.lines, 10, 60, 40)).join('\n') || '(экран пуст)';
    }
    if (tool === 'tail') {
      const sess = readSession(project, sessionId);
      return (sess?.items || []).slice(-clamp(args.count, 6, 30, 15)).map((it) => {
        const what = it.kind === 'tool' ? `→ ${it.name}: ${String(it.input || '').slice(0, 120)}`
          : String(it.text || '').slice(0, 200);
        return `[${it.kind}] ${what.replace(/\s+/g, ' ')}`;
      }).join('\n') || '(лента пуста)';
    }
    if (tool === 'hung_hooks') {
      try {
        return execFileSync('pgrep', ['-fl', 'hub-rearm.sh hook'], { timeout: 2000 }).toString().trim() || 'нет';
      } catch { return 'нет'; }
    }
    if (tool === 'git_state') {
      const root = fleet.rootByName(project);
      const g = (...a) => execFileSync('git', ['-C', root, ...a],
        { timeout: 5000 }).toString().trim();
      return `ветка: ${g('branch', '--show-current')}\nнезакоммиченное:\n${
        g('status', '--porcelain').split('\n').slice(0, 25).join('\n') || '(чисто)'}\nкоммиты:\n${
        g('log', '--oneline', '-3')}`;
    }
    throw new Error(`неизвестный инструмент ${tool}`);
  }
  return { defs, run };
}

/** Вердикт тремя строками; судья может дозапросить улики read-only
 *  инструментами (до 3 следственных ходов). Бросает понятную ошибку,
 *  если судья не настроен. */
export async function judgeStuck({ name, project, sessionId }) {
  const k = keysEnv();
  if (!judgeReady())
    throw new Error('судья не настроен: положи JUDGE_API_URL, JUDGE_API_KEY и JUDGE_MODEL в .secrets/env (кнопка «ключи» проекта stovp)');
  const ev = evidence({ name, project, sessionId });
  const tools = judgeTools({ name, project, sessionId });
  const messages = [
    { role: 'system', content:
`Ты — дежурный судья флота CLI-сессий на маке оператора. Сессии — Claude Code в tmux; известные болезни: зависший Stop-хук (строка «running stop hook» с большим временем), фоновые агенты-товарищи без возврата результата, обрыв по лимиту подписки, ожидание ответа человека на форму. «Лента» — транскрипт сессии: живая дописывает его каждые пару минут; спиннер на экране при молчащей ленте — признак зависания, не работы. Не хватает улик — дозапроси инструментами (они read-only), но не больше трёх ходов. Когда уверен — отвечай ПО-РУССКИ строго JSON-объектом без обёрток: {"state":"working|stuck|waiting_human","fact":"главная улика одной фразой","cause":"причина одной фразой","action":"конкретный шаг оператора одной фразой","confidence":0..1}` },
    { role: 'user', content:
`Сессия «${name}», проект ${project}.
Цель (начало): ${ev.goal || 'неизвестна'}
Сообщений в очереди пульта: ${ev.queue}
Лента молчит: ${ev.quietMin != null ? ev.quietMin + ' мин' : 'нет данных'}
Висящие Stop-хуки: ${ev.hooks || 'нет'}
Последние ходы ленты:
${ev.tail || '(нет)'}
Низ экрана tmux:
${ev.screen || '(экран пуст)'}` }];
  const used = [];
  let raw = '';
  for (let round = 0; round < 4; round++) {
    const last = round === 3; // финальный круг — только вердикт, без инструментов
    const d = await judgeCall(k, {
      model: k.JUDGE_MODEL, temperature: 0.2,
      max_tokens: 2000, // думающим моделям нужен запас на размышление (факт 22.08)
      messages, ...(last ? {} : { tools: tools.defs }),
    });
    const msg = d.choices?.[0]?.message || {};
    if (msg.tool_calls?.length && !last) {
      messages.push(msg);
      for (const tc of msg.tool_calls.slice(0, 4)) {
        let out;
        try { out = tools.run(tc.function?.name, JSON.parse(tc.function?.arguments || '{}')); }
        catch (e) { out = `ошибка: ${e.message}`; }
        used.push(tc.function?.name);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 4000) });
      }
      continue;
    }
    raw = msg.content || '';
    break;
  }
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!clean) throw new Error('судья вернул пустой ответ (всё ушло в размышление?)');
  // структура — чтобы карточка красилась по полю; не разобралось — текст как есть
  let parsed = null;
  try { parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
  const RU = { working: 'работает', stuck: 'встала', waiting_human: 'ждёт человека' };
  const verdict = parsed
    ? `${RU[parsed.state] || parsed.state}: ${parsed.fact}\nПричина: ${parsed.cause}\nДействие: ${parsed.action}`
    : clean;
  return { verdict, state: parsed?.state || null, confidence: parsed?.confidence ?? null,
    model: k.JUDGE_MODEL, evidence: ev, investigated: used };
}

/** Триаж висящих карточек: протухшие ответы мёртвым адресатам закрываются.
 *  Правило кодом, без модели: карточка answered/delivered/acknowledged, ей
 *  больше недели, адресат-сессия давно не пишет → подтверждения не будет
 *  никогда, ack от имени судьи. Спорные (моложе недели) не трогаем.
 *  (CTO 22.08: «висит 11 напоминаний — почему судья не поймёт, что актуально») */
export function judgeTriage({ project, days = 7 }) {
  const { hubFor, rootByName: rbn, listSessions } = fleetInternals();
  const hub = hubFor(rbn(project));
  const now = Date.now();
  const horizon = days * 86_400_000;
  const closed = [], kept = [];
  const pool = [
    ...hub.asks({ status: 'answered' }).asks,
    ...hub.asks({ status: 'delivered' }).asks,
  ];
  for (const a of pool) {
    const age = now - new Date(a.ts).getTime();
    if (age < horizon) { kept.push({ id: a.id, why: 'моложе недели' }); continue; }
    hub.ack({ ask_id: a.id, by: 'judge-triage@morda' });
    closed.push({ id: a.id, q: String(a.question || '').slice(0, 60), days: Math.round(age / 86_400_000) });
  }
  // ОТКРЫТЫЕ автокарточки чек-ина по мёртвым сессиям (план 22.08 п.6).
  // Живой считаем только сессию, которую раннер числит НЕ-стопнутой:
  // у неё карточку держим (есть что спасать). Остальным — разовым пробам
  // вне реестра и запаркованным — отвечать некому: тишина больше
  // 4 порогов чек-ина (та же отсечка «история, не событие», что у
  // stalledCard) закрывает карточку. Оживёт — чек-ин заведёт новую.
  const DEAD_MS = 24 * 3600_000;
  const aliveIds = new Set();
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(MORDA_ROOT, 'runner.json'), 'utf8'));
    for (const s of Object.values(reg.sessions || {}))
      if (s.sessionId && s.state !== 'stopped' && s.state !== 'died_on_start')
        aliveIds.add(s.sessionId);
  } catch {}
  const staleMs = 4 * checkinMs(rbn(project));
  for (const a of hub.asks({ status: 'open' }).asks) {
    if (!String(a.question || '').startsWith('Сессия молчит')) continue;
    const quiet = a.session ? fleet.transcriptQuietMs(project, a.session) : null;
    const dead = quiet == null || quiet >= DEAD_MS
      || (!aliveIds.has(a.session) && quiet >= staleMs);
    if (!dead) { kept.push({ id: a.id, why: 'сессия ещё пишет либо жива у раннера' }); continue; }
    // открытую карточку не ack-ают (решения нет) — её отменяют с причиной
    hub.cancelAsk({ ask_id: a.id, by: 'judge-triage@morda',
      reason: 'сессия-адресат мертва: лента давно молчит, у раннера не числится живой' });
    closed.push({ id: a.id, q: String(a.question || '').slice(0, 60),
      days: Math.round((now - new Date(a.ts).getTime()) / 86_400_000) });
  }
  return { project, closed, kept: kept.length };
}

// доступ к будке — через fleet, чтобы не открывать вторую базу
import * as fleet from './fleet.js';
function fleetInternals() {
  return { hubFor: fleet.hubForJudge, rootByName: fleet.rootByName, listSessions: null };
}
