import { sveltekit } from '@sveltejs/kit/vite';

export default {
  plugins: [sveltekit()],
  // Только localhost (канон фазы 1: пульт — руки, наружу не торчит;
  // телефон — через ТГ-мини-апп с авторизацией, не голым портом).
  server: { host: '127.0.0.1', port: 4747 },
  preview: { host: '127.0.0.1', port: 4747 },
};
