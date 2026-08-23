/**
 * session-tree.js — раскладка плоского списка сессий в дерево
 * «эпик → тикет → сессии» (STOVP-69).
 *
 * До этого сайдбар раскладывал сессии сам и связывал волну с диспетчером по
 * НОМЕРУ БЛОКА из текста заголовка («Блок 2», «Ф2», «волна 3»). Эвристика
 * врала: одно и то же число в разных ветках именования липло к чужому
 * диспетчеру. Теперь уровень задаёт факт — поле `ticket` записи реестра
 * (его задал человек в форме запуска), а роль (диспетчер/волна) осталась
 * пометкой строки, а не способом вложения.
 *
 * Два потребителя, поэтому это отдельный модуль, а не функция страницы:
 * сайдбар (`routes/+layout.svelte`) и секция «Флот» главной
 * (`routes/+page.svelte`). Данные у них разного происхождения (дерево
 * сессий и реестр раннера), общее — поля `epic`, `epic_title`, `ticket`,
 * `ticket_title`.
 */

/** Заголовок строки без ключей, которые уже стоят в заголовках уровней:
 *  «STOVP-64: Блок 1 диспетчер» под эпиком STOVP-64 читается как
 *  «Блок 1 диспетчер». Пусто (у записи реестра заголовка нет) — пусто. */
function shortTitle(s) {
  const full = String(s.title ?? '');
  if (!full) return '';
  let out = full;
  for (const key of [s.epic, s.ticket]) if (key) out = out.replaceAll(key, '');
  return out.replace(/^[\s:—-]+/, '').trim() || full;
}

/**
 * Сгруппировать сессии: эпик → тикет → сессии.
 *
 * @param {Array} list плоский список строк с полями epic/ticket/*_title
 * @returns {Array} [{ epic, epic_title, all, tickets: [{ ticket, ticket_title,
 *   sessions }], loose }] — `loose` это сессии эпика без тикета (диспетчер и
 *   т.п.), «вне эпиков» всегда последней группой, эпики — по числу сессий.
 */
export function groupSessions(list = []) {
  const map = new Map();
  for (const src of list) {
    const ek = src.epic || '';
    if (!map.has(ek))
      map.set(ek, { epic: src.epic || null, epic_title: src.epic_title || null,
        all: [], byTicket: new Map(), loose: [] });
    const g = map.get(ek);
    if (!g.epic_title && src.epic_title) g.epic_title = src.epic_title;
    // копия, а не правка исходной строки: список пришёл из $state, и правка
    // на месте роняет рендер (state_unsafe_mutation)
    const s = { ...src, short: shortTitle(src) };
    g.all.push(s);
    if (!s.ticket) { g.loose.push(s); continue; }
    if (!g.byTicket.has(s.ticket))
      g.byTicket.set(s.ticket, { ticket: s.ticket, ticket_title: s.ticket_title || null, sessions: [] });
    const t = g.byTicket.get(s.ticket);
    if (!t.ticket_title && s.ticket_title) t.ticket_title = s.ticket_title;
    t.sessions.push(s);
  }
  return [...map.values()]
    .map(({ byTicket, ...g }) => ({
      ...g,
      // тикеты — по числу сессий, при равенстве по ключу: порядок не должен
      // прыгать от опроса к опросу
      tickets: [...byTicket.values()].sort((a, b) =>
        b.sessions.length - a.sessions.length || (a.ticket < b.ticket ? -1 : 1)),
    }))
    // эпики вперёд по числу сессий, «вне эпиков» — всегда последним
    .sort((a, b) => (!a.epic) - (!b.epic) || b.all.length - a.all.length);
}
