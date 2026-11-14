/**
 * The in-page half of the bench. `run.mjs` opens this page in a real browser and calls
 * `window.__bench.run()`. Everything is measured here, so no driver round trips are in the numbers.
 */
import { Dataset, type ColumnDef, type ExpressionScope } from '@fw/core';
import type { GridProps } from '@fw/core';
import { createSurface } from '../src/engine/index.ts';
import type { GridSurface } from '../src/contract.ts';
import '../../components/src/theme/tokens.css';
import '../../components/src/theme/grid.css';

const ROWS = Number(new URLSearchParams(location.search).get('rows') ?? 100_000);

const COLUMNS: ColumnDef[] = [
  { id: 'id', type: 'int' },
  { id: 'name', type: 'string' },
  { id: 'dept', type: 'string' },
  { id: 'title', type: 'string' },
  { id: 'city', type: 'string' },
  { id: 'salary', type: 'decimal', scale: 2 },
  { id: 'bonus', type: 'decimal', scale: 2 },
  { id: 'hired', type: 'date' },
  { id: 'qty', type: 'int' },
  { id: 'price', type: 'float' },
  { id: 'active', type: 'boolean' },
  { id: 'score', type: 'float' },
  { id: 'code', type: 'string' },
  { id: 'region', type: 'string' },
  { id: 'mgr', type: 'int' },
  { id: 'note', type: 'string' },
  { id: 'level', type: 'int' },
  { id: 'rate', type: 'decimal', scale: 4 },
  { id: 'created', type: 'datetime' },
];

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
const DEPTS = ['Sales', 'Finance', 'Engineering', 'Support', 'Legal', 'Ops'];

function makeRows(n: number): unknown[][] {
  const rows: unknown[][] = new Array(n);
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)] as string;
    rows[i] = [
      i + 1,
      `${w} ${WORDS[Math.floor(rnd() * WORDS.length)]} ${i}`,
      DEPTS[Math.floor(rnd() * DEPTS.length)],
      `Title ${Math.floor(rnd() * 50)}`,
      `City ${Math.floor(rnd() * 200)}`,
      (30000 + Math.floor(rnd() * 9000000) / 100).toFixed(2),
      (Math.floor(rnd() * 500000) / 100).toFixed(2),
      `20${String(10 + Math.floor(rnd() * 15)).padStart(2, '0')}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
      Math.floor(rnd() * 10000),
      Math.round(rnd() * 100000) / 100,
      rnd() > 0.5,
      Math.round(rnd() * 1000) / 10,
      `C${Math.floor(rnd() * 99999).toString(36)}`,
      `R${Math.floor(rnd() * 20)}`,
      Math.floor(rnd() * n),
      `${w} note ${Math.floor(rnd() * 1000)}`,
      Math.floor(rnd() * 10),
      (rnd() * 10).toFixed(4),
      `2024-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T10:${String(Math.floor(rnd() * 59)).padStart(2, '0')}:00`,
    ];
  }
  return rows;
}

function definition(): GridProps {
  const fields = COLUMNS.map((c) => c.id);
  const formats: Record<string, string> = { salary: '#,##0.00', bonus: '#,##0.00', price: '#,##0.00', rate: '0.0000', hired: 'yyyy-MM-dd' };
  return {
    columns: [
      { id: 'sel', width: 36, frozen: 'left' },
      { id: 'id', width: 70, frozen: 'left' },
      ...fields.slice(1).map((f) => ({ id: f, width: f === 'name' || f === 'note' ? 180 : 110 })),
    ],
    headerRows: [
      { cells: [{ text: '', rowSpan: 2 }, { text: 'Id', rowSpan: 2 }, { text: 'Person', colSpan: 4 }, { text: 'Pay', colSpan: 2 }, { text: 'Details', colSpan: 12 }] },
      { cells: fields.slice(1).map((f) => ({ text: f })) },
    ],
    recordRows: [
      {
        cells: [{ kind: 'rowSelect' }, ...fields.map((f) => ({ field: f, ...(formats[f] ? { format: formats[f] } : {}) }))],
      },
    ],
    footerRows: [
      {
        cells: [
          { text: 'Total', colSpan: 2 },
          ...fields
            .slice(1)
            .map((f) => (f === 'salary' ? { value: '=sum(salary)', format: '#,##0.00' } : f === 'qty' ? { value: '=sum(qty)' } : f === 'name' ? { value: '=count(id)' } : { text: '' })),
        ],
      },
    ],
  };
}

const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
/** Resolves after the frame that follows this call, and the task after it. */
async function afterPaint(): Promise<void> {
  await frame();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const round = (x: number): number => Math.round(x * 100) / 100;

function stats(values: number[]): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  return { n: values.length, mean: round(mean), p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1] ?? 0) };
}

const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  }).observe({ entryTypes: ['longtask'] });
} catch {
  // Not supported: the longest task is then reported as 0.
}

async function run(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { rows: ROWS, columns: 20 };
  const host = document.getElementById('host') as HTMLElement;

  let t = performance.now();
  const data = makeRows(ROWS);
  out.generateMs = round(performance.now() - t);

  const ds = new Dataset({ id: 'bench', columns: COLUMNS });
  t = performance.now();
  ds.load(data);
  out.datasetLoadMs = round(performance.now() - t);

  const scope: ExpressionScope = {
    read: () => undefined,
    aggregate: (name, path) => (ds as unknown as Record<string, (c?: string) => unknown>)[name]?.(path[0]),
  };

  // First paint: from createSurface to the frame after it is presented.
  longTasks.length = 0;
  t = performance.now();
  const surface: GridSurface = createSurface(host, { dataset: ds, definition: definition(), scope, writeCell: () => true, acceptsCell: () => true });
  out.createSurfaceSyncMs = round(performance.now() - t);
  await afterPaint();
  out.firstPaintMs = round(performance.now() - t);
  out.renderedRows = host.querySelectorAll('.fw-grid__row').length;
  out.domNodes = host.querySelectorAll('*').length;
  out.firstPaintLongestTaskMs = round(Math.max(0, ...longTasks));

  const scroller = host.querySelector('.fw-grid__scroller') as HTMLElement;
  out.rowHeightPx = (host.querySelector('.fw-grid__row') as HTMLElement).offsetHeight;
  out.viewport = { w: scroller.clientWidth, h: scroller.clientHeight };

  async function scrollRun(label: string, steps: number, step: (i: number) => [number, number]): Promise<void> {
    longTasks.length = 0;
    const times: number[] = [];
    const renderMs: number[] = [];
    let scrollAt = 0;
    const onScroll = (): void => {
      scrollAt = performance.now();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true, capture: true });
    const off = surface.onRender(() => renderMs.push(performance.now() - scrollAt));
    let last = await frame();
    for (let i = 0; i < steps; i++) {
      const [top, left] = step(i);
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
      const now = await frame();
      times.push(now - last);
      last = now;
    }
    off();
    scroller.removeEventListener('scroll', onScroll, { capture: true });
    out[label] = {
      frameMs: stats(times),
      framesOver20ms: times.filter((x) => x > 20).length,
      framesOver34ms: times.filter((x) => x > 34).length,
      longestTaskMs: round(Math.max(0, ...longTasks)),
      longTasks: longTasks.length,
      renderFromScrollEventMs: stats(renderMs),
    };
  }

  const maxTop = scroller.scrollHeight - scroller.clientHeight;
  const maxLeft = scroller.scrollWidth - scroller.clientWidth;
  // Wheel-like: 3 rows of motion each frame, with horizontal motion mixed in.
  await scrollRun('scrollSteady', 600, (i) => [i * 84, (i % 200) * (maxLeft / 200)]);
  // A page of rows per frame, so every row on screen is new every frame.
  const page = scroller.clientHeight - 100;
  await scrollRun('scrollPageJumps', 300, (i) => [Math.min(maxTop, 100000 + i * page), 0]);
  // A scrollbar drag across the whole dataset in 120 frames.
  await scrollRun('scrollDragAll', 120, (i) => [(maxTop * i) / 119, 0]);
  scroller.scrollLeft = 0;

  // Moving the active cell the way arrow keys would: setActiveCell, scrollToCell, then the render callbacks.
  {
    const times: number[] = [];
    scroller.scrollTop = 0;
    await afterPaint();
    for (let i = 0; i < Math.min(2000, ROWS); i++) {
      const cell = { rowId: ds.rowIdAt(i), track: 2 + (i % 18) };
      const s = performance.now();
      surface.setActiveCell(cell);
      surface.scrollToCell(cell);
      times.push(performance.now() - s);
      if (i % 50 === 0) await frame();
    }
    await afterPaint();
    out.moveActiveCellMs = stats(times);
    const far = { rowId: ds.rowIdAt(Math.floor(ROWS / 2)), track: 10 };
    const s = performance.now();
    surface.setActiveCell(far);
    surface.scrollToCell(far);
    out.jumpFarMs = round(performance.now() - s);
    out.farCellRendered = surface.cellElement(far) !== null;
    await afterPaint();
  }

  // Edit one cell: the repaint targets one row. 'level' feeds no footer, 'qty' feeds a footer sum over all rows.
  for (const [label, column] of [['editRepaintMs', 'level'], ['editWithFooterSumMs', 'qty']] as const) {
    const times: number[] = [];
    scroller.scrollTop = 0;
    await afterPaint();
    for (let i = 0; i < 100; i++) {
      const s = performance.now();
      ds.setValue(i % 20, column, 20000 + i);
      ds.flushInvalidate();
      await Promise.resolve();
      times.push(performance.now() - s);
    }
    out[label] = stats(times);
    await afterPaint();
  }

  // Sorts: dataset.sort, the repaint, then the frame after.
  async function sortRun(label: string, column: string, descending: boolean): Promise<void> {
    await afterPaint();
    longTasks.length = 0;
    const s0 = performance.now();
    ds.sort([{ column, descending }]);
    const sortMs = performance.now() - s0;
    ds.flushInvalidate();
    await Promise.resolve();
    await Promise.resolve();
    const repaintMs = performance.now() - s0 - sortMs;
    await afterPaint();
    out[label] = {
      datasetSortMs: round(sortMs),
      repaintSyncMs: round(repaintMs),
      totalToPaintMs: round(performance.now() - s0),
      longestTaskMs: round(Math.max(0, ...longTasks)),
    };
  }
  scroller.scrollTop = 0;
  await sortRun('sortInt', 'qty', false);
  await sortRun('sortString', 'name', false);
  await sortRun('sortDecimal', 'salary', true);
  await sortRun('sortDate', 'hired', false);
  await sortRun('sortFloat', 'price', false);
  scroller.scrollTop = maxTop / 2;
  await afterPaint();
  await sortRun('sortStringScrolled', 'dept', false);

  {
    const s = performance.now();
    surface.update(definition());
    await afterPaint();
    out.updateDefinitionMs = round(performance.now() - s);
  }

  {
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const s = performance.now();
      surface.resizeTrack?.(5, 110 + (i % 40));
      void scroller.offsetWidth; // Forces layout, so the cost of the resize is counted.
      times.push(performance.now() - s);
    }
    out.resizeLayoutMs = stats(times);
  }

  out.userAgent = navigator.userAgent;
  surface.destroy();
  return out;
}

/** Checks that what is on screen matches the Dataset at several scroll positions, with no gaps. */
async function verify(): Promise<Record<string, unknown>> {
  const host = document.getElementById('host') as HTMLElement;
  const ds = new Dataset({ id: 'verify', columns: COLUMNS });
  ds.load(makeRows(ROWS));
  const scope: ExpressionScope = { read: () => undefined, aggregate: () => 0 };
  const surface = createSurface(host, { dataset: ds, definition: definition(), scope, writeCell: () => true, acceptsCell: () => true });
  const scroller = host.querySelector('.fw-grid__scroller') as HTMLElement;
  const rowH = 28;
  const headerH = 56;
  const problems: string[] = [];
  const positions = [0, 1, 500, 12345, 1_000_000, ROWS * rowH - 700, ROWS * rowH, 777_777];
  const check = async (label: string): Promise<void> => {
    await frame();
    const top = scroller.scrollTop;
    const viewH = scroller.clientHeight;
    const first = Math.max(0, Math.floor((top - 0) / rowH));
    const last = Math.min(ROWS - 1, Math.floor((top + viewH - headerH - 28) / rowH));
    for (let i = first; i <= last; i++) {
      const el = host.querySelector(`.fw-grid__row[data-index="${i}"]`);
      if (!el) {
        problems.push(`${label}: row ${i} missing at scrollTop ${top}`);
        break;
      }
      const idCell = el.children[1] as HTMLElement;
      if ((idCell.textContent ?? '').replace(/,/g, '') !== String(ds.getValue(i, 'id'))) problems.push(`${label}: row ${i} shows ${idCell.textContent}`);
      const box = el.getBoundingClientRect();
      const expected = scroller.getBoundingClientRect().top + headerH + i * rowH - top;
      if (Math.abs(box.top - expected) > 1) problems.push(`${label}: row ${i} at ${box.top}, expected ${expected}`);
    }
  };
  for (const pos of positions) {
    scroller.scrollTop = pos;
    await check(`scroll ${pos}`);
  }
  ds.sort([{ column: 'name' }]);
  ds.flushInvalidate();
  await frame();
  scroller.scrollTop = 4000;
  await check('after sort');
  // Horizontal: the frozen cells stay at the left edge while the others move.
  scroller.scrollLeft = 600;
  await frame();
  const box = (host.querySelector('.fw-grid__row') as HTMLElement).children[1]?.getBoundingClientRect();
  const gridLeft = scroller.getBoundingClientRect().left;
  const frozenLeft = box ? Math.round(box.left - gridLeft) : null;
  const moving = (host.querySelector('.fw-grid__row') as HTMLElement).children[4]?.getBoundingClientRect();
  const out = { problems, frozenCellLeftAfterHScroll: frozenLeft, scrollingCellLeftAfterHScroll: moving ? Math.round(moving.left - gridLeft) : null, rendered: host.querySelectorAll('.fw-grid__row').length };
  surface.destroy();
  return out;
}

(window as unknown as { __bench: { run: typeof run; verify: typeof verify } }).__bench = { run, verify };
