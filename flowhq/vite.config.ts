import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'public',
  resolve: { alias: { '@core': path.resolve(__dirname, 'src/core'), '@web': path.resolve(__dirname, 'src/web') } },
  build: { outDir: 'dist/web', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
