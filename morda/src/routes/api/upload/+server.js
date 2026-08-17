import { json } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import { rootByName } from '$lib/server/fleet.js';
import { guarded } from '$lib/server/guard.js';

// Вложения композера (этап 2 STOVP-58, «вложения путём файла»): файл
// сохраняется в проект (.nyron-hub/uploads), сессии уходит ПУТЬ — CLI
// читает его своим Read (картинки в том числе; проверено фактом 17.08).
const MAX = 25 * 1024 * 1024;

export async function POST({ request }) {
  const blocked = guarded(request);
  if (blocked) return json({ error: `запрос отклонён: ${blocked}` }, { status: 403 });
  try {
    const form = await request.formData();
    const project = form.get('project');
    const file = form.get('file');
    if (typeof project !== 'string' || !file || typeof file === 'string')
      return json({ error: 'нужны project и file' }, { status: 400 });
    if (file.size > MAX)
      return json({ error: `файл больше ${MAX / 1024 / 1024} МБ` }, { status: 400 });
    const root = rootByName(project);
    const dir = path.join(root, '.nyron-hub', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    // имя чистим до безопасного, уникальность — префиксом времени
    const safe = String(file.name || 'file').replace(/[^\w.\-а-яА-ЯёЁ]+/g, '_').slice(-80);
    const rel = path.join('.nyron-hub', 'uploads', `${Date.now().toString(36)}-${safe}`);
    fs.writeFileSync(path.join(root, rel), Buffer.from(await file.arrayBuffer()));
    return json({ path: rel, name: file.name });
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 400 });
  }
}
