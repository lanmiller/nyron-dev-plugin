/**
 * jira.js — человеческие названия тикетов и эпиков для дерева сессий.
 *
 * Локальная карта epics.json остаётся первым источником (её пишет человек),
 * но она знает лишь то, что в неё внесли: новый тикет волны появлялся в
 * сайдбаре голым ключом и без эпика. Трекер знает и родителя, и название —
 * спрашиваем его сами, ОДНИМ запросом на пачку ключей.
 *
 * Синхронность дерева не ломаем: jiraIssue/jiraNames читают только кэш, а
 * незнакомые ключи кладут в очередь; сеть дёргает фоновый jiraFlush, и
 * названия приезжают к следующему опросу. Ключи — из ключницы пульта
 * (.secrets/env, значения через контекст сессии не проходят):
 *   JIRA_URL       — например https://nyron.atlassian.net
 *   JIRA_USERNAME  — почта учётки
 *   JIRA_API_TOKEN — токен id.atlassian.com
 * Ключей нет или трекер молчит — дерево живёт на epics.json, как раньше.
 */
import { keysEnv } from './keys.js';

const TTL = 10 * 60_000;      // название тикета меняется реже, чем опрос флота
const BATCH = 50;             // один запрос на опрос: ключей в дереве десятки
const DEBOUNCE = 1000;        // очередь копится за опрос, ходим в трекер раз
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

// Кэш и очередь — в globalThis: Vite HMR пересоздаёт модуль, а локальные
// Map начинали бы историю заново на каждой правке (тот же приём, что dbs).
const st = (globalThis.__mordaJira ??= { by: new Map(), queue: new Set(), timer: null });

function cached(key) {
  const e = st.by.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL) { st.by.delete(key); return null; }
  return e;
}

function schedule() {
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    jiraFlush().catch(() => { /* трекер молчит — дерево живёт без названий */ });
  }, DEBOUNCE);
  st.timer.unref?.();
}

/** Тикет из кэша: `{ summary, parent, isEpic }` либо null. Незнакомый ключ
 *  встаёт в очередь и приедет к следующему опросу — ждать сеть здесь нельзя. */
export function jiraIssue(key) {
  const k = String(key || '');
  const e = cached(k);
  if (e) return e.issue;
  if (KEY_RE.test(k)) { st.queue.add(k); schedule(); }
  return null;
}

/** Названия пачкой: Map ключ → summary, только для тех, что уже в кэше.
 *  Очередь НЕ трогает: это чтение для отрисовки, а не запрос к трекеру. */
export function jiraNames(keys) {
  const out = new Map();
  for (const key of keys || []) {
    const k = String(key || '');
    const s = cached(k)?.issue?.summary;
    if (s) out.set(k, s);
  }
  return out;
}

/** Тип «эпик» — по имени типа задачи (локаль трекера своя: Epic/Эпик) и по
 *  уровню иерархии, который Jira отдаёт вместе с типом. */
function epicType(t) {
  return /^(epic|эпик)$/i.test(String(t?.name || '').trim())
    || Number(t?.hierarchyLevel) > 0;
}

/** Догрузить очередь: один POST /rest/api/3/search/jql на пачку.
 *  Возвращает число загруженных тикетов. Не бросает никогда: пульт без
 *  трекера обязан работать. */
export async function jiraFlush({ fetch: f = globalThis.fetch, keys = keysEnv() } = {}) {
  if (!st.queue.size) return 0;
  const url = String(keys?.JIRA_URL || '').replace(/\/+$/, '');
  const user = keys?.JIRA_USERNAME, token = keys?.JIRA_API_TOKEN;
  if (!url || !user || !token || typeof f !== 'function') return 0;
  const batch = [...st.queue].slice(0, BATCH);
  for (const k of batch) st.queue.delete(k);
  let data;
  try {
    const res = await f(`${url}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jql: `key in (${batch.join(',')})`,
        fields: ['summary', 'issuetype', 'parent'],
        maxResults: batch.length,
      }),
    });
    if (!res?.ok) throw new Error(`Jira ответила ${res?.status}`);
    data = await res.json();
  } catch {
    // сеть/трекер моргнули — пачка возвращается в очередь, следующий опрос
    // попробует снова (иначе один сбой стирал бы названия до перезапуска)
    for (const k of batch) st.queue.add(k);
    return 0;
  }
  const at = Date.now();
  const got = new Set();
  for (const it of data?.issues || []) {
    const k = String(it?.key || '');
    if (!k) continue;
    const fl = it.fields || {};
    st.by.set(k, { at, issue: {
      summary: fl.summary || null,
      parent: fl.parent?.key || null,
      isEpic: epicType(fl.issuetype),
    } });
    got.add(k);
  }
  // ключ есть в заголовке сессии, а в трекере его нет (опечатка, чужой
  // проект, удалён) — запоминаем неизвестным, иначе каждый опрос дерева
  // отправлял бы за ним новый запрос
  for (const k of batch) if (!got.has(k)) st.by.set(k, { at, issue: null });
  return got.size;
}

/** Сброс кэша и очереди — для тестов и ручной перечитки. */
export function jiraReset() {
  st.by.clear();
  st.queue.clear();
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
}
