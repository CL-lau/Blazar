import { defineConfig } from 'vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: { '/v1': process.env.BLAZAR_ROUTER_URL || 'http://127.0.0.1:' + (process.env.BLAZAR_PORT || '4199') },
  },
});
