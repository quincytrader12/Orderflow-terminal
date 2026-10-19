import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.mjs', 'electron/**/*.test.mjs'] },
});
