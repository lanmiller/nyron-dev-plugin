/**
 * Якорь будки — КОРЕНЬ ПРОЕКТА, а не корень git-репозитория.
 *
 * Проект плагина может быть зонтиком из нескольких НЕЗАВИСИМЫХ репо
 * (ai-evolve = ai-evolve-back + n8n + ai-evolve-docs-test + worktree'ы). Пока
 * якорем был git-common-dir, сессия с cwd внутри саб-репо получала приватную
 * пустую будку: её посты и вотчеры не встречались с диспетчерскими, волны и
 * диспетчер «теряли» друг друга (баг ночного прогона 21.07 — три осиротевших
 * .nyron-hub/.watchers в саб-репо, messages.jsonl в них так и не появился).
 *
 * Определение проекта в плагине — каталог с `.claude/nyron-dev.md`
 * (скилл project-config). По нему и якоримся.
 *
 * Порядок разрешения:
 *   1. NYRON_HUB_DIR — явный оверрайд, перекрывает всё;
 *   2. вверх по дереву до первого каталога с `.claude/nyron-dev.md` — корень проекта;
 *   3. git-common-dir — репо без конфига (у worktree указывает на основной чекаут);
 *   4. cwd — последний фолбэк.
 *
 * ВАЖНО: та же лестница продублирована в `hub-watch.sh::resolve_hub()` —
 * правки обязаны идти парой, иначе вотчеры снова разъедутся с сервером.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function resolveHubDir(cwd = process.cwd(), env = process.env) {
  if (env.NYRON_HUB_DIR) return env.NYRON_HUB_DIR;

  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude', 'nyron-dev.md')))
      return path.join(dir, '.nyron-hub');
    if (dir === path.dirname(dir)) break; // дошли до /
  }

  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (common && path.basename(common) === '.git')
      return path.join(path.dirname(common), '.nyron-hub');
  } catch {}

  return path.join(cwd, '.nyron-hub');
}
