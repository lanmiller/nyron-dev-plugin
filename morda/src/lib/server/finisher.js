/**
 * finisher.js — толкач финала (STOVP-57, план 22.08 п.9): сессия закончила,
 * а ветка не влита — работа не сдана. Правило кодом, без модели:
 *  - живой сессии на промпте — пинок в tmux: «влей по своим merge_rights
 *    или передай диспетчеру» (сессия сама знает свою роль из контекста);
 *  - мёртвой/запаркованной — карточка человеку в будку: влить/прибрать
 *    кнопками git-панели или поднять сессию.
 * Мерж руками пульта или модели — НИКОГДА (вердикт CTO 22.08): только
 * сессия по правам либо человек кнопкой.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rootByName, hubForJudge } from './fleet.js';
import { runnerList, runnerType, runnerFinisherMark } from './runner.js';

const PUSH_EVERY = 4 * 3600_000; // живую не дёргаем чаще раза в 4 часа

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a],
  { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function unmergedBranch(dir) {
  let branch;
  try { branch = git(dir, 'branch', '--show-current'); } catch { return null; }
  if (!branch || branch === 'main') return null;
  try { git(dir, 'merge-base', '--is-ancestor', branch, 'main'); return null; } // влита
  catch { /* не предок main — есть несданное */ }
  let dirty = false;
  try { dirty = !!git(dir, 'status', '--porcelain'); } catch {}
  return { branch, dirty };
}

/** Обход реестра проекта: кого пнуть, о ком завести карточку.
 *  Возвращает список действий — для лога и проверки фактом. */
export function finisherScan(project) {
  const acts = [];
  let rows = [];
  try { rows = runnerList(project); } catch { return acts; }
  for (const s of rows) {
    if (!s.root || !fs.existsSync(s.root)) continue;
    const un = unmergedBranch(s.root);
    if (!un) continue;
    if (s.alive && s.screen === 'prompt' && !s.busy) {
      const last = s.finisher?.at ? Date.now() - new Date(s.finisher.at).getTime() : Infinity;
      if (s.finisher?.branch === un.branch && last < PUSH_EVERY) continue; // уже пнули недавно
      const msg = `[толкач финала] Ветка ${un.branch} не влита в main`
        + (un.dirty ? ', в дереве незакоммиченное' : ', дерево чистое')
        + '. Если работа закончена — ' + (un.dirty ? 'закоммить и ' : '')
        + 'влей по своим merge_rights или передай диспетчеру; если ещё работаешь — продолжай.';
      try {
        runnerType({ name: s.name, text: msg, enter: true });
        runnerFinisherMark({ name: s.name, branch: un.branch });
        acts.push({ name: s.name, branch: un.branch, did: 'пинок' });
      } catch (e) { acts.push({ name: s.name, branch: un.branch, did: `пинок не дошёл: ${e.message}` }); }
    } else if (!s.alive) {
      // карточка держится одна на (session, question) — дедуп будки
      try {
        const hub = hubForJudge(rootByName(project));
        hub.ask({
          session: s.sessionId || s.name, type: 'choice',
          question: `Ветка не влита, сессия запаркована: ${un.branch}`,
          options: [{ n: 1, label: 'вижу, разберусь' }],
          context: `${s.name}: ветка ${un.branch}${un.dirty ? ' + незакоммиченное в дереве' : ''}`
            + ' — влить/прибрать кнопками git-панели или поднять сессию',
          urgency: 'active',
        });
        acts.push({ name: s.name, branch: un.branch, did: 'карточка' });
      } catch { /* будки нет — статус виден в git-панели */ }
    }
    // занятую не трогаем: она ещё работает, пинок только собьёт
  }
  return acts;
}
