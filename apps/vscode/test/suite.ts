// Runs inside the VS Code extension host (see scripts/test.ts). It drives the designer through the
// message protocol, which is the same one the webview uses, and also checks that the real webview
// loads the bundles under the content security policy and says it is ready.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { applyTextEdits, diffFormText, openFormText, type TextEdit } from '@fw/format';
import { WebviewHost } from '../webview/host.ts';
import type { ExtensionApi } from '../src/extension.ts';
import type { DesignerSession } from '../src/provider.ts';
import type { ToWebview } from '../src/protocol.ts';

const VIEW_TYPE = 'fw.formDesigner';
const folder = process.env['FW_TEST_DIR'] as string;
const scriptFolder = process.env['FW_TEST_SCRIPT_DIR'] as string;
const outsideFolder = process.env['FW_TEST_OUTSIDE_DIR'] as string;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

let api: ExtensionApi;
const FIXTURES = readFileSync(join(folder, 'employee.fixtures.json'), 'utf8');

async function openDesigner(name: string): Promise<{ uri: vscode.Uri; session: DesignerSession }> {
  const uri = vscode.Uri.file(isAbsolute(name) ? name : join(folder, name));
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  const session = await waitFor(`the designer for ${name}`, () => api.provider.sessions.get(uri.toString()));
  await waitFor(`the webview of ${name} to be ready`, () => session.ready);
  return { uri, session };
}

const lastText = (session: DesignerSession): Extract<ToWebview, { type: 'text' }> | undefined =>
  [...session.bridge.sent].reverse().find((message): message is Extract<ToWebview, { type: 'text' }> => message.type === 'text');

let nextId = 1000;
/** Sends an edits message as the webview would, and waits for the answer. */
async function sendEdits(session: DesignerSession, edits: TextEdit[], baseVersion: number, label = 'Test edit'): Promise<boolean> {
  const id = nextId++;
  session.bridge.handle({ type: 'edits', id, edits, label, baseVersion });
  const result = await waitFor(`the answer to edits ${id}`, () =>
    session.bridge.sent.find((message) => message.type === 'editsResult' && message.id === id),
  );
  return (result as Extract<ToWebview, { type: 'editsResult' }>).ok;
}

function editFor(text: string, find: string, replacement: string): TextEdit {
  const offset = text.indexOf(find);
  assert.ok(offset >= 0, `${find} is in the text`);
  return { offset, length: find.length, newText: replacement };
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, body: () => Promise<void>): void => void tests.push([name, body]);

test('the text editor stays the default, and the designer is an option', async () => {
  const uri = vscode.Uri.file(join(folder, 'employee.form.json'));
  await vscode.commands.executeCommand('vscode.open', uri);
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputText, 'a plain open uses the text editor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('Open with designer opens the custom editor and the webview loads without policy violations', async () => {
  const uri = vscode.Uri.file(join(folder, 'employee.form.json'));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('fw.openWithDesigner', uri);
  const session = await waitFor('the designer session', () => api.provider.sessions.get(uri.toString()));
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE, 'the tab is the designer');
  await waitFor('the webview to say ready', () => session.ready);
  const text = lastText(session);
  assert.equal(text?.text, session.document.getText());
  assert.equal(text?.version, session.document.version);
  assert.equal(text?.readOnly, false);
  await waitFor('the canvas page to load inside the webview', () => session.notes.includes('canvas ready'), 15000).catch((error: unknown) => {
    throw new Error(`${String(error)} (problems: ${JSON.stringify(session.problems)}, notes: ${JSON.stringify(session.notes)})`);
  });
  assert.deepEqual(session.problems, [], 'the webview reported no policy violations or errors');
});

test('one edits message is one WorkspaceEdit, and one undo reverts it', async () => {
  const { session } = await openDesigner('employee.form.json');
  const { document } = session;
  const before = document.getText();
  const edits = [editFor(before, '"Employee edit"', '"Employee form"'), editFor(before, '"width": 960', '"width": 980')];
  const stepsBefore = document.version;
  assert.equal(await sendEdits(session, edits, document.version, 'Edit title and width'), true);
  const after = applyTextEdits(before, edits);
  assert.equal(document.getText(), after);
  assert.equal(document.isDirty, true);
  assert.equal(document.version, stepsBefore + 1, 'two edits are one document change');
  assert.equal(lastText(session)?.text, after, 'the designer hears about its own edit');

  await vscode.commands.executeCommand('undo');
  await waitFor('undo to revert both edits at once', () => document.getText() === before);
  await waitFor('the designer to hear about the undo', () => lastText(session)?.text === before);

  await vscode.commands.executeCommand('redo');
  await waitFor('redo', () => document.getText() === after);
  await waitFor('the designer to hear about the redo', () => lastText(session)?.text === after);

  await vscode.commands.executeCommand('undo');
  await waitFor('the final undo', () => document.getText() === before);
});

test('offsets are characters, so text after non-ASCII characters is edited in the right place', async () => {
  const { session } = await openDesigner('unicode.form.json');
  const { document } = session;
  const before = document.getText();
  const edit = editFor(before, '"width": 960', '"width": 961');
  assert.equal(await sendEdits(session, [edit], document.version), true);
  assert.equal(document.getText(), applyTextEdits(before, [edit]));
  await vscode.commands.executeCommand('undo');
  await waitFor('undo', () => document.getText() === before);
});

/** Edits made the way the designer makes them: the next form, turned into minimal text edits. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function oneStep(name: string, change: (form: Json) => void, check: (form: Json) => void): Promise<void> {
  const { session } = await openDesigner(name);
  const { document } = session;
  const before = document.getText();
  const opened = openFormText(before);
  assert.equal(opened.status, 'ok');
  const next = structuredClone((opened as { value: Json }).value);
  change(next);
  const edits = diffFormText(before, next);
  assert.ok(edits.length > 0, 'the change is a real change');
  const version = document.version;
  assert.equal(await sendEdits(session, edits, version, 'Stage B edit'), true);
  assert.equal(document.version, version + 1, 'one WorkspaceEdit is one document change');
  check((openFormText(document.getText()) as { value: Json }).value);
  await vscode.commands.executeCommand('undo');
  await waitFor('one undo to revert the whole gesture', () => document.getText() === before);
  await waitFor('the designer to hear about the undo', () => lastText(session)?.text === before);
}
const panel = (form: Json): Json => form['components'].find((c: Json) => c['id'] === 'searchPanel');

test('adding a component is one step', () =>
  oneStep(
    'employee.form.json',
    (form) => panel(form)['children'].push({ id: 'addedButton', type: 'Button', layout: { left: 4, top: 4, width: 80, height: 24 }, props: { text: 'Added' } }),
    (form) => assert.ok(panel(form)['children'].some((c: Json) => c['id'] === 'addedButton')),
  ));

test('re-parenting a component is one step', () =>
  oneStep(
    'employee.form.json',
    (form) => {
      const index = form['components'].findIndex((c: Json) => c['id'] === 'prevButton');
      const [moved] = form['components'].splice(index, 1);
      panel(form)['children'].push(moved);
    },
    (form) => {
      assert.ok(panel(form)['children'].some((c: Json) => c['id'] === 'prevButton'));
      assert.ok(!form['components'].some((c: Json) => c['id'] === 'prevButton'));
    },
  ));

test('editing a Dataset is one step', () =>
  oneStep(
    'employee.form.json',
    (form) => {
      const dataset = form['datasets'][0];
      dataset['columns'].push({ id: 'extra', type: 'string', size: 10 });
      dataset['initialRows'] = [{ extra: 'x' }];
    },
    (form) => assert.ok(form['datasets'][0]['columns'].some((c: Json) => c['id'] === 'extra')),
  ));

test('the preview runs in the real webview with no policy or script problems', async () => {
  const { session } = await openDesigner('employee.form.json');
  await waitFor('the canvas', () => session.notes.includes('canvas ready'), 30000);
  session.bridge.sendTest('showPreview');
  await waitFor('the preview to render the form', () => session.notes.includes('preview rendered') || session.problems.length > 0, 30000);
  assert.deepEqual(session.problems, []);
  assert.ok(session.notes.includes('preview rendered'));
});

test('the kept message lists never grow past a limit', async () => {
  const { session } = await openDesigner('employee.form.json');
  for (let i = 0; i < 450; i++) session.bridge.handle({ type: 'log', level: 'info', message: `note ${i}` });
  assert.ok(session.bridge.received.length <= 200, `received has ${session.bridge.received.length}`);
  assert.ok(session.notes.length <= 200, `notes has ${session.notes.length}`);
  assert.ok(session.bridge.sent.length <= 200);
  assert.equal(session.notes[session.notes.length - 1], 'note 449', 'the newest are kept');
});

test('a throwing text listener cannot break message handling', async () => {
  const posted: Array<{ type: string; level?: string }> = [];
  const host = new WebviewHost('x.form.json', (message) => posted.push(message));
  host.receive({ type: 'text', text: 'a', version: 1, readOnly: false });
  const heard: string[] = [];
  host.onDidChangeText(() => {
    throw new Error('boom');
  });
  host.onDidChangeText((text) => heard.push(text));
  host.receive({ type: 'text', text: 'b', version: 2, readOnly: false });
  assert.deepEqual(heard, ['b'], 'the next listener still runs');
  assert.ok(posted.some((m) => m.type === 'log' && m.level === 'error'), 'the error is reported');
  host.receive({ type: 'text', text: 'c', version: 3, readOnly: false });
  assert.deepEqual(heard, ['b', 'c'], 'later messages are still handled');
  assert.equal(host.readText(), 'c');
});

const noteWith = (session: DesignerSession, text: string): string | undefined => session.notes.find((note) => note.includes(text));

async function openPreview(name: string): Promise<DesignerSession> {
  const { session } = await openDesigner(name);
  await waitFor('the canvas', () => session.notes.includes('canvas ready'), 30000);
  session.bridge.sendTest('showPreview');
  await waitFor('the preview', () => session.notes.includes('preview rendered') || session.problems.length > 0, 30000);
  return session;
}

test('the preview runs the form handler: init and a click', async () => {
  const session = await openPreview(join(scriptFolder, 'scripted.form.ts').replace('.form.ts', '.form.json'));
  session.bridge.sendTest('previewText');
  await waitFor('the init handler to change the label', () => noteWith(session, 'preview text: handler ran'), 30000);
  assert.ok(session.notes.includes('script ok'));
  session.bridge.sendTest('clickPreview');
  await waitFor('the click handler to change the label', () => noteWith(session, 'preview text: clicked'), 30000);
  assert.deepEqual(session.problems, [], 'no policy or script problems');
});

test('a change to the handler file reaches the running preview', async () => {
  const path = join(scriptFolder, 'scripted.form.ts');
  const session = await openPreview(join(scriptFolder, 'scripted.form.json'));
  session.bridge.sendTest('previewText');
  await waitFor('the first run', () => noteWith(session, 'preview text: handler ran'), 30000);
  writeFileSync(path, readFileSync(path, 'utf8').replace('handler ran', 'handler ran again'));
  await waitFor('the recompiled handler to run', () => noteWith(session, 'preview text: handler ran again'), 30000);
  assert.deepEqual(session.problems, []);
});

test('a script that does not compile is reported with its file and line', async () => {
  const session = await openPreview(join(scriptFolder, 'broken.form.json'));
  const note = await waitFor('the compile error', () => noteWith(session, 'script error'), 30000);
  assert.match(note, /broken\.form\.ts:2:/);
  assert.ok(session.notes.includes('preview rendered'), 'the preview still runs, without handlers');
  assert.deepEqual(session.problems, []);
});

test('an import the preview cannot provide is a compile error that says so', async () => {
  const session = await openPreview(join(scriptFolder, 'badimport.form.json'));
  const note = await waitFor('the import error', () => noteWith(session, 'script error'), 30000);
  assert.match(note, /left-pad.*can't be used in the preview/);
});

test('without esbuild the preview runs without scripts and says why', async () => {
  const session = await openPreview('noesbuild.form.json');
  const note = await waitFor('the note about esbuild', () => noteWith(session, 'script unavailable'), 30000);
  assert.match(note, /esbuild was not found/);
  assert.ok(session.notes.includes('preview rendered'));
  assert.deepEqual(session.problems, []);
});

test('a form outside every workspace folder gets a note and runs no script', async () => {
  const uri = vscode.Uri.file(join(outsideFolder, 'outside.form.json'));
  assert.equal(vscode.workspace.getWorkspaceFolder(uri), undefined, 'the form is outside every folder');
  const session = await openPreview(uri.fsPath);
  session.bridge.sendTest('previewText');
  const note = await waitFor('the note about the workspace folder', () => noteWith(session, 'script unavailable'), 30000);
  assert.match(note, /only for forms inside a trusted workspace folder/);
  await sleep(1500);
  assert.equal(noteWith(session, 'outside ran'), undefined, 'the handler did not run');
  assert.ok(session.notes.includes('preview rendered'));
  assert.deepEqual(session.problems, []);
});

test('esbuild reached through a link that leads out of the workspace folder is refused', async () => {
  const session = await openPreview(join(folder, 'linked', 'linked.form.json'));
  const note = await waitFor('the note about esbuild', () => noteWith(session, 'script unavailable'), 30000);
  assert.match(note, /esbuild was not found inside the workspace folder/);
  await sleep(1000);
  assert.equal(noteWith(session, 'never runs'), undefined);
});

test('readFixtures returns the file beside the form, or null, and never writes', async () => {
  const { session } = await openDesigner('employee.form.json');
  const ask = async (id: number): Promise<string | null> => {
    session.bridge.handle({ type: 'readFixtures', id });
    const answer = await waitFor('the fixtures answer', () => session.bridge.sent.find((m) => m.type === 'fixtures' && m.id === id));
    return (answer as Extract<ToWebview, { type: 'fixtures' }>).text;
  };
  const path = join(folder, 'employee.fixtures.json');
  assert.equal(await ask(1), readFileSync(path, 'utf8'));
  const other = await openDesigner('unicode.form.json');
  other.session.bridge.handle({ type: 'readFixtures', id: 2 });
  const none = await waitFor('the answer for a form without fixtures', () => other.session.bridge.sent.find((m) => m.type === 'fixtures' && m.id === 2));
  assert.equal((none as Extract<ToWebview, { type: 'fixtures' }>).text, null);
  assert.equal(readFileSync(path, 'utf8'), FIXTURES, 'the fixtures file is untouched');
  assert.equal(other.session.document.isDirty, false);
});

test('an outside edit reaches the designer', async () => {
  const { uri, session } = await openDesigner('employee.form.json');
  const { document } = session;
  const before = document.getText();
  const typing = new vscode.WorkspaceEdit();
  const offset = before.indexOf('"Employee edit"') + 1;
  typing.insert(uri, document.positionAt(offset), 'X');
  assert.equal(await vscode.workspace.applyEdit(typing), true);
  const expected = document.getText();
  assert.notEqual(expected, before);
  const heard = await waitFor('the designer to hear about typing', () => {
    const text = lastText(session);
    return text?.text === expected ? text : undefined;
  });
  assert.equal(heard.version, document.version);
  await vscode.commands.executeCommand('undo');
  await waitFor('undo', () => document.getText() === before);
});

test('a change on disk (Git, another tool) reaches the designer', async () => {
  const { session } = await openDesigner('disk.form.json');
  const { document } = session;
  await vscode.commands.executeCommand('workbench.action.files.revert');
  const original = readFileSync(document.uri.fsPath, 'utf8');
  const changed = original.replace('"Disk form"', '"Changed on disk"');
  assert.notEqual(changed, original);
  writeFileSync(document.uri.fsPath, changed);
  await waitFor('the designer to hear about the file change', () => lastText(session)?.text === changed, 30000);
});

test('a stale edit is refused and writes nothing', async () => {
  const { uri, session } = await openDesigner('employee.form.json');
  const { document } = session;
  const before = document.getText();
  const staleVersion = document.version;
  const typing = new vscode.WorkspaceEdit();
  typing.insert(uri, document.positionAt(before.indexOf('"Employee edit"') + 1), 'Y');
  await vscode.workspace.applyEdit(typing);
  const afterTyping = document.getText();
  assert.equal(await sendEdits(session, [editFor(afterTyping, '"width": 960', '"width": 999')], staleVersion), false);
  assert.equal(document.getText(), afterTyping, 'the refused edit changed nothing');
  await vscode.commands.executeCommand('undo');
  await waitFor('undo', () => document.getText() === before);
});

test('edits that do not fit, or would break the file, are refused', async () => {
  const { session } = await openDesigner('employee.form.json');
  const { document } = session;
  const before = document.getText();
  assert.equal(await sendEdits(session, [{ offset: before.length + 5, length: 0, newText: 'x' }], document.version), false);
  assert.equal(await sendEdits(session, [{ offset: 0, length: 1, newText: '' }], document.version), false, 'a result that is not JSON');
  assert.equal(document.getText(), before);
  assert.equal(document.isDirty, false);
  session.bridge.handle({ type: 'edits', id: 'nope' });
  assert.equal(document.getText(), before, 'a malformed message is ignored');
});

test('a file with conflict markers opens read-only and is never written', async () => {
  const { session } = await openDesigner('conflict.form.json');
  const { document } = session;
  const before = document.getText();
  const onDisk = readFileSync(document.uri.fsPath, 'utf8');
  assert.match(before, /^<{7} /m);
  assert.equal(await sendEdits(session, [editFor(before, '"Employee edit"', '"Changed"')], document.version), false);
  assert.equal(document.getText(), before);
  assert.equal(document.isDirty, false);
  await vscode.commands.executeCommand('workbench.action.files.save');
  assert.equal(readFileSync(document.uri.fsPath, 'utf8'), onDisk, 'the file on disk is untouched');
});

test('an invalid JSON file is never written either', async () => {
  const { session } = await openDesigner('invalid.form.json');
  const { document } = session;
  const before = document.getText();
  assert.equal(await sendEdits(session, [{ offset: before.length, length: 0, newText: ' ' }], document.version), false);
  assert.equal(document.isDirty, false);
});

test('Open text editor leaves the designer, and the designer can ask for a spot in the text', async () => {
  const { uri, session } = await openDesigner('employee.form.json');
  await vscode.commands.executeCommand('fw.openTextEditor');
  await waitFor('the text editor', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText);

  const again = await openDesigner('employee.form.json');
  const offset = again.session.document.getText().indexOf('"datasets"');
  again.session.bridge.handle({ type: 'openTextEditor', offset });
  const editor = await waitFor('the text editor at the offset', () => {
    const active = vscode.window.activeTextEditor;
    return active && active.document.uri.toString() === uri.toString() && active.selection.active.isEqual(active.document.positionAt(offset)) ? active : undefined;
  });
  assert.equal(editor.document.offsetAt(editor.selection.active), offset);
  void session;
});

test('a hidden designer keeps working and shows the current text when shown again', async () => {
  const { uri, session } = await openDesigner('employee.form.json');
  const { document } = session;
  const before = document.getText();
  // Hide it behind another editor.
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(folder, 'disk.form.json')));
  const typing = new vscode.WorkspaceEdit();
  typing.insert(uri, document.positionAt(before.indexOf('"Employee edit"') + 1), 'Z');
  await vscode.workspace.applyEdit(typing);
  const expected = document.getText();
  await openDesigner('employee.form.json');
  await waitFor('the hidden designer to have the latest text', () => lastText(session)?.text === expected);
  assert.equal(api.provider.sessions.get(uri.toString()), session, 'the same designer, not a new one');
  await vscode.commands.executeCommand('undo');
  await waitFor('undo', () => document.getText() === before);
});

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>('local.fw-designer');
  assert.ok(extension, 'the extension is installed');
  api = await extension.activate();
  let failed = 0;
  for (const [name, body] of tests) {
    try {
      await body();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${name}\n       ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => undefined);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log(`${tests.length - failed} of ${tests.length} extension tests passed`);
  if (failed > 0) throw new Error(`${failed} extension test(s) failed`);
}
