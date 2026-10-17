import { defineConfig } from 'vite';

const apiPort = process.env.PORT ?? '8787';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
});
