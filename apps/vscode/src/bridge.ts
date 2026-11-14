import * as vscode from 'vscode';
import { applyTextEdits, openFormText, type TextEdit } from '@fw/format';
import { compileScript } from './script.ts';
import { parseFromWebview, type FromWebview, type ToWebview } from './protocol.ts';

/** How many messages and notes are kept for tests and diagnosis. Older ones are dropped. */
export const KEEP = 200;

/** Adds to a list that never grows past `KEEP`. */
export function pushCapped<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/** What `DocumentBridge` needs from the webview, so tests can stand in for it. */
export interface WebviewPort {
  post(message: ToWebview): void;
}

export interface BridgeOptions {
  /** Called for `log` messages. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Called when the webview asks for the text editor. */
  onOpenTextEditor?: (offset: number | undefined) => void;
}

/** The fixtures file beside a form: `X.form.json` has `X.fixtures.json` in the same folder. */
export function fixturesUri(form: vscode.Uri): vscode.Uri {
  const name = form.path.split('/').pop() ?? '';
  const base = name.replace(/\.form\.json$/i, '');
  return form.with({ path: `${form.path.slice(0, form.path.length - name.length)}${base}.fixtures.json` });
}

/** Reads the fixtures text, or null if the file is missing or unreadable. Never writes. */
export async function readFixtures(form: vscode.Uri): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(fixturesUri(form)));
  } catch {
    return null;
  }
}

/** True if VS Code says this document's file system can't be written. */
export function isReadOnlyDocument(document: vscode.TextDocument): boolean {
  return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false;
}

/**
 * Connects one document to one webview. The document is the only truth: the webview gets its text
 * and every change to it, and its edits become one `WorkspaceEdit` each, so VS Code's own undo,
 * redo, save and Git keep working.
 */
export class DocumentBridge implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private ready = false;
  /** The last messages the webview sent, kept for tests. */
  readonly received: FromWebview[] = [];
  /** The last messages sent to the webview, kept for tests. */
  readonly sent: ToWebview[] = [];

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly port: WebviewPort,
    private readonly options: BridgeOptions = {},
  ) {
    this.subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== this.document.uri.toString()) return;
      // A change with no content is only the dirty flag changing.
      if (event.contentChanges.length === 0) return;
      this.sendText();
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** The webview's page was created or reloaded and will say `ready` again. */
  reset(): void {
    this.ready = false;
  }

  /** Handles a raw message from the webview. */
  handle(raw: unknown): void {
    const message = parseFromWebview(raw);
    if (!message) {
      this.options.onLog?.('warn', 'Ignored a malformed message from the webview');
      return;
    }
    pushCapped(this.received, message);
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.sendText();
        break;
      case 'edits':
        void this.applyEdits(message).then((result) => {
          this.post({ type: 'editsResult', id: message.id, ...result });
        });
        break;
      case 'readFixtures':
        void readFixtures(this.document.uri).then((text) => this.post({ type: 'fixtures', id: message.id, text }));
        break;
      case 'readScript':
        void compileScript(this.document.uri).then((result) => this.post({ type: 'script', id: message.id, result }));
        break;
      case 'openTextEditor':
        this.options.onOpenTextEditor?.(message.offset);
        break;
      case 'log':
        this.options.onLog?.(message.level, message.message);
        break;
    }
  }

  /** Tells the webview the handler (or a file beside it) changed, so it loads the script again. */
  notifyScriptChanged(): void {
    if (this.ready) this.post({ type: 'scriptChanged' });
  }

  /** For tests: asks the webview page to do something a user would click. */
  sendTest(action: 'showPreview' | 'previewText' | 'clickPreview'): void {
    this.post({ type: 'test', action });
  }

  private post(message: ToWebview): void {
    pushCapped(this.sent, message);
    this.port.post(message);
  }

  private sendText(): void {
    if (!this.ready) return;
    this.post({ type: 'text', text: this.document.getText(), version: this.document.version, readOnly: isReadOnlyDocument(this.document) });
  }

  /** One `WorkspaceEdit` per call, or nothing at all. */
  private async applyEdits(message: Extract<FromWebview, { type: 'edits' }>): Promise<{ ok: boolean; reason?: string }> {
    const { document } = this;
    const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
    if (document.isClosed) return refuse('The document is closed');
    if (isReadOnlyDocument(document)) return refuse('The file is read-only');
    if (message.baseVersion !== document.version) return refuse('The text changed since the designer read it');

    const text = document.getText();
    const edits = [...message.edits].sort((a, b) => a.offset - b.offset);
    if (!editsFit(text, edits)) return refuse('The edits do not fit the text');

    // Never write to a file the format layer says isn't safe to change, and never leave one that doesn't parse.
    if (openFormText(text).status !== 'ok') return refuse('The file has conflict markers or invalid JSON');
    if (edits.length === 0) return { ok: true };
    if (openFormText(applyTextEdits(text, edits)).status !== 'ok') return refuse('The edits would leave the file invalid');

    const workspaceEdit = new vscode.WorkspaceEdit();
    const metadata: vscode.WorkspaceEditEntryMetadata = { label: message.label, needsConfirmation: false };
    for (const edit of edits) {
      const range = new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length));
      workspaceEdit.replace(document.uri, range, edit.newText, metadata);
    }
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    return applied ? { ok: true } : refuse('VS Code did not apply the edit');
  }
}

/** Edits must be inside the text, in order, and must not overlap. */
function editsFit(text: string, edits: readonly TextEdit[]): boolean {
  let end = 0;
  for (const edit of edits) {
    if (edit.offset < end || edit.length < 0 || edit.offset + edit.length > text.length) return false;
    end = edit.offset + edit.length;
  }
  return true;
}
