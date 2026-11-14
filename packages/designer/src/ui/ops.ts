/**
 * The stage B edits the panels ask for, as model commands. Most are the model's own commands. A few
 * need the form to choose an id or an index, so they are small wrappers that do that when they run.
 * A few the model has no command for (Dataset keys and confirmUnsaved, a Grid column's header text)
 * are done here, in the same `Command` shape.
 */
import type { ColumnDefinition, ComponentMeta, FormDefinition, GridCellDefinition, GridProps } from '@fw/core';
import { placeGridCells } from '@fw/core';
import type { ComponentBox } from '../contract.ts';
import { CommandError, commands, findComponent, type ColumnAttributes, type Command, type GridColumnAttributes } from '../model/index.ts';

type Metas = Readonly<Record<string, ComponentMeta>>;

// ---------------------------------------------------------------------------------------------
// Components

export type FormSize = { width: number; height: number } | undefined;

/** Moves a component. The canvas boxes (with their content boxes) and the form size let the model keep it where it is on screen. */
export function reparent(metas: Metas, boxes: readonly ComponentBox[], formSize: FormSize, id: string, parentId: string | null, index?: number): Command {
  return commands.reparent(id, parentId, index, { metas, boxes, ...(formSize ? { formSize } : {}) });
}

const siblingsOf = (form: FormDefinition, parentId: string | null) => (parentId === null ? form.components : (findComponent(form, parentId)?.component.children ?? []));

/** Moves a component one place up (-1) or down (+1) among its siblings. */
export function reorder(id: string, delta: -1 | 1): Command {
  return {
    label: `Reorder ${id}`,
    run(form) {
      const found = findComponent(form, id);
      if (!found) throw new CommandError(`There is no component "${id}"`);
      const list = siblingsOf(form, found.ancestors.at(-1) ?? null);
      const at = list.findIndex((c) => c.id === id);
      const to = at + delta;
      if (to < 0 || to >= list.length) return form;
      return commands.reorder(id, to).run(form);
    },
  };
}

/** Moves a component into the container just above it among its siblings. */
export function moveInto(metas: Metas, boxes: readonly ComponentBox[], formSize: FormSize, id: string): Command {
  return {
    label: `Move ${id} into the one above`,
    run(form) {
      const found = findComponent(form, id);
      if (!found) throw new CommandError(`There is no component "${id}"`);
      const list = siblingsOf(form, found.ancestors.at(-1) ?? null);
      const before = list[list.findIndex((c) => c.id === id) - 1];
      if (!before || !metas[before.type]?.container) throw new CommandError('The component above is not a container, so there is nothing to move into');
      return reparent(metas, boxes, formSize, id, before.id).run(form);
    },
  };
}

/** Moves a component out of its container, to just after it. */
export function moveOut(metas: Metas, boxes: readonly ComponentBox[], formSize: FormSize, id: string): Command {
  return {
    label: `Move ${id} out`,
    run(form) {
      const found = findComponent(form, id);
      if (!found) throw new CommandError(`There is no component "${id}"`);
      const parentId = found.ancestors.at(-1);
      if (!parentId) throw new CommandError('The component is already at the top level');
      const grand = findComponent(form, parentId)?.ancestors.at(-1) ?? null;
      const at = siblingsOf(form, grand).findIndex((c) => c.id === parentId);
      return reparent(metas, boxes, formSize, id, grand, at + 1).run(form);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Datasets

/** Adds a Dataset with a free id and one string column. */
export function addDataset(): Command {
  return {
    label: 'Add Dataset',
    run(form) {
      const taken = new Set((form.datasets ?? []).map((d) => d.id));
      let n = 1;
      while (taken.has(`ds${n}`)) n++;
      return commands.addDataset(`ds${n}`, [{ id: 'col1', type: 'string' }]).run(form);
    },
  };
}

export const removeDataset = (metas: Metas, id: string): Command => commands.removeDataset(id, metas);
export const renameDataset = (metas: Metas, id: string, newId: string): Command => commands.renameDataset(id, newId, metas);

export interface DatasetOptions {
  /** An empty list removes the keys. */
  keys?: string[];
  confirmUnsaved?: boolean;
}

/** Sets a Dataset's keys (which must be its columns) and `confirmUnsaved`. */
export function setDatasetOptions(id: string, options: DatasetOptions): Command {
  return {
    label: `Change Dataset ${id}`,
    run(form) {
      const index = (form.datasets ?? []).findIndex((d) => d.id === id);
      const dataset = form.datasets?.[index];
      if (!dataset) throw new CommandError(`There is no Dataset "${id}"`);
      const next = { ...dataset };
      if (options.keys) {
        for (const key of options.keys) if (!dataset.columns.some((c) => c.id === key)) throw new CommandError(`"${key}" is not a column of "${id}"`);
        if (options.keys.length > 0) next.keys = options.keys;
        else delete next.keys;
      }
      if (options.confirmUnsaved !== undefined) {
        if (options.confirmUnsaved) next.confirmUnsaved = true;
        else delete next.confirmUnsaved;
      }
      if (JSON.stringify(next) === JSON.stringify(dataset)) return form;
      return { ...form, datasets: (form.datasets ?? []).map((d, i) => (i === index ? next : d)) };
    },
  };
}

/** Adds a string column with a free id. */
export function addColumn(datasetId: string): Command {
  return {
    label: `Add column to ${datasetId}`,
    run(form) {
      const dataset = form.datasets?.find((d) => d.id === datasetId);
      if (!dataset) throw new CommandError(`There is no Dataset "${datasetId}"`);
      let n = dataset.columns.length + 1;
      while (dataset.columns.some((c) => c.id === `col${n}`)) n++;
      const column: ColumnDefinition = { id: `col${n}`, type: 'string' };
      return commands.addColumn(datasetId, column).run(form);
    },
  };
}

export const removeColumn = (metas: Metas, datasetId: string, columnId: string): Command => commands.removeColumn(datasetId, columnId, metas);
export const renameColumn = (metas: Metas, datasetId: string, columnId: string, newId: string): Command => commands.renameColumn(datasetId, columnId, newId, metas);
export const setColumn = (datasetId: string, columnId: string, attributes: ColumnAttributes): Command => commands.setColumn(datasetId, columnId, attributes);

export function moveColumn(datasetId: string, columnId: string, delta: -1 | 1): Command {
  return {
    label: `Move column ${columnId}`,
    run(form) {
      const at = form.datasets?.find((d) => d.id === datasetId)?.columns.findIndex((c) => c.id === columnId) ?? -1;
      if (at < 0) throw new CommandError(`There is no column "${columnId}" in "${datasetId}"`);
      return commands.moveColumn(datasetId, columnId, at + delta).run(form);
    },
  };
}

export const addSampleRow = (datasetId: string): Command => commands.addSampleRow(datasetId);
export const removeSampleRow = (datasetId: string, index: number): Command => commands.removeSampleRow(datasetId, index);
export const setSampleCell = (datasetId: string, index: number, columnId: string, value: unknown): Command => commands.setSampleCell(datasetId, index, columnId, value);

// ---------------------------------------------------------------------------------------------
// Grid columns

export interface GridColumnView {
  /** Position in `columns`. */
  index: number;
  /** The track id, which the model's Grid commands take. */
  id: string;
  width: number;
  frozen: boolean;
  /** The text of the first header row's cell here, if it has one. */
  header: string;
  field: string;
  format: string;
  editor: string;
  /** The record cell is a built-in kind (row status or selection), with no field. */
  kind: string;
}

/** True if any cell spans rows or columns. */
export function gridHasMergedCells(props: Partial<GridProps> | undefined): boolean {
  const rows = [...(props?.headerRows ?? []), ...(props?.recordRows ?? []), ...(props?.footerRows ?? [])];
  return rows.some((r) => r.cells.some((c) => (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1));
}

function placedAt(rows: GridProps['headerRows'], tracks: number, index: number): GridCellDefinition | undefined {
  if (!rows?.length) return undefined;
  return placeGridCells(rows.slice(0, 1), tracks).cells.find((p) => p.column === index && p.colSpan === 1)?.cell;
}

/** The columns of a Grid as the panel shows them, read from its tracks and the first header and record rows. */
export function gridColumns(props: Partial<GridProps> | undefined): GridColumnView[] {
  const columns = props?.columns ?? [];
  return columns.map((column, index) => {
    const record = placedAt(props?.recordRows, columns.length, index);
    return {
      index,
      id: column.id,
      width: column.width,
      frozen: column.frozen === 'left',
      header: placedAt(props?.headerRows, columns.length, index)?.text ?? '',
      field: record?.field ?? '',
      format: record?.format ?? '',
      editor: record?.editor ?? '',
      kind: record?.kind ?? '',
    };
  });
}

export const setGridColumn = (gridId: string, trackId: string, attributes: GridColumnAttributes): Command => commands.gridSetColumn(gridId, trackId, attributes);
export const addGridColumn = (gridId: string): Command => commands.gridAddColumn(gridId);
export const removeGridColumn = (gridId: string, trackId: string): Command => commands.gridRemoveColumn(gridId, trackId);
export const moveGridColumn = (gridId: string, trackId: string, to: 'left' | 'right'): Command => commands.gridMoveColumn(gridId, trackId, to);

/** Sets the text of a column's cell in the first header row. A column with no cell of its own there (a merged header) is refused. */
export function setGridHeader(gridId: string, trackId: string, text: string): Command {
  return {
    label: `Change header of ${trackId}`,
    run(form) {
      const grid = findComponent(form, gridId)?.component;
      const props = grid?.props as Partial<GridProps> | undefined;
      if (!grid || grid.type !== 'Grid' || !props?.columns) throw new CommandError(`"${gridId}" is not a Grid`);
      const index = props.columns.findIndex((t) => t.id === trackId);
      const row = props.headerRows?.[0];
      const target = index >= 0 && row ? placeGridCells([row], props.columns.length).cells.find((p) => p.column === index && p.colSpan === 1)?.cell : undefined;
      if (!row || !target) throw new CommandError('This column has no header cell of its own, so edit it in the text editor');
      if (target.text === text) return form;
      const headerRows = (props.headerRows ?? []).map((r, i) => (i === 0 ? { ...r, cells: r.cells.map((c) => (c === target ? { ...c, text } : c)) } : r));
      const edited = { ...grid, props: { ...props, headerRows } };
      const swap = (list: FormDefinition['components']): FormDefinition['components'] => list.map((c) => (c.id === gridId ? edited : c.children ? { ...c, children: swap(c.children) } : c));
      return { ...form, components: swap(form.components) };
    },
  };
}
