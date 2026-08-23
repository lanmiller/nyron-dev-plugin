/**
 * keys.js — наполнение ключницы проекта из пульта.
 *
 * Зачем отдельная ручка: значения ключей не должны проходить через контекст
 * сессии (забор запрещает ей `.secrets/*`), а положить их кто-то обязан.
 * Пульт — единственное место, где человек имеет дело со значениями, и он
 * их НИКОГДА не отдаёт обратно: наружу уходят только имена и «задано/нет».
 *
 * Два входа, оба без показа значений:
 *   keysImport — человек вставляет строки KEY=VALUE (или целый .env);
 *   keysAdopt  — забрать значения, которые УЖЕ лежат в .mcp.json проекта,
 *                и сложить их в ключницу (сам .mcp.json не трогаем — на
 *                указатели его переводит аудитор отдельным шагом).
 */
import fs from 'node:fs';
import path from 'node:path';
import { rootByName } from './fleet.js';
import { MORDA_ROOT } from './plugin-hub.js';

const FILE = 'env';                       // одна ключница на проект (решение CTO 19.08)
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function dirOf(root) { return path.join(root, '.secrets'); }
function fileOf(root) { return path.join(dirOf(root), FILE); }

/** Разбор KEY=VALUE: пустые строки и комментарии пропускаем, имена проверяем. */
function parsePairs(text) {
  const out = new Map();
  const bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) { bad.push(line.slice(0, 24)); continue; }
    const key = line.slice(0, i).trim().replace(/^export\s+/, '');
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!NAME_RE.test(key)) { bad.push(key.slice(0, 24)); continue; }
    if (val) out.set(key, val);
  }
  return { pairs: out, bad };
}

function readExisting(root) {
  try { return parsePairs(fs.readFileSync(fileOf(root), 'utf8')).pairs; }
  catch { return new Map(); }
}

/** Ключница в .gitignore — проверяем и чиним, иначе первый коммит унесёт ключи. */
function ensureIgnored(root) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch {}
  if (/^\/?\.secrets\/?$/m.test(text)) return false;
  const add = (text && !text.endsWith('\n') ? '\n' : '')
    + '\n# Ключница проекта: значения ключей, в git не едет никогда\n/.secrets/\n';
  fs.writeFileSync(gi, text + add);
  return true;
}

function write(root, pairs) {
  fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
  const body = [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const tmp = fileOf(root) + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, fileOf(root));
}

/** Ключница САМОГО пульта (рядом с morda/) — объектом KEY→VALUE для
 *  серверных потребителей: судья (judge.js) и трекер (jira.js). Разбор тот
 *  же, что у ручек человека, — второй читалки формата у пульта быть не
 *  должно. Наружу значения не отдаются никогда, только читаются кодом.
 *  Файла нет — пустой объект: потребитель обязан жить без ключей. */
export function keysEnv() {
  try {
    return Object.fromEntries(parsePairs(
      fs.readFileSync(fileOf(path.resolve(MORDA_ROOT, '..')), 'utf8')).pairs);
  } catch { return {}; }
}

/** Что в ключнице — ТОЛЬКО имена. Значения наружу не отдаются никогда. */
export function keysStatus({ project }) {
  const root = rootByName(project);
  const names = [...readExisting(root).keys()].sort();
  return { project, exists: fs.existsSync(fileOf(root)), names };
}

/** Показать значение ОДНОГО ключа — хозяину в пульт, по клику. Сессиям путь
 *  закрыт забором; это ручка человека: «не вижу значение — не могу поправить»
 *  (CTO 22.08). Наружу пульт торчит только с паролем ключницы. */
export function keysReveal({ project, name }) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('имя ключа: A-Z и подчёркивания');
  const root = rootByName(project);
  const v = readExisting(root).get(name);
  if (v === undefined) throw new Error(`ключа ${name} в ключнице нет`);
  return { name, value: v };
}

/** Удалить один ключ из ключницы. */
export function keysRemove({ project, name }) {
  const root = rootByName(project);
  const merged = readExisting(root);
  if (!merged.delete(String(name || ''))) throw new Error(`ключа ${name} нет`);
  write(root, merged);
  return { removed: name, total: merged.size };
}

/** Залить строки KEY=VALUE. Существующие имена перетираются новыми значениями. */
export function keysImport({ project, text }) {
  const root = rootByName(project);
  const { pairs, bad } = parsePairs(text);
  if (!pairs.size) throw new Error('не нашёл ни одной строки вида KEY=VALUE');
  const merged = readExisting(root);
  const added = [], updated = [];
  for (const [k, v] of pairs) {
    (merged.has(k) ? updated : added).push(k);
    merged.set(k, v);
  }
  const ignoreFixed = ensureIgnored(root);
  write(root, merged);
  return { added, updated, skipped: bad, ignoreFixed, total: merged.size };
}

/** Забрать значения из .mcp.json проекта — они там лежат открытым текстом. */
export function keysAdopt({ project }) {
  const root = rootByName(project);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')); }
  catch (e) { throw new Error(`.mcp.json не читается: ${e.message}`); }
  const found = new Map();
  for (const srv of Object.values(cfg.mcpServers || {})) {
    for (const [k, v] of Object.entries(srv.env || {})) {
      if (NAME_RE.test(k) && typeof v === 'string' && v) found.set(k, v);
    }
  }
  if (!found.size) return { added: [], updated: [], from: '.mcp.json', total: keysStatus({ project }).names.length };
  const merged = readExisting(root);
  const added = [], updated = [];
  for (const [k, v] of found) {
    (merged.has(k) ? updated : added).push(k);
    merged.set(k, v);
  }
  const ignoreFixed = ensureIgnored(root);
  write(root, merged);
  return { added, updated, ignoreFixed, from: '.mcp.json', total: merged.size };
}
