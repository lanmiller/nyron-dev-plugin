// CSRF-щит всех мутирующих ручек (ревью Sol 09.08): localhost не защищает —
// чужой сайт в браузере CTO может слать простые POST на 127.0.0.1. Требуем
// свой заголовок (его нельзя поставить простым cross-origin запросом без
// preflight) и same-origin по Sec-Fetch-Site, когда браузер его прислал.
export function guarded(request) {
  if (request.headers.get('x-morda') !== '1') return 'нет заголовка x-morda';
  const sfs = request.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return `sec-fetch-site: ${sfs}`;
  return null;
}
