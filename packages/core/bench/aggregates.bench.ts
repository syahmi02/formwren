import { expect, it } from 'vitest';
import { Dataset } from '../src/index.ts';

const ROWS = 100_000;

function makeDataset(): Dataset {
  const rows = Array.from({ length: ROWS }, (_, r) => {
    const hash = Math.imul(r, 2654435761) >>> 0;
    return [`${hash % 100_000}.${String(hash % 100).padStart(2, '0')}`, hash % 1_000_000, `row ${r}`];
  });
  return new Dataset({
    id: 'bench',
    columns: [
      { id: 'amount', type: 'decimal', scale: 2 },
      { id: 'qty', type: 'int' },
      { id: 'name', type: 'string' },
    ],
    initialRows: rows,
  });
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
}

it(`times sum after a single edit on ${ROWS} rows`, () => {
  const ds = makeDataset();
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  const cold = time(() => ds.sum('amount'));
  const repeated = median(Array.from({ length: 21 }, () => time(() => ds.sum('amount'))));
  const afterEdit: number[] = [];
  const editOnly: number[] = [];
  for (let i = 0; i < 21; i++) {
    editOnly.push(time(() => ds.setValue(i * 1000, 'amount', `${i}.5`)));
    afterEdit.push(time(() => ds.sum('amount')));
  }
  const afterOtherColumn = time(() => {
    ds.setValue(5, 'name', 'changed');
    ds.sum('amount');
  });
  const afterMinEdit = time(() => {
    ds.setValue(7, 'amount', '1.25');
    ds.min('amount');
  });
  const exact = ds.sum('amount');
  const results = {
    'sum, first (cold)': `${cold.toFixed(2)} ms`,
    'sum, repeated, no change (median of 21)': `${repeated.toFixed(3)} ms`,
    'one edit alone (median of 21)': `${median(editOnly).toFixed(3)} ms`,
    'sum after one edit (median of 21)': `${median(afterEdit).toFixed(3)} ms`,
    'edit another column, then sum': `${afterOtherColumn.toFixed(3)} ms`,
    'edit, then min (recomputed)': `${afterMinEdit.toFixed(2)} ms`,
  };
  console.table(results);

  // The incremental total must equal a full recomputation.
  const check = makeDataset();
  for (let i = 0; i < 21; i++) check.setValue(i * 1000, 'amount', `${i}.5`);
  check.setValue(7, 'amount', '1.25');
  expect(check.sum('amount')).toBe(exact);
});
