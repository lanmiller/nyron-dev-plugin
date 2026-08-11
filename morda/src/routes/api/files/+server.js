import { json } from '@sveltejs/kit';
import { rootByName } from '$lib/server/fleet.js';
import { listDir, readFile, searchFiles } from '$lib/server/files.js';

// Обозреватель файлов проекта: дерево, содержимое, поиск (по именам, а с «?»
// в начале — по содержимому). Требование CTO 11.08 — смотреть файлы репозиториев
// и проекта прямо из пульта, не выходя в редактор.
export async function GET({ url }) {
  const project = url.searchParams.get('project');
  if (!project) return json({ error: 'нужен project' }, { status: 400 });
  try {
    const root = rootByName(project);
    const q = url.searchParams.get('q');
    if (q) return json(searchFiles(root, q));
    const p = url.searchParams.get('path') || '';
    const mode = url.searchParams.get('mode') || 'dir';
    return json(mode === 'file' ? readFile(root, p) : listDir(root, p));
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
