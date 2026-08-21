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

/** Вердикт тремя строками. Бросает понятную ошибку, если судья не настроен. */
export async function judgeStuck({ name, project, sessionId }) {
  const k = keysEnv();
  if (!judgeReady())
    throw new Error('судья не настроен: положи JUDGE_API_URL, JUDGE_API_KEY и JUDGE_MODEL в .secrets/env (кнопка «ключи» проекта stovp)');
  const ev = evidence({ name, project, sessionId });
  const body = {
    model: k.JUDGE_MODEL,
    temperature: 0.2,
    max_tokens: 2000, // думающим моделям нужен запас на размышление (факт 22.08)
    messages: [
      { role: 'system', content:
`Ты — дежурный судья флота CLI-сессий на маке оператора. Сессии — Claude Code в tmux; известные болезни: зависший Stop-хук (строка «running stop hook» с большим временем), фоновые агенты-товарищи без возврата результата, обрыв по лимиту подписки, ожидание ответа человека на форму. «Лента» — транскрипт сессии: живая дописывает его каждые пару минут; спиннер на экране при молчащей ленте — признак зависания, не работы. Отвечай ПО-РУССКИ строго JSON-объектом без обёрток: {"state":"working|stuck|waiting_human","fact":"главная улика одной фразой","cause":"причина одной фразой","action":"конкретный шаг оператора одной фразой","confidence":0..1}` },
      { role: 'user', content:
`Сессия «${name}», проект ${project}.
Цель (начало): ${ev.goal || 'неизвестна'}
Сообщений в очереди пульта: ${ev.queue}
Лента молчит: ${ev.quietMin != null ? ev.quietMin + ' мин' : 'нет данных'}
Висящие Stop-хуки: ${ev.hooks || 'нет'}
Последние ходы ленты:
${ev.tail || '(нет)'}
Низ экрана tmux:
${ev.screen || '(экран пуст)'}` }],
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(`${k.JUDGE_API_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k.JUDGE_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`судья ответил HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const raw = d.choices?.[0]?.message?.content || '';
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
      model: k.JUDGE_MODEL, evidence: ev };
  } finally { clearTimeout(t); }
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
  return { project, closed, kept: kept.length };
}

// доступ к будке — через fleet, чтобы не открывать вторую базу
import * as fleet from './fleet.js';
function fleetInternals() {
  return { hubFor: fleet.hubForJudge, rootByName: fleet.rootByName, listSessions: null };
}
