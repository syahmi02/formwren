import { defaultRegistry, FormView } from '@fw/components';
import { createForm, type FormDefinition, type FormInstance } from '@fw/core';
import { createRoot } from 'react-dom/client';
import type { ComponentBox } from '../contract.ts';
import { parseToCanvas, type FromCanvas } from './messages.ts';

/** The form with the two design-only methods core adds. Either may be missing in an older core. */
type DesignForm = FormInstance & {
  applyDefinition?(next: FormDefinition): void;
  reveal?(id: string | null): void;
};

const round = (value: number): number => Math.round(value * 100) / 100;

/** The element a container positions its children in: a Panel's body, a Dialog's body, or the shown Tabs page. */
const CONTENT = '.fw-panel__body, .fw-dialog__body, .fw-tabs__panel';

function contentBox(el: HTMLElement, origin: DOMRect): ComponentBox['content'] {
  const own = [...el.querySelectorAll<HTMLElement>(CONTENT)].filter((c) => c.closest('.fw-host') === el);
  const target = own.find((c) => typeof c.checkVisibility !== 'function' || c.checkVisibility()) ?? own[0];
  if (!target) return undefined;
  const rect = target.getBoundingClientRect();
  // Children are placed from the padding edge, inside the border.
  return {
    x: round(rect.left + target.clientLeft - origin.left),
    y: round(rect.top + target.clientTop - origin.top),
    width: round(target.clientWidth),
    height: round(target.clientHeight),
  };
}

/**
 * Measures every component host under `root`, relative to the form's top-left corner. A box is not
 * visible while it, or something around it, is hidden (a Tabs page that isn't shown, a closed Dialog).
 */
export function measureBoxes(root: HTMLElement): { boxes: ComponentBox[]; formWidth: number; formHeight: number } {
  const formEl = root.querySelector<HTMLElement>('.fw-form');
  if (!formEl) return { boxes: [], formWidth: 0, formHeight: 0 };
  const origin = formEl.getBoundingClientRect();
  const boxes: ComponentBox[] = [];
  for (const el of formEl.querySelectorAll<HTMLElement>('.fw-host')) {
    const id = el.dataset.id;
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    let depth = 0;
    let parentId: string | null = null;
    for (let up = el.parentElement?.closest<HTMLElement>('.fw-host'); up; up = up.parentElement?.closest<HTMLElement>('.fw-host')) {
      parentId ??= up.dataset.id ?? null;
      depth++;
    }
    const shown = typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
    const content = contentBox(el, origin);
    boxes.push({
      id,
      parentId,
      x: round(rect.left - origin.left),
      y: round(rect.top - origin.top),
      width: round(rect.width),
      height: round(rect.height),
      depth,
      visible: shown && (rect.width > 0 || rect.height > 0),
      ...(content ? { content } : {}),
    });
  }
  return { boxes, formWidth: round(Math.max(origin.width, formEl.scrollWidth)), formHeight: round(Math.max(origin.height, formEl.scrollHeight)) };
}

export interface CanvasHandle {
  stop(): void;
}

/**
 * Runs the canvas page. It listens to its parent window only and reads messages as data: nothing
 * it receives is ever run as code.
 */
export function startCanvas(win: Window, container: HTMLElement): CanvasHandle {
  const parent = win.parent;
  const root = createRoot(container);
  let form: DesignForm | null = null;
  let revealId: string | null = null;
  let parentOrigin = '*';
  let lastSent = '';
  let scheduled = 0;
  let forced = false;

  const send = (message: FromCanvas): void => {
    if (parent === win) return;
    parent.postMessage(message, parentOrigin);
  };
  const fail = (error: unknown): void => send({ type: 'error', message: error instanceof Error ? error.message : String(error) });

  const report = (): void => {
    scheduled = 0;
    const measured = measureBoxes(container);
    const key = JSON.stringify(measured);
    if (key === lastSent && !forced) return;
    forced = false;
    lastSent = key;
    send({ type: 'boxes', ...measured });
  };
  const schedule = (force = false): void => {
    forced ||= force;
    if (scheduled) return;
    scheduled = win.requestAnimationFrame(report);
  };

  const mount = (definition: FormDefinition): void => {
    form = createForm(definition, {
      mode: 'design',
      onError: (error, where) => fail(new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`)),
    }) as DesignForm;
    root.render(<FormView form={form} registry={defaultRegistry} />);
  };

  const onDefinition = (definition: FormDefinition): void => {
    try {
      if (!form || typeof form.applyDefinition !== 'function') {
        // The first definition, or a core that cannot update in place: (re)start the form.
        mount(definition);
      } else {
        form.applyDefinition(definition);
      }
    } catch (error) {
      fail(error);
    }
    // The component to reveal may be gone or renamed by this change. Then there is nothing to reveal.
    if (revealId !== null) {
      try {
        form?.reveal?.(revealId);
      } catch {
        revealId = null;
      }
    }
    schedule(true);
  };

  const onMessage = (event: MessageEvent): void => {
    // Only the window that embeds this page may talk to it.
    if (parent === win || event.source !== parent) return;
    const message = parseToCanvas(event.data);
    if (!message) return;
    if (event.origin && event.origin !== 'null') parentOrigin = event.origin;
    switch (message.type) {
      case 'definition':
        onDefinition(message.definition);
        break;
      case 'reveal':
        revealId = message.id;
        try {
          form?.reveal?.(message.id);
        } catch (error) {
          fail(error);
        }
        schedule(true);
        break;
      case 'theme':
        if (message.theme) win.document.documentElement.dataset.fwTheme = message.theme;
        else delete win.document.documentElement.dataset.fwTheme;
        break;
    }
  };

  const onError = (event: ErrorEvent): void => fail(event.error ?? event.message);
  const onResize = (): void => schedule();
  win.addEventListener('message', onMessage);
  win.addEventListener('error', onError);
  win.addEventListener('resize', onResize);
  const mutations = new MutationObserver(() => schedule());
  mutations.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
  const sizes = new ResizeObserver(() => schedule());
  sizes.observe(container);

  send({ type: 'ready' });
  return {
    stop() {
      win.removeEventListener('message', onMessage);
      win.removeEventListener('error', onError);
      win.removeEventListener('resize', onResize);
      mutations.disconnect();
      sizes.disconnect();
      root.unmount();
    },
  };
}
