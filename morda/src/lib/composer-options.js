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
