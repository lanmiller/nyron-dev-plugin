/**
 * passport.js — верификатор готовности проекта (STOVP-59, шаг 2).
 *
 * Паспорт проекта — `<корень>/.claude/passport.json` (схема — макет
 * docs/specs/2026-08-17-passport-v1.md): какие MCP-серверы нужны и чем их
 * смоукать, какой плагин со скиллами и минимальной версией, какие ключи
 * обязаны лежать в ключнице `.secrets/`. Здесь паспорт прогоняется ФАКТОМ:
 * MCP-сервер реально запускается и отвечает на смоук-вызов, ключница
 * сверяется по именам переменных (значения наружу не выходят никогда),
 * забор-хук получает тестовый опасный вход и обязан ответить deny.
 *
 * Каждый пункт — { id, title, ok, fact, fix }: красный пункт несёт
 * конкретный шаг починки, молчаливых фолбэков нет (требование CTO 17.08).
 * Результат — живое состояние (дом «пульт»), никуда не записывается.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { rootByName, MORDA_ROOT, SPAWN_ENV } from './fleet.js';

const item = (id, title, ok, fact, fix = null) =>
  ({ id, title, ok: !!ok, fact, fix: ok ? null : fix });

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

// KEY=VALUE файл ключницы → карта переменных (значения остаются в процессе,
// в ответ верификатора уходят только имена и «задано/пусто»)
function readEnvFile(full) {
  const vars = {};
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

// Значения, которым нечего делать в файлах, уезжающих в git: токены
// Atlassian/OpenAI/GitHub/GitLab, приватные ключи, пароль в URL.
const SECRET_RE = /ATATT[\w=.-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[\w-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^\s/@]+:[^\s/@]{6,}@/;

// ---------- пункт 4: MCP отвечает фактом ----------

// Мини-клиент MCP поверх stdio (протокол — JSON-RPC по строкам): запустить
// команду из .mcp.json, initialize → tools/call смоук-инструмента.
// Без tool (null) — initialize → tools/list: сервер всё равно реально
// запускается и отвечает; так смоукаются записи паспорта без смоука и
// account-scope серверы конфигуратора.
export function mcpSmoke({ cfg, tool, args, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      // cwd = корень проекта: так же запускает stdio-серверы сам CLI,
      // относительные пути .mcp.json (загрузчик, ключница) работают.
      // SPAWN_ENV — под launchd PATH минимальный, node/docker не видны.
      const env = { ...SPAWN_ENV, ...(cfg.env || {}) };
      env.PATH = `${SPAWN_ENV.PATH}:/usr/local/bin`;   // docker под launchd
      child = spawn(cfg.command, cfg.args || [], { cwd: cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, fact: String(e.message || e) }); }
    let buf = '', err = '', settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({
      ok: false, fact: `нет ответа за ${timeoutMs / 1000}с; stderr: ${err.slice(-260) || 'пусто'}`,
    }), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, fact: String(e.message || e) }); });
    child.on('exit', (code) => {
      if (!settled) { clearTimeout(timer); finish({ ok: false, fact: `процесс сервера умер (код ${code}); stderr: ${err.slice(-260)}` }); }
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send(tool
            ? { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }
            : { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          if (!tool) {
            const n = msg.result?.tools?.length;
            finish(n >= 0
              ? { ok: true, fact: `отвечает: инструментов ${n}` }
              : { ok: false, fact: msg.error ? JSON.stringify(msg.error).slice(0, 260) : 'tools/list без ответа' });
            continue;
          }
          const text = msg.result?.content?.find((c) => c.type === 'text')?.text
            || (msg.error ? JSON.stringify(msg.error) : '');
          finish(msg.result && !msg.result.isError
            ? { ok: true, fact: text.replace(/\s+/g, ' ').slice(0, 160) }
            : { ok: false, fact: text.replace(/\s+/g, ' ').slice(0, 260) || 'ответ с ошибкой' });
        }
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stovp-passport', version: '1' } },
    });
  });
}

// ---------- пункт 6: забор отвечает deny ----------

function guardAnswers(input) {
  const guard = path.join(MORDA_ROOT, 'guard', 'pretooluse-guard.mjs');
  if (!fs.existsSync(guard)) return { ok: false, fact: 'файла забора нет' };
  try {
    const out = execFileSync(process.execPath, [guard],
      { input, timeout: 8000, env: SPAWN_ENV }).toString();
    const deny = /"permissionDecision"\s*:\s*"deny"/.test(out);
    return { ok: deny, fact: deny ? 'deny' : `ответ без deny: ${out.slice(0, 120) || 'молчание'}` };
  } catch (e) { return { ok: false, fact: String(e.message || e) }; }
}

// ---------- быстрый гейт волн (гриль 18.08: «волна не стартует по красному») ----------
//
// Дешёвые проверки без MCP-смоуков — зовётся раннером ПЕРЕД стартом
// сессии (с STOVP-61 — в любом режиме, не только bypass).
// Возвращает: null — паспорта нет; { hard, keys } — проблемы двумя классами:
//   hard — безопасность (ключница не в игноре, секреты в git, забора нет):
//          глушит запуск ЛЮБОЙ сессии проекта;
//   keys — ключ реестра без файла/значения: это human-гейт конкретной
//          работы, а не авария всего проекта.
// Разделение — инцидент KAN-209 (ночь 29.08): новый ключ без значения
// покраснел в 04:00 и паспорт-гейт закрыл запуск ВСЕХ сессий проекта —
// стоп конвейера без возможности разбудить человека. Отличие «нет» от
// «зелёный» ввёл челлендж Sol по STOVP-57: отсутствующий паспорт числился
// зелёным, и bypass-волны шли мимо гейта.
export function passportQuick(root) {
  let pp = null;
  try { pp = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'passport.json'), 'utf8')); }
  catch { return null; }
  const hard = [], keys = [];
  const dir = path.join(root, '.secrets');
  if (!secretsIgnored(root))
    hard.push('.secrets не в git-игноре');
  for (const [file, vars] of Object.entries(pp.keys || {})) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) { keys.push(`нет ключа ${file}`); continue; }
    const have = readEnvFile(full);
    for (const name of Object.keys(vars))
      if (!have[name]) keys.push(`${file}: не задана ${name}`);
  }
  const tracked = git(root, ['ls-files', '.secrets']);
  if (tracked) hard.push('в git закоммичено из .secrets — вынеси и ротируй');
  if (pp.guard && !fs.existsSync(path.join(MORDA_ROOT, 'guard', 'pretooluse-guard.mjs')))
    hard.push('файла забора нет');
  return { hard, keys };
}

/** Решение гейта по паспорту (STOVP-61, решение постановщика 22.08;
 *  смягчено по KAN-209 29.08): ЖЁСТКАЯ краснота (безопасность) закрывает
 *  запуск в ЛЮБОМ режиме; незаполненный ключ — предупреждение, не стоп:
 *  блокируется только работа, которой ключ нужен (это human-гейт, его
 *  снимает пре-флайт диспетчера), остальные сессии проекта живут.
 *  Отсутствие паспорта закрывает только bypass (решение №7 гриля 16.08:
 *  запрет «нет паспорта — не стартуем» не должен остановить единственный
 *  живой проект до его аттестации), остальным режимам — предупреждение.
 *  problems — выход passportQuick (null | { hard, keys }). */
export function passportGate(problems, mode) {
  if (problems === null) {
    if (mode === 'bypass')
      return { block: 'паспорта проекта нет — bypass закрыт: собери паспорт кнопкой «проверить готовность» в настройках', warning: null };
    return { block: null, warning: 'паспорта проекта нет — собери его кнопкой «проверить готовность» в настройках' };
  }
  if (problems.hard.length)
    return { block: `паспорт проекта красный — запуск закрыт: ${problems.hard.join('; ')} (почини через «проверить готовность» в настройках)`, warning: null };
  if (problems.keys.length)
    return { block: null, warning: `в ключнице не всё: ${problems.keys.join('; ')} — работа, которой эти ключи нужны, упрётся в human-гейт; остальным можно` };
  return { block: null, warning: null };
}

// ---------- сам прогон ----------

export async function passportCheck({ project }) {
  const root = rootByName(project);
  const items = [];
  const at = new Date().toISOString();

  // 1. паспорт читается
  const ppFile = path.join(root, '.claude', 'passport.json');
  let pp = null;
  try { pp = JSON.parse(fs.readFileSync(ppFile, 'utf8')); } catch {}
  items.push(item('passport', 'Паспорт проекта', !!pp,
    pp ? `.claude/passport.json v${pp.version}` : 'файла .claude/passport.json нет или он не читается',
    'создай .claude/passport.json по макету docs/specs/2026-08-17-passport-v1.md (пример — nyron-dev-plugin)'));
  // Канон влезает в лимит Codex: он молча срезает хвост AGENTS.md/CLAUDE.md
  //     на project_doc_max_bytes (умолчание 32 КиБ). Канон ai-evolve перерос
  //     лимит и терял правила релиза и отката — никто не знал (факт 21.08).
  {
    const limit = codexDocLimit();
    const big = ['CLAUDE.md', 'AGENTS.md']
      .map((f) => ({ f, size: sizeOf(path.join(root, f)) }))
      .filter((x) => x.size > 0);
    const over = big.filter((x) => x.size > limit);
    if (big.length) {
      items.push(item('canon-size', 'Канон влезает в лимит Codex', !over.length,
        over.length
          ? over.map((x) => `${x.f} ${x.size} Б > лимита ${limit} Б — Codex срежет хвост молча`).join('; ')
          : big.map((x) => `${x.f} ${x.size} Б`).join(', ') + ` (лимит ${limit} Б)`,
        `ужми канон или подними project_doc_max_bytes в ~/.codex/config.toml (сейчас ${limit})`));
    }
  }

  if (!pp) return { project, at, items };

  // 2. ключница: папка, git-игнор, файлы, переменные — по именам
  {
    const dir = path.join(root, '.secrets');
    const problems = [];
    let counted = 0, total = 0;
    if (!fs.existsSync(dir)) problems.push('папки .secrets/ нет');
    const ignored = secretsIgnored(root);
    if (!ignored) problems.push('.secrets НЕ в .gitignore — добавь строку `.secrets/`');
    for (const [file, vars] of Object.entries(pp.keys || {})) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) {
        problems.push(`нет файла ${file} (переменные: ${Object.keys(vars).join(', ')})`);
        total += Object.keys(vars).length;
        continue;
      }
      const have = readEnvFile(full);
      for (const name of Object.keys(vars)) {
        total += 1;
        if (have[name]) counted += 1;
        else problems.push(`${file}: переменная ${name} не задана — ${vars[name]}`);
      }
    }
    items.push(item('keys', 'Ключница .secrets/', !problems.length,
      problems.length ? problems.join('; ') : `переменных задано ${counted}/${total}; папка в git-игноре`,
      'положи недостающее в .secrets/ (комментарии к переменным — в паспорте, раздел keys)'));
  }

  // 3. секреты не в git: ключница не закоммичена, указатели без значений.
  // Совет «ротируй» — только когда значение реально попало в git-историю;
  // незакоммиченный файл со значением — переводится на ключницу без паники.
  {
    const problems = [];
    let rotate = false;
    const tracked = git(root, ['ls-files', '.secrets']);
    if (tracked) {
      problems.push(`в git закоммичено из .secrets: ${tracked.split('\n')[0]}…`);
      rotate = true;
    }
    for (const f of ['.mcp.json', '.env']) {
      const full = path.join(root, f);
      if (!fs.existsSync(full) || !SECRET_RE.test(fs.readFileSync(full, 'utf8'))) continue;
      const inGit = git(root, ['ls-files', f]);
      problems.push(`${f} содержит значение секрета${inGit ? ' И закоммичен' : ''} — это указатель, значениям тут не место`);
      if (inGit) rotate = true;
    }
    items.push(item('no-leak', 'Секреты не в git', !problems.length,
      problems.length ? problems.join('; ') : '.secrets не закоммичен; .mcp.json/.env без значений секретов',
      rotate ? 'вынеси значение в ключницу и РОТИРУЙ токен: git-история его уже скомпрометировала'
        : 'переведи файл на ключницу: значения — в .secrets/, в файле — запуск через morda/keys/with-keys.mjs'));
  }

  // 4. каждый MCP-сервер паспорта отвечает смоук-вызовом
  {
    let mcpCfg = null;
    try { mcpCfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {}; }
    catch {}
    for (const [name, req] of Object.entries(pp.mcp || {})) {
      const cfg = mcpCfg?.[name];
      if (!cfg) {
        items.push(item(`mcp:${name}`, `MCP ${name}`, false,
          'сервера нет в .mcp.json проекта',
          `опиши ${name} в .mcp.json через загрузчик ключницы (morda/keys/with-keys.mjs — пример в nyron-dev-plugin)`));
        continue;
      }
      // подстановка $ИМЯ в аргументы смоука — из env-файлов этого сервера
      const vars = {};
      for (const f of req.keys || []) {
        const full = path.join(root, '.secrets', f);
        if (fs.existsSync(full)) Object.assign(vars, readEnvFile(full));
      }
      const args = JSON.parse(JSON.stringify(req.smoke?.args || {}),
        (k, v) => (typeof v === 'string' && v.startsWith('$') ? (vars[v.slice(1)] ?? v) : v));
      const r = await mcpSmoke({ cfg: { ...cfg, cwd: root }, tool: req.smoke?.tool || null, args });
      items.push(item(`mcp:${name}`, `MCP ${name} — ${req.smoke?.tool || 'tools/list'}`, r.ok, r.fact,
        `сервер не ответил: проверь Docker (если сервер докерный), ключи в .secrets/ и команду в .mcp.json; ручной смоук: node morda/keys/with-keys.mjs …`));
    }
  }

  // 5. плагин установлен, версия не ниже, скиллы на месте
  {
    const p = pp.plugin || {};
    const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', p.marketplace || '', p.name || '');
    let vers = [];
    try { vers = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)); } catch {}
    const cmp = (a, b) => {
      const x = a.split('.').map(Number), y = b.split('.').map(Number);
      return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
    };
    const best = vers.sort(cmp).at(-1) || null;
    const okVer = best && (!p.min_version || cmp(best, p.min_version) >= 0);
    const missing = (p.skills || []).filter((s) =>
      !best || !fs.existsSync(path.join(base, best, 'skills', s)));
    items.push(item('plugin', `Плагин ${p.name || '?'}`, okVer && !missing.length,
      !best ? `установленной копии нет: ${base}`
        : `установлен ${best} (нужно ≥${p.min_version || 'любая'}); скиллов на месте ${(p.skills || []).length - missing.length}/${(p.skills || []).length}`
          + (missing.length ? `; нет: ${missing.join(', ')}` : ''),
      `установи/обнови плагин: /plugin marketplace add git@gitlab.com:your2563006/nyron-dev-plugin.git (маркетплейс ${p.marketplace})`));
  }

  // 6. замок на коммит: pre-commit хук с секрет-детектором установлен
  // (гриль 18.08: ловим значение ДО git-истории, а не ротируем после)
  if (pp.precommit) {
    // в рабочей копии (git worktree) .git — файл, а хуки общие: спрашиваем
    // путь у самого git, иначе замок «пропадал» в каждой копии (факт 21.08)
    const hooksDir = git(root, ['rev-parse', '--git-path', 'hooks'])
      || path.join(root, '.git', 'hooks');
    const hook = path.isAbsolute(hooksDir) ? path.join(hooksDir, 'pre-commit')
      : path.join(root, hooksDir, 'pre-commit');
    let ok = false;
    try { ok = fs.readFileSync(hook, 'utf8').includes('pre-commit-secrets'); } catch {}
    items.push(item('precommit', 'Замок на коммит (pre-commit)', ok,
      ok ? 'хук стоит и зовёт pre-commit-secrets.sh' : 'хука нет или он не наш',
      `поставь: printf '#!/bin/sh\\nexec sh "<клон-плагина>/morda/keys/pre-commit-secrets.sh"\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`));
  }

  // 7. ревизия не просрочена (два ритма, гриль 18.08): паспорт хранит дату
  // последней ревизии; вышел интервал — жёлтая карточка «пора ревизия»
  if (pp.last_audit) {
    const days = Math.floor((Date.now() - Date.parse(pp.last_audit)) / 86_400_000);
    const limit = pp.audit_interval_days || 14;
    items.push(item('audit-fresh', 'Ревизия паспорта', days <= limit,
      `последняя — ${pp.last_audit} (${days} дн. назад, интервал ${limit})`,
      'запусти ревизию кнопкой «аудит проекта»: дрейф факт↔паспорт + чистка канона, выход — список предложений'));
  }

  // 8. забор: опасный вход → deny, мусорный вход → deny (fail-closed)
  if (pp.guard) {
    const dangerous = guardAnswers(JSON.stringify({
      tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' }, cwd: root,
    }));
    const garbage = guardAnswers('это не json');
    const ok = dangerous.ok && garbage.ok;
    items.push(item('guard', 'Забор-хук раннера', ok,
      ok ? 'deny на опасный вход и на мусорный (fail-closed)'
        : `опасный вход: ${dangerous.fact}; мусорный: ${garbage.fact}`,
      'почини morda/guard/pretooluse-guard.mjs — пока забор не отвечает deny, bypass-режим закрыт'));
  }

  const ok = items.filter((i) => i.ok).length;
  saveLast(project, { at, ok, total: items.length });
  return { project, at, items };
}

// Итог последнего прогона — живое состояние (дом «пульт»), не истина в git.
// Нужен, чтобы в строке проекта было видно «готов», а не только кнопка:
// человек не должен догадываться, прошёл проект или нет (CTO 21.08).
const LAST_FILE = path.join(MORDA_ROOT, 'passport-last.json');
function loadAll() {
  try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return {}; }
}
function saveLast(project, v) {
  const all = loadAll();
  all[project] = v;
  try {
    fs.writeFileSync(LAST_FILE + '.tmp', JSON.stringify(all, null, 2));
    fs.renameSync(LAST_FILE + '.tmp', LAST_FILE);
  } catch { /* не смогли записать — не повод валить прогон */ }
}
export function passportLast() { return loadAll(); }

/** Сколько байт инструкций Codex реально читает: из его конфига, иначе умолчание. */
function codexDocLimit() {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const m = cfg.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {}
  return 32768;                      // умолчание Codex (codex-rs/core: 32 KiB)
}


/** Закрыта ли ключница от git. Спрашиваем git; если путь за символической
 *  ссылкой (общая ключница рабочей копии), git отказывается смотреть — тогда
 *  сверяем само правило в .gitignore. Важно не «git ответил», а «правило есть
 *  и ничего не закоммичено» (факт 21.08, worktree). */
function secretsIgnored(root) {
  if (git(root, ['check-ignore', '.secrets/']) !== null) return true;
  if (git(root, ['check-ignore', '.secrets']) !== null) return true;
  try {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    return /^\/?\.secrets\/?$/m.test(gi);
  } catch { return false; }
}

function sizeOf(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

// ---------- строгий MCP-профиль сессии (разряды, решение постановщика 21.08) ----------
//
// Сессия под задачу не тащит все серверы машины (факт 21.08: дефолт CLI —
// 25 серверов, 167+ инструментов). Профиль = MCP из паспорта проекта
// (команды — из его .mcp.json, cwd сессии = корень, относительные пути
// работают) + аккаунтные по канону (realm=account, user-scope основного).
// Режет набор ТОЛЬКО связка --strict-mcp-config + --mcp-config: проверено
// фактом — без strict флаг --mcp-config лишь добавляет к дефолту.
export function strictMcpProfile(root) {
  const j = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const canon = j(path.join(MORDA_ROOT, 'canon.json')) || {};
  const acc = j(path.join(os.homedir(), '.claude.json'))?.mcpServers || {};
  const accountIds = [
    ...(canon.items || []).filter((c) => c.kind === 'mcp' && c.realm === 'account').map((c) => c.id),
    ...Object.entries(canon.realms || {}).filter(([, r]) => r === 'account').map(([id]) => id),
  ];
  const servers = {}, from = [], missing = [];
  for (const id of accountIds)
    if (acc[id]) { servers[id] = acc[id]; from.push(`${id} (аккаунтный)`); }
  const pp = j(path.join(root, '.claude', 'passport.json'));
  const proj = j(path.join(root, '.mcp.json'))?.mcpServers || {};
  for (const name of Object.keys(pp?.mcp || {})) {
    // конфиг паспортного сервера: проектный .mcp.json сильнее (едет с репо,
    // относительные пути — от корня), нет в проекте — берём user-scope
    // аккаунта: машинные инструменты (playwright, codebase-memory) живут там,
    // и заставлять дублировать их в каждый .mcp.json — ложный отказ
    // (факт 22.08: psylia не стартовала строгим профилем)
    if (proj[name]) { servers[name] = proj[name]; from.push(`${name} (паспорт, .mcp.json)`); }
    else if (acc[name]) { servers[name] = acc[name]; from.push(`${name} (паспорт, user-scope)`); }
    else missing.push(name);
  }
  return { servers, from, missing };
}
