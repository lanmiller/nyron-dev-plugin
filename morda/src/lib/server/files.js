import fs from 'node:fs';
import path from 'node:path';

/** Обозреватель файлов проекта (требование CTO 11.08: «файлы должны быть
 *  доступны для просмотра — и репы, и проекта, мне же надо их посмотреть»).
 *  Показываем ВЕСЬ корень проекта, а не только рабочую папку сессии.
 *
 *  Граница безопасности одна и жёсткая: любой путь резолвится и обязан
 *  остаться внутри корня проекта — иначе отказ. Морда слушает только петлю,
 *  но обозреватель читает файлы, поэтому выход за корень недопустим и здесь
 *  (иначе `../../.ssh/id_rsa` уедет в браузер). */

// шумные каталоги: в дереве от них пользы нет, а обход дорогой
const SKIP = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build',
  '__pycache__', '.pytest_cache', '.ruff_cache', '.venv', 'venv', '.next',
  '.turbo', 'coverage', '.cache']);

const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.svelte', '.json', '.yml', '.yaml', '.toml', '.py', '.sh', '.bash',
  '.zsh', '.css', '.scss', '.html', '.sql', '.env', '.ini', '.cfg', '.conf',
  '.xml', '.svg', '.gitignore', '.dockerignore', '.example', '.lock', '.rs',
  '.go', '.java', '.kt', '.rb', '.php', '.vue', '.astro', '.jsonl',
  '.csv', '.tsv']);

// картинки отдаются сырым потоком (mode=raw) и показываются как картинки —
// скриншоты требований и дизайна смотрят прямо в пульте (CTO 11.08)
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};
const VIEWER_MIME = { ...IMAGE_MIME, '.pdf': 'application/pdf' };
export function viewerMime(rel) {
  return VIEWER_MIME[path.extname(rel).toLowerCase()] || null;
}

const MAX_RAW = 25 * 1024 * 1024;  // потолок на отдачу сырого файла
const MAX_BYTES = 512 * 1024;   // больше — отдаём голову и честно говорим
const MAX_ENTRIES = 400;        // защита от каталогов на десятки тысяч файлов

/** Резолв пути внутри корня. Бросает, если уводит наружу. */
function safeJoin(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel || '.');
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error('путь вне корня проекта');
  return full;
}

/** Один уровень дерева: папки сверху, дальше по алфавиту. */
export function listDir(root, rel = '') {
  const full = safeJoin(root, rel);
  const st = fs.statSync(full);
  if (!st.isDirectory()) throw new Error('это не каталог');
  const out = [];
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.name.startsWith('.') && SKIP.has(e.name)) continue;
    if (SKIP.has(e.name)) continue;
    const child = path.join(full, e.name);
    let size = null, mtime = null;
    try { const s = fs.statSync(child); size = s.size; mtime = s.mtime.toISOString(); } catch {}
    out.push({
      name: e.name,
      path: path.relative(path.resolve(root), child),
      dir: e.isDirectory(),
      size, mtime,
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  return { path: rel || '', entries: out, truncated: out.length >= MAX_ENTRIES };
}

/** Сырой файл для просмотрщика: картинки и PDF. Возвращает буфер и тип. */
export function rawFile(root, rel) {
  const full = safeJoin(root, rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('это каталог');
  const mime = viewerMime(rel);
  if (!mime) throw new Error('этот тип не показывается просмотрщиком');
  if (st.size > MAX_RAW) throw new Error(`файл больше ${MAX_RAW / 1048576} МБ`);
  return { buf: fs.readFileSync(full), mime };
}

/** Содержимое файла. Двоичное не отдаём — только признак. */
export function readFile(root, rel) {
  const full = safeJoin(root, rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('это каталог');
  const ext = path.extname(full).toLowerCase() || path.basename(full).toLowerCase();
  // картинку и PDF текстом не читаем — клиент запросит их сырым режимом
  const mime = viewerMime(rel);
  if (mime && ext !== '.svg')
    return { path: rel, size: st.size, binary: true, viewer: mime, text: null,
      mtime: st.mtime.toISOString() };
  const isText = TEXT_EXT.has(ext) || st.size < 64 * 1024;
  if (!isText)
    return { path: rel, size: st.size, binary: true, text: null,
      mtime: st.mtime.toISOString() };
  const fd = fs.openSync(full, 'r');
  try {
    const len = Math.min(st.size, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    // нулевые байты в начале — верный признак двоичного файла
    if (buf.subarray(0, 4096).includes(0))
      return { path: rel, size: st.size, binary: true, text: null,
        mtime: st.mtime.toISOString() };
    return {
      path: rel, size: st.size, binary: false,
      truncated: st.size > MAX_BYTES,
      text: buf.toString('utf8'),
      mtime: st.mtime.toISOString(),
      lang: ext.replace(/^\./, ''),
    };
  } finally { fs.closeSync(fd); }
}

/** Поиск по именам, а с `?` в начале запроса — по содержимому текстовых
 *  файлов (как в Claude Desktop: «?text to search contents»). */
export function searchFiles(root, query, { limit = 60 } = {}) {
  const base = path.resolve(root);
  const byContent = query.startsWith('?');
  const needle = (byContent ? query.slice(1) : query).trim().toLowerCase();
  if (!needle) return { query, entries: [] };
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= limit || depth > 8) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (hits.length >= limit) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const rel = path.relative(base, full);
      if (!byContent) {
        if (rel.toLowerCase().includes(needle)) hits.push({ path: rel, name: e.name });
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_BYTES) continue;
        const text = fs.readFileSync(full, 'utf8');
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) {
          const from = Math.max(0, at - 60);
          hits.push({ path: rel, name: e.name,
            excerpt: text.slice(from, at + 120).replace(/\s+/g, ' ').trim(),
            line: text.slice(0, at).split('\n').length });
        }
      } catch {}
    }
  };
  walk(base, 0);
  return { query, byContent, entries: hits };
}
