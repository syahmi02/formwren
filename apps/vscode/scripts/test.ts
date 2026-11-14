// Runs the extension tests in the downloaded test copy of VS Code (.vscode-test/). Run with `pnpm vscode:test`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { download, runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '../..');

const build = spawnSync(process.execPath, [join(root, 'scripts/build.ts'), '--test'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

// The test copy of VS Code is cached in .vscode-test/. The version follows engines.vscode in package.json.
const vscodeExecutablePath = await download({ cachePath: join(repo, '.vscode-test'), extensionDevelopmentPath: root });

// The repository root is a workspace folder, and forms with a script live inside it, so the project's own esbuild is inside the workspace.
const scriptDir = mkdtempSync(join(root, '.test-work-'));
const work = mkdtempSync(join(tmpdir(), 'fw-designer-test-'));
const workspace = join(work, 'forms');
mkdirSync(workspace);
try {
  const demo = readFileSync(join(repo, 'apps/demo/src/forms/EmployeeEdit.form.json'), 'utf8');
  const employee = demo.replace(/\r\n/g, '\n');
  writeFileSync(join(workspace, 'employee.form.json'), employee);
  writeFileSync(join(workspace, 'unicode.form.json'), employee.replace('"Employee edit"', '"\u{1F600} 日本語"'));
  writeFileSync(join(workspace, 'disk.form.json'), employee.replace('"Employee edit"', '"Disk form"'));
  writeFileSync(join(workspace, 'invalid.form.json'), employee.slice(0, employee.length - 20));
  const lines = employee.split('\n');
  lines.splice(2, 0, '<<<<<<< HEAD');
  lines.splice(4, 0, '=======', '  "title": "Other side",', '>>>>>>> branch');
  writeFileSync(join(workspace, 'conflict.form.json'), lines.join('\n'));
  writeFileSync(join(workspace, 'employee.fixtures.json'), readFileSync(join(repo, 'apps/demo/src/forms/EmployeeEdit.fixtures.json'), 'utf8'));
  copyFileSync(join(workspace, 'employee.form.json'), join(workspace, 'original.txt'));

  const scripted = {
    json: JSON.stringify({
      formatVersion: 1,
      id: 't.Scripted',
      title: 'Scripted',
      size: { width: 400, height: 200 },
      variables: { message: { type: 'string', default: 'before' } },
      events: { init: 'onInit' },
      components: [
        { id: 'msg', type: 'Label', layout: { left: 8, top: 8, width: 300, height: 24 }, props: { text: '=vars.message' } },
        { id: 'go', type: 'Button', layout: { left: 8, top: 40, width: 80, height: 28 }, props: { text: 'Go' }, events: { click: 'onGo' } },
      ],
    }),
    script: (init: string) =>
      `import { defineForm } from '@fw/core';
export default defineForm((form) => ({
  onInit() { form.vars.message = '${init}'; },
  onGo() { form.vars.message = 'clicked'; },
}));
`,
  };
  writeFileSync(join(scriptDir, 'scripted.form.json'), scripted.json);
  writeFileSync(join(scriptDir, 'scripted.form.ts'), scripted.script('handler ran'));
  writeFileSync(join(scriptDir, 'broken.form.json'), scripted.json);
  writeFileSync(join(scriptDir, 'broken.form.ts'), ["import { defineForm } from '@fw/core';", 'export default defineForm((form) => ({ onInit() { form.vars.message = ; } }));', ''].join(String.fromCharCode(10)));
  writeFileSync(join(scriptDir, 'badimport.form.json'), scripted.json);
  writeFileSync(join(scriptDir, 'badimport.form.ts'), ["import left from 'left-pad';", 'export default left;', ''].join(String.fromCharCode(10)));
  // A workspace folder with no esbuild inside it: the note about esbuild.
  writeFileSync(join(workspace, 'noesbuild.form.json'), scripted.json);
  writeFileSync(join(workspace, 'noesbuild.form.ts'), scripted.script('never runs'));
  // esbuild that is reachable from inside the folder, but only through a link that leads out of it: refused.
  const linked = join(workspace, 'linked');
  mkdirSync(join(linked, 'node_modules'), { recursive: true });
  const viteDir = dirname(createRequire(join(repo, 'noop.js')).resolve('vite/package.json'));
  const esbuildDir = dirname(createRequire(join(viteDir, 'noop.js')).resolve('esbuild/package.json'));
  symlinkSync(esbuildDir, join(linked, 'node_modules', 'esbuild'), 'junction');
  writeFileSync(join(linked, 'linked.form.json'), scripted.json);
  writeFileSync(join(linked, 'linked.form.ts'), scripted.script('never runs'));
  // A form outside every workspace folder.
  const outside = join(work, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'outside.form.json'), scripted.json);
  writeFileSync(join(outside, 'outside.form.ts'), scripted.script('outside ran'));
  const workspaceFile = join(work, 'test.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: repo }, { path: workspace }] }));

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist/test/suite.cjs'),
    extensionTestsEnv: { FW_TEST_DIR: workspace, FW_TEST_SCRIPT_DIR: scriptDir, FW_TEST_OUTSIDE_DIR: outside, FW_DESIGNER_TEST: '1' },
    launchArgs: [
      workspaceFile,
      '--user-data-dir', join(work, 'user'),
      '--extensions-dir', join(work, 'extensions'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
    ],
  });
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
}
