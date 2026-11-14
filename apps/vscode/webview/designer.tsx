// The page the designer webview runs. It connects the designer to the extension through a small
// message protocol (src/protocol.ts) and shows the designer once the first text has arrived.
import { componentMetas } from '@fw/components/meta';
import '@fw/components/theme.css';
import * as core from '@fw/core';
import type { FormModule } from '@fw/core';
import { Designer } from '@fw/designer';
import { createRoot } from 'react-dom/client';
import type { FromWebview, ToWebview } from '../src/protocol.ts';
import './vscode.css';
import canvasTemplate from './canvas.html?raw';
import { WebviewHost } from './host.ts';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

// The form's script is compiled in the extension with `@fw/core` left out, and takes it from here, so
// the script and the preview share one runtime.
(globalThis as { __fwCore?: unknown }).__fwCore = core;

const vscode = acquireVsCodeApi();
const post = (message: FromWebview): void => vscode.postMessage(message);

// Policy violations and errors go to the extension, where tests and the output log can see them.
document.addEventListener('securitypolicyviolation', (event) => {
  post({ type: 'log', level: 'error', message: `Blocked by the content security policy: ${event.violatedDirective} ${event.blockedURI}` });
});
window.addEventListener('error', (event) => post({ type: 'log', level: 'error', message: `Script error: ${event.message}` }));
window.addEventListener('unhandledrejection', (event) => post({ type: 'log', level: 'error', message: `Unhandled rejection: ${String(event.reason)}` }));

const body = document.body;
const container = document.getElementById('root') as HTMLElement;
const host = new WebviewHost(body.dataset['fileName'] ?? 'form.form.json', post);

/**
 * A webview can't point a frame at its own files: a frame never goes through VS Code's resource
 * loader, and a blob page has no loader either. So the page fetches the canvas script and styles
 * (which it may, from our own files only), and the canvas page is built from a template into a blob
 * URL that points at blob URLs of those two files. Nothing comes from the network.
 */
async function canvasUrl(): Promise<string> {
  const blobOf = async (url: string, type: string): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
    return URL.createObjectURL(new Blob([await response.text()], { type }));
  };
  const [script, style] = await Promise.all([
    blobOf(body.dataset['canvasJs'] ?? '', 'text/javascript'),
    blobOf(body.dataset['canvasCss'] ?? '', 'text/css'),
  ]);
  const html = canvasTemplate.replaceAll('__SOURCE__', 'blob:').replaceAll('__NONCE__', body.dataset['nonce'] ?? '').replaceAll('__CSS__', style).replaceAll('__JS__', script);
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: unknown; message?: unknown } | null;
  if (!data || typeof data !== 'object') return;
  // The extension's messages arrive here with VS Code's own window as the source, so they are told
  // apart from the canvas frame's messages by their type.
  // Test hooks work only when the extension host says it is running tests, and never from the canvas frame. (VS Code's own messages don't arrive with window.parent as their source.)
  if (data.type === 'test') {
    if (body.dataset['test'] !== '1' || event.source === document.querySelector('iframe')?.contentWindow) return;
    const action = (data as { action?: unknown }).action;
    if (action === 'showPreview') void showPreviewForTest();
    if (action === 'clickPreview') document.querySelector<HTMLElement>('.dz-preview__form button')?.click();
    if (action === 'previewText') void reportPreviewTextForTest();
    return;
  }
  if (data.type === 'text' || data.type === 'editsResult' || data.type === 'fixtures' || data.type === 'script' || data.type === 'scriptChanged') {
    if (event.source !== document.querySelector('iframe')?.contentWindow) host.receive(data as unknown as ToWebview);
  } else if (event.source !== document.querySelector('iframe')?.contentWindow) {
    // Anything else must come from the canvas frame.
    return;
  } else if (data.type === 'ready') {
    post({ type: 'log', level: 'info', message: 'canvas ready' });
  } else if (data.type === 'error') {
    post({ type: 'log', level: 'error', message: `canvas: ${String(data.message)}` });
  }
});

/** Test hook: clicks the Preview tab like a user and reports whether the form rendered. */
async function showPreviewForTest(): Promise<void> {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) => element.textContent?.trim() === 'Preview');
  if (!tab) {
    post({ type: 'log', level: 'error', message: 'preview: no Preview tab' });
    return;
  }
  tab.click();
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (document.querySelector('.dz-preview .fw-form')) {
      post({ type: 'log', level: 'info', message: 'preview rendered' });
      return;
    }
  }
  post({ type: 'log', level: 'error', message: 'preview: the form did not render' });
}

/** Test hook: reports the preview's text whenever it changes, for a while. */
async function reportPreviewTextForTest(): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = (document.querySelector('.dz-preview__form')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text !== last) {
      last = text;
      post({ type: 'log', level: 'info', message: `preview text: ${text}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const scriptNote = document.getElementById('fw-script-note');

/**
 * Loads the form's handler module for the preview. The extension compiles it. Here it becomes a blob
 * URL that is imported, which the policy allows (script-src has blob:) without any eval. If it can't
 * run, the preview runs without handlers and a note under the designer says why.
 */
async function loadScript(): Promise<FormModule | null> {
  const result = await host.readScript();
  const note = result.status === 'unavailable' || result.status === 'error' ? result.message : '';
  if (scriptNote) scriptNote.textContent = result.status === 'error' ? `The form script does not compile.
${note}` : note;
  post({ type: 'log', level: 'info', message: `script ${result.status}${note ? `: ${note}` : ''}` });
  if (result.status !== 'ok') return null;
  const url = URL.createObjectURL(new Blob([result.code], { type: 'text/javascript' }));
  try {
    const loaded = (await import(/* @vite-ignore */ url)) as { default?: FormModule };
    if (!loaded.default || typeof loaded.default.setup !== 'function') throw new Error('The form script has no default export made with defineForm.');
    return loaded.default;
  } catch (error) {
    const message = `The form script failed to load: ${error instanceof Error ? error.message : String(error)}`;
    if (scriptNote) scriptNote.textContent = message;
    post({ type: 'log', level: 'info', message: `script error: ${message}` });
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

host.whenLoaded(() => {
  post({ type: 'log', level: 'info', message: 'text received' });
  canvasUrl().then(
    (url) => {
      const root = createRoot(container);
      // A new loadScript makes the designer load the script again, which is how a change reaches the preview.
      const render = (): void => root.render(<Designer host={host} metas={componentMetas} canvasUrl={url} loadScript={() => loadScript()} />);
      host.onScriptChanged(render);
      render();
    },
    (error: unknown) => post({ type: 'log', level: 'error', message: `canvas: ${String(error)}` }),
  );
});

post({ type: 'ready' });
