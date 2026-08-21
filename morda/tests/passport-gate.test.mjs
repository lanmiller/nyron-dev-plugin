/**
 * Тесты гейта паспорта при старте сессии (STOVP-61,
 * morda/src/lib/server/passport.js: passportQuick + passportGate).
 *
 * Что и зачем покрывают: красный паспорт закрывает запуск в ЛЮБОМ режиме
 * (дыра из челленджа Sol: гейт стоял только на bypass); отсутствие
 * паспорта различимо от зелёного (раньше «нет» считалось зелёным) и
 * закрывает только bypass — остальным режимам предупреждение (решение
 * постановщика 22.08, наследует решение №7 гриля 16.08 «не останавливать
 * единственный живой проект»). Зелёный — пропуск без слов.
 *
 * Запуск: npm test в morda/ (node --test tests/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { passportQuick, passportGate } from '../src/lib/server/passport.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pgate-'));

function gitRoot() {
  const root = tmp();
  execFileSync('git', ['-C', root, 'init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.secrets\n');
  return root;
}

test('passportQuick: паспорта нет → null (не зелёный)', () => {
  assert.equal(passportQuick(tmp()), null);
});

test('passportQuick: незаданный ключ → красный; всё на месте → зелёный', () => {
  const root = gitRoot();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'passport.json'),
    JSON.stringify({ keys: { env: { FOO: 'токен' } } }));
  fs.mkdirSync(path.join(root, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, '.secrets', 'env'), '# ключница\n');
  const red = passportQuick(root);
  assert.ok(red.some((p) => p.includes('не задана FOO')));
  fs.writeFileSync(path.join(root, '.secrets', 'env'), 'FOO=1\n');
  assert.deepEqual(passportQuick(root), []);
});

test('passportGate: красный закрывает любой режим', () => {
  for (const mode of ['bypass', 'auto', 'acceptEdits', 'plan', null]) {
    const g = passportGate(['нет ключа env'], mode);
    assert.match(g.block, /красный — запуск закрыт/);
    assert.equal(g.warning, null);
  }
});

test('passportGate: «нет паспорта» закрывает только bypass, остальным предупреждение', () => {
  const b = passportGate(null, 'bypass');
  assert.match(b.block, /паспорта проекта нет — bypass закрыт/);
  for (const mode of ['auto', 'acceptEdits', 'plan', null]) {
    const g = passportGate(null, mode);
    assert.equal(g.block, null);
    assert.match(g.warning, /паспорта проекта нет/);
  }
});

test('passportGate: зелёный — пропуск без слов', () => {
  assert.deepEqual(passportGate([], 'bypass'), { block: null, warning: null });
  assert.deepEqual(passportGate([], 'auto'), { block: null, warning: null });
});
