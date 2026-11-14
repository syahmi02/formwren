import * as vscode from 'vscode';
import { FormDesignerProvider, VIEW_TYPE, openTextEditor } from './provider.ts';

/** What tests can reach. Returned from `activate`. */
export interface ExtensionApi {
  readonly provider: FormDesignerProvider;
}

/** The form file a command should act on: the argument, or the active tab. */
function targetUri(argument: unknown): vscode.Uri | undefined {
  if (argument instanceof vscode.Uri) return argument;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const provider = new FormDesignerProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // The designer redraws from the text, but a hidden panel keeps its canvas so showing it again is instant.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('fw.openWithDesigner', async (argument?: unknown) => {
      const uri = targetUri(argument);
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('fw.openTextEditor', async (argument?: unknown) => {
      const uri = targetUri(argument);
      if (uri) await openTextEditor(uri);
    }),
  );
  return { provider };
}

export function deactivate(): void {}
