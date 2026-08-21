/**
 * configurator.js — матрица «инструмент × копия × проект» (замысел
 * docs/specs/2026-08-20-configurator.md). Три адресата состояния:
 *   основной аккаунт (CLAUDE_CONFIG_DIR или ~/.claude + ~/.claude.json),
 *   копии подписок (slots.json, только claude-слоты со своим home),
 *   проекты машины (паспорт .claude/passport.json — «нужен ли по канону»).
 *
 * Канон флота — morda/canon.json (едет в git, правится руками): ПОЛНЫЙ
 * список того, что обязано стоять у всех. Матрица показывает расхождения,
 * не чинит их молча: постановка CTO 21.08 — сначала довести ОСНОВНОЙ до
 * канона и смоукнуть, только потом раздавать копиям. Поэтому configSync
 * закрыт гейтом «основной зелёный», а сама раздача — существующий
 * slotSync (runner.js:508), здесь он НЕ дублируется.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projects, rootByName, MORDA_ROOT, CLAUDE_BIN, SPAWN_ENV } from './fleet.js';
import { claudeSlots, slotSync } from './runner.js';
import { mcpSmoke } from './passport.js';

const CANON_FILE = path.join(MORDA_ROOT, 'canon.json');
const mainDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function canonItems() {
  const d = readJson(CANON_FILE);
  if (!d?.items?.length) throw new Error(`канон не читается: ${CANON_FILE}`);
  return d.items;
}
// ярлыки внеканонных инструментов (canon.json → tags): «тестовый» и т.п.
function canonTags() {
  return readJson(CANON_FILE)?.tags || {};
}
// разряды внеканонных (canon.json → realms): account | session;
// у канонных разряд лежит прямо в item.realm
function canonRealms() {
  return readJson(CANON_FILE)?.realms || {};
}
const canonOf = (kind, id) =>
  canonItems().find((c) => c.kind === kind && c.id === id) || null;

// ---------- обнаружение: стоит ли инструмент у адресата ----------
//
// Адресат = конфиг-каталог CLI (dir) + файл аккаунта .claude.json (acc):
// у основного это ~/.claude и ~/.claude.json, у копии — её home и
// <home>/.claude.json. Скиллы и плагины живут в каталоге, user-scope
// MCP — в файле аккаунта (так же их берёт slotSync).

function skillAt(dir, id) {
  const ok = fs.existsSync(path.join(dir, 'skills', id));
  return { ok, fact: ok ? `skills/${id}` : `нет каталога skills/${id}` };
}

function pluginAt(dir, id) {
  const st = readJson(path.join(dir, 'settings.json'));
  const key = Object.keys(st?.enabledPlugins || {}).find((k) => k.split('@')[0] === id);
  if (key && st.enabledPlugins[key]) return { ok: true, fact: `включён: ${key}` };
  if (key) return { ok: false, fact: `выключен в settings.json: ${key}` };
  return { ok: false, fact: st ? 'нет в enabledPlugins' : 'settings.json нет или пуст' };
}

function mcpAt(dir, acc, id, { scanProjects = false } = {}) {
  if (acc?.mcpServers?.[id]) return { ok: true, fact: 'user-scope (.claude.json)' };
  const mc = readJson(path.join(dir, 'mcp_config.json'));
  if (mc?.mcpServers?.[id]) return { ok: true, fact: 'mcp_config.json' };
  // проектный scope основного: стоит, но флоту не раздаётся (slotSync
  // мержит только user-scope) — честный жёлтый факт, а не зелёная галка
  if (scanProjects) {
    const where = Object.entries(acc?.projects || {})
      .filter(([, p]) => p?.mcpServers?.[id]).map(([root]) => path.basename(root));
    if (where.length) return { ok: false,
      fact: `только project-scope: ${where.join(', ')} — копиям не раздаётся` };
  }
  return { ok: false, fact: 'не прописан' };
}

function detect(item, dir, acc, isMain) {
  if (item.kind === 'skill') return skillAt(dir, item.id);
  if (item.kind === 'plugin') return pluginAt(dir, item.id);
  return mcpAt(dir, acc, item.id, { scanProjects: isMain });
}

// ---------- нужен ли проекту (паспорт) ----------

function passportOf(root) {
  return readJson(path.join(root, '.claude', 'passport.json'));
}
function needIn(item, pp) {
  if (!pp) return { required: false, fact: 'паспорта нет' };
  if (item.kind === 'mcp') {
    const e = pp.mcp?.[item.id];
    return e ? { required: true, fact: e.smoke ? `смоук: ${e.smoke.tool}` : 'смоук: tools/list' }
      : { required: false, fact: null };
  }
  if (item.kind === 'plugin')
    return pp.plugin?.name === item.id
      ? { required: true, fact: `≥${pp.plugin.min_version || 'любая'}` }
      : { required: false, fact: null };
  return (pp.skills || []).includes(item.id)
    ? { required: true, fact: 'в паспорте (skills)' } : { required: false, fact: null };
}

// ---------- сама матрица ----------

export function configMatrix() {
  const md = mainDir();
  const mainAcc = readJson(path.join(os.homedir(), '.claude.json')) || {};
  const slots = claudeSlots();
  const projs = projects();
  const pps = projs.map((p) => ({ name: p.name, pp: passportOf(p.root) }));

  const tags = canonTags();
  const realms = canonRealms();
  const row = (item, isCanon) => {
    const copies = {};
    for (const s of slots)
      copies[s.id] = detect(item, s.home, readJson(path.join(s.home, '.claude.json')) || {}, false);
    const inProjects = {};
    for (const { name, pp } of pps) inProjects[name] = needIn(item, pp);
    return { ...item, canon: isCanon, tag: tags[item.id] || null,
      realm: item.realm || realms[item.id] || null,
      main: detect(item, md, mainAcc, true), copies, projects: inProjects };
  };

  const rows = canonItems().map((c) => row(c, true));

  // вне канона, но фактически стоит у основного — показываем как «директорию»
  // (замысел §1: карточки того, что есть), решение «в канон или снести» — за CTO
  const seen = new Set(rows.map((r) => `${r.kind}:${r.id}`));
  const extras = [];
  let skills = [];
  try { skills = fs.readdirSync(path.join(md, 'skills')).filter((s) => !s.startsWith('.')); }
  catch {}
  for (const s of skills) if (!seen.has(`skill:${s}`))
    extras.push(row({ id: s, kind: 'skill', title: s }, false));
  for (const m of Object.keys(mainAcc.mcpServers || {})) if (!seen.has(`mcp:${m}`))
    extras.push(row({ id: m, kind: 'mcp', title: m }, false));
  const st = readJson(path.join(md, 'settings.json'));
  for (const k of Object.keys(st?.enabledPlugins || {})) {
    const id = k.split('@')[0];
    if (st.enabledPlugins[k] && !seen.has(`plugin:${id}`) && !extras.some((e) => e.id === id))
      extras.push(row({ id, kind: 'plugin', title: id, marketplace: k.split('@')[1] }, false));
  }

  const red = rows.filter((r) => !r.main.ok);
  return {
    at: new Date().toISOString(),
    items: [...rows, ...extras],
    copies: slots.map((s) => ({ id: s.id, label: s.label })),
    projects: projs.map((p) => p.name),
    main_green: !red.length,
    main_red: red.map((r) => r.title || r.id),
  };
}

// ---------- «нужен проекту»: запись в паспорт ----------

export function configRequire({ project, kind, name, required = true }) {
  const root = rootByName(project);
  const file = path.join(root, '.claude', 'passport.json');
  const pp = readJson(file) || { version: 1 };
  const c = canonOf(kind, name);
  if (kind === 'mcp') {
    if (required) {
      pp.mcp = pp.mcp || {};
      pp.mcp[name] = pp.mcp[name]
        || { keys: [], ...(c?.smoke ? { smoke: c.smoke } : {}) };
    } else if (pp.mcp) delete pp.mcp[name];
  } else if (kind === 'skill') {
    const set = new Set(pp.skills || []);
    required ? set.add(name) : set.delete(name);
    pp.skills = [...set].sort();
    if (!pp.skills.length) delete pp.skills;
  } else if (kind === 'plugin') {
    if (required) {
      if (pp.plugin && pp.plugin.name !== name)
        throw new Error(`в паспорте уже плагин ${pp.plugin.name} — второго поля v1 не знает`);
      pp.plugin = pp.plugin || { name, marketplace: c?.marketplace || null };
    } else if (pp.plugin?.name === name) delete pp.plugin;
  } else throw new Error('kind: mcp|skill|plugin');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(pp, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return { project, kind, name, required };
}

// ---------- «проверить фактом»: смоук одного инструмента ----------

export async function configSmoke({ kind, name, project }) {
  if (kind === 'skill') {
    const f = path.join(mainDir(), 'skills', name, 'SKILL.md');
    if (!fs.existsSync(f)) return { ok: false, fact: `нет файла ${f}` };
    // description бывает YAML-скаляром (>- / |): берём первую содержательную
    // строку после ключа, а не сам маркер переноса
    const m = fs.readFileSync(f, 'utf8').match(/^description:\s*(.*)$([\s\S]{0,400})/m);
    const desc = ((m?.[1] && !/^[>|][+-]?$/.test(m[1].trim()))
      ? m[1] : m?.[2]?.split('\n').find((l) => l.trim()))?.trim().slice(0, 120);
    return { ok: true, fact: `SKILL.md на месте${desc ? `: ${desc}…` : ''}` };
  }
  if (kind === 'plugin') {
    const c = canonOf(kind, name);
    const base = path.join(mainDir(), 'plugins', 'cache', c?.marketplace || '', name);
    let vers = [];
    try { vers = fs.readdirSync(base); } catch {}
    return vers.length
      ? { ok: true, fact: `установлен в plugins/cache: ${vers.join(', ')}` }
      : { ok: false, fact: `нет установленной копии: ${base}` };
  }
  if (kind !== 'mcp') throw new Error('kind: mcp|skill|plugin');
  // конфиг сервера: паспорт проекта (его .mcp.json) либо user-scope основного
  let cfg = null, smoke = null, cwd = MORDA_ROOT;
  if (project) {
    const root = rootByName(project);
    cfg = readJson(path.join(root, '.mcp.json'))?.mcpServers?.[name];
    smoke = passportOf(root)?.mcp?.[name]?.smoke || null;
    cwd = root;
    if (!cfg) return { ok: false, fact: `сервера ${name} нет в .mcp.json проекта ${project}` };
  } else {
    const acc = readJson(path.join(os.homedir(), '.claude.json')) || {};
    cfg = acc.mcpServers?.[name]
      || readJson(path.join(mainDir(), 'mcp_config.json'))?.mcpServers?.[name];
    if (!cfg) return { ok: false, fact: 'не прописан у основного (user-scope)' };
  }
  if (cfg.type && cfg.type !== 'stdio')
    return { ok: null, fact: `сервер типа ${cfg.type} — смоук из пульта не поддержан` };
  // без явного смоука зовётся tools/list — это тоже реальный запуск сервера
  const r = await mcpSmoke({ cfg: { ...cfg, cwd },
    tool: smoke?.tool || null, args: smoke?.args || {}, timeoutMs: 60_000 });
  return { ok: r.ok, fact: r.fact };
}

// ---------- раздача копиям: зеркало с предупреждением и гейтом ----------

// slotSync — зеркало: skills/rules/agents/commands/plugins сносятся и
// заменяются конфигом основного (user-scope MCP — мержатся). Что именно
// потеряет копия — человек видит ДО нажатия (постановка CTO 21.08).
export function syncPreview({ id }) {
  const s = claudeSlots().find((x) => x.id === id);
  if (!s) throw new Error(`нет claude-копии ${id}`);
  const md = mainDir();
  const lost = [];
  for (const dirName of ['skills', 'rules', 'agents', 'commands']) {
    let ours = [];
    try { ours = fs.readdirSync(path.join(s.home, dirName)).filter((x) => !x.startsWith('.')); }
    catch { continue; }
    for (const x of ours)
      if (!fs.existsSync(path.join(md, dirName, x))) lost.push(`${dirName}/${x}`);
  }
  const replaced = ['settings.json', 'mcp_config.json', 'skills', 'rules',
    'agents', 'commands', 'plugins'].filter((i) => fs.existsSync(path.join(md, i)));
  const copyOnlyMcp = Object.keys(readJson(path.join(s.home, '.claude.json'))?.mcpServers || {})
    .filter((m) => !(readJson(path.join(os.homedir(), '.claude.json'))?.mcpServers || {})[m]);
  return { id, label: s.label, replaced, lost,
    kept_mcp: copyOnlyMcp, // user-scope мержится — свои серверы копия сохранит
  };
}

/** Гейт постановщика: раздача закрыта, пока основной сам не по канону. */
export function configSync({ id }) {
  const m = configMatrix();
  if (!m.main_green)
    throw new Error(`основной не по канону — раздача закрыта: ${m.main_red.join('; ')}`);
  return slotSync({ id });
}

// ---------- «поставить основному»: MCP и скиллы-с-источником из канона ----------

// Скилл ставится копией из git-источника (canon.json → source, путь от
// MORDA_ROOT) — так канонный скилл живёт в репо, а не «где-то в ~/.claude».
// Плагин пульт не ставит: он ставится в самом CLI — честная ошибка.
export function configInstall({ kind, name }) {
  if (kind === 'skill') {
    const c = canonOf('skill', name);
    if (!c?.source) throw new Error('у скилла нет source в canon.json — источник назовёт CTO');
    const from = path.resolve(MORDA_ROOT, c.source);
    if (from !== MORDA_ROOT && !from.startsWith(MORDA_ROOT + path.sep))
      throw new Error(`source вне morda: ${c.source}`);
    if (!fs.existsSync(path.join(from, 'SKILL.md')))
      throw new Error(`в источнике нет SKILL.md: ${from}`);
    const to = path.join(mainDir(), 'skills', name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    return { installed: name, note: `скопирован из ${c.source}` };
  }
  if (kind !== 'mcp')
    throw new Error('плагин ставится в самом CLI: /plugin marketplace add …');
  const c = canonOf('mcp', name);
  if (!c?.install) throw new Error(`в canon.json нет install для ${name}`);
  const out = execFileSync(CLAUDE_BIN,
    ['mcp', 'add-json', name, JSON.stringify(c.install), '--scope', 'user'],
    { timeout: 20_000, env: SPAWN_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return { installed: name, note: out.trim().split('\n').at(-1) || 'добавлен user-scope' };
}
