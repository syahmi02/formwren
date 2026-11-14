/** The messages between the extension host and the designer webview. Plain data only. */
import type { TextEdit } from '@fw/format';

/** What compiling a form's handler module gave. Everything the webview needs to run it or to say why not. */
export type ScriptResult =
  /** The compiled module, as ES module text. Its default export is the form module. */
  | { status: 'ok'; code: string }
  /** There is no `<form>.form.ts` beside the form. Nothing to say. */
  | { status: 'none' }
  /** The script can't run, and this says why in words for the person using the designer. */
  | { status: 'unavailable'; message: string }
  /** The script doesn't compile. `message` has the file and line. */
  | { status: 'error'; message: string };

/** Extension host to webview. */
export type ToWebview =
  /** The current text. Sent when the webview is ready and after every change, whoever made it. */
  | { type: 'text'; text: string; version: number; readOnly: boolean }
  /** The answer to an `edits` message. */
  | { type: 'editsResult'; id: number; ok: boolean; reason?: string }
  /** The answer to `readFixtures`: the file's text, or null if there is no such file. */
  | { type: 'fixtures'; id: number; text: string | null }
  /** The answer to `readScript`. */
  | { type: 'script'; id: number; result: ScriptResult }
  /** The handler file (or something beside it) changed, so the preview should load the script again. */
  | { type: 'scriptChanged' }
  /** Only tests send this: it drives the page, which a test can't click. */
  | { type: 'test'; action: 'showPreview' | 'previewText' | 'clickPreview' };

/** Webview to extension host. */
export type FromWebview =
  | { type: 'ready' }
  /** `baseVersion` is the document version of the text the designer last read. */
  | { type: 'edits'; id: number; edits: TextEdit[]; label: string; baseVersion: number }
  | { type: 'openTextEditor'; offset?: number }
  /** Asks for the fixtures file beside the form. The webview never names a path. */
  | { type: 'readFixtures'; id: number }
  /** Asks for the handler module beside the form, compiled. The webview never names a path. */
  | { type: 'readScript'; id: number }
  /** Anything worth recording, such as a content security policy violation. */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Checks a message that came across the webview boundary. */
export function parseFromWebview(value: unknown): FromWebview | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'edits': {
      const { id, edits, label, baseVersion } = message;
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(baseVersion) || typeof label !== 'string' || !Array.isArray(edits)) return null;
      const parsed: TextEdit[] = [];
      for (const edit of edits as unknown[]) {
        if (typeof edit !== 'object' || edit === null) return null;
        const { offset, length, newText } = edit as Record<string, unknown>;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || typeof newText !== 'string') return null;
        parsed.push({ offset: offset as number, length: length as number, newText });
      }
      return { type: 'edits', id: id as number, edits: parsed, label, baseVersion: baseVersion as number };
    }
    case 'readFixtures':
      return Number.isSafeInteger(message['id']) ? { type: 'readFixtures', id: message['id'] as number } : null;
    case 'readScript':
      return Number.isSafeInteger(message['id']) ? { type: 'readScript', id: message['id'] as number } : null;
    case 'openTextEditor': {
      const offset = message['offset'];
      if (offset === undefined) return { type: 'openTextEditor' };
      return Number.isSafeInteger(offset) ? { type: 'openTextEditor', offset: offset as number } : null;
    }
    case 'log': {
      const { level, message: text } = message;
      if ((level !== 'info' && level !== 'warn' && level !== 'error') || typeof text !== 'string') return null;
      return { type: 'log', level, message: text.slice(0, 2000) };
    }
    default:
      return null;
  }
}
