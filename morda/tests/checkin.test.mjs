/**
 * Тесты чек-ина по лентам (STOVP-60, morda/src/lib/server/checkin.js).
 *
 * Что и зачем покрывают: «работает» доказывается записями в трёх лентах
 * (транскрипт, субагенты, фоновые команды), а не живостью процесса.
 * Кейсы: свежесть берёт максимум по лентам; живой CLI не прикрывает
 * тишину дольше порога (тупик psylia 21.08); пишущий фоновый агент
 * держит «работает»; вердикты сторожа кроме «working» не трогаются;
 * Ожидание свежести нужно из-за асинхронного индекса на fs.watch (STOVP-65).
 * порог читается из ключа конфига; карточка «застряла» встаёт в будку
 * один раз на эпизод (дедуп) и не плодится на древних сессиях.
 *
 * Запуск: npm test в morda/ (node --test tests/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastActivityMs, checkinMs, checkinState, stalledCard, CHECKIN_MIN_DEFAULT }
  from '../src/lib/server/checkin.js';

const MIN = 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-'));
const touch = (p, ageMs) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
};

async function дождаться(проверка, сообщение) {
  const край = Date.now() + 1500;
  while (Date.now() <= край) {
    const результат = проверка();
    if (результат) return результат;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(сообщение);
}

test('lastActivityMs: максимум по трём лентам', async () => {
  const projDir = tmp();               // каталог-слаг с транскриптами
  const base = tmp();                  // корень скретчпадов (tasks)
  const key = 'sess-1';
  const file = path.join(projDir, `${key}.jsonl`);
  const now = Date.now();
  touch(file, 40 * MIN);               // главный поток молчит 40 минут

  // только транскрипт → его mtime
  const mtime = new Date(now - 40 * MIN).toISOString();
  let act = lastActivityMs(file, key, mtime, { tmpBase: base });
  assert.ok(Math.abs(act - (now - 40 * MIN)) < 2000);

  // фоновый агент писал 3 минуты назад → он и есть свежесть
  touch(path.join(projDir, key, 'subagents', 'agent-a1.jsonl'), 3 * MIN);
  act = await дождаться(() => {
    const значение = lastActivityMs(file, key, mtime, { tmpBase: base });
    return Math.abs(значение - (now - 3 * MIN)) < 2000 && значение;
  }, 'lastActivityMs не заметил файл субагента за 1,5 с');
  assert.ok(Math.abs(act - (now - 3 * MIN)) < 2000);

  // фоновая команда дописала вывод минуту назад → свежесть ещё новее
  touch(path.join(base, path.basename(projDir), key, 'tasks', 'abc.output'), 1 * MIN);
  act = await дождаться(() => {
    const значение = lastActivityMs(file, key, mtime, { tmpBase: base });
    return Math.abs(значение - (now - 1 * MIN)) < 2000 && значение;
  }, 'lastActivityMs не заметил файл задачи за 1,5 с');
  assert.ok(Math.abs(act - (now - 1 * MIN)) < 2000);
});

test('checkinState: живой CLI не прикрывает тишину дольше порога', () => {
  const now = Date.now();
  const r = checkinState({ w: undefined, lastAct: now - 20 * MIN,
    aliveOwned: true, thresholdMs: 15 * MIN, now });
  assert.equal(r.state, 'stalled');
  assert.match(r.reason, /живость работой не считается/);
});

test('checkinState: пишет только фоновая лента — работает', () => {
  const now = Date.now();
  const r = checkinState({ w: undefined, lastAct: now - 2 * MIN,
    aliveOwned: false, thresholdMs: 15 * MIN, now });
  assert.equal(r.state, 'working');
});

test('checkinState: вердикт сторожа «working» гаснет по порогу, прочие — нет', () => {
  const now = Date.now();
  const working = { state: 'working', reason: 'сторож' };
  const waiting = { state: 'waiting_decision', reason: 'ждёт решения' };
  assert.equal(checkinState({ w: working, lastAct: now - 16 * MIN,
    aliveOwned: true, thresholdMs: 15 * MIN, now }).state, 'stalled');
  assert.equal(checkinState({ w: working, lastAct: now - 10 * MIN,
    aliveOwned: false, thresholdMs: 15 * MIN, now }).state, 'working');
  assert.equal(checkinState({ w: waiting, lastAct: now - 90 * MIN,
    aliveOwned: false, thresholdMs: 15 * MIN, now }).state, 'waiting_decision');
});

test('checkinState: до порога живой CLI держит зелёное, без CLI — вне надзора', () => {
  const now = Date.now();
  assert.equal(checkinState({ w: undefined, lastAct: now - 10 * MIN,
    aliveOwned: true, thresholdMs: 15 * MIN, now }).state, 'working');
  assert.equal(checkinState({ w: undefined, lastAct: now - 10 * MIN,
    aliveOwned: false, thresholdMs: 15 * MIN, now }), null);
});

test('checkinState: закрытый вчерашний разговор — не «застряла», а вне надзора', () => {
  const now = Date.now();
  assert.equal(checkinState({ w: undefined, lastAct: now - 300 * MIN,
    aliveOwned: false, thresholdMs: 15 * MIN, now }), null);
});

test('checkinMs: ключ конфига читается, дефолт без конфига', () => {
  const root = tmp();
  delete process.env.MORDA_CHECKIN_MIN;
  assert.equal(checkinMs(root), CHECKIN_MIN_DEFAULT * MIN);
  const root2 = tmp();
  fs.mkdirSync(path.join(root2, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root2, '.claude', 'nyron-dev.md'),
    '# конфиг\ncheckin_min: 7\n');
  assert.equal(checkinMs(root2), 7 * MIN);
  process.env.MORDA_CHECKIN_MIN = '1';
  assert.equal(checkinMs(root2), 1 * MIN);
  delete process.env.MORDA_CHECKIN_MIN;
});

test('checkinMs: правка ключа действует без рестарта (кэш по mtime)', () => {
  const root = tmp();
  delete process.env.MORDA_CHECKIN_MIN;
  const f = path.join(root, '.claude', 'nyron-dev.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'checkin_min: 7\n');
  assert.equal(checkinMs(root), 7 * MIN);
  fs.writeFileSync(f, 'checkin_min: 3\n');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 1000)); // mtime вперёд
  assert.equal(checkinMs(root), 3 * MIN);
});

test('stalledCard: одна карточка на эпизод, древняя тишина не плодит', async () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const { HubDb } = await import(path.resolve(HERE, '../../nyron-dev/hub/hub-db.mjs'));
  const hub = new HubDb(path.join(tmp(), '.nyron-hub'));
  const args = { key: 'sess-x', title: 'Волна Ф1', reason: 'ленты молчат 16 мин',
    quietMs: 16 * MIN, thresholdMs: 15 * MIN };
  const first = stalledCard(hub, args);
  assert.equal(first.deduped, false);
  // формат опций — {n, label}: карточка решается кнопкой AskCard (send(o.n))
  assert.equal(first.ask.options[0].n, 1);
  assert.ok(first.ask.options[0].label);
  const second = stalledCard(hub, args);
  assert.equal(second.deduped, true);                      // тот же эпизод
  assert.equal(hub.asks({ status: 'open' }).asks.length, 1);
  // тишина в 5 порогов у НЕ-живой — история, не событие: карточки нет
  assert.equal(stalledCard(hub, { ...args, key: 'sess-y', quietMs: 75 * MIN }), null);
  assert.equal(hub.asks({ status: 'open' }).asks.length, 1);
  // ...но живой CLI получает карточку при любой длине тупика: пульт могли
  // открыть сильно позже перехода (кросс-ревью Sol, блокер 1)
  const late = stalledCard(hub, { ...args, key: 'sess-z', quietMs: 75 * MIN, aliveOwned: true });
  assert.equal(late.deduped, false);
  assert.equal(hub.asks({ status: 'open' }).asks.length, 2);
});
