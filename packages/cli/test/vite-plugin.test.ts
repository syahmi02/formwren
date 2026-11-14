import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { fwForms } from '../src/vite-plugin.ts';
import { formText, project, write } from './helpers.ts';

const entry = (names: string[]): string =>
  names.map((name, i) => `import f${i} from './${name}.form.json';`).join('\n') + `\nconsole.log(${names.map((_, i) => `f${i}`).join(', ')});\n`;

async function bundle(root: string): Promise<Rollup.OutputChunk[]> {
  const result = await build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: [fwForms()],
    build: { write: false, minify: false, rollupOptions: { input: join(root, 'main.js') } },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs.flatMap((output) => output.output.filter((item): item is Rollup.OutputChunk => item.type === 'chunk'));
}

describe('fwForms()', () => {
  it('turns a form into a FormEntry whose script is a separate chunk', async () => {
    const root = project({
      'main.js': entry(['A']),
      'A.form.json': formText({ script: './A.form.ts', title: 'Chunk test' }),
      'A.form.ts': "export default { setup: () => ({ onInit: () => 'ran-the-script' }) };\n",
    });
    const chunks = await bundle(root);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const main = chunks.find((chunk) => chunk.isEntry);
    expect(main?.code).toContain('Chunk test');
    expect(main?.code).toMatch(/definition/);
    expect(main?.code).not.toContain('ran-the-script');
    expect(main?.dynamicImports.length).toBe(1);
    expect(chunks.find((chunk) => !chunk.isEntry)?.code).toContain('ran-the-script');
  });

  it('makes load() return a module with no handlers when the form has no script', async () => {
    const root = project({ 'main.js': entry(['B']), 'B.form.json': formText() });
    const chunks = await bundle(root);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.code).toContain('setup: () => ({})');
  });

  it('keeps each form in its own module and regenerates .form.gen.ts on build start', async () => {
    const root = project({
      'main.js': entry(['A', 'B']),
      'A.form.json': formText({ id: 'test.A', title: 'First form' }),
      'B.form.json': formText({ id: 'test.B', title: 'Second form' }),
    });
    const [main] = await bundle(root);
    expect(main?.code).toContain('First form');
    expect(main?.code).toContain('Second form');
    expect(existsSync(join(root, 'A.form.gen.ts'))).toBe(true);
    expect(existsSync(join(root, 'B.form.gen.ts'))).toBe(true);
  });

  it('writes quotes and backslashes in the content safely', async () => {
    const root = project({ 'main.js': entry(['C']), 'C.form.json': formText({ title: 'Quote " and \\ and  ' }) });
    const [main] = await bundle(root);
    expect(main?.code).toContain('Quote');
  });

  it('fails the build with the file, line and message for a semantic error', async () => {
    const text = formText({
      components: [{ id: 'a', type: 'Label', layout: { left: 0, top: 0, width: 10, height: 10 }, props: { text: '=vars.nope' } }],
    });
    const root = project({ 'main.js': entry(['D']), 'D.form.json': text });
    const line = text.split('\n').findIndex((l) => l.includes('"text"')) + 1;
    await expect(bundle(root)).rejects.toThrow(`D.form.json:${line}: components[0].props.text: No variable named "nope"`);
  });

  it('fails the build for a schema error', async () => {
    const root = project({ 'main.js': entry(['E']), 'E.form.json': formText({ components: 5 }) });
    await expect(bundle(root)).rejects.toThrow(/E\.form\.json:\d+: components/);
  });

  it('fails the build for a file with conflict markers', async () => {
    const root = project({ 'main.js': entry(['F']), 'F.form.json': '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n' });
    await expect(bundle(root)).rejects.toThrow(/conflict markers/);
  });
});

describe('fwForms() safety', () => {
  it.each([
    ['../outside.ts', /must stay inside the project/],
    ['/etc/A.ts', /must be a relative path/],
    ['./A.txt', /must be a \.ts or \.tsx file/],
    ['./Missing.ts', /Script file not found/],
  ])('fails the build for the script %s', async (script, expected) => {
    const root = project({ 'proj/main.js': entry(['A']), 'proj/A.form.json': formText({ script }), 'proj/A.txt': 'x', 'outside.ts': 'export default 1;' });
    await expect(bundle(join(root, 'proj'))).rejects.toThrow(expected);
  });

  it('fails the build for a form that is not UTF-8', async () => {
    const root = project({ 'main.js': entry(['A']) });
    writeFileSync(join(root, 'A.form.json'), Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x7d]));
    await expect(bundle(root)).rejects.toThrow(/not valid UTF-8/);
  });

  it('throws a clear error at load time when the script has no default export', async () => {
    const root = project({
      'main.js': entry(['A']),
      'A.form.json': formText({ script: './A.form.ts', datasets: undefined }),
      'A.form.ts': 'export const nothing = 1;\n',
    });
    const chunks = await bundle(root);
    expect(chunks.map((chunk) => chunk.code).join('\n')).toContain('has no default export');
  });

  it('leaves ?raw and ?url imports to Vite', async () => {
    const root = project({
      'main.js': "import text from './A.form.json?raw';\nconsole.log(text);\n",
      // Not a valid form: the plugin would fail the build if it handled this import.
      'A.form.json': '{ "this is": "not a form" }',
    });
    const chunks = await bundle(root);
    expect(chunks[0]?.code).toContain('this is');
  });
});

describe('fwForms() in the dev server', () => {
  it('reloads and keeps types current when a form is changed, created and deleted', { timeout: 30_000 }, async () => {
    const { createServer } = await import('vite');
    const { rmSync } = await import('node:fs');
    const root = project({ 'index.html': '<html></html>', 'A.form.json': formText({ datasets: undefined }) });
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [fwForms()],
      server: { middlewareMode: true, watch: { usePolling: true, interval: 50 }, hmr: { port: 0 } },
    });
    const sent: string[] = [];
    const hot = server.environments.client.hot;
    const original = hot.send.bind(hot);
    hot.send = ((payload: { type: string }) => {
      sent.push(payload.type);
      return original(payload as never);
    }) as typeof hot.send;
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    try {
      await server.pluginContainer.buildStart({});
      await new Promise((resolve) => setTimeout(resolve, 300));
      write(root, 'A.form.json', formText({ datasets: undefined, title: 'changed' }));
      await waitFor(() => sent.includes('full-reload'));
      expect(sent).toContain('full-reload');

      sent.length = 0;
      write(root, 'B.form.json', formText({ datasets: undefined }));
      await waitFor(() => sent.includes('full-reload'));
      expect(sent).toContain('full-reload');
      expect(existsSync(join(root, 'B.form.gen.ts'))).toBe(true);

      sent.length = 0;
      rmSync(join(root, 'B.form.json'));
      await waitFor(() => sent.includes('full-reload'));
      expect(sent).toContain('full-reload');
    } finally {
      await server.close();
    }
  });
});
