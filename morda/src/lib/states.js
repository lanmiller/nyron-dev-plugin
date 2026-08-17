// Словарь состояний сторожа для отображения (цвета — токены дизайн-лока).
export const STATE_RU = {
  working: ['работает', 'var(--ok)'],
  waiting_decision: ['ждёт решения', 'var(--warn)'],
  waiting_silent: ['ждёт молча', 'var(--hot)'],
  stalled: ['застряла', 'var(--stall)'],
  dead: ['закончилась', 'var(--dead)'],
  // раннер: CLI-процесс закрыт, транскрипт цел — поднимется от сообщения
  parked: ['запаркована', 'var(--dead)'],
};

export function age(ts) {
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  return `${Math.floor(m / 1440)} дн`;
}

export function hhmm(ts) {
  try { return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
