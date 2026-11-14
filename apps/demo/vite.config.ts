import { defineConfig } from 'vite';

// The browser only talks to the dev server. It forwards the transaction endpoint to the demo server, so the server needs no CORS (step 4, decision 10).
// FW_DSX_TARGET lets the browser tests point at a separate test server.
const target = process.env.FW_DSX_TARGET ?? 'http://127.0.0.1:5300';

export default defineConfig({
  server: { proxy: { '/dsx': { target, changeOrigin: false } } },
});
