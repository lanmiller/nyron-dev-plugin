import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Git-панель пульта (мандат CTO 22.08: «чтобы всё было видно и можно было
 *  разобраться с ветками, слияниями, коммитами»). Уровень VS Code Source
 *  Control: статус, диф, stage/commit, ветки, граф, push/pull — по НЕСКОЛЬКИМ
 *  репозиториям проекта (моно-папка ai-evolve с вложенными репо).
 *
 *  Границы безопасности:
 *  - только execFile, никакого shell — аргументы не интерпретируются;
 *  - корень проекта приходит из fleet.rootByName (allowlist projects.json),
 *    репозиторий — относительный путь, резолвится и обязан остаться внутри
 *    корня (паттерн safeJoin из files.js) и быть репозиторием на глубине ≤2;
 *  - пути файлов уходят в git строго после `--`;
 *  - разрушительных операций нет ВОВСЕ: ни force-push, ни hard reset;
 *    discard (git restore / clean одного файла) — единственная потеря
 *    данных, и её подтверждает человек в UI.
 *
 *  Хелпер git() паспорта (passport.js:25) не переиспользован сознательно:
 *  он синхронный и молча глотает ошибки — паспорту так и надо, а панели
 *  нужны async, честные ошибки и большие буферы диффов.
 */

const run = promisify(execFile);

const MAX_BUF = 32 * 1024 * 1024;      // диф ai-evolve на 454 файла — большой
const MAX_DIFF = 400 * 1024;           // больше в браузер не льём — режем с пометкой
const GRAPH_N = 60;

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

async function git(repo, args, { timeout = 15_000 } = {}) {
  const { stdout } = await run('git', ['-C', repo, ...args],
    { timeout, maxBuffer: MAX_BUF, env: ENV });
  return stdout;
}

// шумные каталоги при поиске вложенных репо — тот же смысл, что SKIP в files.js
const SKIP = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build',
  '__pycache__', '.venv', 'venv', '.next', '.turbo', 'coverage', '.cache']);

function isRepo(dir) {
  // .git бывает и папкой (обычный клон), и файлом (worktree, submodule)
  return fs.existsSync(path.join(dir, '.git'));
}

/** Репозитории проекта: сам корень + вложенные на глубину 2 (моно-папка). */
export function findRepos(root) {
  const base = path.resolve(root);
  const out = [];
  if (isRepo(base)) out.push('.');
  const level1 = [];
  for (const e of safeReaddir(base)) {
    const d1 = path.join(base, e);
    if (isRepo(d1)) out.push(e);
    else level1.push(e);
  }
  for (const e of level1) {
    const d1 = path.join(base, e);
    for (const e2 of safeReaddir(d1)) {
      if (isRepo(path.join(d1, e2))) out.push(path.join(e, e2));
    }
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

/** Резолв репозитория внутри корня. Бросает, если путь уводит наружу,
 *  глубже двух уровней или там нет репозитория. */
export function repoPath(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel || '.');
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error('репозиторий вне корня проекта');
  const depth = full === base ? 0 : full.slice(base.length + 1).split(path.sep).length;
  if (depth > 2) throw new Error('репозитории ищутся на глубину 2');
  if (!isRepo(full)) throw new Error(`не репозиторий: ${rel || '.'}`);
  return full;
}

// Статусы в терминах VS Code: M изменён, A добавлен, D удалён, R переименован,
// U неотслеживаемый, C конфликт. Из porcelain v2.
function xyLabel(c) {
  return { M: 'M', T: 'M', A: 'A', D: 'D', R: 'R', C: 'A', U: 'C', '?': 'U' }[c] || c;
}

/** Статус репозитория: ветка, ahead/behind, staged/unstaged списки.
 *  porcelain v2 с -z: имена файлов с любыми символами не ломают парсер. */
export async function status(root, rel) {
  const repo = repoPath(root, rel);
  const raw = await git(repo, ['status', '--porcelain=v2', '-b', '-z', '-uall']);
  const tok = raw.split('\0');
  const st = { branch: null, upstream: null, ahead: 0, behind: 0,
    detached: false, staged: [], unstaged: [], merging: false };
  for (let i = 0; i < tok.length; i++) {
    const line = tok[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice(14);
      if (h === '(detached)') st.detached = true; else st.branch = h;
    } else if (line.startsWith('# branch.upstream ')) {
      st.upstream = line.slice(18);
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { st.ahead = +m[1]; st.behind = +m[2]; }
    } else if (line[0] === '1' || line[0] === '2') {
      const p = line.split(' ');
      const xy = p[1];
      // формат: 1 XY sub mH mI mW hH hI path | 2 … X score path (+ NUL origPath)
      const file = line.split(' ').slice(line[0] === '1' ? 8 : 9).join(' ');
      let orig = null;
      if (line[0] === '2') orig = tok[++i] || null;
      if (xy[0] !== '.') st.staged.push({ file, orig, s: xyLabel(xy[0]) });
      if (xy[1] !== '.') st.unstaged.push({ file, orig, s: xyLabel(xy[1]) });
    } else if (line[0] === 'u') {
      st.merging = true;
      const file = line.split(' ').slice(10).join(' ');
      st.unstaged.push({ file, orig: null, s: 'C' });
    } else if (line[0] === '?') {
      st.unstaged.push({ file: line.slice(2), orig: null, s: 'U' });
    }
  }
  return st;
}

/** Сводка по всем репозиториям проекта — верхняя навигация панели. */
export async function overview(root) {
  const repos = findRepos(root);
  return Promise.all(repos.map(async (rel) => {
    try {
      const st = await status(root, rel);
      return { rel, branch: st.branch, detached: st.detached,
        ahead: st.ahead, behind: st.behind, upstream: st.upstream,
        staged: st.staged.length, changed: st.unstaged.length };
    } catch (e) {
      return { rel, error: String(e.message || e) };
    }
  }));
}

/** Диф одного файла. Неотслеживаемый показываем как сплошное добавление. */
export async function diff(root, rel, file, { staged = false, untracked = false } = {}) {
  const repo = repoPath(root, rel);
  checkRelFile(repo, file);
  let text;
  if (untracked) {
    const full = path.join(repo, file);
    const stat = fs.statSync(full);
    if (stat.size > MAX_DIFF) return { file, text: '', truncated: true, size: stat.size };
    const body = fs.readFileSync(full, 'utf8');
    text = body.split('\n').map((l) => '+' + l).join('\n');
    return { file, text, untracked: true };
  }
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', file);
  text = await git(repo, args);
  const truncated = text.length > MAX_DIFF;
  if (truncated) text = text.slice(0, MAX_DIFF);
  return { file, text, truncated };
}

/** Файл обязан остаться внутри репозитория (та же граница, что в files.js). */
function checkRelFile(repo, file) {
  if (!file) throw new Error('нужен файл');
  const full = path.resolve(repo, file);
  if (full !== repo && !full.startsWith(repo + path.sep))
    throw new Error('файл вне репозитория');
  return full;
}

export async function stage(root, rel, files) {
  const repo = repoPath(root, rel);
  files.forEach((f) => checkRelFile(repo, f));
  await git(repo, ['add', '--', ...files]);
  return { staged: files.length };
}

export async function unstage(root, rel, files) {
  const repo = repoPath(root, rel);
  files.forEach((f) => checkRelFile(repo, f));
  await git(repo, ['restore', '--staged', '--', ...files]);
  return { unstaged: files.length };
}

/** Откат правок файла. Отслеживаемый — restore, неотслеживаемый — clean
 *  одного конкретного файла. Подтверждение — на стороне UI. */
export async function discard(root, rel, files) {
  const repo = repoPath(root, rel);
  files.forEach((f) => checkRelFile(repo, f));
  const tracked = [];
  const untracked = [];
  const known = new Set((await git(repo, ['ls-files', '-z', '--', ...files]))
    .split('\0').filter(Boolean));
  for (const f of files) (known.has(f) ? tracked : untracked).push(f);
  if (tracked.length) await git(repo, ['restore', '--', ...tracked]);
  if (untracked.length) await git(repo, ['clean', '-f', '--', ...untracked]);
  return { discarded: files.length };
}

export async function commit(root, rel, message) {
  const repo = repoPath(root, rel);
  if (!String(message || '').trim()) throw new Error('пустое сообщение коммита');
  // коммитятся только staged-файлы; хуки (pre-commit-secrets) работают
  const out = await git(repo, ['commit', '-m', message], { timeout: 60_000 });
  return { out: out.trim() };
}

/** Ветки: локальные и удалённые, текущая помечена. */
export async function branches(root, rel) {
  const repo = repoPath(root, rel);
  const raw = await git(repo, ['for-each-ref', 'refs/heads', 'refs/remotes',
    '--format=%(refname:short)\x1f%(objectname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(committerdate:unix)\x1f%(refname)']);
  const locals = [];
  const remotes = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, sha, head, upstream, date, ref] = line.split('\x1f');
    const b = { name, sha, current: head === '*', upstream: upstream || null, date: +date * 1000 };
    if (ref.startsWith('refs/remotes/')) {
      if (!name.endsWith('/HEAD')) remotes.push(b);
    } else locals.push(b);
  }
  // текущая — всегда первой, дальше свежие сверху
  locals.sort((a, b) => (b.current - a.current) || (b.date - a.date));
  remotes.sort((a, b) => b.date - a.date);
  return { locals, remotes };
}

/** Переключение ветки — только на чистом дереве (мандат постановщика).
 *  Неотслеживаемые файлы переключению не мешают — как в самом git. */
export async function checkout(root, rel, branch) {
  const repo = repoPath(root, rel);
  await git(repo, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new Error(`некорректное имя ветки: ${branch}`);
  });
  const st = await status(root, rel);
  const dirty = st.staged.length + st.unstaged.filter((f) => f.s !== 'U').length;
  if (dirty) throw new Error(`дерево не чистое (${dirty} файл(ов) с правками) — закоммить или откати перед переключением`);
  // remote-ветка (origin/x) — локальной ветки может не быть: git switch сам
  // создаст трекающую по --guess (поведение по умолчанию)
  const name = branch.replace(/^origin\//, '');
  await git(repo, ['switch', name], { timeout: 30_000 });
  return { switched: name };
}

export async function createBranch(root, rel, name) {
  const repo = repoPath(root, rel);
  await git(repo, ['check-ref-format', '--branch', name]).catch(() => {
    throw new Error(`некорректное имя ветки: ${name}`);
  });
  await git(repo, ['switch', '-c', name]);
  return { created: name };
}

/** Влить ветку в текущую (обычно main). Только чистое дерево; конфликт —
 *  честная ошибка с abort, полурезультат в дереве не оставляем.
 *  (CTO 22.08: «как мне вливать?» — мержи делались руками сессии) */
export async function merge(root, rel, branch) {
  const repo = repoPath(root, rel);
  await git(repo, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new Error(`некорректное имя ветки: ${branch}`);
  });
  const st = await status(root, rel);
  const dirty = st.staged.length + st.unstaged.filter((f) => f.s !== 'U').length;
  if (dirty) throw new Error(`дерево не чистое (${dirty} файл(ов)) — закоммить или откати перед мержем`);
  const into = (await git(repo, ['branch', '--show-current'])).trim() || '(detached)';
  try {
    await git(repo, ['merge', '--no-ff', branch,
      '-m', `мерж ${branch} в ${into} (git-панель пульта)`], { timeout: 60_000 });
  } catch (e) {
    await git(repo, ['merge', '--abort']).catch(() => {});
    throw new Error(`конфликт при мерже ${branch} в ${into} — мерж отменён, дерево цело; разведи конфликт в сессии`);
  }
  return { merged: branch, into };
}

/** Прибрать ветку: удалить локально и на origin — ТОЛЬКО если влита в
 *  текущую. Невлитую не трогаем вовсе («прибраться» ≠ «потерять работу»).
 *  Если ветку держит worktree — сносим его, но лишь с чистым деревом. */
export async function tidyBranch(root, rel, branch) {
  const repo = repoPath(root, rel);
  await git(repo, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new Error(`некорректное имя ветки: ${branch}`);
  });
  const cur = (await git(repo, ['branch', '--show-current'])).trim();
  if (branch === cur) throw new Error('это текущая ветка — сначала переключись');
  const notMerged = (await git(repo, ['branch', '--no-merged', 'HEAD']))
    .split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim());
  if (notMerged.includes(branch))
    throw new Error(`ветка ${branch} НЕ влита в текущую — прибирать отказываюсь; сначала «влить»`);
  // ветку может держать рабочая копия (git worktree) — снесём, если чистая
  const wt = (await git(repo, ['worktree', 'list', '--porcelain']))
    .split('\n\n').map((b) => ({
      dir: b.match(/^worktree (.+)$/m)?.[1],
      br: b.match(/^branch refs\/heads\/(.+)$/m)?.[1],
    })).find((w) => w.br === branch);
  const out = { removed: branch };
  if (wt?.dir) {
    const wtDirty = (await git(wt.dir, ['status', '--porcelain'])).trim();
    if (wtDirty) throw new Error(`рабочая копия ${wt.dir} не чистая — прибери или закоммить в ней сначала`);
    await git(repo, ['worktree', 'remove', wt.dir], { timeout: 30_000 });
    out.worktree = wt.dir;
  }
  await git(repo, ['branch', '-d', branch]);
  const hadRemote = (await git(repo, ['branch', '-r']))
    .split('\n').some((l) => l.trim() === `origin/${branch}`);
  if (hadRemote) {
    await git(repo, ['push', 'origin', '--delete', branch], { timeout: 30_000 });
    out.remote = `origin/${branch} удалена`;
  }
  return out;
}

/** Граф: последние коммиты всех веток в topo-порядке + раскладка по колонкам.
 *  Раскладка простая (колонка на ветку): активные дорожки ждут своего
 *  родителя; коммит занимает первую ждущую его дорожку, его родители
 *  занимают её же и новые справа. Этого достаточно, чтобы видеть мержи. */
export async function graph(root, rel) {
  const repo = repoPath(root, rel);
  const raw = await git(repo, ['log', '--branches', '--remotes', '--topo-order',
    `-n${GRAPH_N}`, '--date=format:%d.%m %H:%M',
    '--pretty=format:%H\x1f%P\x1f%an\x1f%ad\x1f%D\x1f%s\x1e']);
  const commits = raw.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean)
    .map((line) => {
      const [sha, parents, author, date, refs, subject] = line.split('\x1f');
      return { sha, parents: parents ? parents.split(' ') : [],
        author, date, subject,
        refs: refs ? refs.split(', ').filter(Boolean) : [] };
    });
  // lanes[i] — sha, которого дорожка ждёт (null — свободна)
  const lanes = [];
  for (const c of commits) {
    const waiting = [];
    lanes.forEach((sha, i) => { if (sha === c.sha) waiting.push(i); });
    let lane;
    if (waiting.length) {
      lane = waiting[0];                       // главная дорожка коммита
      for (const i of waiting.slice(1)) lanes[i] = null;  // мерж: ветки сошлись
    } else {
      lane = lanes.indexOf(null);              // новая голова — свободная колонка
      if (lane === -1) lane = lanes.length;
    }
    c.lane = lane;
    c.merged = waiting.slice(1);               // дорожки, влившиеся в эту точку
    // родители: первый продолжает дорожку, остальные открывают новые
    if (c.parents.length === 0) lanes[lane] = null;
    else {
      lanes[lane] = c.parents[0];
      for (const p of c.parents.slice(1)) {
        let free = lanes.indexOf(null);
        // родитель уже ожидается другой дорожкой — новую не открываем
        if (lanes.includes(p)) continue;
        if (free === -1) { free = lanes.length; }
        lanes[free] = p;
      }
    }
    c.snapshot = [...lanes];                   // состояние дорожек ПОСЛЕ коммита
  }
  return { commits, laneCount: Math.max(1, ...commits.map((c) => c.lane + 1)) };
}

/** Один коммит: сообщение целиком и изменённые файлы. */
export async function commitInfo(root, rel, sha) {
  const repo = repoPath(root, rel);
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) throw new Error('некорректный sha');
  const raw = await git(repo, ['show', '--name-status', '--format=%H\x1f%an\x1f%ad\x1f%B\x1e',
    '--date=format:%d.%m.%Y %H:%M', sha]);
  const [head, rest] = raw.split('\x1e');
  const [h, author, date, body] = head.split('\x1f');
  const files = (rest || '').split('\n').filter(Boolean).map((l) => {
    const [s, ...f] = l.split('\t');
    return { s: xyLabel(s[0]), file: f[f.length - 1], orig: f.length > 1 ? f[0] : null };
  });
  return { sha: h, author, date, message: body.trim(), files };
}

// Сетевые операции: без force, pull только fast-forward — дивергенцию
// человек разбирает сам (панель её честно покажет через ahead/behind).
export async function push(root, rel) {
  const repo = repoPath(root, rel);
  const st = await status(root, rel);
  const args = st.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
  const out = await run('git', ['-C', repo, ...args],
    { timeout: 60_000, maxBuffer: MAX_BUF, env: ENV });
  return { out: (out.stderr || out.stdout).trim() };
}

export async function pull(root, rel) {
  const repo = repoPath(root, rel);
  const out = await run('git', ['-C', repo, 'pull', '--ff-only'],
    { timeout: 60_000, maxBuffer: MAX_BUF, env: ENV });
  return { out: (out.stderr || out.stdout).trim() };
}

export async function fetch(root, rel) {
  const repo = repoPath(root, rel);
  await git(repo, ['fetch', '--prune'], { timeout: 60_000 });
  return { fetched: true };
}
