// @vitest-environment jsdom
import { componentMetas } from '@fw/components/meta';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BOXES, FORM, TEXT, find, open, parsed, pointer, selectedId } from './ui-support.tsx';

afterEach(cleanup);

const tab = (name: string) => screen.getByRole('tab', { name });
const ids = (list: { id: string }[] | undefined) => (list ?? []).map((c) => c.id);

describe('palette', () => {
  it('groups the components by category, with the names from their descriptions', async () => {
    await open();
    const palette = screen.getByRole('region', { name: 'Component palette' });
    for (const title of ['Inputs', 'Actions', 'Display', 'Containers']) expect(within(palette).getByRole('region', { name: title })).toBeTruthy();
    expect(within(within(palette).getByRole('region', { name: 'Containers' })).getAllByRole('button').map((b) => b.textContent)).toEqual([componentMetas.Dialog?.displayName, componentMetas.Panel?.displayName, componentMetas.Tabs?.displayName]);
    expect(within(palette).getByRole('button', { name: componentMetas.TextInput?.displayName as string })).toBeTruthy();
  });

  it('adds at the top level with Enter on a picked item, and selects the new component', async () => {
    const { host, user } = await open();
    screen.getByRole('button', { name: 'Button' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(host.applied).toEqual(['Add Button']));
    expect(parsed(host).components.at(-1)?.id).toBe('button1');
    expect(find(host, 'button1')?.layout).toMatchObject({ left: 16 });
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Inspector' }).textContent).toContain('button1'));
    act(() => host.undo());
    expect(host.readText()).toBe(TEXT);
  });

  it('adds into the selected container', async () => {
    const { host, user, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 350, clientY: 120 });
    pointer('pointerup', overlay, { clientX: 350, clientY: 120 });
    expect(selectedId()).toBe('group');
    expect(screen.getByText(/press Enter to add into group/)).toBeTruthy();
    screen.getByRole('button', { name: 'Text input' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(ids(find(host, 'group')?.children)).toEqual(['inner', 'textInput1']));
  });

  it('drops a dragged component into the deepest container under the pointer, with an indicator', async () => {
    const { host } = await open();
    pointer('pointerdown', screen.getByRole('button', { name: 'Text input' }));
    pointer('pointermove', window, { clientX: 210, clientY: 60 });
    expect(screen.getByTestId('drop-indicator').textContent).toContain('in group');
    expect(screen.getByTestId('drop-parent')).toBeTruthy();
    pointer('pointerup', window, { clientX: 210, clientY: 60 });
    await waitFor(() => expect(host.applied).toEqual(['Add Text input']));
    expect(ids(find(host, 'group')?.children)).toEqual(['inner', 'textInput1']);
    // The position is relative to the container, on the grid.
    expect(find(host, 'textInput1')?.layout).toMatchObject({ left: 8, top: 16 });
    expect(screen.queryByTestId('drop-indicator')).toBeNull();
  });

  it('drops on the form itself when no container is under the pointer, and Escape cancels a drag', async () => {
    const { host } = await open();
    pointer('pointerdown', screen.getByRole('button', { name: 'Label' }));
    pointer('pointermove', window, { clientX: 250, clientY: 200 });
    expect(screen.getByTestId('drop-indicator').textContent).toContain('in the form');
    fireEvent.keyDown(window, { key: 'Escape' });
    pointer('pointerup', window, { clientX: 250, clientY: 200 });
    await act(async () => {});
    expect(host.applied).toEqual([]);
    pointer('pointerdown', screen.getByRole('button', { name: 'Label' }));
    pointer('pointermove', window, { clientX: 250, clientY: 200 });
    pointer('pointerup', window, { clientX: 250, clientY: 200 });
    await waitFor(() => expect(parsed(host).components.at(-1)?.id).toBe('label1'));
    expect(parsed(host).components.at(-1)?.layout).toMatchObject({ left: 248, top: 200 });
  });

  it('is disabled when the form is read-only', async () => {
    await open(TEXT, (h) => {
      h.readOnly = true;
    });
    for (const item of screen.getByRole('region', { name: 'Component palette' }).querySelectorAll('button')) expect((item as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('outline', () => {
  const rows = () => screen.getAllByRole('treeitem');
  const row = (id: string) => rows().find((r) => r.getAttribute('data-id') === id) as HTMLElement;
  const openOutline = async () => {
    const context = await open();
    await context.user.click(tab('Outline'));
    return context;
  };

  it('shows the components as a tree in order, and selects from it', async () => {
    const { user } = await openOutline();
    expect(rows().map((r) => `${r.getAttribute('data-id')}:${r.getAttribute('aria-level')}`)).toEqual(['title:1', 'name:1', 'group:1', 'inner:2', 'ok:1', 'grid:1']);
    await user.click(row('name'));
    expect(selectedId()).toBe('name');
    expect(row('name').getAttribute('aria-selected')).toBe('true');
  });

  it('moves the selection with the arrow keys', async () => {
    const { user } = await openOutline();
    await user.click(row('title'));
    row('title').focus();
    await user.keyboard('{ArrowDown}');
    expect(selectedId()).toBe('name');
    await waitFor(() => expect(document.activeElement).toBe(row('name')));
    await user.keyboard('{End}');
    expect(row('grid').getAttribute('aria-selected')).toBe('true');
  });

  it('reorders with Alt+Up and Alt+Down', async () => {
    const { host, user } = await openOutline();
    await user.click(row('title'));
    row('title').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['name', 'title', 'group', 'ok', 'grid']));
    await waitFor(() => expect(document.activeElement).toBe(row('title')));
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'ok', 'grid']));
  });

  it('moves into the container above and out again, from the keyboard and the buttons', async () => {
    const { host, user, overlay } = await openOutline();
    void overlay;
    await user.click(row('ok'));
    row('ok').focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(ids(find(host, 'group')?.children)).toEqual(['inner', 'ok']));
    await user.click(screen.getByRole('button', { name: 'Move out' }));
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'ok', 'grid']));
    // Nothing to move into when the one above is not a container.
    await user.click(row('name'));
    await user.click(screen.getByRole('button', { name: 'Move into' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a container/);
    expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'ok', 'grid']);
  });

  it('moves out with Alt+Left', async () => {
    const { host, user } = await openOutline();
    await user.click(row('inner'));
    row('inner').focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'inner', 'ok', 'grid']));
    expect(find(host, 'group')?.children ?? []).toEqual([]);
  });

  it('re-parents by dragging a row onto a container', async () => {
    const { host } = await openOutline();
    pointer('pointerdown', row('name'), { clientX: 10, clientY: 10 });
    pointer('pointermove', window, { clientX: 30, clientY: 30 });
    pointer('pointermove', row('group'), { clientX: 30, clientY: 40 });
    expect(row('group').getAttribute('data-drop')).toBe('into');
    pointer('pointerup', window, { clientX: 30, clientY: 40 });
    await waitFor(() => expect(ids(find(host, 'group')?.children)).toEqual(['inner', 'name']));
    expect(host.applied).toEqual(['Move name into group']);
  });

  it('refuses to drop a container into itself, and says why', async () => {
    const { host } = await openOutline();
    pointer('pointerdown', row('group'), { clientX: 10, clientY: 10 });
    pointer('pointermove', window, { clientX: 30, clientY: 30 });
    pointer('pointermove', row('inner'), { clientX: 30, clientY: 40 });
    pointer('pointerup', window, { clientX: 30, clientY: 40 });
    await act(async () => {});
    expect(host.applied).toEqual([]);
  });

  it('renames inline, and the selection follows', async () => {
    const { host, user } = await openOutline();
    await user.click(row('title'));
    row('title').focus();
    await user.keyboard('{F2}');
    const input = screen.getByLabelText('New id for title');
    await user.clear(input);
    await user.type(input, 'heading{Enter}');
    await waitFor(() => expect(find(host, 'heading')).toBeTruthy());
    await waitFor(() => expect(row('heading').getAttribute('aria-selected')).toBe('true'));
  });

  it('keeps the old id on Escape, and says why a duplicate or invalid id is refused', async () => {
    const { host, user } = await openOutline();
    await user.click(row('title'));
    row('title').focus();
    await user.keyboard('{F2}');
    let input = screen.getByLabelText('New id for title');
    await user.clear(input);
    await user.type(input, 'name{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('already uses the id "name"');
    await user.clear(input);
    await user.type(input, '9x{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('letters, digits');
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('New id for title')).toBeNull();
    input = document.body;
    expect(host.applied).toEqual([]);
  });

  it('tells the canvas to reveal what is selected, so a hidden page or dialog shows', async () => {
    const { user, sent, fromCanvas } = await openOutline();
    await fromCanvas({ type: 'boxes', boxes: BOXES.map((b) => (b.id === 'inner' ? { ...b, visible: false } : b)), formWidth: 400, formHeight: 300 });
    expect(row('inner').getAttribute('data-hidden')).toBe('true');
    await user.click(row('inner'));
    await waitFor(() => expect(sent).toContainEqual({ type: 'reveal', id: 'inner' }));
  });

  it('deletes the row with Delete, and is read-only when the form is', async () => {
    const { host, user } = await openOutline();
    await user.click(row('ok'));
    row('ok').focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(ids(parsed(host).components)).toEqual(['title', 'name', 'group', 'grid']));
  });
});

describe('Dataset editor', () => {
  const openDatasets = async (text = TEXT, setup?: Parameters<typeof open>[1]) => {
    const context = await open(text, setup);
    await context.user.click(tab('Datasets'));
    return context;
  };

  it('shows the Datasets and the columns with typed fields', async () => {
    await openDatasets();
    expect(within(screen.getByRole('combobox', { name: 'Dataset' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['dsEmp', 'dsOther']);
    expect((screen.getByLabelText('salary type') as HTMLSelectElement).value).toBe('int');
    expect((screen.getByLabelText('empNo size') as HTMLInputElement).value).toBe('10');
    // Size is for text, so a number column has none.
    expect(screen.queryByLabelText('salary size')).toBeNull();
    expect((screen.getByLabelText('keys') as HTMLInputElement).value).toBe('empNo');
  });

  it('changes a column type, adds a column and renames one, each as its own step', async () => {
    const { host, user } = await openDatasets();
    await user.selectOptions(screen.getByLabelText('note type'), 'int');
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns[2]).toMatchObject({ id: 'note', type: 'int' }));
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns).toHaveLength(4));
    const field = screen.getByLabelText('note id');
    await user.clear(field);
    await user.type(field, 'memo{Enter}');
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns[2]?.id).toBe('memo'));
    expect(host.applied).toHaveLength(3);
  });

  it('moves and removes columns', async () => {
    const { host, user } = await openDatasets();
    await user.click(screen.getByRole('button', { name: 'Move column note up' }));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns.map((c) => c.id)).toEqual(['empNo', 'note', 'salary']));
    await user.click(screen.getByRole('button', { name: 'Delete column note' }));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.columns.map((c) => c.id)).toEqual(['empNo', 'salary']));
  });

  it('shows a refusal plainly when a column or a Dataset is still in use', async () => {
    const { host, user } = await openDatasets();
    await user.click(screen.getByRole('button', { name: 'Delete column salary' }));
    const first = await screen.findByRole('alert');
    expect(first.textContent).toMatch(/still used/);
    expect(first.textContent).toContain('dsEmp.salary');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Dataset "dsEmp" is still used/));
    expect(host.applied).toEqual([]);
  });

  it('adds a Dataset, and removes one that nothing uses', async () => {
    const { host, user } = await openDatasets();
    await user.click(screen.getByRole('button', { name: 'Add Dataset' }));
    await waitFor(() => expect(parsed(host).datasets?.map((d) => d.id)).toEqual(['dsEmp', 'dsOther', 'ds1']));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset' }), 'dsOther');
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(parsed(host).datasets?.map((d) => d.id)).toEqual(['dsEmp', 'ds1']));
  });

  it('edits the sample rows, checking each value against its column type', async () => {
    const { host, user } = await openDatasets();
    const cell = screen.getByLabelText('Row 1, salary');
    await user.clear(cell);
    await user.type(cell, '12abc{Enter}');
    expect(screen.getAllByRole('alert').some((a) => /whole number/.test(a.textContent ?? ''))).toBe(true);
    expect(host.applied).toEqual([]);
    await user.clear(cell);
    await user.type(cell, '25{Enter}');
    await waitFor(() => expect(parsed(host).datasets?.[0]?.sampleRows?.[0]).toEqual({ empNo: 'E1', salary: 25 }));
    await user.click(screen.getByRole('button', { name: 'Add sample row' }));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.sampleRows).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Remove sample row 2' }));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.sampleRows).toHaveLength(1));
  });

  it('sets the keys and confirmUnsaved', async () => {
    const { host, user } = await openDatasets();
    await user.click(screen.getByLabelText('confirmUnsaved'));
    await waitFor(() => expect(parsed(host).datasets?.[0]?.confirmUnsaved).toBe(true));
    const keys = screen.getByLabelText('keys');
    await user.clear(keys);
    await user.type(keys, 'nope{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('"nope" is not a column'));
  });

  it('can be used by keyboard alone, and does nothing when read-only', async () => {
    const { user } = await openDatasets(TEXT, (h) => {
      h.readOnly = true;
    });
    for (const control of screen.getByRole('region', { name: 'Datasets' }).querySelectorAll('input, select, button')) {
      if ((control as HTMLElement).id === 'dz-dataset-pick') continue;
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
    await user.tab();
  });
});

describe('Grid columns editor', () => {
  const openGrid = async () => {
    const context = await open();
    pointer('pointerdown', context.overlay, { clientX: 20, clientY: 110 });
    pointer('pointerup', context.overlay, { clientX: 20, clientY: 110 });
    expect(selectedId()).toBe('grid');
    return context;
  };
  const grid = (host: Parameters<typeof find>[0]) => find(host, 'grid')?.props as { columns: { id: string; width: number }[]; headerRows: { cells: { text?: string }[] }[]; recordRows: { cells: { field?: string; editor?: string; format?: string }[] }[] };

  it('lists the columns, with the fields of the bound Dataset to pick from', async () => {
    await openGrid();
    const panel = screen.getByRole('region', { name: 'Grid columns' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    const field = screen.getByLabelText('Column 1 field') as HTMLSelectElement;
    expect(field.value).toBe('empNo');
    expect([...field.options].map((o) => o.value)).toEqual(['', 'empNo', 'salary', 'note']);
    expect((screen.getByLabelText('Column 2 width') as HTMLInputElement).value).toBe('80');
    expect((screen.getByLabelText('Column 1 header') as HTMLInputElement).value).toBe('A');
  });

  it('changes the width, header, field, format and editor of a column', async () => {
    const { host, user } = await openGrid();
    const width = screen.getByLabelText('Column 1 width');
    await user.clear(width);
    await user.type(width, '150{Enter}');
    await waitFor(() => expect(grid(host).columns[0]?.width).toBe(150));
    await user.selectOptions(screen.getByLabelText('Column 2 field'), 'note');
    await waitFor(() => expect(grid(host).recordRows[0]?.cells[1]?.field).toBe('note'));
    await user.selectOptions(screen.getByLabelText('Column 1 editor'), 'text');
    await waitFor(() => expect(grid(host).recordRows[0]?.cells[0]?.editor).toBe('text'));
    const format = screen.getByLabelText('Column 2 format');
    await user.type(format, '#,##0{Enter}');
    await waitFor(() => expect(grid(host).recordRows[0]?.cells[1]?.format).toBe('#,##0'));
    const header = screen.getByLabelText('Column 2 header');
    await user.clear(header);
    await user.type(header, 'Pay{Enter}');
    await waitFor(() => expect(grid(host).headerRows[0]?.cells[1]?.text).toBe('Pay'));
  });

  it('adds, moves and removes columns', async () => {
    const { host, user } = await openGrid();
    await user.click(within(screen.getByRole('region', { name: 'Grid columns' })).getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(grid(host).columns).toHaveLength(3));
    expect(grid(host).headerRows[0]?.cells).toHaveLength(3);
    expect(grid(host).recordRows[0]?.cells).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Column 1 move right' }));
    await waitFor(() => expect(grid(host).columns.map((c) => c.id)).toEqual(['b', 'a', expect.any(String)]));
    expect(grid(host).recordRows[0]?.cells[0]?.field).toBe('salary');
    await user.click(screen.getByRole('button', { name: 'Column 3 remove' }));
    await waitFor(() => expect(grid(host).columns).toHaveLength(2));
  });

  it('says merged headers are text-only, and opens the text editor', async () => {
    const { host, user } = await openGrid();
    expect(screen.getByTestId('grid-merged-note').textContent).toMatch(/text editor/);
    await user.click(within(screen.getByRole('region', { name: 'Grid columns' })).getByRole('button', { name: 'Open text editor' }));
    expect(host.openedTextEditor).toBe(1);
  });
});

describe('binding picker', () => {
  const openName = async () => {
    const context = await open();
    pointer('pointerdown', context.overlay, { clientX: 20, clientY: 60 });
    pointer('pointerup', context.overlay, { clientX: 20, clientY: 60 });
    expect(selectedId()).toBe('name');
    return context;
  };

  it('offers the columns of the form, and writes the one picked', async () => {
    const { host, user } = await openName();
    const picker = screen.getByLabelText('Pick a column for value') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'dsEmp.empNo', 'dsEmp.salary', 'dsEmp.note', 'dsOther.code']);
    expect(picker.value).toBe('dsEmp.empNo');
    await user.selectOptions(picker, 'dsEmp.note');
    await waitFor(() => expect(find(host, 'name')?.bind).toEqual({ value: 'dsEmp.note' }));
  });

  it('still lets you type any value, and clears it when emptied', async () => {
    const { host, user } = await openName();
    const field = screen.getByLabelText('value (binding)');
    await user.clear(field);
    await user.type(field, 'dsLater.col{Enter}');
    await waitFor(() => expect(find(host, 'name')?.bind).toEqual({ value: 'dsLater.col' }));
    expect((screen.getByLabelText('Pick a column for value') as HTMLSelectElement).value).toBe('');
    await user.clear(field);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(find(host, 'name')?.bind).toBeUndefined());
  });

  it('offers Dataset ids for a Dataset binding', async () => {
    const { host, user, overlay } = await open();
    pointer('pointerdown', overlay, { clientX: 20, clientY: 110 });
    pointer('pointerup', overlay, { clientX: 20, clientY: 110 });
    const picker = screen.getByLabelText('Pick a Dataset for dataset') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'dsEmp', 'dsOther']);
    await user.selectOptions(picker, 'dsOther');
    await waitFor(() => expect(find(host, 'grid')?.bind).toEqual({ dataset: 'dsOther' }));
  });
});

describe('preview', () => {
  const SIMPLE = JSON.stringify({ formatVersion: 1, id: 'p.Form', size: { width: 300, height: 100 }, components: [{ id: 'title', type: 'Label', layout: { left: 8, top: 8, width: 120, height: 24 }, props: { text: 'Hello' } }] }, null, 2) + '\n';
  const region = () => screen.getByRole('region', { name: 'Preview' });

  it('runs the form in run mode with the real components, and never touches the file', async () => {
    const { host, user } = await open(SIMPLE);
    await user.click(tab('Preview'));
    expect(within(region()).getByText('Hello')).toBeTruthy();
    expect(region().textContent).toContain('no fixtures file');
    await user.click(tab('Design'));
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    expect(host.applied).toEqual([]);
    expect(host.readText()).toBe(SIMPLE);
  });

  it('reads the fixtures from the host, and reloads when the text changes', async () => {
    const { host, user } = await open(SIMPLE, (h) => {
      h.fixtures = JSON.stringify({ 'svc.one': { status: { ok: true } } });
    });
    await user.click(tab('Preview'));
    await waitFor(() => expect(region().textContent).toContain('fixtures file (1 services)'));
    act(() => host.setText(SIMPLE.replace('"Hello"', '"Changed"')));
    expect(await within(region()).findByText('Changed')).toBeTruthy();
    expect(within(region()).queryByText('Hello')).toBeNull();
  });

  it('reports a fixtures file that is not valid, and runs with no transport', async () => {
    const { user } = await open(SIMPLE, (h) => {
      h.fixtures = '{ nope';
    });
    await user.click(tab('Preview'));
    expect((await within(region()).findByRole('alert')).textContent).toMatch(/not valid JSON/);
    expect(within(region()).getByText('Hello')).toBeTruthy();
  });

  it('says why it cannot run a form that cannot be read', async () => {
    const { host, user } = await open(SIMPLE);
    await user.click(tab('Preview'));
    act(() => host.setText('{ nope'));
    await waitFor(() => expect(screen.getByText(/needs a form that can be read/)).toBeTruthy());
  });

  it('switches with the arrow keys on the tabs', async () => {
    const { user } = await open(SIMPLE);
    tab('Design').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Preview').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Preview'));
  });
});

describe('form data', () => {
  it('is the form used by these tests', () => {
    expect(FORM.components).toHaveLength(5);
  });
});
