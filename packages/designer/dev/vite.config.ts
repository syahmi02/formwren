import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The development page for the designer. From the repository root:
//   pnpm exec vite --config packages/designer/dev/vite.config.ts
// then open http://localhost:5196/dev/index.html
// The root is the designer package, so the page (dev/) and the canvas page (src/canvas/) are both served.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 5196, strictPort: true, fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
});
