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
import { runnerList } from './runner.js';

const STATE = path.join(MORDA_ROOT, 'escalator.json');
// экраны, на которых CLI-сессия ждёт человека (та же семантика, что у
// сводки «ждут вас» на главной)
const HITL_SCREENS = new Set(['hitl', 'permission', 'needs_auth']);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { asks: [], hitl: {} }; }
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
  return { lines, link, freshAsks };
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
  for (const p of projects() || []) {
    const { lines, link, freshAsks } = collect(p, st);
    if (baseline) { st.asks.push(...freshAsks.map((a) => a.id)); continue; }
    if (!lines.length) continue;
    sent++;
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
  saveState(st);
  return sent;
}
