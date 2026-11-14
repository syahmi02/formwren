import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Production-style build of the bench page into bench/dist, served by `vite preview`.
export default defineConfig({
  root: here,
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', minify: 'esbuild' },
  preview: { port: 5191, strictPort: true, host: '127.0.0.1' },
  server: { port: 5191, strictPort: true, host: '127.0.0.1' },
});
