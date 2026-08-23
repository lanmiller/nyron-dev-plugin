/**
 * Красные контрактные тесты серверной части STOVP-69.
 *
 * Что и зачем покрывают: тикет извлекается из цели, явное поле сильнее
 * парсинга и сохраняется в метаданных реестра; fleet отдаёт тикет владельца
 * сессии и выбирает эпик по локальной карте либо кэшу Jira; Jira грузит ключи
 * одной пачкой, кэширует ответы и безопасно деградирует без ключей/сети;
 * MCP-схема запуска принимает ticket. UI намеренно остаётся ручной приёмкой.
 *
 * Запуск: node --test morda/tests/runner-ticket.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const MORDA = path.join(REPO, 'morda');
const КОРЕНЬ = fs.mkdtempSync(path.join(os.tmpdir(), 'morda-ticket-'));
const РЕЕСТР = path.join(КОРЕНЬ, 'runner.json');

fs.copyFileSync(path.join(MORDA, 'projects.json.example'),
  path.join(КОРЕНЬ, 'projects.json.example'));
fs.writeFileSync(path.join(КОРЕНЬ, 'epics.json'), JSON.stringify({
  tickets: { 'STOVP-65': 'STOVP-64' },
  epics: { 'STOVP-64': 'Пульт' },
}));
fs.writeFileSync(РЕЕСТР, JSON.stringify({ sessions: {} }));

// Эти пути вычисляются во время импорта fleet.js/plugin-hub.js, поэтому env
// обязан быть выставлен до обоих динамических импортов.
process.env.MORDA_ROOT = КОРЕНЬ;
process.env.MORDA_RUNNER_STATE = РЕЕСТР;
process.env.NYRON_PLUGIN_HUB = path.join(REPO, 'nyron-dev', 'hub');

const runner = await import('../src/lib/server/runner.js');
const fleet = await import('../src/lib/server/fleet.js');

// runner.js поднимает серверный flusher очереди; в тестовом процессе он не
// должен удерживать event loop после окончания TAP-прогона.
globalThis.__mordaQueueFlusher?.unref?.();
after(() => {
  clearInterval(globalThis.__mordaQueueFlusher);
  fs.rmSync(КОРЕНЬ, { recursive: true, force: true });
});

async function jiraApi() {
  return import('../src/lib/server/jira.js');
}

function jiraОтвет(issues, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { issues }; },
  };
}

const КЛЮЧИ = {
  JIRA_URL: 'https://x.atlassian.net',
  JIRA_USERNAME: 'u',
  JIRA_API_TOKEN: 't',
};

test('DoD 1–2: ticketOf находит первый ключ, а явный тикет сильнее цели', () => {
  const случаи = [
    [{ goal: 'исполни STOVP-65 и отчитайся' }, 'STOVP-65'],
    [{ goal: 'сначала STOVP-70, после STOVP-65' }, 'STOVP-70'],
    [{ ticket: '  KAN-140  ', goal: 'исполни STOVP-65' }, 'KAN-140'],
    [{ ticket: 'не ключ', goal: 'исполни STOVP-65' }, 'STOVP-65'],
  ];
  for (const [аргументы, ожидается] of случаи)
    assert.equal(runner.ticketOf(аргументы), ожидается, JSON.stringify(аргументы));
});

test('DoD 1–2, негативные: ticketOf не нормализует регистр и не выдумывает ключ', () => {
  for (const аргументы of [
    { goal: 'исполни stovp-65' },
    { goal: 'цель без ключа' },
    { ticket: 'stovp-65', goal: '' },
    {},
    undefined,
  ]) assert.equal(runner.ticketOf(аргументы), null, JSON.stringify(аргументы));
});

test('DoD 3: registryRecord собирает новую запись с тикетом и стартовыми флагами', () => {
  const запись = runner.registryRecord(null, {
    project: 'stovp', root: '/work/stovp', goal: 'Исполни KAN-140',
    sessionId: 's1', model: 'sonnet', mode: 'bypass', effort: 'high',
    slot: 'main', mcp: 'strict', ticket: 'KAN-140', passport_warning: 'нет паспорта',
  });
  const { startedAt, ...поля } = запись;
  assert.match(startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(поля, {
    project: 'stovp', root: '/work/stovp', goal: 'Исполни KAN-140',
    goalSent: false, sessionId: 's1', model: 'sonnet', mode: 'bypass',
    effort: 'high', slot: 'main', mcp: 'strict', ticket: 'KAN-140',
    state: 'starting', stoppedAt: null, passport_warning: 'нет паспорта',
  });
});

test('DoD 3: registryRecord при restart/resume/adopt мержит мету и не стирает ticket', () => {
  const прежняя = {
    project: 'stovp', root: '/old', goal: 'Старая цель', goalSent: true,
    sessionId: 'old-session', model: 'opus', mode: 'plan', effort: 'max',
    slot: 'slot-a', mcp: 'strict', ticket: 'STOVP-65',
    startedAt: '2020-01-01T00:00:00.000Z', state: 'stopped',
    stoppedAt: '2020-01-02T00:00:00.000Z', passport_warning: 'предупреждение',
  };
  const запись = runner.registryRecord(прежняя, {
    project: 'stovp', root: '/new', goal: null, sessionId: 'new-session',
    model: undefined, mode: 'bypass', effort: null, slot: undefined,
    mcp: null, ticket: null, passport_warning: undefined,
  });
  assert.equal(запись.ticket, 'STOVP-65');
  assert.equal(запись.goal, 'Старая цель');
  assert.equal(запись.model, 'opus');
  assert.equal(запись.mode, 'bypass');
  assert.equal(запись.effort, 'max');
  assert.equal(запись.slot, 'slot-a');
  assert.equal(запись.mcp, 'strict');
  assert.equal(запись.passport_warning, 'предупреждение');
  assert.equal(запись.goalSent, false);
  assert.equal(запись.state, 'starting');
  assert.equal(запись.stoppedAt, null);
  assert.notEqual(запись.startedAt, прежняя.startedAt);
});

test('DoD 3: runnerOwned отдаёт ticket записи и null для старого формата', () => {
  fs.writeFileSync(РЕЕСТР, JSON.stringify({ sessions: {
    'net-takoi-sessii-stovp69': { sessionId: 's1', ticket: 'STOVP-65', state: 'running' },
    'net-takoi-sessii-legacy': { sessionId: 's2', state: 'running' },
  } }));
  const свои = fleet.runnerOwned();
  assert.deepEqual(свои.get('s1'), {
    name: 'net-takoi-sessii-stovp69', alive: false, ticket: 'STOVP-65',
  });
  assert.deepEqual(свои.get('s2'), {
    name: 'net-takoi-sessii-legacy', alive: false, ticket: null,
  });
});

test('DoD 3–4: toEpic предпочитает локальную карту, затем родителя и тип из кэша Jira', async () => {
  assert.equal(typeof fleet.toEpic, 'function', 'fleet.toEpic должен быть экспортирован');
  const { jiraIssue, jiraFlush, jiraReset } = await jiraApi();
  jiraReset();
  assert.equal(jiraIssue('KAN-140'), null);
  assert.equal(jiraIssue('KAN-100'), null);
  await jiraFlush({ keys: КЛЮЧИ, fetch: async () => jiraОтвет([
    { key: 'KAN-140', fields: { summary: 'Дочерняя задача',
      issuetype: { name: 'Task' }, parent: { key: 'KAN-100' } } },
    { key: 'KAN-100', fields: { summary: 'Большая работа',
      issuetype: { name: 'Эпик' }, parent: { key: 'KAN-1' } } },
  ]) });
  assert.equal(fleet.toEpic('STOVP-65'), 'STOVP-64');
  assert.equal(fleet.toEpic('KAN-140'), 'KAN-100');
  assert.equal(fleet.toEpic('KAN-100'), 'KAN-100');
  assert.equal(fleet.toEpic('UNKNOWN-7'), 'UNKNOWN-7');
  assert.equal(fleet.toEpic(null), null);
});

test('DoD 3: схема MCP pult_start объявляет строковое поле ticket', () => {
  const исходник = fs.readFileSync(path.join(MORDA, 'mcp', 'pult-mcp.mjs'), 'utf8');
  const блок = исходник.match(/\bpult_start\s*:\s*\{([\s\S]*?)(?=\n\s*pult_[a-z_]+\s*:\s*\{)/)?.[1];
  assert.ok(блок, 'не найден блок pult_start до следующего MCP-тула');
  const схема = блок.match(/inputSchema\s*:\s*\{([\s\S]*?)\n\s*\},\n\s*async handler/)?.[1];
  assert.ok(схема, 'не найден inputSchema pult_start');
  assert.match(схема, /\bticket\s*:\s*\{\s*type\s*:\s*['"]string['"]/);
});

test('DoD 4: jiraFlush грузит очередь одной пачкой и повторно сеть не вызывает', async () => {
  const { jiraIssue, jiraFlush, jiraReset, jiraNames } = await jiraApi();
  jiraReset();
  assert.equal(jiraIssue('STOVP-65'), null);
  assert.equal(jiraIssue('STOVP-64'), null);
  const вызовы = [];
  const fetch = async (url, параметры = {}) => {
    вызовы.push({ url: String(url), параметры });
    return jiraОтвет([
      { key: 'STOVP-65', fields: { summary: 'Поле тикета',
        issuetype: { name: 'Task' }, parent: { key: 'STOVP-64' } } },
      { key: 'STOVP-64', fields: { summary: 'Пульт',
        issuetype: { name: 'Epic' }, parent: null } },
    ]);
  };
  assert.equal(await jiraFlush({ fetch, keys: КЛЮЧИ }), 2);
  assert.equal(вызовы.length, 1);
  const запрос = вызовы[0];
  const jql = `${decodeURIComponent(запрос.url)}\n${запрос.параметры.body || ''}`;
  assert.match(jql, /key\s+in\s*\(/i);
  assert.match(jql, /STOVP-65/);
  assert.match(jql, /STOVP-64/);
  const заголовки = new Headers(запрос.параметры.headers);
  assert.equal(заголовки.get('authorization'),
    `Basic ${Buffer.from('u:t').toString('base64')}`);
  assert.deepEqual(jiraIssue('STOVP-65'), {
    summary: 'Поле тикета', parent: 'STOVP-64', isEpic: false,
  });
  assert.deepEqual(jiraIssue('STOVP-64'), {
    summary: 'Пульт', parent: null, isEpic: true,
  });
  assert.deepEqual(jiraNames(['STOVP-65', 'STOVP-64', 'NO-1']), new Map([
    ['STOVP-65', 'Поле тикета'], ['STOVP-64', 'Пульт'],
  ]));
  assert.equal(await jiraFlush({ fetch, keys: КЛЮЧИ }), 0);
  assert.equal(вызовы.length, 1);
});

test('DoD 4, негативные: без ключей и при ошибке Jira сервер не бросает', async () => {
  const { jiraIssue, jiraFlush, jiraReset } = await jiraApi();
  jiraReset();
  assert.equal(jiraIssue('STOVP-70'), null);
  let вызовов = 0;
  const fetch = async () => { вызовов++; throw new Error('сеть недоступна'); };
  assert.equal(await jiraFlush({ fetch, keys: {} }), 0);
  assert.equal(вызовов, 0);
  assert.equal(jiraIssue('STOVP-70'), null);
  assert.equal(await jiraFlush({ fetch, keys: КЛЮЧИ }), 0);
  assert.equal(вызовов, 1);
  assert.equal(jiraIssue('STOVP-70'), null);
  assert.equal(await jiraFlush({
    keys: КЛЮЧИ,
    fetch: async () => { вызовов++; return jiraОтвет([], 500); },
  }), 0);
  assert.equal(вызовов, 2);
  assert.equal(jiraIssue('STOVP-70'), null);
});

test('DoD 4, негативный: отсутствующий в Jira ключ запоминается неизвестным', async () => {
  const { jiraIssue, jiraFlush, jiraReset } = await jiraApi();
  jiraReset();
  assert.equal(jiraIssue('DELETED-404'), null);
  let вызовов = 0;
  const fetch = async () => { вызовов++; return jiraОтвет([]); };
  assert.equal(await jiraFlush({ fetch, keys: КЛЮЧИ }), 0);
  assert.equal(вызовов, 1);
  assert.equal(jiraIssue('DELETED-404'), null);
  assert.equal(await jiraFlush({ fetch, keys: КЛЮЧИ }), 0);
  assert.equal(вызовов, 1);
});
