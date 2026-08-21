/**
 * hooks.server.js — вход по паролю для пульта, выставленного наружу
 * (туннель tuna и т.п., CTO 19.08). Локальная работа не меняется: без
 * заданного пароля щит выключен и пульт открыт, как и был.
 *
 * Логин и пароль живут в КЛЮЧНИЦЕ проекта (.secrets/env — общая ключница проекта), не в
 * коде и не в git: тот же дом, что у токенов Jira. Механика простая —
 * HTTP Basic: браузер сам покажет окно ввода и запомнит на сессию.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MORDA_ROOT } from '$lib/server/fleet.js';

const ENV_FILE = process.env.MORDA_AUTH_FILE
  || path.join(MORDA_ROOT, '..', '.secrets', 'env');

// читаем ключницу один раз на старт: смена пароля = перезапуск пульта
function loadAuth() {
  try {
    const vars = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    if (vars.MORDA_USER && vars.MORDA_PASSWORD)
      return { user: vars.MORDA_USER, pass: vars.MORDA_PASSWORD };
  } catch { /* файла нет — щит выключен */ }
  return null;
}
const auth = loadAuth();

// сравнение без утечки по времени: длина + побайтовое ИЛИ
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Локальный заход (сам мак) пароля не требует: пульт слушает 127.0.0.1, и
// снаружи туда попасть нельзя иначе как через туннель — а туннель приходит
// с чужим Host. Так вход спрашивают ровно там, где он нужен (CTO 20.08).
function isLocal(event) {
  const host = (event.request.headers.get('host') || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

export async function handle({ event, resolve }) {
  if (!auth) return resolve(event);           // пароля нет — локальный режим
  if (isLocal(event)) return resolve(event);  // свой мак — без пароля
  const header = event.request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let user = '', pass = '';
    try {
      const [u, ...rest] = atob(header.slice(6)).split(':');
      user = u; pass = rest.join(':');
    } catch { /* мусорный заголовок — просим заново */ }
    if (same(user, auth.user) && same(pass, auth.pass)) return resolve(event);
  }
  return new Response('нужен вход', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="STOVP", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

// Триаж хвостов — сам, раз в опрос: ответы мёртвым адресатам закрываются
// без человека (CTO 22.08: «висит 11 напоминаний — почему судья не поймёт»).
// Правило кодом, модели не нужно; ошибка одного проекта не роняет остальные.
import { projects } from '$lib/server/fleet.js';
import { judgeTriage } from '$lib/server/judge.js';
const TRIAGE_EVERY = 6 * 3600 * 1000;
if (!globalThis.__mordaTriage) {
  globalThis.__mordaTriage = setInterval(() => {
    for (const p of projects() || []) {
      try {
        const r = judgeTriage({ project: p.name });
        if (r.closed.length) console.log(`[triage] ${p.name}: закрыто ${r.closed.length}`);
      } catch { /* проект без будки — пропускаем */ }
    }
  }, TRIAGE_EVERY);
  globalThis.__mordaTriage.unref?.();
}
