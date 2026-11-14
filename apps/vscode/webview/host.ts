import type { DesignerHost } from '@fw/designer/contract';
import type { TextEdit } from '@fw/format';
import type { FromWebview, ScriptResult, ToWebview } from '../src/protocol.ts';

/**
 * The webview side of `DesignerHost`. It keeps the last text the extension sent, so `readText` can
 * answer at once, and remembers the document version of the last read so the extension can refuse
 * edits made from text that has since changed.
 */
export class WebviewHost implements DesignerHost {
  private text = '';
  private version = 0;
  private readVersion = 0;
  private isReadOnly = true;
  private loaded = false;
  private nextId = 1;
  private readonly pending = new Map<number, (ok: boolean) => void>();
  private readonly pendingScripts = new Map<number, (result: ScriptResult) => void>();
  private readonly scriptListeners = new Set<() => void>();
  private readonly pendingFixtures = new Map<number, (text: string | null) => void>();
  private readonly listeners = new Set<(text: string) => void>();
  private readonly onFirstText: Array<() => void> = [];

  constructor(
    readonly fileName: string,
    private readonly post: (message: FromWebview) => void,
  ) {}

  get readOnly(): boolean {
    return this.isReadOnly;
  }

  /** True once the extension has sent the text. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Calls `callback` once the first text has arrived (or now, if it has). */
  whenLoaded(callback: () => void): void {
    if (this.loaded) callback();
    else this.onFirstText.push(callback);
  }

  readText(): string {
    this.readVersion = this.version;
    return this.text;
  }

  applyEdits(edits: readonly TextEdit[], label: string): Promise<boolean> {
    if (this.isReadOnly) return Promise.resolve(false);
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'edits', id, edits: edits.map((edit) => ({ ...edit })), label, baseVersion: this.readVersion });
    });
  }

  readFixtures(): Promise<string | null> {
    const id = this.nextId++;
    return new Promise<string | null>((resolve) => {
      this.pendingFixtures.set(id, resolve);
      this.post({ type: 'readFixtures', id });
    });
  }

  /** The compiled handler module beside the form. Not part of `DesignerHost`: the page turns it into `loadScript`. */
  readScript(): Promise<ScriptResult> {
    const id = this.nextId++;
    return new Promise<ScriptResult>((resolve) => {
      this.pendingScripts.set(id, resolve);
      this.post({ type: 'readScript', id });
    });
  }

  /** Called when the handler changed on disk. Returns an unsubscribe function. */
  onScriptChanged(listener: () => void): () => void {
    this.scriptListeners.add(listener);
    return () => void this.scriptListeners.delete(listener);
  }

  onDidChangeText(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  openTextEditor(offset?: number): void {
    this.post(offset === undefined ? { type: 'openTextEditor' } : { type: 'openTextEditor', offset });
  }

  /** Handles a message from the extension. */
  receive(message: ToWebview): void {
    if (message.type === 'script') {
      this.pendingScripts.get(message.id)?.(message.result);
      this.pendingScripts.delete(message.id);
      return;
    }
    if (message.type === 'scriptChanged') {
      for (const listener of [...this.scriptListeners]) {
        try {
          listener();
        } catch (error) {
          this.post({ type: 'log', level: 'error', message: `A script listener threw: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      return;
    }
    if (message.type === 'fixtures') {
      this.pendingFixtures.get(message.id)?.(message.text);
      this.pendingFixtures.delete(message.id);
      return;
    }
    if (message.type === 'editsResult') {
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve?.(message.ok);
      return;
    }
    if (message.type !== 'text') return;
    const changed = !this.loaded || message.text !== this.text || message.readOnly !== this.isReadOnly;
    this.text = message.text;
    this.version = message.version;
    this.isReadOnly = message.readOnly;
    if (!this.loaded) {
      this.loaded = true;
      for (const callback of this.onFirstText.splice(0)) {
        try {
          callback();
        } catch (error) {
          this.post({ type: 'log', level: 'error', message: `Starting the designer failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      return;
    }
    if (!changed) return;
    // One bad listener must not stop the others, or the handling of the next message.
    for (const listener of [...this.listeners]) {
      try {
        listener(this.text);
      } catch (error) {
        this.post({ type: 'log', level: 'error', message: `A text listener threw: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
}
