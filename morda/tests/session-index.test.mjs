/**
 * Падающие контрактные тесты индекса сессий (STOVP-65).
 *
 * Что и зачем покрывают: индекс не перечитывает диск без изменений,
 * инвалидируется событиями файловой системы для транскриптов и фоновых лент,
 * сохраняет публичный контракт listSessions, видит worktree-каталоги и
 * корректно переживает отсутствующие каталоги и битые строки JSONL.
 *
 * Запуск: node --test morda/tests/session-index.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionIndex, listSessions } from '../../nyron-dev/hub/transcript.mjs';

const база = fs.mkdtempSync(path.join(os.tmpdir(), 'sidx-'));
const каталогПроектов = path.join(база, 'projects');
const scratchBase = path.join(база, 'scratch');
const прежнийКаталогПроектов = process.env.CLAUDE_PROJECTS_DIR;

fs.mkdirSync(каталогПроектов, { recursive: true });
process.env.CLAUDE_PROJECTS_DIR = каталогПроектов;

after(() => {
  if (прежнийКаталогПроектов === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = прежнийКаталогПроектов;
  fs.rmSync(база, { recursive: true, force: true });
});

const слаг = (root) => root.replace(/[/.]/g, '-');
const каталогСлага = (root, хвост = '') =>
  path.join(каталогПроектов, `${слаг(root)}${хвост}`);

function строкаПользователя(root, key, title = `Задача ${key}`) {
  return JSON.stringify({
    type: 'user', cwd: root, entrypoint: 'cli', sessionId: key,
    message: { role: 'user', content: title },
    timestamp: '2026-08-23T10:00:00.000Z',
  });
}

function записатьСессию(root, key, { dir = каталогСлага(root), title } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.jsonl`);
  fs.writeFileSync(file, `${строкаПользователя(root, key, title)}\n`);
  return file;
}

function установитьВремя(file, mtimeMs) {
  const время = new Date(mtimeMs);
  fs.utimesSync(file, время, время);
}

async function дождаться(проверка, сообщение) {
  const край = Date.now() + 1500;
  let последняяОшибка;
  while (Date.now() <= край) {
    try {
      const результат = проверка();
      if (результат) return результат;
    } catch (ошибка) {
      последняяОшибка = ошибка;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (последняяОшибка) throw последняяОшибка;
  assert.fail(сообщение);
}

function считатьЧтенияFs() {
  const имена = [
    'readdirSync', 'statSync', 'openSync', 'readSync', 'readFileSync', 'existsSync',
  ];
  const исходные = new Map();
  const вызовы = Object.fromEntries(имена.map((имя) => [имя, 0]));

  for (const имя of имена) {
    исходные.set(имя, fs[имя]);
    fs[имя] = function (...args) {
      вызовы[имя] += 1;
      return исходные.get(имя).apply(this, args);
    };
  }

  const снять = () => {
    for (const [имя, метод] of исходные) fs[имя] = метод;
  };
  снять.сумма = () => Object.values(вызовы).reduce((сумма, n) => сумма + n, 0);
  снять.вызовы = вызовы;
  return снять;
}

test('DoD 3: повторный list без изменений не читает диск', (t) => {
  const root = path.join(база, 'root-cache');
  записатьСессию(root, 'cache-1');
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());

  assert.equal(idx.list().length, 1);
  const снять = считатьЧтенияFs();
  try {
    assert.equal(idx.list().length, 1);
    assert.equal(снять.сумма(), 0, JSON.stringify(снять.вызовы));
  } finally {
    снять();
  }
});

test('DoD 4: дописанная строка JSONL отражается не позже чем через секунду', async (t) => {
  const root = path.join(база, 'root-append');
  const file = записатьСессию(root, 'append-1', { title: 'Старое название' });
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());
  const прежде = idx.list()[0];

  fs.appendFileSync(file, `${JSON.stringify({
    type: 'custom-title', customTitle: 'Новое название',
    timestamp: '2026-08-23T10:01:00.000Z',
  })}\n`);

  const после = await дождаться(() => {
    const сессия = idx.list().find((item) => item.key === 'append-1');
    return сессия?.title === 'Новое название' && сессия.size > прежде.size && сессия;
  }, 'индекс не заметил дописанную строку JSONL за 1,5 с');
  assert.ok(после.lastActivity >= new Date(после.mtime).getTime());
});

test('DoD 4: новый и удалённый JSONL отражаются не позже чем через секунду', async (t) => {
  const root = path.join(база, 'root-create-delete');
  const старыйФайл = записатьСессию(root, 'old-1');
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());
  assert.deepEqual(idx.list().map((item) => item.key), ['old-1']);

  записатьСессию(root, 'new-1');
  await дождаться(
    () => idx.list().some((item) => item.key === 'new-1'),
    'индекс не заметил новый JSONL за 1,5 с',
  );

  fs.unlinkSync(старыйФайл);
  await дождаться(
    () => !idx.list().some((item) => item.key === 'old-1'),
    'индекс не заметил удаление JSONL за 1,5 с',
  );
});

test('DoD 4: файлы subagents и tasks обновляют lastActivity не позже чем через секунду', async (t) => {
  const root = path.join(база, 'root-activity');
  const key = 'activity-1';
  const file = записатьСессию(root, key);
  const dir = каталогСлага(root);
  const subagents = path.join(dir, key, 'subagents');
  const tasks = path.join(scratchBase, path.basename(dir), key, 'tasks');
  fs.mkdirSync(subagents, { recursive: true });
  fs.mkdirSync(tasks, { recursive: true });
  установитьВремя(file, Date.now() - 20_000);

  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());
  idx.list();

  const времяАгента = Date.now() - 4_000;
  const агент = path.join(subagents, 'agent-a1.jsonl');
  fs.writeFileSync(агент, '{}\n');
  установитьВремя(агент, времяАгента);
  await дождаться(
    () => Math.abs(idx.lastActivity(key) - времяАгента) < 250,
    'lastActivity не заметил файл субагента за 1,5 с',
  );

  const времяЗадачи = Date.now() - 1_000;
  const задача = path.join(tasks, 'job.output');
  fs.writeFileSync(задача, 'готово');
  установитьВремя(задача, времяЗадачи);
  await дождаться(
    () => Math.abs(idx.lastActivity(key) - времяЗадачи) < 250,
    'lastActivity не заметил файл задачи за 1,5 с',
  );
});

test('DoD 5: list индекса без lastActivity эквивалентен listSessions', (t) => {
  const root = path.join(база, 'root-compatible');
  const старый = записатьСессию(root, 'compat-old', { title: 'Старая' });
  const новый = записатьСессию(root, 'compat-new', { title: 'Новая' });
  const чужойRoot = path.join(база, 'foreign-root');
  записатьСессию(чужойRoot, 'foreign', { dir: каталогСлага(root), title: 'Чужая' });
  установитьВремя(старый, Date.now() - 10_000);
  установитьВремя(новый, Date.now() - 1_000);
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());

  const безАктивности = idx.list().map(({ lastActivity, ...сессия }) => сессия);
  assert.deepEqual(безАктивности, listSessions(root));
  assert.deepEqual(безАктивности.map((item) => item.key), ['compat-new', 'compat-old']);
});

test('DoD 5: worktree-каталог участвует в списке и дедупликации по key', (t) => {
  const root = path.join(база, 'root-worktree');
  const основной = записатьСессию(root, 'same-key', { title: 'Из корня' });
  const worktreeDir = каталогСлага(root, '--claude-worktrees-x');
  const дубль = записатьСессию(root, 'same-key', { dir: worktreeDir, title: 'Из worktree' });
  const толькоWorktree = записатьСессию(root, 'worktree-only', { dir: worktreeDir });
  установитьВремя(основной, Date.now() - 20_000);
  установитьВремя(дубль, Date.now() - 1_000);
  установитьВремя(толькоWorktree, Date.now() - 2_000);
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());

  const список = idx.list();
  assert.deepEqual(список.map((item) => item.key), ['same-key', 'worktree-only']);
  assert.equal(список.find((item) => item.key === 'same-key').title, 'Из worktree');
});

test('Негативный DoD 4: отсутствующий слаг даёт пустой список и подхватывается после появления', async (t) => {
  const root = path.join(база, 'root-late');
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());
  assert.deepEqual(idx.list(), []);
  assert.equal(idx.lastActivity('missing-key'), 0);

  записатьСессию(root, 'late-1');
  await дождаться(
    () => idx.list().some((item) => item.key === 'late-1'),
    'индекс не подхватил появившийся каталог слага за 1,5 с',
  );
});

test('Негативный DoD 5: битые строки JSONL не ломают заголовок и список', (t) => {
  const root = path.join(база, 'root-broken');
  const dir = каталогСлага(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken-title.jsonl'),
    `{это не JSON}\n${строкаПользователя(root, 'broken-title', 'Валидный заголовок')}\n`);
  fs.writeFileSync(path.join(dir, 'broken-empty.jsonl'), [
    '{снова не JSON}',
    JSON.stringify({
      type: 'assistant', cwd: root, entrypoint: 'cli',
      message: { role: 'assistant', content: 'Ответ' },
    }),
    '',
  ].join('\n'));
  const idx = sessionIndex(root, { scratchBase });
  t.after(() => idx.close());

  const поКлючу = new Map(idx.list().map((item) => [item.key, item]));
  assert.equal(поКлючу.get('broken-title').title, 'Валидный заголовок');
  assert.equal(поКлючу.get('broken-empty').title, '(без названия)');
});

test('DoD 5: sessionIndex — синглтон до close и новый объект после close', () => {
  const root = path.join(база, 'root-singleton');
  const первый = sessionIndex(root, { scratchBase });
  const повторный = sessionIndex(root, { scratchBase: path.join(база, 'другой-scratch') });
  assert.strictEqual(повторный, первый);

  первый.close();
  const послеClose = sessionIndex(root, { scratchBase });
  try {
    assert.notStrictEqual(послеClose, первый);
  } finally {
    послеClose.close();
  }
});
