import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DocumentBridge, pushCapped } from './bridge.ts';

export const VIEW_TYPE = 'fw.formDesigner';

/** Escapes text for an HTML attribute. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The page the webview shows. No inline script or style, and the policy allows only our own files. */
export function webviewHtml(webview: vscode.Webview, root: vscode.Uri, fileName: string): string {
  const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();
  const source = webview.cspSource;
  // React Aria adds a small <style> element while a press is under way (to stop text selection). It reads this nonce from the meta tag below.
  const nonce = randomBytes(16).toString('base64');
  const policy = [
    "default-src 'none'",
    `script-src ${source} blob:`,
    `style-src ${source} blob: 'nonce-${nonce}'`,
    `img-src ${source} data:`,
    `font-src ${source}`,
    // The canvas blob inherits this policy, so it needs blob: for its own script and styles.
    // A webview can't navigate a frame to its own files, so the page builds the canvas from a template
    // into a blob URL. That blob is the only frame, and it only holds our own script and styles.
    'frame-src blob:',
    // Only to read our own canvas script and styles.
    `connect-src ${source}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  // Light and dark: the entry script sets data-fw-theme on <html> from VS Code's theme class on <body>.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(policy)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta property="csp-nonce" content="${attr(nonce)}">
<title>Form Designer</title>
<link rel="stylesheet" href="${attr(asset('designer.css'))}">
</head>
<body data-canvas-js="${attr(asset('canvas.js'))}" data-canvas-css="${attr(asset('canvas.css'))}" data-csp-source="${attr(source)}" data-nonce="${attr(nonce)}"${process.env['FW_DESIGNER_TEST'] === '1' ? ' data-test="1"' : ''} data-file-name="${attr(fileName)}">
<div id="root"></div>
<p class="fw-vscode-note" role="note" id="fw-script-note"></p>
<script src="${attr(asset('designer.js'))}"></script>
</body>
</html>
`;
}

/** What a test needs to drive one open designer. */
export interface DesignerSession {
  readonly document: vscode.TextDocument;
  readonly bridge: DocumentBridge;
  /** True once the webview page has said `ready`. */
  readonly ready: boolean;
  /** Content security policy violations and errors the webview reported. */
  readonly problems: string[];
  /** Notes the webview sent, such as "canvas ready". */
  readonly notes: string[];
}

export class FormDesignerProvider implements vscode.CustomTextEditorProvider {
  /** Open designers, by document URI. Kept so tests can reach them. */
  readonly sessions = new Map<string, DesignerSession>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  get webviewRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const root = this.webviewRoot;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const problems: string[] = [];
    const notes: string[] = [];
    const session = { ready: false };
    const bridge = new DocumentBridge(
      document,
      { post: (message) => void webview.postMessage(message) },
      {
        onLog: (level, message) => {
          if (level === 'info') pushCapped(notes, message);
          else pushCapped(problems, `${level}: ${message}`);
        },
        onOpenTextEditor: (offset) => void openTextEditor(document.uri, offset),
      },
    );
    const key = document.uri.toString();
    const view: DesignerSession = {
      document,
      bridge,
      get ready() {
        return session.ready;
      },
      problems,
      notes,
    };
    this.sessions.set(key, view);

    // The preview recompiles the handler when it, or a file it may import beside it, changes.
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{ts,tsx,js,json}'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (uri: vscode.Uri): void => {
      if (uri.toString() === document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => bridge.notifyScriptChanged(), 250);
    };
    const subscriptions = [
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidGrantWorkspaceTrust(() => bridge.notifyScriptChanged()),
    ];

    webview.html = webviewHtml(webview, root, document.uri.path.split('/').pop() ?? 'form.form.json');
    const receive = webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready') session.ready = true;
      bridge.handle(message);
    });
    panel.onDidDispose(() => {
      receive.dispose();
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.dispose();
      bridge.dispose();
      if (this.sessions.get(key) === view) this.sessions.delete(key);
    });
  }
}

/** Opens the text editor for a file, at a character offset if given. */
export async function openTextEditor(uri: vscode.Uri, offset?: number): Promise<void> {
  let selection: vscode.Range | undefined;
  if (offset !== undefined) {
    const document = await vscode.workspace.openTextDocument(uri);
    const position = document.positionAt(Math.min(Math.max(offset, 0), document.getText().length));
    selection = new vscode.Range(position, position);
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', selection ? { selection } : undefined);
}
