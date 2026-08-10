import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The proxy is what makes dev same-origin. The session cookie is
 * sameSite: 'strict' and the API has no CORS, so hitting :3000 directly from
 * :5173 would send no cookie - a login that appears to succeed and then 401s
 * on every call. Proxying keeps dev and production behaviourally identical.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
