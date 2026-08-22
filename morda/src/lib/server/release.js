/**
 * release.js — выкат плагина nyron-dev одной кнопкой пульта (план 22.08 п.5).
 * Пульт показывает дифф «что поедет» (releaseStatus) и делает весь цикл
 * (releaseRun): бамп двух json → CHANGELOG → коммит → push → обновление
 * marketplace-клона → обновление установок (user И project — урок 22.08:
 * project-scope, прибитый к старой версии, молча перекрывает user-scope).
 * САМ выкат — только нажатием человека в UI; автоматики нет нигде.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MORDA_ROOT, CLAUDE_BIN, SPAWN_ENV } from './fleet.js';

const REPO = path.dirname(MORDA_ROOT);                    // корень nyron-dev-plugin
const PLUGIN_JSON = path.join(REPO, 'nyron-dev', '.claude-plugin', 'plugin.json');
const MARKET_JSON = path.join(REPO, '.claude-plugin', 'marketplace.json');
const CHANGELOG = path.join(REPO, 'CHANGELOG.md');
const MKT = 'nyron-dev-marketplace-v2';
const PLUGIN_KEY = `nyron-dev@${MKT}`;
const MKT_CLONE = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', MKT);
const CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache', MKT, 'nyron-dev');
const INSTALLED = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const claude = (args, cwd = REPO) =>
  execFileSync(CLAUDE_BIN, args, { cwd, timeout: 120_000, env: SPAWN_ENV,
    stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// установки этого плагина у основного (по scope) — из реестра CLI
function installRecords() {
  const d = readJson(INSTALLED);
  return d?.plugins?.[PLUGIN_KEY] || [];
}

/** Дифф «что поедет»: версии по всем точкам пути + коммиты с прошлого выката. */
export function releaseStatus() {
  const devVersion = readJson(PLUGIN_JSON)?.version || null;
  const marketVersion = readJson(MARKET_JSON)?.plugins?.[0]?.version || null;
  const cloneSha = (() => { try { return git(MKT_CLONE, 'rev-parse', '--short', 'HEAD'); } catch { return null; } })();
  const headSha = git(REPO, 'rev-parse', '--short', 'main');
  // что изменилось в плагине с версии, которую видит marketplace-клон
  let commits = [];
  if (cloneSha) {
    try {
      commits = git(REPO, 'log', '--oneline', `${cloneSha}..main`,
        '--', 'nyron-dev', '.claude-plugin', 'CHANGELOG.md').split('\n').filter(Boolean);
    } catch { commits = []; } // клон мог уйти вперёд/в сторону — покажем пусто
  }
  // незакоммиченное в файлах плагина — в выкат не поедет, честно предупредить
  const dirty = git(REPO, 'status', '--porcelain', '--', 'nyron-dev', '.claude-plugin', 'CHANGELOG.md')
    .split('\n').filter(Boolean);
  let cache = [];
  try { cache = fs.readdirSync(CACHE_DIR); } catch {}
  const installs = installRecords().map((r) => ({
    scope: r.scope, version: r.version, projectPath: r.projectPath || null }));
  // предложение следующей версии: минорный бамп (как сложилось: 0.9 → 0.10)
  const m = String(devVersion || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const suggest = m ? `${m[1]}.${+m[2] + 1}.0` : null;
  return { devVersion, marketVersion, cloneSha, headSha, commits, dirty,
    cache, installs, suggest,
    up_to_date: !commits.length && installs.every((i) => i.version === devVersion) };
}

/** Сам выкат. Зовётся ТОЛЬКО кнопкой человека в UI (confirm обязателен). */
export function releaseRun({ version, notes, confirm }) {
  if (!confirm) throw new Error('выкат без подтверждения не выполняется');
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('версия: x.y.z');
  const st = releaseStatus();
  if (st.dirty.length)
    throw new Error(`в файлах плагина незакоммиченное — сначала закоммить: ${st.dirty.join('; ')}`);
  const cmp = version.split('.').map(Number), cur = String(st.devVersion).split('.').map(Number);
  const newer = cmp[0] !== cur[0] ? cmp[0] > cur[0] : cmp[1] !== cur[1] ? cmp[1] > cur[1] : cmp[2] > cur[2];
  if (!newer) throw new Error(`версия ${version} не новее текущей ${st.devVersion}`);
  const onMain = git(REPO, 'branch', '--show-current') === 'main';
  if (!onMain) throw new Error('основной чекаут не на main — выкат только с main');

  const steps = [];
  // 1. бамп версий в двух json
  const pj = readJson(PLUGIN_JSON); pj.version = version;
  fs.writeFileSync(PLUGIN_JSON, JSON.stringify(pj, null, 2) + '\n');
  const mj = readJson(MARKET_JSON); mj.plugins[0].version = version;
  fs.writeFileSync(MARKET_JSON, JSON.stringify(mj, null, 2) + '\n');
  steps.push(`версии подняты до ${version}`);
  // 2. запись в CHANGELOG: заметки человека или список коммитов
  const body = (notes || '').trim()
    || st.commits.map((c) => `- ${c.replace(/^\S+\s/, '')}`).join('\n')
    || '- технический выкат без описания';
  const old = fs.readFileSync(CHANGELOG, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CHANGELOG, old.replace('\n## ',
    `\n## ${version} — ${today}\n\n${body}\n\n## `));
  steps.push('CHANGELOG дополнен');
  // 3. коммит и push (origin = gitlab; github-зеркало обновится само)
  git(REPO, 'add', '--', PLUGIN_JSON, MARKET_JSON, CHANGELOG);
  git(REPO, 'commit', '-m', `выкат ${version} (кнопка пульта)`);
  git(REPO, 'push', 'origin', 'main');
  steps.push('закоммичено и запушено в origin/main');
  // 4. обновить marketplace-клон и установку у основного (user-scope)
  steps.push(claude(['plugin', 'marketplace', 'update', MKT]) || 'marketplace обновлён');
  steps.push(claude(['plugin', 'update', PLUGIN_KEY, '-y']) || 'user-scope обновлён');
  // 5. project-scope установки: без этого старая версия молча перекрывает
  //    новую в своих деревьях (найдено фактом 22.08 на /Users/stovp/ai-evolve)
  for (const r of installRecords().filter((x) => x.scope === 'project' && x.projectPath))
    try {
      steps.push(claude(['plugin', 'update', PLUGIN_KEY, '--scope', 'project', '-y'], r.projectPath)
        || `project-scope ${r.projectPath} обновлён`);
    } catch (e) { steps.push(`project-scope ${r.projectPath}: НЕ обновился — ${e.message}`); }
  // 6. проверка фактом: новая версия в кеше
  const ok = fs.existsSync(path.join(CACHE_DIR, version));
  steps.push(ok ? `кеш подтверждён: ${version} на месте`
    : `кеша ${version} НЕТ — зеркало github могло не успеть, повтори обновление позже`);
  return { version, ok, steps };
}
