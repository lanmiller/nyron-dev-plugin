/**
 * tui.js — парсер TUI-диалогов Claude CLI с tmux-экрана в структуру для
 * нативного рендера (требование CTO 17.08: формы в пульте — карточками,
 * как в приложении, а не сырым экраном).
 *
 * Почему с экрана: AskUserQuestion и прочие пикеры НЕ пишутся в транскрипт
 * до ответа — экран терминала единственный живой источник. Семантика клавиш
 * снята фактом с живой формы (сессия stovp-proto-hitl, 17.08):
 *   цифра N — одиночный выбор: выбрать и перейти дальше; мультиселект:
 *     переключить галочку; фокус на «Type something» — открыть ввод;
 *   набор текста — уходит в фокусную опцию свободного ответа;
 *   Tab / Shift+Tab — следующий / предыдущий вопрос (таб);
 *   Enter — выбрать фокусное; Esc — отменить форму целиком.
 *
 * Форматы экрана (сняты фактом):
 *   вопрос:  «←  ☒ Выбор  ☐ Флаги  ✔ Submit  →», пустая строка, текст
 *            вопроса, опции «❯ 1. Метка ✔» / «2. [ ] Метка» с описанием
 *            продолжением, разделитель, «5. Chat about this», футер
 *            «Enter to select · … · Esc to cancel»;
 *   сводка:  «Review your answers», строки «● вопрос» / «→ ответ»,
 *            «1. Submit answers / 2. Cancel».
 *
 * Парсер не притворяется всезнающим: не распознал — вернул null, окно
 * сессии показывает сырой экран (честный фолбэк, не молчаливый).
 */

// Таб-строка: «←  ☒ Выбор  ☒ Флаги  ✔ Submit  →» (у формы из одного
// вопроса её нет). ☒ — вопрос отвечен, ✔ — маркер Submit-таба.
// current — текущий таб: в терминале он подсвечен фоном, из capture -e
// достаём его метку по SGR-коду 48;5;N (снято фактом 17.08).
function parseTabs(line, currentLabel) {
  const tabs = [];
  for (const m of line.matchAll(/([☒☐✔])\s+(.+?)(?=\s\s+[☒☐✔→]|\s+→|$)/g)) {
    const label = m[2].trim();
    tabs.push({ label, answered: m[1] === '☒', submit: label === 'Submit',
      current: currentLabel !== null && label === currentLabel });
  }
  return tabs.length ? tabs : null;
}

const ANSI_RE = /\[[0-9;]*m/g;

/**
 * Запрос разрешения с экрана CLI → структура для карточки (CTO 19.08:
 * «почему индикации нет» — человек должен видеть, ЧТО именно разрешает,
 * а не только кнопки «разрешить/отказать»).
 *
 * Формат экрана (снят фактом с живой сессии-аудитора):
 *   Bash command
 *     <команда, может быть многострочной>
 *     <описание одной строкой>
 *   Contains simple_expansion        ← пометки CLI, необязательны
 *   Do you want to proceed?
 *   ❯ 1. Yes / 2. No
 */
export function parsePermission(raw) {
  const lines = raw.replace(ANSI_RE, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const ask = lines.findIndex((l) => /Do you want to proceed\?|requires approval/i.test(l));
  if (ask < 0) return null;
  // блок запроса — непустые строки над вопросом (до рамки/верха экрана)
  const block = [];
  for (let i = ask - 1; i >= 0 && ask - i < 25; i--) {
    const t = lines[i];
    if (/^[─—-]{10,}$/.test(t.trim())) break;
    if (t.trim()) block.unshift(t);
  }
  if (!block.length) return null;
  // пометки CLI («Contains simple_expansion») — не часть команды
  const notes = block.filter((l) => /^\s*(Contains|This command|Note:)/i.test(l))
    .map((l) => l.trim());
  const rest = block.filter((l) => !notes.includes(l.trim()));
  // заголовок — ПЕРВАЯ строка блока, если она короткая («Bash command»,
  // «Edit file», имя MCP-тулзы); иначе весь блок — тело
  const first = rest[0]?.trim() || '';
  const hasHead = first.length <= 40 && !/[.;:)]$/.test(first);
  return {
    title: hasHead ? first : 'Действие сессии',
    body: rest.slice(hasHead ? 1 : 0).map((l) => l.replace(/^ {0,3}/, '')).join('\n').trim(),
    notes,
  };
}

// подсветка фоном (SGR 48;5;N) внутри строки — так CLI помечает текущий таб
function highlighted(rawLine) {
  const m = rawLine.match(/\[48;5;\d+m([^]+)/);
  return m ? m[1].replace(/[☒☐✔]/g, '').trim() : null;
}

export function parseDialog(raw) {
  const rawLines = raw.split('\n');
  const lines = rawLines.map((l) => l.replace(ANSI_RE, '').replace(/\s+$/, ''));

  // якорь «это вообще наша форма»: футер пикера, а у Submit-экрана
  // футера нет — узнаём по заголовку сводки
  let footAt = lines.findIndex((l) => /Enter to select|keys to navigate|Esc to cancel/.test(l));
  const review = lines.some((l) => /Review your answers|Ready to submit your answers/.test(l));
  if (footAt < 0 && !review) return null;
  if (footAt < 0) footAt = lines.length;

  const tabIdx = lines.findLastIndex((l) => /^\s*←?\s*[☒☐].*✔\s+Submit/.test(l));
  const tabs = tabIdx >= 0 ? parseTabs(lines[tabIdx], highlighted(rawLines[tabIdx])) : null;
  const startAt = tabIdx >= 0 ? tabIdx + 1 : 0;

  // Submit-экран: сводка ответов + «1. Submit answers / 2. Cancel»
  if (review) {
    const answers = [];
    for (let i = startAt; i < footAt; i++) {
      const q = lines[i].match(/^\s*●\s+(.*)$/);
      if (q) answers.push({ question: q[1], answer: '' });
      const a = lines[i].match(/^\s*→\s+(.*)$/);
      if (a && answers.length) answers.at(-1).answer = a[1];
    }
    return { kind: 'review', tabs, answers };
  }

  // Экран вопроса: опции между вопросом и футером
  const options = [];
  let question = [];
  let sawOption = false;
  for (let i = startAt; i < footAt; i++) {
    const l = lines[i];
    if (/^[─—-]{10,}$/.test(l.trim())) continue;
    const m = l.match(/^\s*(❯)?\s*(\d+)\.\s+(?:\[([ ✔x])\]\s+)?(.*)$/);
    if (m) {
      sawOption = true;
      let label = m[4].trim();
      const selected = m[3] ? m[3] !== ' ' : /\s✔$/.test(label);
      label = label.replace(/\s✔$/, '');
      options.push({
        n: Number(m[2]),
        label,
        desc: [],
        focused: !!m[1],
        multi: m[3] !== undefined,
        selected,
        free: /^Type something\.?$/.test(label),
        chat: /^Chat about this$/.test(label),
      });
    } else if (sawOption && l.trim() && options.length) {
      options.at(-1).desc.push(l.trim());
    } else if (!sawOption && l.trim()) {
      question.push(l.trim());
    }
  }
  if (!options.length) return null;
  // «Type something» с уже набранным текстом метку меняет — считаем
  // свободным вводом последнюю не-chat опцию, если явной не нашлось
  if (!options.some((o) => o.free)) {
    const cand = options.findLast((o) => !o.chat);
    if (cand && options.some((o) => o.chat)) cand.free = true;
  }
  return {
    kind: 'question',
    tabs,
    question: question.join(' '),
    multi: options.some((o) => o.multi),
    options: options.map((o) => ({ ...o, desc: o.desc.join(' ') })),
  };
}
