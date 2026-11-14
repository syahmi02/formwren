import type { InlineConfig } from 'vite';
import type { Io } from './commands.ts';
import { fwForms } from './vite-plugin.ts';

// Vite is loaded on demand so `fw check` and `fw fmt` start fast.

/**
 * The project's own `vite.config.ts`, if there is one, is loaded and merged by Vite itself: these
 * inline settings win over it, and plugin lists are joined.
 */
async function baseConfig(io: Io): Promise<InlineConfig> {
  const { default: react } = await import('@vitejs/plugin-react');
  return { root: io.cwd, plugins: [fwForms(), react()] };
}

export async function dev(io: Io, port: number | undefined, host: boolean): Promise<number> {
  const { createServer } = await import('vite');
  const config = await baseConfig(io);
  const server = await createServer({ ...config, server: { port: port ?? 5173, host: host || undefined } });
  await server.listen();
  server.printUrls();
  return 0;
}

export async function build(io: Io): Promise<number> {
  const { build: viteBuild } = await import('vite');
  const config = await baseConfig(io);
  // Output files get content hashes in their names, and the build writes only static files (FR-101).
  await viteBuild({ ...config, build: { outDir: 'dist', emptyOutDir: true } });
  return 0;
}
