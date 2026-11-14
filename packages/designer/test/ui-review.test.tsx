// @vitest-environment jsdom
import { componentMetas } from '@fw/components/meta';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryHost } from '../dev/memory-host.ts';
import { Designer } from '../src/ui/index.ts';
import { BOXES, TEXT, find, open, parsed, pointer, selectedId } from './ui-support.tsx';

afterEach(cleanup);

const tab = (name: string) => screen.getByRole('tab', { name });
const ids = (list: { id: string }[] | undefined) => (list ?? []).map((c) => c.id);

describe('a form of the wrong shape', () => {
  it('shows what went wrong instead of a blank page, and recovers when the text is fixed', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = new MemoryHost({ fileName: 'test.form.json', text: TEXT });
    render(<Designer host={host} metas={componentMetas} />);
    await screen.findByTestId('overlay');
    for (const broken of ['{"formatVersion":1,"id":"x"}', '{"formatVersion":1,"id":"x","components":[{"id":"a","type":"Label","layout":{},"children":{}}]}']) {
      act(() => host.setText(broken));
      // Either the model calls the file invalid (a read-only banner), or the view's own boundary catches it.
      await waitFor(() => expect(screen.queryByTestId('designer-error') ?? screen.queryByTestId('readonly-banner')).not.toBeNull());
      act(() => host.setText(TEXT));
      await waitFor(() => expect(screen.queryByTestId('overlay')).not.toBeNull());
      expect(screen.queryByTestId('designer-error')).toBeNull();
      expect(screen.queryByTestId('readonly-banner')).toBeNull();
    }
    quiet.mockRestore();
  });
});

describe('positions inside a container count from its content box', () => {
  it('puts a dropped component on the grid of the content box, where the indicator showed', async () => {
    const { host } = await open();
    pointer('pointerdown', screen.getByRole('button', { name: 'Text input' }));
    pointer('pointermove', window, { clientX: 210, clientY: 60 });
    const indicator = screen.getByTestId('drop-indicator');
    // Content box at (201, 41): the pointer is 9 right and 19 below it, which the 8 px grid puts at (8, 16).
    expect(indicator.style.left).toBe('209px');
    expect(indicator.style.top).toBe('57px');
    expect(screen.getByTestId('drop-parent').style.top).toBe('41px');
    pointer('pointerup', window, { clientX: 210, clientY: 60 });
    await waitFor(() => expect(find(host, 'textInput1')).toBeTruthy());
    expect(find(host, 'textInput1')?.layout).toMatchObject({ left: 8, top: 16 });
  });

  it('snaps a child to the grid of the content box', async () => {
    const { host, overlay } = await open();
    // 'inner' is at (8, 8) in the content box, drawn at (209, 49). A drag of 10 lands on 16 in the content frame.
    pointer('pointerdown', overlay, { clientX: 215, clientY: 55 });
    pointer('pointermove', overlay, { clientX: 225, clientY: 65 });
    pointer('pointerup', overlay, { clientX: 225, clientY: 65 });
    await waitFor(() => expect(host.applied).toEqual(['Move inner']));
    expect(find(host, 'inner')?.layout).toMatchObject({ left: 16, top: 16 });
  });

  it('adds from the keyboard below what the container holds, in its content box', async () => {
    const { host, user, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 350, clientY: 120 });
    pointer('pointerup', overlay, { clientX: 350, clientY: 120 });
    expect(selectedId()).toBe('group');
    screen.getByRole('button', { name: 'Button' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(ids(find(host, 'group')?.children)).toEqual(['inner', 'button1']));
    // inner ends at 73 on the canvas, which is 32 into the content box, so the new one goes at 40.
    expect(find(host, 'button1')?.layout).toMatchObject({ left: 16, top: 40 });
  });
});

describe('outline', () => {
  const row = (id: string) => screen.getAllByRole('treeitem').find((r) => r.getAttribute('data-id') === id) as HTMLElement;
  const openOutline = async () => {
    const context = await open();
    await context.user.click(tab('Outline'));
    return context;
  };

  it('puts a row dragged down inside its parent where the line showed, not one place later', async () => {
    const { host } = await openOutline();
    pointer('pointerdown', row('title'), { clientX: 10, clientY: 10 });
    pointer('pointermove', window, { clientX: 30, clientY: 30 });
    pointer('pointermove', row('ok'), { clientX: 30, clientY: 40 });
    expect(row('ok').getAttribute('data-drop')).toBe('after');
    pointer('pointerup', window, { clientX: 30, clientY: 40 });
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['name', 'group', 'ok', 'title', 'grid']));
  });

  it('puts a row dragged up where the line showed', async () => {
    const { host } = await openOutline();
    pointer('pointerdown', row('grid'), { clientX: 10, clientY: 10 });
    pointer('pointermove', window, { clientX: 30, clientY: 30 });
    pointer('pointermove', row('name'), { clientX: 30, clientY: 40 });
    pointer('pointerup', window, { clientX: 30, clientY: 40 });
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'grid', 'group', 'ok']));
  });

  it('moves focus to the next row when Delete removes the focused one', async () => {
    const { host, user } = await openOutline();
    await user.click(row('ok'));
    row('ok').focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'grid']));
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('data-id')).toBe('grid'));
    // The last row hands focus to the one before it (the container's child, in tree order).
    await user.keyboard('{Delete}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group']));
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('data-id')).toBe('inner'));
  });

  it('does not take focus back from a field after a command that changed nothing', async () => {
    const { user, fromCanvas } = await openOutline();
    await user.click(row('title'));
    row('title').focus();
    // Alt+Up on the first row does nothing.
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    const field = screen.getByLabelText('text');
    await user.click(field);
    await user.type(field, 'x');
    // Something redraws the outline: the canvas reports new boxes.
    await fromCanvas({ type: 'boxes', boxes: BOXES.map((b) => (b.id === 'ok' ? { ...b, visible: false } : b)), formWidth: 400, formHeight: 300 });
    expect(document.activeElement).toBe(field);
  });

  it('ignores a component list that is not a list', async () => {
    const { host } = await openOutline();
    act(() => host.setText(TEXT.replace('"children": [', '"children": [').replace(/"id": "ok"/, '"id": "ok", "children": {}')));
    await waitFor(() => expect(screen.queryByTestId('designer') ?? screen.queryByTestId('designer-error')).not.toBeNull());
  });
});

describe('Dataset editor', () => {
  it('stays on a Dataset that was renamed, so the next edit goes to it', async () => {
    const { host, user } = await open();
    await user.click(tab('Datasets'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset' }), 'dsOther');
    const id = screen.getByLabelText('id', { selector: '#dz-ds-id' });
    await user.clear(id);
    await user.type(id, 'dsMore{Enter}');
    await waitFor(() => expect(parsed(host).datasets?.map((d) => d.id)).toEqual(['dsEmp', 'dsMore']));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Dataset' }) as HTMLSelectElement).value).toBe('dsMore'));
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(parsed(host).datasets?.[1]?.columns).toHaveLength(2));
    expect(parsed(host).datasets?.[0]?.columns).toHaveLength(3);
  });

  it('keeps focus in a column field after renaming the column with Enter', async () => {
    const { host, user } = await open();
    await user.click(tab('Datasets'));
    const field = screen.getByLabelText('note id');
    await user.clear(field);
    await user.type(field, 'memo{Enter}');
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns[2]?.id).toBe('memo'));
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole('region', { name: 'Columns' })).getByLabelText('memo id')));
  });
});

describe('userEvent is wired', () => {
  it('works', async () => {
    expect(userEvent.setup()).toBeTruthy();
  });
});

describe('a host that is a class instance', () => {
  it('works when the host keeps its state on itself, as the VS Code host does', async () => {
    // Private fields throw if a method is called without its object, as an unbound reference would be.
    class ClassHost {
      readonly fileName = 'test.form.json';
      readonly readOnly = false;
      #text = TEXT;
      readonly #listeners = new Set<(text: string) => void>();
      readText(): string {
        return this.#text;
      }
      onDidChangeText(listener: (text: string) => void): () => void {
        this.#listeners.add(listener);
        return () => void this.#listeners.delete(listener);
      }
      async applyEdits(): Promise<boolean> {
        return false;
      }
      setText(text: string): void {
        this.#text = text;
        for (const listener of [...this.#listeners]) listener(text);
      }
    }
    const host = new ClassHost();
    render(<Designer host={host} metas={componentMetas} />);
    await screen.findByTestId('overlay');
    act(() => host.setText(TEXT.replace('"inner"', '"inner2"')));
    await screen.findByTestId('overlay');
  });
});
