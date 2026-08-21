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
import { MORDA_ROOT, TMUX_BIN, SPAWN_ENV, rootByName, transcriptQuietMs } from './fleet.js';

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
      .filter((l) => l.trim()).slice(-12).join('\n');
  } catch {}
  const quiet = sessionId ? transcriptQuietMs(project, sessionId) : null;
  let hooks = '';
  try {
    hooks = execFileSync('pgrep', ['-fl', 'hub-rearm.sh hook'], { timeout: 2000 })
      .toString().trim();
  } catch {}
  return { screen, quietMin: quiet != null ? Math.round(quiet / 60000) : null, hooks };
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
    messages: [{ role: 'user', content:
`Ты — дежурный судья флота CLI-сессий. Отвечай ПО-РУССКИ, ровно три строки:
1) состояние (работает / встала / ждёт человека) и на основании какого факта;
2) причина;
3) конкретное действие для оператора пульта.

Факты о сессии «${name}» (проект ${project}):
— низ экрана tmux:
${ev.screen || '(экран пуст)'}
— лента сессии молчит: ${ev.quietMin != null ? ev.quietMin + ' мин' : 'нет данных'};
— висящие процессы Stop-хуков: ${ev.hooks || 'нет'}.` }],
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
    const verdict = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!verdict) throw new Error('судья вернул пустой ответ (всё ушло в размышление?)');
    return { verdict, model: k.JUDGE_MODEL, evidence: ev };
  } finally { clearTimeout(t); }
}
