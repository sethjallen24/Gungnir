import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :3000 (npm run dev starts both) and Vite proxies to it.
const api = { target: `http://localhost:${process.env.PORT ?? 3000}`, changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web', target: 'es2022' },
  server: { port: 5173, proxy: { '/api': api, '/oauth': api, '/m': api } },
});
