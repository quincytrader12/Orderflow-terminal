import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy for the built app (the desktop window and the web build).
 * Scripts only from the app itself (plus the inline start-up guard, by its hash) and
 * no eval; styles and fonts from the app and Google Fonts; images from anywhere over
 * https (coin logos); connections to any exchange or RPC (https/wss, and http for a
 * local history server). The dev server is left without it so hot reload works.
 */
function csp(): Plugin {
  return {
    name: 'novus-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')}`.trim(),
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data: blob: https:",
          "connect-src 'self' https: wss: http: ws: data: blob:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true, minify: process.env.NOMINIFY ? false : 'esbuild', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.mjs', 'electron/**/*.test.mjs'] },
});
