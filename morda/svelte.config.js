import adapter from '@sveltejs/adapter-node';

/** Морда — пульт флота сессий (этап 3 спеки docs/specs/2026-08-08-morda-pult.md).
 * adapter-node: фаза 1 — localhost, фаза 2 — тот же build на сервере. */
export default {
  kit: {
    adapter: adapter(),
    // Штатный CSRF-чек SvelteKit режет multipart-POST (вложения), потому что
    // adapter-node без env ORIGIN не знает свой адрес, а пульт открывают и
    // как localhost, и как 127.0.0.1. Наш щит — свой и строже: заголовок
    // x-morda + sec-fetch-site на каждой мутирующей ручке (guard.js).
    csrf: { checkOrigin: false },
  },
};
