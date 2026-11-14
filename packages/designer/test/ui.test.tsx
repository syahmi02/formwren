// @vitest-environment jsdom
import { componentMetas } from '@fw/components/meta';
import { openFormText } from '@fw/format';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryHost } from '../dev/memory-host.ts';
import type { ComponentBox, FromCanvas } from '../src/contract.ts';
import { Designer } from '../src/ui/index.ts';

afterEach(cleanup);

const FORM = {
  formatVersion: 1,
  id: 'test.Form',
  size: { width: 400, height: 300 },
  components: [
    { id: 'title', type: 'Label', layout: { left: 16, top: 16, width: 120, height: 24 }, props: { text: 'Hello' } },
    { id: 'name', type: 'TextInput', layout: { left: 16, top: 56, width: 160, height: 24 } },
    {
      id: 'group',
      type: 'Panel',
      layout: { left: 200, top: 16, width: 180, height: 120 },
      children: [{ id: 'inner', type: 'Label', layout: { left: 8, top: 8, width: 80, height: 24 }, props: { text: 'In' } }],
    },
    { id: 'ok', type: 'Button', layout: { right: 16, bottom: 16, width: 80, height: 28 }, props: { text: 'OK' } },
  ],
};
const TEXT = JSON.stringify(FORM, null, 2) + '\n';

const box = (id: string, x: number, y: number, width: number, height: number, depth = 0, parentId: string | null = null, visible = true): ComponentBox => ({ id, parentId, x, y, width, height, depth, visible });
const BOXES: ComponentBox[] = [
  box('title', 16, 16, 120, 24),
  box('name', 16, 56, 160, 24),
  box('group', 200, 16, 180, 120),
  box('inner', 208, 24, 80, 24, 1, 'group'),
  box('ok', 304, 256, 80, 28),
];

/** Opens the designer on a memory host and plays the canvas: it reports boxes from the iframe's window. */
async function open(text = TEXT, setup?: (host: MemoryHost) => void) {
  const host = new MemoryHost({ fileName: 'test.form.json', text });
  setup?.(host);
  const user = userEvent.setup();
  render(<Designer host={host} metas={componentMetas} />);
  const overlay = await screen.findByTestId('overlay');
  const frame = screen.getByTitle('Form canvas') as HTMLIFrameElement;
  const fromCanvas = (message: FromCanvas) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }));
    });
  await fromCanvas({ type: 'ready' });
  await fromCanvas({ type: 'boxes', boxes: BOXES, formWidth: 400, formHeight: 300 });
  return { host, user, overlay, frame, fromCanvas };
}

/** jsdom may lack PointerEvent, and React only needs the event's name and coordinates. */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: Element, init: { clientX?: number; clientY?: number; altKey?: boolean } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

const parsed = (host: MemoryHost) => {
  const opened = openFormText(host.readText());
  if (opened.status !== 'ok') throw new Error('not ok');
  return opened.value as unknown as typeof FORM;
};
const layoutOf = (host: MemoryHost, id: string) => {
  const find = (list: typeof FORM.components): (typeof FORM.components)[number] | undefined => {
    for (const c of list) {
      if (c.id === id) return c;
      const inner = find(((c as { children?: typeof FORM.components }).children ?? []) as typeof FORM.components);
      if (inner) return inner;
    }
    return undefined;
  };
  return find(parsed(host).components)?.layout as unknown as Record<string, number>;
};
const selectedId = () => screen.queryByTestId('selection')?.getAttribute('data-id') ?? null;

describe('selection', () => {
  it('selects the deepest visible box under the pointer, and Escape clears it', async () => {
    const { overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointerup', overlay, { clientX: 20, clientY: 20 });
    expect(selectedId()).toBe('title');
    // 'inner' sits inside 'group': the deeper one wins.
    pointer('pointerdown', overlay, { clientX: 210, clientY: 30 });
    pointer('pointerup', overlay, { clientX: 210, clientY: 30 });
    expect(selectedId()).toBe('inner');
    pointer('pointerdown', overlay, { clientX: 350, clientY: 120 });
    pointer('pointerup', overlay, { clientX: 350, clientY: 120 });
    expect(selectedId()).toBe('group');
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(selectedId()).toBeNull();
  });

  it('clears the selection when the pointer lands on nothing, and ignores boxes that are not visible', async () => {
    const { overlay, fromCanvas } = await open();
    await fromCanvas({ type: 'boxes', boxes: BOXES.map((b) => (b.id === 'inner' ? { ...b, visible: false } : b)), formWidth: 400, formHeight: 300 });
    pointer('pointerdown', overlay, { clientX: 210, clientY: 30 });
    pointer('pointerup', overlay, { clientX: 210, clientY: 30 });
    expect(selectedId()).toBe('group');
    pointer('pointerdown', overlay, { clientX: 5, clientY: 290 });
    pointer('pointerup', overlay, { clientX: 5, clientY: 290 });
    expect(selectedId()).toBeNull();
  });

  it('walks through the components with Tab and Shift+Tab, in document order', async () => {
    const { overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(selectedId()).toBe('title');
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(selectedId()).toBe('name');
    fireEvent.keyDown(overlay, { key: 'Tab' });
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(selectedId()).toBe('inner');
    fireEvent.keyDown(overlay, { key: 'Tab', shiftKey: true });
    expect(selectedId()).toBe('group');
    // Past the last one, Tab is left alone so focus can leave the canvas.
    fireEvent.keyDown(overlay, { key: 'Tab' });
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(selectedId()).toBe('ok');
    const leave = fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(leave).toBe(true);
    expect(selectedId()).toBe('ok');
  });

  it('tells assistive technology what is selected', async () => {
    const { overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('title, Label');
  });
});

describe('move', () => {
  it('shows live feedback while dragging and applies one command on pointer up', async () => {
    const { host, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointermove', overlay, { clientX: 40, clientY: 30 });
    pointer('pointermove', overlay, { clientX: 60, clientY: 36 });
    expect(screen.getByTestId('live')).toBeTruthy();
    expect(host.applied).toEqual([]);
    expect(host.readText()).toBe(TEXT);
    pointer('pointerup', overlay, { clientX: 60, clientY: 36 });
    await waitFor(() => expect(host.applied).toEqual(['Move title']));
    expect(layoutOf(host, 'title')).toEqual({ left: 56, top: 32, width: 120, height: 24 });
    expect(screen.queryByTestId('live')).toBeNull();
    // The text is the source: one undo takes it back.
    act(() => host.undo());
    expect(host.readText()).toBe(TEXT);
  });

  it('snaps to the grid, and Alt turns snapping off', async () => {
    const { host, overlay } = await open();
    // 3 pixels is within the grid's reach, so it snaps back to where it was: nothing to write.
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointermove', overlay, { clientX: 23, clientY: 23 });
    pointer('pointerup', overlay, { clientX: 23, clientY: 23 });
    await act(async () => {});
    expect(host.applied).toEqual([]);
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointermove', overlay, { clientX: 23, clientY: 23, altKey: true });
    pointer('pointerup', overlay, { clientX: 23, clientY: 23 });
    await waitFor(() => expect(host.applied).toEqual(['Move title']));
    expect(layoutOf(host, 'title')).toMatchObject({ left: 19, top: 19 });
  });

  it('draws a guide when an edge lines up with a sibling', async () => {
    const { overlay } = await open();
    // 'name' starts at y=56. Moving 'title' (24 high) to y=56 lines up their tops.
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointermove', overlay, { clientX: 20, clientY: 58 });
    expect(document.querySelector('.dz-guide')).not.toBeNull();
  });

  it('keeps a right and bottom anchor', async () => {
    const { host, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 310, clientY: 262 });
    pointer('pointermove', overlay, { clientX: 286, clientY: 254 });
    pointer('pointerup', overlay, { clientX: 286, clientY: 254 });
    await waitFor(() => expect(host.applied).toEqual(['Move ok']));
    expect(layoutOf(host, 'ok')).toEqual({ right: 40, bottom: 24, width: 80, height: 28 });
  });

  it('does nothing for a plain click, which only selects', async () => {
    const { host, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointerup', overlay, { clientX: 20, clientY: 20 });
    await act(async () => {});
    expect(host.applied).toEqual([]);
    expect(selectedId()).toBe('title');
  });
});

describe('resize', () => {
  it('shows eight handles on the selection', async () => {
    const { overlay } = await open();
    expect(document.querySelectorAll('.dz-handle')).toHaveLength(0);
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect([...document.querySelectorAll('.dz-handle')].map((h) => h.getAttribute('data-handle')).sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  });

  it('drags a handle into one resize command', async () => {
    const { host, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    const handle = screen.getByTestId('handle-e');
    pointer('pointerdown', handle, { clientX: 136, clientY: 28 });
    pointer('pointermove', overlay, { clientX: 168, clientY: 28 });
    expect(screen.getByTestId('live').textContent).toContain('152');
    pointer('pointerup', overlay, { clientX: 168, clientY: 28 });
    await waitFor(() => expect(host.applied).toEqual(['Resize title']));
    expect(layoutOf(host, 'title')).toEqual({ left: 16, top: 16, width: 152, height: 24 });
  });

  it('resizes from the west or north edge of a right-anchored box without adding a left edge', async () => {
    const { host, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 310, clientY: 262 });
    pointer('pointerup', overlay, { clientX: 310, clientY: 262 });
    pointer('pointerdown', screen.getByTestId('handle-nw'), { clientX: 304, clientY: 256 });
    pointer('pointermove', overlay, { clientX: 296, clientY: 248 });
    pointer('pointerup', overlay, { clientX: 296, clientY: 248 });
    await waitFor(() => expect(host.applied).toEqual(['Resize ok']));
    expect(layoutOf(host, 'ok')).toEqual({ right: 16, bottom: 16, width: 88, height: 36 });
  });
});

describe('keyboard', () => {
  it('nudges by 1 px, or 8 px with Shift, and a quick burst is one undo step', async () => {
    const { host, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) {
      fireEvent.keyDown(overlay, { key });
      await act(async () => {});
    }
    fireEvent.keyDown(overlay, { key: 'ArrowRight', shiftKey: true });
    await act(async () => {});
    expect(layoutOf(host, 'title')).toMatchObject({ left: 26, top: 17 });
    expect(host.applied).toHaveLength(4);
    act(() => host.undo());
    expect(host.readText()).toBe(TEXT);
  });

  it('resizes with Control and the arrow keys', async () => {
    const { host, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    fireEvent.keyDown(overlay, { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(layoutOf(host, 'title')).toMatchObject({ left: 16, width: 128 }));
  });

  it('deletes the selection with Delete, with no confirmation, and undo brings it back', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { host, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 20, clientY: 60 });
    pointer('pointerup', overlay, { clientX: 20, clientY: 60 });
    expect(selectedId()).toBe('name');
    fireEvent.keyDown(overlay, { key: 'Delete' });
    await waitFor(() => expect(parsed(host).components.map((c) => c.id)).toEqual(['title', 'group', 'ok']));
    expect(confirm).not.toHaveBeenCalled();
    expect(host.applied).toEqual(['Delete name']);
    expect(selectedId()).toBeNull();
    act(() => host.undo());
    expect(host.readText()).toBe(TEXT);
    confirm.mockRestore();
  });

  it('does nothing for arrow keys and Delete when nothing is selected', async () => {
    const { host, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'ArrowLeft' });
    fireEvent.keyDown(overlay, { key: 'Delete' });
    await act(async () => {});
    expect(host.applied).toEqual([]);
  });

  it('can be focused', async () => {
    const { overlay } = await open();
    overlay.focus();
    expect(document.activeElement).toBe(overlay);
  });
});

describe('inspector', () => {
  it('lists the props from the component description, with typed editors', async () => {
    const { overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(inspector.textContent).toContain('title');
    expect((screen.getByLabelText('text') as HTMLInputElement).value).toBe('Hello');
    expect(screen.getByLabelText('align').tagName).toBe('SELECT');
    expect(screen.getByLabelText('live')).toHaveProperty('type', 'checkbox');
    expect((screen.getByLabelText('width') as HTMLInputElement).value).toBe('120');
    expect((screen.getByLabelText('right') as HTMLInputElement).value).toBe('');
  });

  it('writes a text field on blur or Enter, never per keystroke', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    const field = screen.getByLabelText('text');
    await user.clear(field);
    await user.type(field, 'Bye');
    expect(host.applied).toEqual([]);
    expect(host.readText()).toBe(TEXT);
    await user.tab();
    await waitFor(() => expect(host.applied).toEqual(['Change text of title']));
    expect((parsed(host).components[0] as { props: { text: string } }).props.text).toBe('Bye');
    await user.clear(field);
    await user.type(field, 'Again{Enter}');
    await waitFor(() => expect(host.applied).toHaveLength(2));
    expect((parsed(host).components[0] as { props: { text: string } }).props.text).toBe('Again');
  });

  it('puts the old text back on Escape, and writes nothing for an unchanged field', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    const field = screen.getByLabelText('text') as HTMLInputElement;
    await user.type(field, 'xyz{Escape}');
    expect(field.value).toBe('Hello');
    await user.tab();
    await act(async () => {});
    expect(host.applied).toEqual([]);
  });

  it('edits layout edges, the id, a checkbox, a choice, a binding and an event', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(selectedId()).toBe('name');
    await user.clear(screen.getByLabelText('left'));
    await user.type(screen.getByLabelText('left'), '40{Enter}');
    await waitFor(() => expect(layoutOf(host, 'name').left).toBe(40));
    await user.click(screen.getByLabelText('disabled'));
    await waitFor(() => expect((parsed(host).components[1] as { props?: Record<string, unknown> }).props).toEqual({ disabled: true }));
    await user.type(screen.getByLabelText('value (binding)'), 'dsEmp.empName{Enter}');
    await waitFor(() => expect((parsed(host).components[1] as { bind?: Record<string, string> }).bind).toEqual({ value: 'dsEmp.empName' }));
    await user.type(screen.getByLabelText('change (event)'), 'onNameChange{Enter}');
    await waitFor(() => expect((parsed(host).components[1] as { events?: Record<string, string> }).events).toEqual({ change: 'onNameChange' }));
    await user.clear(screen.getByLabelText('id'));
    await user.type(screen.getByLabelText('id'), 'empName{Enter}');
    await waitFor(() => expect(parsed(host).components[1]?.id).toBe('empName'));
    // The selection follows the rename.
    await waitFor(() => expect((screen.getByLabelText('id') as HTMLInputElement).value).toBe('empName'));
  });

  it('chooses a value from a list of choices', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    await user.selectOptions(screen.getByLabelText('align'), 'center');
    await waitFor(() => expect((parsed(host).components[0] as unknown as { props: { align: string } }).props.align).toBe('center'));
  });

  it('keeps an = expression as text and checks numbers', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    fireEvent.keyDown(overlay, { key: 'Tab' });
    await user.type(screen.getByLabelText('maxLength'), 'abc{Enter}');
    expect(screen.getByText('Enter a number, or an expression that starts with =.')).toBeTruthy();
    expect(host.applied).toEqual([]);
    await user.clear(screen.getByLabelText('maxLength'));
    await user.type(screen.getByLabelText('maxLength'), '=params.limit{Enter}');
    await waitFor(() => expect((parsed(host).components[1] as unknown as { props: { maxLength: unknown } }).props.maxLength).toBe('=params.limit'));
  });

  it('refuses a duplicate or invalid id with a message, and writes nothing', async () => {
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    await user.clear(screen.getByLabelText('id'));
    await user.type(screen.getByLabelText('id'), 'name{Enter}');
    expect(screen.getByText('Another component already uses the id "name".')).toBeTruthy();
    await user.clear(screen.getByLabelText('id'));
    await user.type(screen.getByLabelText('id'), '1x{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('letters, digits');
    expect(host.applied).toEqual([]);
  });

  it('shows the diagnostics of the selected component', async () => {
    const bad = { ...FORM, components: FORM.components.map((c) => (c.id === 'name' ? { ...c, props: { nonsense: 1 } } : c)) };
    const { overlay } = await open(JSON.stringify(bad, null, 2));
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    expect(screen.getByRole('region', { name: 'Problems' }).textContent).toMatch(/nonsense/);
  });

  it('follows the text when it changes from outside', async () => {
    const { host, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    act(() => host.setText(TEXT.replace('"Hello"', '"Changed"')));
    await waitFor(() => expect((screen.getByLabelText('text') as HTMLInputElement).value).toBe('Changed'));
  });
});

describe('read-only', () => {
  const blocked = async (host: MemoryHost, overlay: HTMLElement) => {
    pointer('pointerdown', overlay, { clientX: 20, clientY: 20 });
    pointer('pointermove', overlay, { clientX: 60, clientY: 60 });
    pointer('pointerup', overlay, { clientX: 60, clientY: 60 });
    fireEvent.keyDown(overlay, { key: 'ArrowRight' });
    fireEvent.keyDown(overlay, { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(overlay, { key: 'Delete' });
    await act(async () => {});
    expect(host.applied).toEqual([]);
    expect(document.querySelectorAll('.dz-handle')).toHaveLength(0);
  };

  it('blocks every edit for a file with merge conflicts, says why, and opens the text editor', async () => {
    // The form is shown from an earlier good version, so open good text first, then break it.
    const { host, user, overlay } = await open();
    fireEvent.keyDown(overlay, { key: 'Tab' });
    act(() => host.setText(`<<<<<<< HEAD\n${TEXT}=======\n${TEXT}>>>>>>> other\n`));
    await waitFor(() => expect(screen.getByTestId('readonly-banner').textContent).toMatch(/merge conflict|conflict markers/i));
    expect(screen.getByTestId('readonly-badge')).toBeTruthy();
    await blocked(host, overlay);
    for (const input of screen.getByRole('complementary', { name: 'Inspector' }).querySelectorAll('input, select, textarea')) expect((input as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Open text editor' }));
    expect(host.openedTextEditor).toBe(1);
  });

  it('shows the line and column of invalid JSON', async () => {
    const { host, overlay } = await open();
    act(() => host.setText(TEXT.replace('"id": "test.Form",', '"id": "test.Form" ')));
    await waitFor(() => expect(screen.getByTestId('readonly-banner').textContent).toMatch(/Line \d+, column \d+/));
    await blocked(host, overlay);
  });

  it('blocks everything when the host is read-only', async () => {
    const { host, overlay } = await open(TEXT, (h) => {
      h.readOnly = true;
    });
    expect(screen.getByTestId('readonly-banner').textContent).toContain('read-only');
    await blocked(host, overlay);
    expect(host.readText()).toBe(TEXT);
  });

  it('recovers when the text becomes valid again', async () => {
    const { host } = await open();
    act(() => host.setText('{ nope'));
    await waitFor(() => expect(screen.queryByTestId('readonly-banner')).not.toBeNull());
    act(() => host.setText(TEXT));
    await waitFor(() => expect(screen.queryByTestId('readonly-banner')).toBeNull());
  });
});

describe('the canvas link', () => {
  it('sends the definition when the canvas is ready, and again after each change', async () => {
    const host = new MemoryHost({ fileName: 'test.form.json', text: TEXT });
    render(<Designer host={host} metas={componentMetas} />);
    const frame = (await screen.findByTitle('Form canvas')) as HTMLIFrameElement;
    const sent: unknown[] = [];
    frame.contentWindow?.addEventListener('message', (event) => sent.push(event.data));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow }));
    });
    await waitFor(() => expect(sent.some((m) => (m as { type: string }).type === 'definition')).toBe(true));
    const before = sent.length;
    await act(async () => {
      await host.applyEdits([{ offset: TEXT.indexOf('"Hello"'), length: 7, newText: '"Hi"' }], 'x');
    });
    await waitFor(() => expect(sent.length).toBeGreaterThan(before));
  });

  it('ignores messages that do not come from its canvas', async () => {
    const { host, overlay } = await open();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'boxes', boxes: [box('title', 0, 0, 400, 300)], formWidth: 1, formHeight: 1 }, source: window }));
    });
    pointer('pointerdown', overlay, { clientX: 350, clientY: 250 });
    pointer('pointerup', overlay, { clientX: 350, clientY: 250 });
    expect(selectedId()).toBeNull();
    expect(host.applied).toEqual([]);
  });
});
