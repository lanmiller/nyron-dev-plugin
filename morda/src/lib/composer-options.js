// Опции чипов композера — ОДИН словарь на оба места показа: старт сессии
// (главная) и композер её окна (запрос CTO 17.08 «сделай такой же инпут»).
// Дублировать списки по страницам нельзя: модели уже разъезжались.

export const MODEL_OPTS = [
  { value: 'fable', label: 'Fable 5', desc: 'самые сложные задачи' },
  { value: 'opus', label: 'Opus 5', desc: 'сложные задачи' },
  { value: 'sonnet', label: 'Sonnet 5', desc: 'эффективная для повседневного' },
  { value: 'haiku', label: 'Haiku 4.5', desc: 'быстрая, для мелочей' },
];

export const EFFORT_OPTS = [
  { value: 'low', label: 'Low', desc: 'быстрые ответы на простое' },
  { value: 'medium', label: 'Medium', desc: 'лёгкие задачи' },
  { value: 'high', label: 'High', desc: 'баланс для обычной работы' },
  { value: 'xhigh', label: 'Extra', desc: 'сложная, детальная работа' },
  { value: 'max', label: 'Max', desc: 'самое трудное; дольше всего' },
];

// Набор MCP-серверов сессии (разряды, постановщик 21.08). Дефолт CLI тащит
// ВСЕ серверы машины (факт: 25 серверов, 167+ инструментов); строгий
// профиль — MCP паспорта проекта + аккаунтные из канона, остальное
// отсекает --strict-mcp-config (без него --mcp-config только добавляет).
export const MCP_OPTS = [
  { value: '', label: 'Все серверы', icon: 'network',
    desc: 'дефолт CLI: все MCP машины (сейчас ~25 серверов)' },
  { value: 'strict', label: 'Строгий', icon: 'funnel',
    desc: 'только MCP паспорта проекта + аккаунтные из канона' },
];

// Слот запуска: «авто» — пульт сам берёт наименее занятую подписку
// (runner.js: slotPick). Остальные варианты доклеивает страница из живого
// списка слотов машины — их состав знает только сервер.
export const SLOT_AUTO = { value: 'auto', label: 'Автослот', icon: 'shuffle',
  desc: 'пульт берёт наименее занятую подписку' };

// Пресеты формы запуска (STOVP-69): три понятных случая вместо шести чипов.
// Модель и effort в пресет НЕ входят — они остаются на своих дефолтах
// (fable/high) и правятся в «тонкой настройке».
export const LAUNCH_PRESETS = [
  { value: 'task', label: 'Задача', icon: 'circle-check',
    desc: 'auto · строгий MCP · автослот',
    set: { mode: 'auto', mcp: 'strict', slot: 'auto' },
    placeholder: 'Опиши задачу — запустится новая сессия' },
  { value: 'wave', label: 'Волна / Диспетчер', icon: 'radio-tower',
    desc: 'bypass · строгий MCP · автослот',
    set: { mode: 'bypass', mcp: 'strict', slot: 'auto' },
    placeholder: 'Цель диспетчера или текст чипа волны',
    hint: 'Цель диспетчера — через скилл nyron-waves; волна — текст чипа /goal …' },
  { value: 'ask', label: 'Разовый вопрос', icon: 'message-square',
    desc: 'auto · все серверы · автослот',
    set: { mode: 'auto', mcp: '', slot: 'auto' },
    placeholder: 'Спроси что угодно — ответит разовая сессия' },
];

/** Пресет, которому отвечают текущие чипы, либо null — «своя настройка»
 *  (человек покрутил чип в шторке руками). */
export function presetOf({ mode, mcp, slot }) {
  return LAUNCH_PRESETS.find((p) => p.set.mode === mode
    && p.set.mcp === mcp && p.set.slot === slot)?.value || null;
}

export const MODE_OPTS = [
  { value: 'auto', label: 'Auto', icon: 'zap',
    desc: 'Клод сам решает вопросы разрешений' },
  { value: 'acceptEdits', label: 'Accept edits', icon: 'file-pen',
    desc: 'правки файлов — без спроса, остальное спросит' },
  { value: 'plan', label: 'Plan', icon: 'notebook-pen',
    desc: 'сначала покажет план, потом сделает' },
  { value: '', label: 'Manual', icon: 'hand',
    desc: 'каждое действие — вопросом' },
  { value: 'bypass', label: 'Bypass', icon: 'shield-check',
    desc: 'вообще без вопросов; опасное режет забор: снос вне проекта, силовой пуш, серверы' },
];
