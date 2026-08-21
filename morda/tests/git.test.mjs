/**
 * Тесты git-панели (morda/src/lib/server/git.js).
 *
 * Что и зачем покрывают: панель ходит в настоящий git, поэтому проверяем
 * на временном репозитории, собранном в tmp: разбор porcelain-статуса
 * (staged/unstaged/untracked, переименование), stage/unstage/discard
 * (включая удаление неотслеживаемого), коммит только staged, чистоту
 * дерева при переключении ветки, раскладку графа по дорожкам (мерж
 * сходится, ветка занимает свою колонку) и границы безопасности:
 * репозиторий вне корня/глубже 2 уровней и файл вне репо — отказ.
 *
 * Запуск: npm test в morda/ (node --test tests/).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as g from '../src/lib/server/git.js';

let root;   // «проект»: корень с вложенным репо
let repo;   // вложенный репозиторий rel='r'

function sh(args, cwd = repo) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
function write(rel, body) { fs.writeFileSync(path.join(repo, rel), body); }

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'morda-git-'));
  repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  sh(['init', '-b', 'main']);
  sh(['config', 'commit.gpgsign', 'false']);
  write('a.txt', 'один\n');
  write('b.txt', 'до\n');
  sh(['add', '.']);
  sh(['commit', '-m', 'старт']);
  // ветка с мержем — для графа
  sh(['switch', '-c', 'feat']);
  write('a.txt', 'один\nдва\n');
  sh(['commit', '-am', 'фича']);
  sh(['switch', 'main']);
  write('b.txt', 'до\nещё\n');
  sh(['commit', '-am', 'на главной']);
  sh(['merge', '--no-ff', '-m', 'мерж фичи', 'feat']);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('findRepos видит вложенный репозиторий, repoPath держит границы', () => {
  assert.deepEqual(g.findRepos(root), ['r']);
  assert.throws(() => g.repoPath(root, '../..'), /вне корня/);
  assert.throws(() => g.repoPath(root, 'r/x/y/z'), /глубину 2/);
  assert.throws(() => g.repoPath(root, 'нет-такого'), /не репозиторий/);
});

test('status раскладывает staged / unstaged / untracked', async () => {
  write('a.txt', 'правка\n');           // изменён, не staged
  write('new.txt', 'новый\n');          // неотслеживаемый
  sh(['add', 'a.txt']);                 // теперь staged
  write('a.txt', 'правка поверх\n');    // и снова изменён поверх staged
  const st = await g.status(root, 'r');
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.staged.map((f) => [f.file, f.s]), [['a.txt', 'M']]);
  assert.deepEqual(st.unstaged.map((f) => [f.file, f.s]).sort(),
    [['a.txt', 'M'], ['new.txt', 'U']]);
});

test('diff: staged и untracked отдают текст с плюсами', async () => {
  const d1 = await g.diff(root, 'r', 'a.txt', { staged: true });
  assert.match(d1.text, /\+правка/);
  const d2 = await g.diff(root, 'r', 'new.txt', { untracked: true });
  assert.equal(d2.text, '+новый\n+');
  await assert.rejects(g.diff(root, 'r', '../../etc/passwd'), /вне репозитория/);
});

test('unstage/discard возвращают дерево к чистому, clean сносит новый файл', async () => {
  await g.unstage(root, 'r', ['a.txt']);
  await g.discard(root, 'r', ['a.txt', 'new.txt']);
  const st = await g.status(root, 'r');
  assert.equal(st.staged.length + st.unstaged.length, 0);
  assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
});

test('commit пишет только staged; пустое сообщение — отказ', async () => {
  write('a.txt', 'к коммиту\n');
  await g.stage(root, 'r', ['a.txt']);
  await assert.rejects(g.commit(root, 'r', '  '), /пустое сообщение/);
  await g.commit(root, 'r', 'тестовый коммит');
  const st = await g.status(root, 'r');
  assert.equal(st.staged.length, 0);
});

test('checkout: грязное дерево — отказ, чистое — переключает; ветки в списке', async () => {
  write('a.txt', 'грязь\n');
  await assert.rejects(g.checkout(root, 'r', 'feat'), /не чистое/);
  await g.discard(root, 'r', ['a.txt']);
  await g.checkout(root, 'r', 'feat');
  const br = await g.branches(root, 'r');
  assert.equal(br.locals.find((b) => b.current)?.name, 'feat');
  await g.checkout(root, 'r', 'main');
  await assert.rejects(g.createBranch(root, 'r', 'плохое имя'), /некорректное имя/);
});

test('graph: мерж занимает две дорожки и сходится', async () => {
  const gr = await g.graph(root, 'r');
  assert.ok(gr.laneCount >= 2, 'мерж требует минимум двух дорожек');
  const merge = gr.commits.find((c) => c.parents.length === 2);
  assert.ok(merge, 'мерж-коммит в графе есть');
  // оба родителя мержа присутствуют и лежат на разных дорожках
  const [p1, p2] = merge.parents.map((sha) => gr.commits.find((c) => c.sha === sha));
  assert.ok(p1 && p2);
  assert.notEqual(p1.lane, p2.lane);
});

test('commitInfo отдаёт сообщение и файлы', async () => {
  const gr = await g.graph(root, 'r');
  const info = await g.commitInfo(root, 'r', gr.commits.at(-1).sha);
  assert.equal(info.message, 'старт');
  assert.deepEqual(info.files.map((f) => f.file).sort(), ['a.txt', 'b.txt']);
  await assert.rejects(g.commitInfo(root, 'r', '$(rm -rf)'), /некорректный sha/);
});
