/** Commands that edit a Grid's columns (FR-075): its tracks, and the header, record and footer cells under them. */
import { placeGridCells, type ComponentDefinition, type FormDefinition, type GridCellDefinition, type GridProps, type GridRowDefinition, type GridTrackDefinition } from '@fw/core';
import { validateForm } from '@fw/format';
import { CommandError, findComponent, mapComponent, requireId, type Command } from './command-base.ts';

type Section = 'headerRows' | 'recordRows' | 'footerRows';
const SECTIONS: readonly Section[] = ['headerRows', 'recordRows', 'footerRows'];
const EDITORS = ['text', 'number', 'dropdown', 'date', 'checkbox'] as const;

export interface GridColumnOptions {
  /** The track id. Defaults to the field, or `columnN`. */
  id?: string;
  width?: number;
  /** The Dataset column the record cell shows. */
  field?: string;
  format?: string;
  editor?: (typeof EDITORS)[number];
  /** Header text. Defaults to the field or id. Only used when the Grid has exactly one simple header row. */
  header?: string;
}

export interface GridColumnAttributes {
  width?: number;
  /** `undefined` removes the field. */
  field?: string | undefined;
  format?: string | undefined;
  editor?: (typeof EDITORS)[number] | undefined;
}

function gridOf(form: FormDefinition, id: string): { component: ComponentDefinition; props: GridProps; path: string } {
  const found = findComponent(form, id);
  if (!found) throw new CommandError(`There is no component "${id}"`);
  if (found.component.type !== 'Grid') throw new CommandError(`"${id}" is a ${found.component.type}, not a Grid`);
  const props = found.component.props as Partial<GridProps> | undefined;
  if (!props || !Array.isArray(props.columns) || !Array.isArray(props.recordRows)) throw new CommandError(`The Grid "${id}" has no columns or record row to edit`);
  return { component: found.component, props: props as GridProps, path: found.path };
}

/** Errors under a component's path, as text, so a change can be checked for new ones. */
function errorsUnder(form: FormDefinition, path: string): Set<string> {
  return new Set(
    validateForm(form)
      .filter((d) => d.severity === 'error' && d.path.startsWith(`${path}.`))
      .map((d) => `${d.path}: ${d.message}`),
  );
}

/** Puts new props on the Grid, and refuses the result if it has an error the Grid didn't have before. */
function commit(form: FormDefinition, gridId: string, props: GridProps): FormDefinition {
  const { path } = gridOf(form, gridId);
  const next = mapComponent(form, gridId, (component) => ({ ...component, props: props as unknown as Record<string, unknown> }));
  const before = errorsUnder(form, path);
  const created = [...errorsUnder(next, path)].filter((error) => !before.has(error));
  if (created.length > 0) throw new CommandError(`That would break the Grid: ${created.join('; ')}`);
  return next;
}

function trackIndex(props: GridProps, trackId: string): number {
  const index = props.columns.findIndex((track) => track.id === trackId);
  if (index < 0) throw new CommandError(`The Grid has no column "${trackId}"`);
  return index;
}

/** Placement of a section, refused if it isn't valid to begin with. */
function placed(props: GridProps, section: Section, trackCount: number): ReturnType<typeof placeGridCells> {
  const rows = props[section] ?? [];
  const placement = placeGridCells(rows, trackCount);
  if (placement.errors.length > 0) throw new CommandError(`The Grid's ${section} are not valid, so its columns can't be edited: ${placement.errors[0]}`);
  return placement;
}

function withSection(props: GridProps, section: Section, rows: GridRowDefinition[]): GridProps {
  return { ...props, [section]: rows };
}

function recordCell(props: GridProps, index: number): GridCellDefinition {
  const cell = placed(props, 'recordRows', props.columns.length).cells.find((p) => p.row === 0 && p.column === index);
  if (!cell) throw new CommandError(`Column ${index + 1} has no record cell`);
  return cell.cell;
}

function cleaned(cell: GridCellDefinition): GridCellDefinition {
  const copy = { ...cell };
  if (copy.colSpan === 1) delete copy.colSpan;
  if (copy.rowSpan === 1) delete copy.rowSpan;
  return copy;
}

export const gridCommands = {
  /**
   * Adds a column at `index` (default: the end): a track, a record cell with the field, and a
   * header text cell when the Grid has one simple header row. Other header and footer rows get an
   * empty cell, or the merged cell over that place grows by one.
   */
  gridAddColumn(gridId: string, options: GridColumnOptions = {}, index?: number): Command {
    return {
      label: `Add column to ${gridId}`,
      run(form) {
        const { props } = gridOf(form, gridId);
        const count = props.columns.length;
        const at = index === undefined ? count : Math.min(Math.max(Math.trunc(index), 0), count);
        const id = options.id ?? options.field ?? `column${count + 1}`;
        requireId('column', id);
        if (props.columns.some((track) => track.id === id)) throw new CommandError(`The Grid already has a column "${id}"`);
        const width = options.width ?? 120;
        if (!(width > 0) || !Number.isFinite(width)) throw new CommandError('A column needs a width above 0');
        if (options.editor !== undefined && !EDITORS.includes(options.editor)) throw new CommandError(`"${String(options.editor)}" isn't an editor`);

        let next: GridProps = { ...props, columns: [...props.columns.slice(0, at), { id, width } as GridTrackDefinition, ...props.columns.slice(at)] };
        for (const section of SECTIONS) {
          const rows = props[section];
          if (!rows) continue;
          const placement = placed(props, section, count);
          const crossing = placement.cells.filter((p) => p.column < at && at < p.column + p.colSpan);
          if (section === 'recordRows' && crossing.length > 0) throw new CommandError('A merged record cell spans that place, so a column can\'t go there');
          const covered = new Set<number>();
          for (const p of crossing) for (let r = p.row; r < p.row + p.rowSpan; r++) covered.add(r);
          const simpleHeader = section === 'headerRows' && rows.length === 1 && placement.cells.every((p) => p.rowSpan === 1 && p.colSpan === 1);
          const newRows = rows.map((row, r) => {
            const cells = row.cells.map((cell) => {
              const hit = crossing.find((p) => p.cell === cell);
              return hit ? { ...cell, colSpan: hit.colSpan + 1 } : cell;
            });
            if (covered.has(r)) return { ...row, cells };
            const position = placement.cells.filter((p) => p.row === r && p.column < at).length;
            let fresh: GridCellDefinition = {};
            if (section === 'recordRows') {
              if (options.field !== undefined) fresh.field = options.field;
              if (options.format !== undefined) fresh.format = options.format;
              if (options.editor !== undefined) fresh.editor = options.editor;
            } else if (simpleHeader) {
              fresh = { text: options.header ?? options.field ?? id };
            }
            return { ...row, cells: [...cells.slice(0, position), fresh, ...cells.slice(position)] };
          });
          next = withSection(next, section, newRows);
        }
        return commit(form, gridId, next);
      },
    };
  },

  /**
   * Removes a column: its track and record cell, and the header and footer cells over it (a merged
   * cell over it shrinks by one). Refused if a merged record cell spans it, and for the last column.
   */
  gridRemoveColumn(gridId: string, trackId: string): Command {
    return {
      label: `Remove column ${trackId} from ${gridId}`,
      run(form) {
        const { props } = gridOf(form, gridId);
        const at = trackIndex(props, trackId);
        if (props.columns.length === 1) throw new CommandError('A Grid needs at least one column');
        let next: GridProps = { ...props, columns: props.columns.filter((_track, i) => i !== at) };
        for (const section of SECTIONS) {
          const rows = props[section];
          if (!rows) continue;
          const placement = placed(props, section, props.columns.length);
          const touching = placement.cells.filter((p) => p.column <= at && at < p.column + p.colSpan);
          if (section === 'recordRows' && touching.some((p) => p.colSpan > 1)) throw new CommandError(`A merged record cell spans column "${trackId}", so it can't be removed`);
          const newRows = rows.map((row, r) => ({
            ...row,
            cells: row.cells.flatMap((cell) => {
              const hit = touching.find((p) => p.row === r && p.cell === cell);
              if (!hit) return [cell];
              if (hit.colSpan === 1) return [];
              return [cleaned({ ...cell, colSpan: hit.colSpan - 1 })];
            }),
          }));
          next = withSection(next, section, newRows);
        }
        return commit(form, gridId, next);
      },
    };
  },

  /** Sets a column's width, and its record cell's field, format and editor. `undefined` removes field, format or editor. */
  gridSetColumn(gridId: string, trackId: string, attributes: GridColumnAttributes): Command {
    return {
      label: `Change column ${trackId} of ${gridId}`,
      run(form) {
        const { props } = gridOf(form, gridId);
        const at = trackIndex(props, trackId);
        let next = props;
        if (attributes.width !== undefined) {
          if (!(attributes.width > 0) || !Number.isFinite(attributes.width)) throw new CommandError('A column needs a width above 0');
          next = { ...next, columns: next.columns.map((track, i) => (i === at ? { ...track, width: attributes.width as number } : track)) };
        }
        const wantsCell = 'field' in attributes || 'format' in attributes || 'editor' in attributes;
        if (wantsCell) {
          if (attributes.field !== undefined) requireId('field', attributes.field);
          if (attributes.editor !== undefined && !EDITORS.includes(attributes.editor)) throw new CommandError(`"${String(attributes.editor)}" isn't an editor`);
          const target = recordCell(props, at);
          const edited: GridCellDefinition = { ...target };
          for (const key of ['field', 'format', 'editor'] as const) {
            if (!(key in attributes)) continue;
            const value = attributes[key];
            if (value === undefined) delete edited[key];
            else (edited as Record<string, unknown>)[key] = value;
          }
          next = withSection(next, 'recordRows', (next.recordRows).map((row) => ({ ...row, cells: row.cells.map((cell) => (cell === target ? edited : cell)) })));
        }
        if (next === props) return form;
        return commit(form, gridId, next);
      },
    };
  },

  /**
   * Moves a column to an index, or one place `'left'` or `'right'`. Its cells in every row move with
   * it. Refused if a merged cell touches the columns in between.
   */
  gridMoveColumn(gridId: string, trackId: string, to: number | 'left' | 'right'): Command {
    return {
      label: `Move column ${trackId} of ${gridId}`,
      run(form) {
        const { props } = gridOf(form, gridId);
        const from = trackIndex(props, trackId);
        const target = to === 'left' ? from - 1 : to === 'right' ? from + 1 : Math.trunc(to);
        const dest = Math.min(Math.max(target, 0), props.columns.length - 1);
        if (dest === from) return form;
        const lo = Math.min(from, dest);
        const hi = Math.max(from, dest);
        const reorder = <T>(list: readonly T[], offset: number): T[] => {
          const block = list.slice(lo - offset, hi - offset + 1);
          const moved = block.splice(from - lo, 1);
          block.splice(dest - lo, 0, ...moved);
          return [...list.slice(0, lo - offset), ...block, ...list.slice(hi - offset + 1)];
        };
        let next: GridProps = { ...props, columns: reorder(props.columns, 0) };
        for (const section of SECTIONS) {
          const rows = props[section];
          if (!rows) continue;
          const placement = placed(props, section, props.columns.length);
          const inRange = placement.cells.filter((p) => p.column <= hi && p.column + p.colSpan - 1 >= lo);
          if (inRange.some((p) => p.colSpan > 1 || p.rowSpan > 1)) throw new CommandError('A merged cell touches those columns, so the column can\'t be moved');
          const newRows = rows.map((row, r) => {
            const before = placement.cells.filter((p) => p.row === r && p.column < lo).length;
            return { ...row, cells: reorder(row.cells, lo - before) };
          });
          next = withSection(next, section, newRows);
        }
        return commit(form, gridId, next);
      },
    };
  },
} as const;
