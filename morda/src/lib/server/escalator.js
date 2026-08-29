// Эскалатор (мандат CTO 25.08: «вопросы диспетчеров и HITL пнули до
// постановщика — всё сваливается в одну Desktop-сессию»). Постоянного
// слушателя нет: раз в тик собираем НОВЫЕ события «ждут человека» и
// доставляем их пинком в живую Desktop-сессию постановщика через
// курьера — головой headless `claude -p` с руками ListAgents+SendMessage
// (канал проверен живьём 25.08: пинок из сессии дошёл в Desktop-чат).
// Некому доставить — события никуда не деваются: они и так лежат асками
// в будке и видны в пульте; эскалатор их просто не помечает и попробует
// на следующем тике.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { projects, hubForJudge, rootByName, MORDA_ROOT, CLAUDE_BIN, SPAWN_ENV }
  from './fleet.js';
import { runnerList, injectSend } from './runner.js';
import { dutyDeliver } from './duty.js';

const STATE = path.join(MORDA_ROOT, 'escalator.json');
// экраны, на которых CLI-сессия ждёт человека (та же семантика, что у
// сводки «ждут вас» на главной)
const HITL_SCREENS = new Set(['hitl', 'permission', 'needs_auth']);
// Автопинок висящего вопроса (KAN-209 29.08: карточка «сессия молчит» от
// 11:02 разобрана в 14:11 — пассивная карточка никого не будит): вопрос
// открыт дольше порога → постановщик недоступен или не дошли руки → автор
// получает стандартный пинок «продолжай по своей роли». Один пинок на ask.
const NUDGE_MS = (Number(process.env.MORDA_NUDGE_MIN) >= 5
  ? Number(process.env.MORDA_NUDGE_MIN) : 30) * 60_000;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    s.nudged ??= {};
    return s;
  } catch { return { asks: [], hitl: {}, nudged: {} }; }
}
function saveState(s) {
  // память доставленного ограничена: старые id уходят, дедуп будки всё
  // равно не даст той же карточке возникнуть заново
  s.asks = s.asks.slice(-500);
  fs.writeFileSync(STATE, JSON.stringify(s));
}

/** Собрать новые события по проекту: открытые ask'и, о которых постановщика
 *  ещё не пинали, и сессии, ВНОВЬ вставшие на экран «ждёт человека». */
function collect(p, st) {
  const lines = [];
  const link = `http://127.0.0.1:4747/?p=${encodeURIComponent(p.name)}`;
  let asks = [];
  try { asks = hubForJudge(rootByName(p.name)).asks({ status: 'open' }).asks; }
  catch { /* проект без будки */ }
  const freshAsks = asks.filter((a) => !st.asks.includes(a.id));
  for (const a of freshAsks)
    lines.push(`- вопрос (ask ${a.id}) от «${String(a.session || '?').slice(0, 40)}»: `
      + `«${String(a.question || '').slice(0, 200)}»`);
  let rows = [];
  try { rows = runnerList(p.name); } catch {}
  const hitlNow = new Set();
  for (const s of rows) {
    if (!s.alive || !HITL_SCREENS.has(s.screen)) continue;
    const key = `${p.name}/${s.name}/${s.screen}`;
    hitlNow.add(key);
    if (st.hitl[key]) continue; // об этом эпизоде уже пинали
    lines.push(`- сессия «${s.name}» ждёт человека на экране ${s.screen} — глянь pult_screen`);
    st.hitl[key] = Date.now();
  }
  // эпизод кончился (сессия ушла с экрана) — метка снимается, новый
  // заход на тот же экран снова даст пинок
  for (const k of Object.keys(st.hitl))
    if (k.startsWith(p.name + '/') && !hitlNow.has(k)) delete st.hitl[k];
  return { lines, link, freshAsks, openAsks: asks, rows };
}

/** Автопинок автора висящего вопроса: постановщика пнули, но вопрос открыт
 *  дольше NUDGE_MS — значит, человека нет (ночь) или руки не дошли. Автору
 *  уходит стандартное «продолжай по своей роли» прямым вводом в CLI (в
 *  занятую — мид-тёрн; открытый диалог injectSend сам переведёт в очередь) +
 *  пометка в ленту будки. Один пинок на ask — дальше решает человек. */
function nudgeStale(p, st, openAsks, rows) {
  let sent = 0;
  for (const a of openAsks) {
    if (st.nudged[a.id]) continue;
    const age = Date.now() - new Date(a.ts || 0).getTime();
    if (!(age > NUDGE_MS)) continue;
    const s = rows.find((r) => r.alive
      && (r.sessionId === a.session || r.name === a.session));
    st.nudged[a.id] = Date.now();   // и при неудаче: второй заход не нужен
    if (!s) continue;
    const min = Math.round(age / 60000);
    try {
      injectSend({ name: s.name, text:
        `[эскалатор] Твой вопрос «${String(a.question || '').slice(0, 160)}» висит без ответа ${min} мин — постановщик недоступен. `
        + 'Продолжай по своей роли и мандату: решение в рамках уже принятых — прими сам и зафиксируй комментом; '
        + 'настоящий блокер — оформи блокером в тикет и возьми следующую работу. Не стой на промпте молча.' });
      sent++;
      try {
        hubForJudge(rootByName(p.name)).post({ from: 'эскалатор',
          text: `автопинок «${s.name}» (ask ${a.id}): вопрос без ответа ${min} мин, послано «продолжай по своей роли»` });
      } catch { /* лента недоступна — пинок важнее пометки */ }
      console.log(`[escalator] ${p.name}: автопинок ${s.name} по ask ${a.id} (${min} мин)`);
    } catch (e) { console.log(`[escalator] ${p.name}: автопинок ${s.name} не ушёл — ${e.message}`); }
  }
  return sent;
}

/** Курьер: headless-голова находит живую Desktop-сессию постановщика и
 *  вручает ей пачку. Сам ничего не решает — только доставка. */
function courier(project, slug, link, lines, onDone) {
  const payload = [
    `[эскалация пульта · проект ${project}] Новые события «ждут человека»:`,
    ...lines,
    `Разбери по мандату постановщика: pult_asks → понятное реши сам (pult_answer),`,
    `непонятное доуточни у автора, человеку перескажи только готовые к решению`,
    `вопросы. Карточки: ${link}`,
  ].join('\n');
  const prompt = [
    'Ты — курьер эскалаций пульта. Твоя единственная задача — доставить пачку событий постановщику.',
    '1. Вызови ListAgents. Постановщик — интерактивная сессия БЕЗ пометки tmux в строке;',
    // имена сессий — слаг РАБОЧЕЙ ПАПКИ (basename корня), не имя проекта
    // пульта: у «nyron» корень ai-evolve → сессии зовутся ai-evolve-*
    `   предпочти имя, начинающееся с «${slug}-»; среди подходящих бери САМУЮ СТАРШУЮ`,
    '   по старту (постановщик живёт долго, свежесозданные чаще оказываются чьими-то субагентами).',
    '   Если НИ ОДНОЙ интерактивной сессии без tmux нет — заверши работу молча, ничего не отправляя.',
    '2. Отправь выбранной сессии SendMessage ОДНИМ сообщением ровно этот текст:',
    '<пачка>',
    payload,
    '</пачка>',
    'Больше никаких действий и никаких других сообщений.',
  ].join('\n');
  execFile(CLAUDE_BIN, ['-p', prompt, '--model', 'haiku',
    '--allowedTools', 'ListAgents,SendMessage'],
  { env: SPAWN_ENV, timeout: 180_000, cwd: MORDA_ROOT },
  (err, stdout) => onDone(err, String(stdout || '').slice(0, 200)));
}

/** Один тик эскалатора. Возвращает, сколько пачек ушло (для лога). */
export function escalatorScan() {
  // первый запуск — базлайн: всё висящее помечается доставленным БЕЗ
  // пинков (лавина старых карточек — не «новые события»; они и так в пульте)
  const baseline = !fs.existsSync(STATE);
  const st = loadState();
  let sent = 0;
  const allOpenIds = new Set();
  for (const p of projects() || []) {
    const { lines, link, freshAsks, openAsks, rows } = collect(p, st);
    openAsks.forEach((a) => allOpenIds.add(a.id));
    if (baseline) { st.asks.push(...freshAsks.map((a) => a.id)); continue; }
    nudgeStale(p, st, openAsks, rows);
    if (!lines.length) continue;
    sent++;
    // Первый адресат — ДЕЖУРНЫЙ (решение CTO 29.08: Desktop-чат исполняется
    // только в момент хода и оркестрировать не может): пачка уходит прямым
    // вводом в его CLI, доставку дожимает strandedSweep. Дежурного нет —
    // фолбэк на курьера в Desktop, как жило до дежурного.
    const dutyPack = [
      `[эскалация пульта · проект ${p.name}] Новые события «ждут человека»:`,
      ...lines,
      `Разбери по мандату дежурного. Карточки: ${link}`,
    ].join('\n');
    if (dutyDeliver(dutyPack)) {
      console.log(`[escalator] ${p.name}: доставлено дежурному ${lines.length} событий`);
      st.asks.push(...freshAsks.map((a) => a.id));
      continue;
    }
    let slug = p.name;
    try { slug = path.basename(rootByName(p.name)); } catch {}
    courier(p.name, slug, link, lines, (err, out) => {
      if (err) { console.log(`[escalator] ${p.name}: курьер не доставил — ${err.message}`); return; }
      console.log(`[escalator] ${p.name}: доставлено ${lines.length} событий (${out.split('\n')[0]})`);
    });
    // ask'и помечаем сразу: повторный пинок той же карточкой хуже, чем
    // потерянный при упавшем курьере — карточка всё равно висит в пульте
    st.asks.push(...freshAsks.map((a) => a.id));
  }
  // память пинков не растёт вечно: закрытые вопросы выпадают (сверка — по
  // открытым ВСЕХ проектов, иначе проекты стирали бы метки друг друга)
  for (const id of Object.keys(st.nudged))
    if (!allOpenIds.has(id)) delete st.nudged[id];
  saveState(st);
  return sent;
}
