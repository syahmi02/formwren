import { it } from 'vitest';
import { Dataset, type ColumnDef } from '../src/index.ts';

const ROWS = 100_000;
const WORDS = ['alpha', 'bravo', 'Charlie', 'delta', 'Echo', 'foxtrot', 'golf', 'Hotel', 'india', 'Juliet'];

const columns: ColumnDef[] = Array.from({ length: 20 }, (_, c) => {
  if (c % 5 === 0) return { id: `c${c}`, type: 'decimal', scale: 2 };
  if (c % 5 === 1) return { id: `c${c}`, type: 'int' };
  if (c % 5 === 2) return { id: `c${c}`, type: 'date' };
  return { id: `c${c}`, type: 'string' };
});

function makeRow(r: number): unknown[] {
  const hash = Math.imul(r, 2654435761) >>> 0;
  return columns.map((column, c) => {
    const value = (hash >>> (c % 16)) + c;
    if (column.type === 'decimal') return `${value % 100_000}.${String(value % 100).padStart(2, '0')}`;
    if (column.type === 'int') return value % 1_000_000;
    if (column.type === 'date') return `20${String(value % 30).padStart(2, '0')}-${String((value % 12) + 1).padStart(2, '0')}-${String((value % 28) + 1).padStart(2, '0')}`;
    return `${WORDS[value % WORDS.length]} ${value % 1000}`;
  });
}

function time(label: string, run: () => void, results: Record<string, string>): void {
  const start = performance.now();
  run();
  results[label] = `${(performance.now() - start).toFixed(1)} ms`;
}

it(`times Dataset operations on ${ROWS} rows x ${columns.length} columns`, () => {
  const results: Record<string, string> = {};
  const rows = Array.from({ length: ROWS }, (_, r) => makeRow(r));
  const ds = new Dataset({ id: 'bench', columns });

  time('load', () => ds.load(rows), results);
  time('sort by text', () => ds.sort([{ column: 'c3' }]), results);
  time('sort by decimal', () => ds.sort([{ column: 'c0' }]), results);
  time('sort by date, then text', () => ds.sort([{ column: 'c2' }, { column: 'c3', descending: true }]), results);
  time('filter', () => ds.setFilter((get) => (get('c1') as number) % 2 === 0), results);
  ds.setFilter(null);
  time('sum decimals', () => ds.sum('c0'), results);
  time('1,000 cell edits', () => {
    for (let i = 0; i < 1000; i++) ds.setValue(i * 50, 'c3', `edited ${i}`);
  }, results);
  time('extract changes', () => ds.getChanges(), results);
  time('accept save', () => ds.acceptSave(ds.beginSave()), results);

  console.table(results);
  const used = process.memoryUsage();
  console.log(`Heap used with rows held twice (input and Dataset): ${(used.heapUsed / 1024 / 1024).toFixed(0)} MB`);
});
