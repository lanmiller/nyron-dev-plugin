import { json } from '@sveltejs/kit';
import { rootByName } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';
import * as g from '$lib/server/git.js';

/** Git-панель: чтение — GET, изменение состояния — POST. Проект резолвится
 *  ТОЛЬКО по имени через allowlist (fleet.rootByName) — как в api/files. */

export async function GET({ url }) {
  const q = (k) => url.searchParams.get(k);
  const project = q('project');
  if (!project) return json({ error: 'нужен project' }, { status: 400 });
  try {
    const root = rootByName(project);
    const repo = q('repo') || '.';
    switch (q('op')) {
      case 'overview': return json({ repos: await g.overview(root) });
      case 'status': return json(await g.status(root, repo));
      case 'diff': return json(await g.diff(root, repo, q('file'), {
        staged: q('staged') === '1', untracked: q('untracked') === '1' }));
      case 'branches': return json(await g.branches(root, repo));
      case 'graph': return json(await g.graph(root, repo));
      case 'commit': return json(await g.commitInfo(root, repo, q('sha')));
      default: return json({ error: 'неизвестная операция' }, { status: 400 });
    }
  } catch (e) {
    return json({ error: gitErr(e) }, { status: 400 });
  }
}

export async function POST({ request }) {
  const bad = guarded(request);
  if (bad) return json({ error: bad }, { status: 403 });
  const b = await request.json().catch(() => ({}));
  if (!b.project) return json({ error: 'нужен project' }, { status: 400 });
  try {
    const root = rootByName(b.project);
    const repo = b.repo || '.';
    const files = Array.isArray(b.files) ? b.files.map(String) : [];
    switch (b.op) {
      case 'stage': return json(await g.stage(root, repo, files));
      case 'unstage': return json(await g.unstage(root, repo, files));
      case 'discard': return json(await g.discard(root, repo, files));
      case 'commit': return json(await g.commit(root, repo, b.message));
      case 'checkout': return json(await g.checkout(root, repo, b.branch));
      case 'create-branch': return json(await g.createBranch(root, repo, b.name));
      case 'push': return json(await g.push(root, repo));
      case 'pull': return json(await g.pull(root, repo));
      case 'fetch': return json(await g.fetch(root, repo));
      default: return json({ error: 'неизвестная операция' }, { status: 400 });
    }
  } catch (e) {
    return json({ error: gitErr(e) }, { status: 400 });
  }
}

/** Ошибка git-процесса несёт полезное в stderr — отдаём его, не «exit 1». */
function gitErr(e) {
  const s = String(e.stderr || '').trim();
  return s || String(e.message || e);
}
