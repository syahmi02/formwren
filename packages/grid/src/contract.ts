/** The shared contract between the Grid's engine, its interaction layer and its host. See docs/plans/step-3.md. */
import type { AnyDataset, ChangeResult, ExpressionScope, GridProps, PlacedCell } from '@fw/core';

/** A cell in the record area. A row id, not a position, so it survives sorting. */
export interface CellRef {
  rowId: number;
  /** Position of the column track in `GridProps.columns`. */
  track: number;
}

export interface GridOptions {
  dataset: AnyDataset;
  definition: GridProps;
  /** Writes through the form model, so text parsing and refusal work as they do for inputs. */
  writeCell(rowId: number, column: string, value: unknown): ChangeResult;
  /** True if the value fits the column. Handlers can still refuse it. */
  acceptsCell(column: string, value: unknown): boolean;
  /** Reads footer expressions. A one-segment aggregate path means the Grid's own Dataset. */
  scope: ExpressionScope;
  /** Finds another Dataset by id, for dropdown editors whose `options` is a Dataset id. */
  resolveDataset?(id: string): AnyDataset | undefined;
  /** Draws sample rows with no interaction, for the designer. */
  design?: boolean;
  readOnly?: boolean;
  /** Grid events, such as `cellChange` or `rowDoubleClick`. */
  fire?(event: string, detail: unknown): void;
  reportError?(error: unknown, where: string): void;
}

export interface GridHandle {
  /** Applies a changed definition with no remount. */
  update(definition: GridProps): void;
  /** Moves focus to the Grid, and to a cell if given. */
  focus(cell?: CellRef): void;
  /** Locks or unlocks editing with no rebuild. Becoming read-only cancels an open draft. */
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}

/** Everything about the record area's shape that the interaction layer needs. */
export interface GridLayout {
  readonly definition: GridProps;
  readonly trackCount: number;
  /** How many leading tracks are frozen. */
  readonly frozenCount: number;
  /** The record row's cells, by track. */
  readonly recordCells: readonly PlacedCell[];
  /** The header cells, placed, for sorting and resizing. */
  readonly headerCells: readonly PlacedCell[];
}

/**
 * What the engine gives the interaction layer. The engine owns all row and cell DOM, scrolling and
 * painting. The interaction layer owns focus, keys, editors, selection and sorting, and never
 * creates or removes row or cell elements.
 */
export interface GridSurface {
  /** The element with `role="grid"`, `tabindex="0"` and `aria-activedescendant`. It keeps focus between edits. */
  readonly root: HTMLElement;
  /** A layer that scrolls with the record area, above it, for editors. Absolutely position children from `cellRect`. */
  readonly overlay: HTMLElement;
  readonly layout: GridLayout;
  /** The element for a record cell, or null if its row isn't rendered. */
  cellElement(cell: CellRef): HTMLElement | null;
  /** The cell's box relative to `overlay`, available even for a row that isn't rendered. */
  cellRect(cell: CellRef): { left: number; top: number; width: number; height: number };
  /** The record cell or header cell an event target is inside. */
  locate(target: EventTarget | null): { cell: CellRef } | { header: PlacedCell } | null;
  /** Scrolls until the cell is fully visible, past frozen tracks too. */
  scrollToCell(cell: CellRef): void;
  /** How many full rows fit in the viewport, for Page Up and Page Down. */
  pageSize(): number;
  /** Marks the active cell, keeps its row rendered, and sets `aria-activedescendant`. */
  setActiveCell(cell: CellRef | null): void;
  /** Runs after rows are rendered or repainted. Returns an unsubscribe function. */
  onRender(listener: () => void): () => void;
  update(definition: GridProps): void;
  /** Sets a track's width in pixels, as a drag on its resize handle does. Never below the minimum width. */
  resizeTrack?(track: number, width: number): void;
  destroy(): void;
}

export interface GridBehavior {
  update(): void;
  focus(cell?: CellRef): void;
  /** Becoming read-only cancels an open draft. */
  setReadOnly(readOnly: boolean): void;
  destroy(): void;
}
