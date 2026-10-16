import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@core': path.resolve(__dirname, 'src/core'), '@web': path.resolve(__dirname, 'src/web') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
