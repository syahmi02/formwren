import { componentMetas } from '@fw/components/meta';
import { openFormText } from '@fw/format';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryHost } from '../dev/memory-host.ts';
import type { ComponentBox, FromCanvas } from '../src/contract.ts';
import { Designer } from '../src/ui/index.ts';

export const FORM = {
  formatVersion: 1,
  id: 'test.Form',
  size: { width: 400, height: 300 },
  datasets: [
    {
      id: 'dsEmp',
      keys: ['empNo'],
      columns: [
        { id: 'empNo', type: 'string', size: 10 },
        { id: 'salary', type: 'int' },
        { id: 'note', type: 'string' },
      ],
      sampleRows: [{ empNo: 'E1', salary: 10 }],
    },
    { id: 'dsOther', columns: [{ id: 'code', type: 'string' }] },
  ],
  components: [
    { id: 'title', type: 'Label', layout: { left: 16, top: 16, width: 120, height: 24 }, props: { text: 'Hello' } },
    { id: 'name', type: 'TextInput', layout: { left: 16, top: 56, width: 160, height: 24 }, bind: { value: 'dsEmp.empNo' } },
    {
      id: 'group',
      type: 'Panel',
      layout: { left: 200, top: 16, width: 180, height: 120 },
      children: [{ id: 'inner', type: 'Label', layout: { left: 8, top: 8, width: 80, height: 24 }, props: { text: 'In' } }],
    },
    { id: 'ok', type: 'Button', layout: { right: 16, bottom: 16, width: 80, height: 28 }, props: { text: 'OK' } },
    {
      id: 'grid',
      type: 'Grid',
      layout: { left: 16, top: 100, width: 170, height: 100 },
      bind: { dataset: 'dsEmp' },
      props: {
        columns: [
          { id: 'a', width: 100 },
          { id: 'b', width: 80 },
        ],
        headerRows: [{ cells: [{ text: 'A' }, { text: 'B' }] }],
        recordRows: [{ cells: [{ field: 'empNo' }, { field: 'salary' }] }],
      },
    },
  ],
};
export const TEXT = JSON.stringify(FORM, null, 2) + '\n';

export const box = (id: string, x: number, y: number, width: number, height: number, depth = 0, parentId: string | null = null, visible = true): ComponentBox => ({ id, parentId, x, y, width, height, depth, visible });
export const BOXES: ComponentBox[] = [
  box('title', 16, 16, 120, 24),
  box('name', 16, 56, 160, 24),
  // A titled Panel: its children start inside the border and below the title, at the content box.
  { ...box('group', 200, 16, 180, 120), content: { x: 201, y: 41, width: 178, height: 94 } },
  box('inner', 209, 49, 80, 24, 1, 'group'),
  box('ok', 304, 256, 80, 28),
  box('grid', 16, 100, 170, 100),
];

/** Opens the designer on a memory host and plays the canvas: it reports boxes from the iframe's window. */
export async function open(text = TEXT, setup?: (host: MemoryHost) => void) {
  const host = new MemoryHost({ fileName: 'test.form.json', text });
  setup?.(host);
  const user = userEvent.setup();
  render(<Designer host={host} metas={componentMetas} />);
  const overlay = await screen.findByTestId('overlay');
  const frame = screen.getByTitle('Form canvas') as HTMLIFrameElement;
  const sent: { type: string; id?: string | null }[] = [];
  frame.contentWindow?.addEventListener('message', (event) => sent.push(event.data));
  const fromCanvas = (message: FromCanvas) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    });
  await fromCanvas({ type: 'ready' });
  await fromCanvas({ type: 'boxes', boxes: BOXES, formWidth: 400, formHeight: 300 });
  return { host, user, overlay, frame, fromCanvas, sent };
}

/** jsdom may lack PointerEvent, and React only needs the event's name and coordinates. */
export function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: EventTarget, init: { clientX?: number; clientY?: number; altKey?: boolean } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

export type Loose = { id: string; type: string; layout: Record<string, number>; props?: Record<string, unknown>; bind?: Record<string, string>; children?: Loose[] };
export type LooseForm = { datasets?: { id: string; keys?: string[]; confirmUnsaved?: boolean; columns: Record<string, unknown>[]; sampleRows?: Record<string, unknown>[] }[]; components: Loose[] };

export const parsed = (host: MemoryHost): LooseForm => {
  const opened = openFormText(host.readText());
  if (opened.status !== 'ok') throw new Error('not ok');
  return opened.value as unknown as LooseForm;
};

export const find = (host: MemoryHost, id: string): Loose | undefined => {
  const walk = (list: Loose[]): Loose | undefined => {
    for (const c of list) {
      if (c.id === id) return c;
      const inner = walk(c.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(parsed(host).components);
};

export const selectedId = () => screen.queryByTestId('selection')?.getAttribute('data-id') ?? null;
