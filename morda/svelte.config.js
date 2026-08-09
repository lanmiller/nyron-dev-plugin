import adapter from '@sveltejs/adapter-node';

/** Морда — пульт флота сессий (этап 3 спеки docs/specs/2026-08-08-morda-pult.md).
 * adapter-node: фаза 1 — localhost, фаза 2 — тот же build на сервере. */
export default {
  kit: { adapter: adapter() },
};
