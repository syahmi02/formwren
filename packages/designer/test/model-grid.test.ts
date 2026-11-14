import { placeGridCells, type GridProps } from '@fw/core';
import { validateForm } from '@fw/format';
import { componentMetas } from '@fw/components/meta';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/index.ts';
import { SAMPLE_B } from './model-sample-b.ts';
import { setup } from './model-util.ts';

const errors = (model: ReturnType<typeof setup>['model']) => validateForm(model.definition.value, { components: componentMetas }).filter((d) => d.severity === 'error');

function gridOf(model: ReturnType<typeof setup>['model']): GridProps {
  return model.find('grid')!.props as unknown as GridProps;
}

/** Every section places without error, and the shape of each record cell list matches the tracks. */
function expectPlaceable(model: ReturnType<typeof setup>['model']): void {
  const grid = gridOf(model);
  for (const rows of [grid.headerRows, grid.recordRows, grid.footerRows]) {
    if (rows) expect(placeGridCells(rows, grid.columns.length).errors).toEqual([]);
  }
  expect(errors(model)).toEqual([]);
}

const ids = (grid: GridProps) => grid.columns.map((t) => t.id);
const fields = (grid: GridProps) => grid.recordRows[0]!.cells.map((c) => c.field);
const headers = (grid: GridProps) => grid.headerRows![0]!.cells.map((c) => c.text);

describe('gridAddColumn', () => {
  it('adds a track, a record cell with the field, and a header text cell', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { result } = await run(commands.gridAddColumn('grid', { field: 'name', id: 'name2', width: 90 }));
    expect(result).toEqual({ status: 'applied' });
    const grid = gridOf(model);
    expect(ids(grid)).toEqual(['empNo', 'name', 'salary', 'name2']);
    expect(grid.columns[3]).toEqual({ id: 'name2', width: 90 });
    expect(fields(grid)).toEqual(['empNo', 'name', 'salary', 'name']);
    expect(headers(grid)).toEqual(['No', 'Name', 'Salary', 'name']);
    // The footer's merged "Total" cell is left alone and the footer gets an empty cell.
    expect(grid.footerRows![0]!.cells.length).toBe(3);
    expectPlaceable(model);
  });

  it('defaults the id and header from the field, and the width to 120', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.gridAddColumn('grid', { field: 'empNo', id: 'extra' }));
    await run(commands.gridAddColumn('grid', { header: 'Hello' }));
    const grid = gridOf(model);
    expect(ids(grid).slice(3)).toEqual(['extra', 'column5']);
    expect(grid.columns[4]!.width).toBe(120);
    expect(headers(grid).slice(3)).toEqual(['empNo', 'Hello']);
    expect(grid.recordRows[0]!.cells[4]).toEqual({});
  });

  it('inserts in the middle, extending a merged footer cell that spans the place', async () => {
    const { run, model } = setup(SAMPLE_B);
    // Footer: "Total" spans tracks 0 and 1. Inserting at 1 lands inside it.
    await run(commands.gridAddColumn('grid', { field: 'name', id: 'middle' }, 1));
    const grid = gridOf(model);
    expect(ids(grid)).toEqual(['empNo', 'middle', 'name', 'salary']);
    expect(fields(grid)).toEqual(['empNo', 'name', 'name', 'salary']);
    expect(grid.footerRows![0]!.cells[0]!.colSpan).toBe(3);
    expect(grid.footerRows![0]!.cells.length).toBe(2);
    expectPlaceable(model);
  });

  it('inserts at the start', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.gridAddColumn('grid', { id: 'first' }, 0));
    const grid = gridOf(model);
    expect(ids(grid)).toEqual(['first', 'empNo', 'name', 'salary']);
    expect(headers(grid)[0]).toBe('first');
    expect(grid.footerRows![0]!.cells[0]).toEqual({});
    expectPlaceable(model);
  });

  it('writes one added cell per section as small edits', async () => {
    const { run } = setup(SAMPLE_B);
    const { diff } = await run(commands.gridAddColumn('grid', { field: 'name', id: 'name2' }));
    expect(diff.added.join('\n')).toContain('"name2"');
    expect(diff.removed.length).toBeLessThanOrEqual(5);
  });

  it('refuses a duplicate track id, a bad width, an unknown editor, and a Grid that is not one', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.gridAddColumn('grid', { id: 'name' }))).toMatch(/already has a column/);
    expect(await refused(commands.gridAddColumn('grid', { id: 'x', width: 0 }))).toMatch(/width/);
    expect(await refused(commands.gridAddColumn('grid', { id: 'x', editor: 'slider' as never }))).toMatch(/editor/);
    expect(await refused(commands.gridAddColumn('plain', { id: 'x' }))).toMatch(/not a Grid/);
    expect(await refused(commands.gridAddColumn('nope', { id: 'x' }))).toMatch(/no component/);
  });

  it('refuses a field that is not a column of the Grid\'s Dataset, so the Grid stays valid', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.gridAddColumn('grid', { id: 'x', field: 'missing' }))).toMatch(/break the Grid.*no column "missing"/);
  });

  it('refuses a column inside a merged record cell', async () => {
    const merged = SAMPLE_B.replace('{ "field": "name", "editor": "text" },\n              { "field": "salary", "format": "#,##0.00" }', '{ "field": "name", "colSpan": 2 }');
    const { refused } = setup(merged);
    expect(await refused(commands.gridAddColumn('grid', { id: 'x' }, 2))).toMatch(/merged record cell/);
  });
});

describe('gridRemoveColumn', () => {
  it('removes the track, the record cell, the header cell and shrinks a merged footer cell', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.gridRemoveColumn('grid', 'name'));
    const grid = gridOf(model);
    expect(ids(grid)).toEqual(['empNo', 'salary']);
    expect(fields(grid)).toEqual(['empNo', 'salary']);
    expect(headers(grid)).toEqual(['No', 'Salary']);
    // "Total" spanned 2 columns, now 1, so it has no colSpan.
    expect(grid.footerRows![0]!.cells[0]).toEqual({ text: 'Total' });
    expectPlaceable(model);
  });

  it('removes the last column of a merged footer cell, and the first column', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.gridRemoveColumn('grid', 'empNo'));
    expect(ids(gridOf(model))).toEqual(['name', 'salary']);
    expectPlaceable(model);
    await run(commands.gridRemoveColumn('grid', 'salary'));
    expect(ids(gridOf(model))).toEqual(['name']);
    expectPlaceable(model);
  });

  it('refuses a merged record cell, and the last column', async () => {
    const merged = SAMPLE_B.replace('{ "field": "name", "editor": "text" },\n              { "field": "salary", "format": "#,##0.00" }', '{ "field": "name", "colSpan": 2 }');
    const { refused } = setup(merged);
    expect(await refused(commands.gridRemoveColumn('grid', 'salary'))).toMatch(/merged record cell/);
    const single = setup(SAMPLE_B);
    await single.run(commands.gridRemoveColumn('grid', 'name'));
    await single.run(commands.gridRemoveColumn('grid', 'salary'));
    expect(await single.refused(commands.gridRemoveColumn('grid', 'empNo'))).toMatch(/at least one column/);
  });

  it('refuses an unknown column', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.gridRemoveColumn('grid', 'nope'))).toMatch(/no column "nope"/);
  });

  it('handles a header cell that spans rows', async () => {
    const tall = SAMPLE_B.replace(
      '"headerRows": [{ "cells": [{ "text": "No" }, { "text": "Name" }, { "text": "Salary" }] }]',
      '"headerRows": [{ "cells": [{ "text": "No", "rowSpan": 2 }, { "text": "Person", "colSpan": 2 }] }, { "cells": [{ "text": "Name" }, { "text": "Salary" }] }]',
    );
    const { run, model } = setup(tall);
    expectPlaceable(model);
    await run(commands.gridRemoveColumn('grid', 'empNo'));
    expect(gridOf(model).headerRows![0]!.cells).toEqual([{ text: 'Person', colSpan: 2 }]);
    expectPlaceable(model);
    await run(commands.gridAddColumn('grid', { id: 'again' }, 0));
    expectPlaceable(model);
    expect(gridOf(model).headerRows!.length).toBe(2);
  });
});

describe('gridSetColumn', () => {
  it('sets the width, one line changed', async () => {
    const { run, model } = setup(SAMPLE_B);
    const { diff } = await run(commands.gridSetColumn('grid', 'name', { width: 200 }));
    expect(diff.removed).toEqual(['          { "id": "name", "width": 160 },']);
    expect(diff.added).toEqual(['          { "id": "name", "width": 200 },']);
    expect(gridOf(model).columns[1]!.width).toBe(200);
  });

  it('sets and removes field, format and editor on the record cell', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.gridSetColumn('grid', 'empNo', { format: '000', editor: 'number' }));
    expect(gridOf(model).recordRows[0]!.cells[0]).toEqual({ field: 'empNo', format: '000', editor: 'number' });
    await run(commands.gridSetColumn('grid', 'salary', { format: undefined }));
    expect(gridOf(model).recordRows[0]!.cells[2]).toEqual({ field: 'salary' });
    await run(commands.gridSetColumn('grid', 'empNo', { field: 'name' }));
    expect(fields(gridOf(model))[0]).toBe('name');
    expectPlaceable(model);
  });

  it('refuses a width of 0, an unknown editor, and a field that is not a column', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.gridSetColumn('grid', 'name', { width: 0 }))).toMatch(/width/);
    expect(await refused(commands.gridSetColumn('grid', 'name', { editor: 'slider' as never }))).toMatch(/editor/);
    expect(await refused(commands.gridSetColumn('grid', 'name', { field: 'missing' }))).toMatch(/break the Grid/);
    expect(await refused(commands.gridSetColumn('grid', 'zzz', { width: 5 }))).toMatch(/no column/);
  });

  it('writes nothing when nothing changes', async () => {
    const { model, host } = setup(SAMPLE_B);
    expect((await model.apply(commands.gridSetColumn('grid', 'name', { width: 160 }))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });
});

describe('gridMoveColumn', () => {
  it('moves a column right and left, with its cells in every row', async () => {
    const { run, model } = setup(SAMPLE_B.replace('{ "text": "Total", "colSpan": 2 }, { "value": "=sum(salary)" }', '{ "text": "A" }, { "text": "B" }, { "value": "=sum(salary)" }'));
    await run(commands.gridMoveColumn('grid', 'empNo', 'right'));
    let grid = gridOf(model);
    expect(ids(grid)).toEqual(['name', 'empNo', 'salary']);
    expect(fields(grid)).toEqual(['name', 'empNo', 'salary']);
    expect(headers(grid)).toEqual(['Name', 'No', 'Salary']);
    expect(grid.footerRows![0]!.cells.map((c) => c.text)).toEqual(['B', 'A', undefined]);
    await run(commands.gridMoveColumn('grid', 'salary', 0));
    grid = gridOf(model);
    expect(ids(grid)).toEqual(['salary', 'name', 'empNo']);
    expect(headers(grid)).toEqual(['Salary', 'Name', 'No']);
    await run(commands.gridMoveColumn('grid', 'salary', 'left'));
    expect(ids(gridOf(model))).toEqual(['salary', 'name', 'empNo']);
    expectPlaceable(model);
  });

  it('writes nothing at the edge', async () => {
    const { model, host } = setup(SAMPLE_B);
    expect((await model.apply(commands.gridMoveColumn('grid', 'empNo', 'left'))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('refuses when a merged cell touches the columns involved', async () => {
    const { refused } = setup(SAMPLE_B);
    // The footer's "Total" spans the first two columns.
    expect(await refused(commands.gridMoveColumn('grid', 'empNo', 'right'))).toMatch(/merged cell/);
  });

  it('refuses a move that crosses the merged cell from the other side too', async () => {
    const { refused } = setup(SAMPLE_B);
    // salary and name swap places, but the footer's merged cell covers name.
    expect(await refused(commands.gridMoveColumn('grid', 'salary', 'left'))).toMatch(/merged cell/);
  });

  it('leaves a Grid with a frozen first column valid, or refuses', async () => {
    const frozen = SAMPLE_B.replace('{ "id": "empNo", "width": 80 }', '{ "id": "empNo", "width": 80, "frozen": "left" }').replace('{ "text": "Total", "colSpan": 2 }, { "value": "=sum(salary)" }', '{ "text": "A" }, { "text": "B" }, { "value": "=sum(salary)" }');
    const { run, refused, model } = setup(frozen);
    // Moving the frozen column behind an unfrozen one breaks "frozen columns come first".
    expect(await refused(commands.gridMoveColumn('grid', 'empNo', 'right'))).toMatch(/Frozen columns must come first/);
    await run(commands.gridMoveColumn('grid', 'salary', 'left'));
    expectPlaceable(model);
  });
});

describe('Grid column commands and read-only', () => {
  it('write nothing when read-only', async () => {
    const { model, host } = setup(SAMPLE_B);
    host.readOnly = true;
    expect((await model.apply(commands.gridRemoveColumn('grid', 'name'))).status).toBe('read-only');
    expect(host.calls).toEqual([]);
  });
});
