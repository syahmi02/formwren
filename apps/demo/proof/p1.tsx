/**
 * Proof test P1 (FRAMEWORK.md section 8): a Grid over 100,000 rows x 20 columns, built from a JSON
 * form through createForm, FormView and defaultRegistry. This page exposes `window.p1` for
 * apps/demo/e2e/p1*.spec.ts. Expected values come from the model (the Dataset) and from a shadow
 * copy of every scripted edit that the page keeps itself; they are never read back from the DOM.
 * Decimal totals are worked out with BigInt, independently of the library's decimal code.
 */
import { FormView, defaultRegistry } from '@fw/components';
import '@fw/components/theme.css';
import { createForm, formatValue, type AnyDataset, type CellValue, type ColumnDef, type ColumnType, type FormDefinition, type SortKey } from '@fw/core';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const ROWS = Number(new URLSearchParams(location.search).get('rows') ?? 100_000);
const SCALE = 12;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Col {
  id: string;
  type: ColumnType;
  label: string;
  size?: number;
  precision?: number;
  scale?: number;
  format?: string;
  width: number;
  editor?: 'text' | 'number' | 'date' | 'checkbox' | 'dropdown';
}

/** The 20 data columns, in Dataset order. The Grid's tracks add a status and a checkbox column in front. */
const D = (i: number): Col => ({
  id: `d${i}`,
  type: 'decimal',
  label: `Dec ${i}`,
  precision: 30,
  scale: SCALE,
  format: '#,##0.000000000000',
  width: 230,
  editor: 'number',
});
const COLS: Col[] = [
  { id: 'id', type: 'int', label: 'Id', width: 80 },
  { id: 'name', type: 'string', label: 'Name', size: 60, width: 180, editor: 'text' },
  { id: 'dept', type: 'string', label: 'Dept', size: 20, width: 110, editor: 'text' },
  { id: 'city', type: 'string', label: 'City', size: 30, width: 110, editor: 'text' },
  { id: 'code', type: 'string', label: 'Code', size: 12, width: 90, editor: 'text' },
  { id: 'note', type: 'string', label: 'Note', size: 80, width: 200, editor: 'text' },
  { id: 'hired', type: 'date', label: 'Hired', format: 'yyyy-MM-dd', width: 110, editor: 'date' },
  { id: 'created', type: 'datetime', label: 'Created', format: 'yyyy-MM-dd HH:mm:ss', width: 170 },
  { id: 'active', type: 'boolean', label: 'Active', width: 80, editor: 'checkbox' },
  { id: 'qty', type: 'int', label: 'Qty', format: '#,##0', width: 90, editor: 'number' },
  { id: 'score', type: 'float', label: 'Score', format: '#,##0.0', width: 90, editor: 'number' },
  { id: 'price', type: 'decimal', label: 'Price', precision: 14, scale: 2, format: '#,##0.00', width: 120, editor: 'number' },
  { id: 'rate', type: 'decimal', label: 'Rate', precision: 10, scale: 4, format: '0.0000', width: 100, editor: 'number' },
  D(0),
  D(1),
  D(2),
  D(3),
  D(4),
  D(5),
  D(6),
];
if (COLS.length !== 20) throw new Error(`P1 needs 20 columns, has ${COLS.length}`);
const COL_INDEX = new Map(COLS.map((c, i) => [c.id, i]));
const LONG = COLS.filter((c) => /^d\d$/.test(c.id));

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const DEPTS = ['Sales', 'Finance', 'Engineering', 'Support', 'Legal', 'Ops'];

function digits(rand: () => number, n: number, nonZeroFirst = false): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    const d = Math.floor(rand() * 10);
    s += String(nonZeroFirst && i === 0 && d === 0 ? 1 : d);
  }
  return s;
}
/** Exact decimal text: up to 18 integer digits and exactly 12 places, which a double can't hold. */
function longDecimal(rand: () => number): string {
  return `${rand() < 0.25 ? '-' : ''}${digits(rand, 1 + Math.floor(rand() * 18), true)}.${digits(rand, SCALE)}`;
}
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function makeRow(rand: () => number, i: number): CellValue[] {
  const w = WORDS[Math.floor(rand() * WORDS.length)] as string;
  return [
    i + 1,
    `${w} ${WORDS[Math.floor(rand() * WORDS.length)]} ${i}`,
    DEPTS[Math.floor(rand() * DEPTS.length)] as string,
    `City ${Math.floor(rand() * 300)}`,
    `C${Math.floor(rand() * 99999).toString(36)}`,
    `${w} note ${Math.floor(rand() * 1000)}`,
    `20${pad(10 + Math.floor(rand() * 15), 2)}-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}`,
    `2024-${pad(1 + Math.floor(rand() * 12), 2)}-${pad(1 + Math.floor(rand() * 28), 2)}T${pad(Math.floor(rand() * 24), 2)}:${pad(Math.floor(rand() * 60), 2)}:${pad(Math.floor(rand() * 60), 2)}`,
    rand() > 0.5,
    Math.floor(rand() * 10000),
    Math.round(rand() * 100000) / 10,
    `${Math.floor(rand() * 90_000_000)}.${pad(Math.floor(rand() * 100), 2)}`,
    `${Math.floor(rand() * 99999)}.${pad(Math.floor(rand() * 10000), 4)}`,
    ...LONG.map(() => longDecimal(rand)),
  ];
}

// Tracks: status, select, then the 20 columns. The first four tracks are frozen.
const TRACK_OF = new Map<string, number>(COLS.map((c, i) => [c.id, i + 2]));
const FROZEN = new Set(['id', 'name']);

function buildDefinition(): FormDefinition {
  const col = (id: string): Col => COLS[COL_INDEX.get(id) as number] as Col;
  const tracks = [
    { id: 'status', width: 40, frozen: 'left' as const },
    { id: 'select', width: 40, frozen: 'left' as const },
    ...COLS.map((c) => ({ id: c.id, width: c.width, ...(FROZEN.has(c.id) ? { frozen: 'left' as const } : {}) })),
  ];
  const leaf = (id: string) => ({ text: col(id).label });
  const groups = [
    ['Text', ['dept', 'city', 'code', 'note']],
    ['When', ['hired', 'created', 'active']],
    ['Numbers', ['qty', 'score', 'price', 'rate']],
    ['Long decimals', ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']],
  ] as const;
  const headerRows = [
    {
      cells: [
        { text: '', rowSpan: 2 },
        { text: '', rowSpan: 2 },
        { text: 'Id', rowSpan: 2 },
        { text: 'Name', rowSpan: 2 },
        ...groups.map(([text, ids]) => ({ text, colSpan: ids.length })),
      ],
    },
    { cells: groups.flatMap(([, ids]) => ids.map(leaf)) },
  ];
  const record = {
    cells: [
      { kind: 'rowStatus' },
      { kind: 'rowSelect' },
      ...COLS.map((c) => ({ field: c.id, ...(c.editor ? { editor: c.editor } : {}), ...(c.format ? { format: c.format } : {}) })),
    ],
  };
  const sum = (id: string) => ({ value: `=sum(${id})`, ...(col(id).format ? { format: col(id).format } : {}) });
  const footerTotal = {
    cells: [
      { text: 'Total', colSpan: 3 },
      { value: '=count(id)', format: '#,##0' },
      { text: '', colSpan: 4 },
      { text: '', colSpan: 3 },
      sum('qty'),
      { text: '' },
      sum('price'),
      sum('rate'),
      ...LONG.map((c) => sum(c.id)),
    ],
  };
  const footerAverage = {
    cells: [
      { text: 'Average', colSpan: 3 },
      { text: '' },
      { text: '', colSpan: 4 },
      { text: '', colSpan: 3 },
      { text: '', colSpan: 2 },
      { value: '=avg(price)', format: '#,##0.0000' },
      { text: '' },
      { value: '=avg(d0)', format: '#,##0.00000000000000' },
      { text: '', colSpan: 6 },
    ],
  };
  const columns: ColumnDef[] = COLS.map((c) => ({
    id: c.id,
    type: c.type,
    label: c.label,
    ...(c.size ? { size: c.size } : {}),
    ...(c.precision ? { precision: c.precision } : {}),
    ...(c.scale !== undefined ? { scale: c.scale } : {}),
  }));
  return JSON.parse(
    JSON.stringify({
      formatVersion: 1,
      id: 'proof.P1',
      size: { width: 1260, height: 840 },
      datasets: [{ id: 'dsBig', columns }],
      components: [
        {
          id: 'bigGrid',
          type: 'Grid',
          layout: { left: 0, top: 0, right: 0, bottom: 0 },
          props: { columns: tracks, headerRows, recordRows: [record], footerRows: [footerTotal, footerAverage] },
          bind: { dataset: 'dsBig' },
        },
      ],
    }),
  ) as FormDefinition;
}

// ---- Long tasks and frames, recorded from the start of the page ----
const longTasks: { start: number; duration: number }[] = [];
let longTaskSupported = true;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch {
  longTaskSupported = false;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const task = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
/** The frame after this call has been presented, and the task after it. */
async function afterPaint(): Promise<void> {
  await nextFrame();
  await task();
}
/** Lets batched repaints run: a task, then two frames. */
async function settle(): Promise<void> {
  await yieldToEventLoop();
  await nextFrame();
  await nextFrame();
  await task();
}

let frameTimes: number[] | null = null;
let framePrev = 0;
function frameLoop(now: number): void {
  if (frameTimes) {
    if (framePrev) frameTimes.push(now - framePrev);
    framePrev = now;
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

// ---- Data ----
const timings: Record<string, number> = {};
let t = performance.now();
const rand = mulberry32(20260711);
const rows: CellValue[][] = new Array<CellValue[]>(ROWS);
for (let i = 0; i < ROWS; i++) rows[i] = makeRow(rand, i);
timings.generateMs = performance.now() - t;

const definition = buildDefinition();
const container = document.getElementById('root');
if (!container) throw new Error('p1.html has no #root element');
const root = createRoot(container);

const tStart = performance.now();
const form = createForm(definition);
const maybeDs = form.getDataset('dsBig');
if (!maybeDs) throw new Error('dsBig is missing');
const ds: AnyDataset = maybeDs;
timings.createFormMs = performance.now() - tStart;
t = performance.now();
ds.load(rows);
timings.datasetLoadMs = performance.now() - t;
void form.init();
t = performance.now();
flushSync(() => root.render(<FormView form={form} registry={defaultRegistry} />));
timings.renderCommitMs = performance.now() - t;

/** Shadow copy: row id to the values the test believes it holds. Only scripted edits touch it. */
const shadow = new Map<number, CellValue[]>();
for (let i = 0; i < ds.rowCount; i++) shadow.set(ds.rowIdAt(i), (rows[i] as CellValue[]).slice());

async function waitForRows(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (document.querySelector('.fw-grid__row[data-row-id]')) return;
    await nextFrame();
  }
  throw new Error('The Grid never rendered a row');
}
const ready = (async () => {
  await waitForRows();
  await afterPaint();
  const end = performance.now();
  timings.firstPaintMs = end - tStart;
  timings.firstPaintFromNavigationMs = end;
  const paints = performance.getEntriesByType('paint');
  timings.browserFirstContentfulPaintMs = paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? Number.NaN;
  return timings;
})();

// ---- Exact decimal helpers (BigInt, not the library's code) ----
function scaled(text: string, places: number): bigint {
  const neg = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace(/^[-+]/, '').split('.');
  if (frac.length > places) throw new Error(`"${text}" has more than ${places} places`);
  const v = BigInt(whole + frac.padEnd(places, '0'));
  return neg ? -v : v;
}
/** Text of a scaled integer. Keeps at least `minFraction` places. */
function unscale(v: bigint, places: number, grouping: boolean, minFraction = places): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(places + 1, '0');
  let whole = s.slice(0, s.length - places);
  let frac = s.slice(s.length - places);
  while (frac.length > minFraction && frac.endsWith('0')) frac = frac.slice(0, -1);
  if (grouping) whole = group(whole);
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
/** Display text of a long decimal, worked out independently: group the digits, keep all 12 places. */
function independentDecimalText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  return unscale(scaled(String(value), SCALE), SCALE, true, SCALE);
}

function shadowSum(column: string): bigint {
  const at = COL_INDEX.get(column) as number;
  const scale = COLS[at]?.scale as number;
  let total = 0n;
  for (const row of shadow.values()) {
    const v = row[at];
    if (v !== null && v !== undefined) total += scaled(String(v), scale);
  }
  return total;
}
function shadowCount(column: string): number {
  const at = COL_INDEX.get(column) as number;
  let n = 0;
  for (const row of shadow.values()) if (row[at] !== null && row[at] !== undefined) n++;
  return n;
}
/** Division rounded half away from zero, as the footer's average is specified. */
function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (2n * x + y) / (2n * y);
  return neg ? -q : q;
}

/** Footer text the page should show, by track (+1000 for the second footer row), from the shadow copy. */
function expectedFooter(): Record<number, string> {
  const out: Record<number, string> = {};
  const track = (id: string): number => TRACK_OF.get(id) as number;
  out[track('name')] = group(String(shadowCount('id')));
  let qty = 0;
  const qtyAt = COL_INDEX.get('qty') as number;
  for (const row of shadow.values()) qty += (row[qtyAt] as number | null) ?? 0;
  out[track('qty')] = group(String(qty));
  for (const c of LONG) out[track(c.id)] = unscale(shadowSum(c.id), SCALE, true, SCALE);
  out[track('price')] = unscale(shadowSum('price'), 2, true, 2);
  out[track('rate')] = unscale(shadowSum('rate'), 4, false, 4);
  // Averages: the library gives scale + 2 places, rounded half away from zero; the pattern then shows them all.
  const avg = (column: string, scale: number): string => {
    const n = shadowCount(column);
    return n === 0 ? '' : unscale(divRound(shadowSum(column) * 100n, BigInt(n)), scale + 2, true, scale + 2);
  };
  out[1000 + track('price')] = avg('price', 2);
  out[1000 + track('d0')] = avg('d0', SCALE);
  return out;
}

// ---- Verification of the DOM against the model ----
interface Mismatch {
  where: string;
  expected: string;
  actual: string | null;
}
interface RenderCheck {
  label: string;
  rows: number;
  cells: number;
  first: number;
  last: number;
  mismatches: Mismatch[];
}

function scroller(): HTMLElement {
  return document.querySelector('.fw-grid__scroller') as HTMLElement;
}

/** Compares every rendered record cell with formatValue of the model, and checks the rows cover the viewport. */
function verifyRendered(label: string): RenderCheck {
  const mismatches: Mismatch[] = [];
  const sc = scroller();
  const body = sc.querySelector('.fw-grid__body') as HTMLElement;
  const rowEls = Array.from(body.querySelectorAll<HTMLElement>('.fw-grid__row'));
  const header = sc.querySelector('.fw-grid__header') as HTMLElement;
  const footer = sc.querySelector('.fw-grid__footer') as HTMLElement;
  const rowH = (rowEls[0]?.offsetHeight ?? 28) || 28;
  let cells = 0;
  const seen = new Set<number>();
  for (const el of rowEls) {
    const rowId = Number(el.dataset.rowId);
    const index = ds.indexOfRow(rowId);
    const where = `${label} row ${rowId}`;
    if (index < 0) {
      mismatches.push({ where: `${where} is rendered but not in the Dataset`, expected: 'absent', actual: 'present' });
      continue;
    }
    seen.add(index);
    if (el.dataset.index !== String(index)) mismatches.push({ where: `${where} data-index`, expected: String(index), actual: el.dataset.index ?? null });
    const ty = new DOMMatrix(getComputedStyle(el).transform).m42;
    // Chrome reports transforms with 6 significant digits, so beyond 1M px this is only good to about 5 px; exact placement of visible rows is checked below from their bounding boxes.
    if (Math.abs(ty - index * rowH) > 6) mismatches.push({ where: `${where} transform`, expected: String(index * rowH), actual: String(ty) });
    const status = ds.statusOf(rowId);
    if (el.dataset.status !== status) mismatches.push({ where: `${where} status`, expected: status, actual: el.dataset.status ?? null });
    for (const cell of Array.from(el.children) as HTMLElement[]) {
      const track = Number(cell.dataset.track);
      cells++;
      if (track === 0) {
        const mark = { normal: '', inserted: 'I', updated: 'U', deleted: 'D' }[status];
        if ((cell.textContent ?? '') !== mark) mismatches.push({ where: `${where} status mark`, expected: mark, actual: cell.textContent });
        continue;
      }
      if (track === 1) {
        const want = String(ds.isRowSelected(rowId));
        const got = cell.querySelector('[role=checkbox]')?.getAttribute('aria-checked') ?? null;
        if (got !== want) mismatches.push({ where: `${where} select`, expected: want, actual: got });
        continue;
      }
      const c = COLS[track - 2] as Col;
      const value = ds.getValueById(rowId, c.id);
      const expected = formatValue(value, c.type, c.format);
      const actual = cell.textContent ?? '';
      if (actual !== expected) mismatches.push({ where: `${where} ${c.id}`, expected, actual });
      if (LONG.includes(c)) {
        const independent = independentDecimalText(value);
        if (actual !== independent) mismatches.push({ where: `${where} ${c.id} (independent)`, expected: independent, actual });
      }
    }
  }
  // Coverage: every row that is at least partly visible must be rendered, and sit where it should.
  const headerH = header.offsetHeight;
  const footerH = footer.offsetHeight;
  const scTop = sc.scrollTop;
  const count = ds.rowCount;
  const first = Math.max(0, Math.floor(scTop / rowH));
  const last = Math.min(count - 1, Math.floor((scTop + sc.clientHeight - headerH - footerH - 1) / rowH));
  const box = sc.getBoundingClientRect();
  for (let i = first; i <= last; i++) {
    if (!seen.has(i)) {
      mismatches.push({ where: `${label} row index ${i} is visible but not rendered (scrollTop ${scTop})`, expected: 'rendered', actual: 'missing' });
      break;
    }
  }
  for (const el of rowEls) {
    const index = Number(el.dataset.index);
    if (index < first || index > last) continue;
    const want = box.top + sc.clientTop + headerH + index * rowH - scTop;
    const got = el.getBoundingClientRect().top;
    if (Math.abs(got - want) > 1.5) mismatches.push({ where: `${label} row ${index} position`, expected: String(want), actual: String(got) });
  }
  return { label, rows: rowEls.length, cells, first, last, mismatches };
}

/** The model's values against the shadow copy of every scripted edit, for all live rows. */
function verifyShadow(): { checked: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  let checked = 0;
  if (ds.rowCount !== shadow.size) mismatches.push({ where: 'row count', expected: String(shadow.size), actual: String(ds.rowCount) });
  for (let i = 0; i < ds.rowCount && mismatches.length < 50; i++) {
    const rowId = ds.rowIdAt(i);
    const want = shadow.get(rowId);
    if (!want) {
      mismatches.push({ where: `row ${rowId} is in the Dataset but not in the shadow`, expected: 'absent', actual: 'present' });
      continue;
    }
    COLS.forEach((c, k) => {
      checked++;
      const got = ds.getValueById(rowId, c.id);
      const w = want[k] ?? null;
      const same =
        c.type === 'decimal' && got !== null && w !== null ? scaled(String(got), c.scale as number) === scaled(String(w), c.scale as number) : got === w;
      if (!same) mismatches.push({ where: `row ${rowId} ${c.id}`, expected: String(w), actual: String(got) });
    });
  }
  return { checked, mismatches };
}

function verifyFooter(): { checked: number; mismatches: Mismatch[]; expected: Record<number, string> } {
  const mismatches: Mismatch[] = [];
  const want = expectedFooter();
  const footerRows = Array.from(document.querySelectorAll<HTMLElement>('.fw-grid__footer .fw-grid__sectionrow'));
  let checked = 0;
  footerRows.forEach((row, r) => {
    for (const cell of Array.from(row.children) as HTMLElement[]) {
      const track = Number(cell.getAttribute('aria-colindex')) - 1;
      const expected = want[(r === 1 ? 1000 : 0) + track];
      if (expected === undefined) continue;
      checked++;
      const actual = cell.textContent ?? '';
      if (actual !== expected) mismatches.push({ where: `footer row ${r + 1} track ${track}`, expected, actual });
    }
  });
  return { checked, mismatches, expected: want };
}

/** Scrolls to each position, lets the Grid settle, and verifies. Positions are [top, left]. */
async function verifyAt(positions: [number, number][]): Promise<RenderCheck[]> {
  const sc = scroller();
  const out: RenderCheck[] = [];
  for (const [top, left] of positions) {
    sc.scrollTop = top;
    sc.scrollLeft = left;
    await settle();
    out.push(verifyRendered(`scroll ${Math.round(sc.scrollTop)},${Math.round(sc.scrollLeft)}`));
  }
  return out;
}

// ---- Scripted edits ----
function editValue(c: Col, r: () => number): CellValue {
  switch (c.type) {
    case 'string':
      return `${WORDS[Math.floor(r() * WORDS.length)]} ${Math.floor(r() * 100000)}`;
    case 'int':
      return Math.floor(r() * 100000);
    case 'float':
      return Math.round(r() * 100000) / 10;
    case 'boolean':
      return r() < 0.5;
    case 'date':
      return `20${pad(10 + Math.floor(r() * 15), 2)}-${pad(1 + Math.floor(r() * 12), 2)}-${pad(1 + Math.floor(r() * 28), 2)}`;
    case 'datetime':
      return `2025-${pad(1 + Math.floor(r() * 12), 2)}-${pad(1 + Math.floor(r() * 28), 2)}T${pad(Math.floor(r() * 24), 2)}:00:00`;
    case 'decimal':
      if (c.id === 'price') return `${Math.floor(r() * 9_000_000)}.${pad(Math.floor(r() * 100), 2)}`;
      if (c.id === 'rate') return `${Math.floor(r() * 99999)}.${pad(Math.floor(r() * 10000), 4)}`;
      return longDecimal(r);
  }
}

interface ScriptResult {
  ops: number;
  counts: Record<string, number>;
  checkpoints: { after: number; renderedRows: number; cells: number; renderedMismatches: number; shadowMismatches: number; footerMismatches: number; sample: Mismatch[] }[];
  totalMs: number;
}

/** Scripted operations that mix every kind of edit, with full checks along the way. */
async function runScript(count: number, seed: number, checkEvery: number): Promise<ScriptResult> {
  const r = mulberry32(seed);
  const sc = scroller();
  const counts: Record<string, number> = { setVisible: 0, setOffscreen: 0, setNull: 0, insert: 0, remove: 0, setCurrent: 0, sort: 0, scroll: 0 };
  const checkpoints: ScriptResult['checkpoints'] = [];
  const rowH = 28;
  const start = performance.now();
  const editable = COLS.filter((c) => c.id !== 'id');
  const pickCol = (): Col => editable[Math.floor(r() * editable.length)] as Col;
  const visibleRange = (): [number, number] => {
    const first = Math.max(0, Math.min(ds.rowCount - 1, Math.floor(sc.scrollTop / rowH)));
    return [first, Math.max(first, Math.min(ds.rowCount - 1, first + Math.floor(sc.clientHeight / rowH) - 3))];
  };
  const doSet = (index: number, c: Col, value: CellValue): void => {
    const rowId = ds.rowIdAt(index);
    ds.setValue(index, c.id, value);
    (shadow.get(rowId) as CellValue[])[COL_INDEX.get(c.id) as number] = value;
  };
  for (let i = 1; i <= count; i++) {
    const roll = r();
    if (roll < 0.28) {
      counts.setVisible = (counts.setVisible ?? 0) + 1;
      const [a, b] = visibleRange();
      const c = pickCol();
      doSet(a + Math.floor(r() * (b - a + 1)), c, editValue(c, r));
    } else if (roll < 0.5) {
      counts.setOffscreen = (counts.setOffscreen ?? 0) + 1;
      const c = pickCol();
      doSet(Math.floor(r() * ds.rowCount), c, editValue(c, r));
    } else if (roll < 0.56) {
      counts.setNull = (counts.setNull ?? 0) + 1;
      doSet(Math.floor(r() * ds.rowCount), LONG[Math.floor(r() * LONG.length)] as Col, null);
    } else if (roll < 0.64) {
      counts.insert = (counts.insert ?? 0) + 1;
      const values = makeRow(r, 1_000_000 + i);
      const obj: Record<string, CellValue> = {};
      COLS.forEach((c, k) => (obj[c.id] = values[k] as CellValue));
      const rowId = ds.insertRow(Math.floor(r() * (ds.rowCount + 1)), obj);
      shadow.set(rowId, values);
    } else if (roll < 0.7) {
      counts.remove = (counts.remove ?? 0) + 1;
      const index = Math.floor(r() * ds.rowCount);
      const rowId = ds.rowIdAt(index);
      ds.deleteRows([index]);
      shadow.delete(rowId);
    } else if (roll < 0.8) {
      counts.setCurrent = (counts.setCurrent ?? 0) + 1;
      ds.setCurrentIndex(Math.floor(r() * ds.rowCount));
    } else if (roll < 0.85) {
      counts.sort = (counts.sort ?? 0) + 1;
      const column = COLS[Math.floor(r() * COLS.length)]?.id as string;
      const keys: SortKey[] = r() < 0.15 ? [] : [{ column, descending: r() < 0.5 }];
      ds.sort(keys);
    } else {
      counts.scroll = (counts.scroll ?? 0) + 1;
      sc.scrollTop = Math.floor(r() * Math.max(0, sc.scrollHeight - sc.clientHeight));
      sc.scrollLeft = Math.floor(r() * Math.max(0, sc.scrollWidth - sc.clientWidth));
    }
    // Some operations run back to back, so batching of repaints is exercised; others wait.
    if (r() < 0.6) await yieldToEventLoop();
    if (r() < 0.2) await nextFrame();
    if (checkEvery > 0 && i % checkEvery === 0) {
      await settle();
      const rendered = verifyRendered(`after ${i}`);
      const sh = verifyShadow();
      const fo = verifyFooter();
      checkpoints.push({
        after: i,
        renderedRows: rendered.rows,
        cells: rendered.cells,
        renderedMismatches: rendered.mismatches.length,
        shadowMismatches: sh.mismatches.length,
        footerMismatches: fo.mismatches.length,
        sample: [...rendered.mismatches, ...sh.mismatches, ...fo.mismatches].slice(0, 5),
      });
    }
  }
  await settle();
  return { ops: count, counts, checkpoints, totalMs: performance.now() - start };
}

// ---- Measurements ----
function stats(values: number[]): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  const rd = (x: number): number => Math.round(x * 100) / 100;
  return { n: values.length, mean: rd(mean), p50: rd(at(0.5)), p95: rd(at(0.95)), p99: rd(at(0.99)), max: rd(sorted[sorted.length - 1] ?? 0) };
}

/** Scrolls one step per frame and records the frame times and long tasks. */
async function scrollRun(steps: number, step: (i: number, max: { top: number; left: number }) => [number, number]) {
  const sc = scroller();
  await afterPaint();
  const max = { top: sc.scrollHeight - sc.clientHeight, left: sc.scrollWidth - sc.clientWidth };
  const tasksBefore = longTasks.length;
  const times: number[] = [];
  let last = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
  for (let i = 0; i < steps; i++) {
    const [top, left] = step(i, max);
    sc.scrollTop = top;
    sc.scrollLeft = left;
    const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    times.push(now - last);
    last = now;
  }
  const tasks = longTasks.slice(tasksBefore);
  await settle();
  return {
    frameMs: stats(times),
    framesOver20ms: times.filter((x) => x > 20).length,
    framesOver34ms: times.filter((x) => x > 34).length,
    longTasks: tasks.length,
    longestTaskMs: Math.round(Math.max(0, ...tasks.map((x) => x.duration)) * 100) / 100,
    mismatchesAfter: verifyRendered('after scroll run').mismatches.length,
    sample: verifyRendered('after scroll run').mismatches.slice(0, 6),
  };
}

/** Clicks a header cell the way the mouse does and reports the time until the sorted rows are painted. */
async function sortClick(label: string, shift = false) {
  const cells = Array.from(document.querySelectorAll<HTMLElement>('.fw-grid__header .fw-grid__cell'));
  const cell = cells.find((c) => (c.firstChild?.textContent ?? '') === label);
  if (!cell) throw new Error(`No header "${label}"`);
  await afterPaint();
  const t0 = performance.now();
  cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: shift, view: window }));
  await afterPaint();
  const ms = performance.now() - t0;
  const firstRow = document.querySelector<HTMLElement>('.fw-grid__row[data-index="0"]');
  return {
    clickToPaintMs: Math.round(ms * 100) / 100,
    sortKeys: JSON.stringify(ds.sortKeys),
    firstRowId: Number(firstRow?.dataset.rowId),
    ariaSort: cell.getAttribute('aria-sort'),
  };
}

declare global {
  interface Window {
    p1: unknown;
  }
}

window.p1 = {
  ready,
  form,
  ds,
  timings,
  columns: COLS.map((c) => ({ id: c.id, type: c.type, label: c.label, track: TRACK_OF.get(c.id), format: c.format, editor: c.editor })),
  rows: ROWS,
  longTaskSupported,
  longTasks: () => longTasks.slice(),
  startFrames: () => {
    frameTimes = [];
    framePrev = 0;
  },
  stopFrames: () => {
    const out = frameTimes ?? [];
    frameTimes = null;
    return { ...stats(out), over20: out.filter((x) => x > 20).length, over34: out.filter((x) => x > 34).length };
  },
  settle,
  afterPaint,
  verifyRendered: (label = 'now') => verifyRendered(label),
  verifyShadow,
  verifyFooter,
  verifyAt,
  runScript,
  sortClick,
  scrollSteady: () => scrollRun(600, (i, max) => [Math.min(max.top, i * 84), (i % 200) * (max.left / 200)]),
  scrollPages: () => scrollRun(300, (i, max) => [Math.min(max.top, 100000 + i * 700), 0]),
  scrollDragAll: () => scrollRun(120, (i, max) => [(max.top * i) / 119, 0]),
  /** Dispatches a key on the Grid root and times the paint that follows. */
  keyLatency: async (key: string, times: number) => {
    const grid = document.querySelector<HTMLElement>('.fw-grid') as HTMLElement;
    grid.focus();
    const out: number[] = [];
    for (let i = 0; i < times; i++) {
      const t0 = performance.now();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await afterPaint();
      out.push(performance.now() - t0);
    }
    return stats(out);
  },
  setValue: (index: number, column: string, value: CellValue) => {
    const rowId = ds.rowIdAt(index);
    ds.setValue(index, column, value);
    (shadow.get(rowId) as CellValue[])[COL_INDEX.get(column) as number] = value;
  },
  shadowSize: () => shadow.size,
  /** Records an edit made through the UI, with the value the test itself typed, so the footer check stays independent. */
  shadowSet: (rowId: number, column: string, value: CellValue) => {
    (shadow.get(rowId) as CellValue[])[COL_INDEX.get(column) as number] = value;
  },
  /** Checks the whole view is ordered by an int or decimal column. Empty values must be last. */
  orderCheck: (column: string, descending: boolean): { ok: boolean; at: number } => {
    const c = COLS[COL_INDEX.get(column) as number] as Col;
    let prev: bigint | null = null;
    let seenNull = false;
    for (let i = 0; i < ds.rowCount; i++) {
      const v = ds.getValue(i, column);
      if (v === null || v === undefined || v === '') {
        seenNull = true;
        continue;
      }
      if (seenNull) return { ok: false, at: i };
      const n = c.type === 'decimal' ? scaled(String(v), c.scale as number) : BigInt(Number(v));
      if (prev !== null && (descending ? n > prev : n < prev)) return { ok: false, at: i };
      prev = n;
    }
    return { ok: true, at: -1 };
  },
};
