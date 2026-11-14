// Builds the extension: the extension host (Node, CommonJS), and the two webview bundles. Run with
// `pnpm vscode:build`. Pass --test to build the extension tests as well.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = resolve(root, '../../packages');
const dist = resolve(root, 'dist');
const withTests = process.argv.includes('--test');

// The workspace packages are TypeScript source, and this folder isn't linked to them, so point at the source directly.
const alias = [
  { find: /^@fw\/designer\/contract$/, replacement: resolve(packages, 'designer/src/contract.ts') },
  { find: /^@fw\/designer$/, replacement: resolve(packages, 'designer/src/index.ts') },
  { find: /^@fw\/components\/meta$/, replacement: resolve(packages, 'components/src/meta/index.ts') },
  { find: /^@fw\/components\/theme\.css$/, replacement: resolve(packages, 'components/src/theme/index.css') },
  { find: /^@fw\/components$/, replacement: resolve(packages, 'components/src/index.ts') },
  { find: /^@fw\/core$/, replacement: resolve(packages, 'core/src/index.ts') },
  { find: /^@fw\/format$/, replacement: resolve(packages, 'format/src/index.ts') },
  { find: /^@fw\/grid$/, replacement: resolve(packages, 'grid/src/index.ts') },
];

function config(entry: string, name: string, kind: 'node' | 'browser', outDir: string): InlineConfig {
  return {
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias },
    define: kind === 'browser' ? { 'process.env.NODE_ENV': '"production"' } : {},
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: true,
      minify: kind === 'browser',
      target: kind === 'node' ? 'node22' : 'es2023',
      cssCodeSplit: false,
      lib: {
        entry: resolve(root, entry),
        name: kind === 'browser' ? `fw_${name}` : undefined,
        formats: [kind === 'node' ? 'cjs' : 'iife'],
        fileName: () => (kind === 'node' ? `${name}.cjs` : `${name}.js`),
        cssFileName: name,
      },
      rollupOptions: kind === 'node' ? { external: ['vscode', /^node:/] } : {},
    },
  };
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'webview'), { recursive: true });

await build(config('src/extension.ts', 'extension', 'node', dist));
await build(config('webview/designer.tsx', 'designer', 'browser', resolve(dist, 'webview')));
await build(config('webview/canvas.ts', 'canvas', 'browser', resolve(dist, 'webview')));

if (withTests) await build(config('test/suite.ts', 'suite', 'node', resolve(dist, 'test')));
console.log(`Built the extension in ${dist}`);
