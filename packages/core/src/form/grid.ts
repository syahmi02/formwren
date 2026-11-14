import type { GridCellDefinition, GridRowDefinition } from './definition.ts';

export interface PlacedCell {
  cell: GridCellDefinition;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
}

export interface GridPlacement {
  cells: PlacedCell[];
  errors: string[];
}

/**
 * Works out where each cell goes, the way an HTML table does: a cell takes the next free column
 * in its row, skipping columns covered by a row span from above.
 */
export function placeGridCells(rows: readonly GridRowDefinition[], trackCount: number): GridPlacement {
  const occupied = rows.map(() => new Array<boolean>(trackCount).fill(false));
  const cells: PlacedCell[] = [];
  const errors: string[] = [];

  rows.forEach((row, r) => {
    const covered = occupied[r] as boolean[];
    let c = 0;
    row.cells.forEach((cell, cellIndex) => {
      while (c < trackCount && covered[c]) c++;
      const rowSpan = cell.rowSpan ?? 1;
      const colSpan = cell.colSpan ?? 1;
      const label = `Row ${r + 1}, cell ${cellIndex + 1}`;
      if (c + colSpan > trackCount) {
        errors.push(`${label} runs past the last column`);
        return;
      }
      if (r + rowSpan > rows.length) {
        errors.push(`${label} spans ${rowSpan} rows, but only ${rows.length - r} are left`);
        return;
      }
      for (let y = r; y < r + rowSpan; y++) {
        for (let x = c; x < c + colSpan; x++) {
          const line = occupied[y] as boolean[];
          if (line[x]) errors.push(`${label} overlaps another cell`);
          line[x] = true;
        }
      }
      cells.push({ cell, row: r, column: c, rowSpan, colSpan });
      c += colSpan;
    });
    const uncovered = covered.filter((isCovered) => !isCovered).length;
    if (uncovered > 0) errors.push(`Row ${r + 1} leaves ${uncovered} of ${trackCount} columns without a cell`);
  });

  return { cells, errors };
}
