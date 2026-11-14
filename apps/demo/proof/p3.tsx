/**
 * Proof test P3 (FRAMEWORK.md section 8): 300 components from JSON, 1,000 scripted changes, and a
 * hidden tab that shows the latest values. This page builds the form and exposes `window.p3`
 * for apps/demo/e2e/p3.spec.ts. The expected text for each component is computed from the model
 * (Dataset and variables), never read back from the page.
 */
import { FormView, defaultRegistry } from '@fw/components';
import '@fw/components/theme.css';
import {
  createForm,
  type AnyDataset,
  type ColumnDefinition,
  type ComponentDefinition,
  type FormDefinition,
  type FormInstance,
} from '@fw/core';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const ROWS = 40;
const TEXT_COLUMNS = 10;
const NUMBER_COLUMNS = 10;
const BOOL_COLUMNS = 5;
const TOTAL = 300;

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

/** Exact decimal text with 18 integer digits and 12 places, which a double can't hold. */
function longDecimal(rand: () => number): string {
  const digits = (n: number, first = false): string => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const d = Math.floor(rand() * 10);
      s += String(first && i === 0 && d === 0 ? 1 : d);
    }
    return s;
  };
  return `${rand() < 0.2 ? '-' : ''}${digits(18, true)}.${digits(12)}`;
}

function words(rand: () => number): string {
  const parts = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const n = 1 + Math.floor(rand() * 3);
  return Array.from({ length: n }, () => parts[Math.floor(rand() * parts.length)]).join(' ') + ` ${Math.floor(rand() * 1000)}`;
}

const CATEGORIES = [
  { value: 'A', label: 'Category A' },
  { value: 'B', label: 'Category B' },
  { value: 'C', label: 'Category C' },
];

/** What the test needs to know about one component, to work out its expected text from the model. */
type Expect =
  | { kind: 'text'; column: string }
  | { kind: 'number'; column: string }
  | { kind: 'check'; column: string }
  | { kind: 'textarea'; column: string }
  | { kind: 'combo'; column: string }
  | { kind: 'radio'; column: string }
  | { kind: 'labelColumn'; column: string }
  | { kind: 'labelVar'; name: string }
  | { kind: 'labelSum'; column: string }
  | { kind: 'labelRow' };

interface Entry {
  id: string;
  type: string;
  page: string;
  expect: Expect;
}

const entries: Entry[] = [];
let counter = 0;

function make(page: string, slot: number): ComponentDefinition {
  const n = counter++;
  const id = `c${String(n).padStart(3, '0')}`;
  const layout = { left: 8 + (n % 6) * 150, top: 8 + Math.floor((n % 90) / 6) * 56, width: 140, height: 52 };
  const small = { ...layout, height: 24 };
  const push = (type: string, expect: Expect): void => {
    entries.push({ id, type, page, expect });
  };
  const textCol = `t${n % TEXT_COLUMNS}`;
  const numCol = `n${n % NUMBER_COLUMNS}`;
  switch (slot % 10) {
    case 0:
    case 1:
    case 2:
      push('TextInput', { kind: 'text', column: textCol });
      return { id, type: 'TextInput', layout, props: { label: `Text ${id}` }, bind: { value: `dsP.${textCol}` } };
    case 3:
    case 4:
    case 5:
      push('NumberInput', { kind: 'number', column: numCol });
      return { id, type: 'NumberInput', layout, props: { label: `Number ${id}` }, bind: { value: `dsP.${numCol}` } };
    case 6: {
      const col = `b${n % BOOL_COLUMNS}`;
      push('Checkbox', { kind: 'check', column: col });
      return { id, type: 'Checkbox', layout: small, props: { label: `Flag ${id}` }, bind: { value: `dsP.${col}` } };
    }
    case 7:
      push('Label', { kind: 'labelColumn', column: textCol });
      return { id, type: 'Label', layout: small, bind: { text: `dsP.${textCol}` } };
    case 8: {
      const variant = n % 4;
      if (variant === 0) {
        push('Label', { kind: 'labelVar', name: 'v0' });
        return { id, type: 'Label', layout: small, props: { text: "=concat('Var 0: ', vars.v0)" } };
      }
      if (variant === 1) {
        push('Label', { kind: 'labelVar', name: 'v1' });
        return { id, type: 'Label', layout: small, props: { text: "=concat('Var 1: ', vars.v1, '/', vars.v2)" } };
      }
      if (variant === 2) {
        push('Label', { kind: 'labelSum', column: numCol });
        return { id, type: 'Label', layout: small, props: { text: `=concat('Sum: ', sum(ds.dsP.${numCol}))` } };
      }
      push('Label', { kind: 'labelRow' });
      return {
        id,
        type: 'Label',
        layout: small,
        props: { text: "=concat('Row ', ds.dsP.$currentIndex + 1, ' of ', ds.dsP.$rowCount)" },
      };
    }
    default:
      push('Label', { kind: 'labelColumn', column: numCol });
      return { id, type: 'Label', layout: small, bind: { text: `dsP.${numCol}` } };
  }
}

function pagePanel(id: string, title: string, count: number): ComponentDefinition {
  const children: ComponentDefinition[] = [];
  for (let i = 0; i < count; i++) children.push(make(id, i));
  return { id, type: 'Panel', layout: { left: 0, top: 0, right: 0, bottom: 0 }, props: { title }, children };
}

function buildDefinition(): FormDefinition {
  const rand = mulberry32(12345);
  const columns: ColumnDefinition[] = [];
  for (let i = 0; i < TEXT_COLUMNS; i++) columns.push({ id: `t${i}`, type: 'string', size: 100 });
  for (let i = 0; i < NUMBER_COLUMNS; i++) columns.push({ id: `n${i}`, type: 'decimal', precision: 30, scale: 12 });
  for (let i = 0; i < BOOL_COLUMNS; i++) columns.push({ id: `b${i}`, type: 'boolean' });
  columns.push({ id: 'cat', type: 'string', size: 1 });
  const initialRows: Record<string, unknown>[] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: Record<string, unknown> = { cat: 'ABC'[r % 3] };
    for (let i = 0; i < TEXT_COLUMNS; i++) row[`t${i}`] = words(rand);
    for (let i = 0; i < NUMBER_COLUMNS; i++) row[`n${i}`] = longDecimal(rand);
    for (let i = 0; i < BOOL_COLUMNS; i++) row[`b${i}`] = rand() < 0.5;
    initialRows.push(row);
  }

  // Header panel: real types other than the four main ones.
  const header: ComponentDefinition[] = [];
  const headerLayout = (i: number) => ({ left: 8 + (i % 6) * 150, top: 8 + Math.floor(i / 6) * 56, width: 140, height: 52 });
  const addHeader = (def: Pick<ComponentDefinition, 'id' | 'type' | 'props' | 'bind'>, expect?: Expect): void => {
    const i = header.length;
    header.push({ ...def, layout: headerLayout(i) });
    if (expect) entries.push({ id: def.id, type: def.type, page: 'header', expect });
  };
  addHeader({ id: 'hdrCombo', type: 'ComboBox', props: { label: 'Category (combo)', options: CATEGORIES }, bind: { value: 'dsP.cat' } }, { kind: 'combo', column: 'cat' });
  addHeader({ id: 'hdrRadio', type: 'RadioGroup', props: { label: 'Category (radio)', options: CATEGORIES }, bind: { value: 'dsP.cat' } }, { kind: 'radio', column: 'cat' });
  addHeader({ id: 'hdrArea', type: 'TextArea', props: { label: 'Notes' }, bind: { value: 'dsP.t0' } }, { kind: 'textarea', column: 't0' });
  addHeader({ id: 'hdrPrev', type: 'Button', props: { text: 'Previous' } });
  addHeader({ id: 'hdrNext', type: 'Button', props: { text: 'Next' } });
  while (header.length < 24) {
    const i = header.length;
    const id = `h${String(i).padStart(2, '0')}`;
    const kind = i % 4;
    const t = `t${i % TEXT_COLUMNS}`;
    const nn = `n${i % NUMBER_COLUMNS}`;
    const b = `b${i % BOOL_COLUMNS}`;
    if (kind === 0) addHeader({ id, type: 'TextInput', props: { label: `Head text ${id}` }, bind: { value: `dsP.${t}` } }, { kind: 'text', column: t });
    else if (kind === 1) addHeader({ id, type: 'NumberInput', props: { label: `Head number ${id}` }, bind: { value: `dsP.${nn}` } }, { kind: 'number', column: nn });
    else if (kind === 2) addHeader({ id, type: 'Checkbox', props: { label: `Head flag ${id}` }, bind: { value: `dsP.${b}` } }, { kind: 'check', column: b });
    else addHeader({ id, type: 'Label', bind: { text: `dsP.${t}` } }, { kind: 'labelColumn', column: t });
  }

  // 300 = header panel (1) + its children + tabs (1) + 3 pages + the children on the pages.
  const childTotal = TOTAL - 1 - header.length - 1 - 3;
  const per = Math.floor(childTotal / 3);
  const pages = [pagePanel('pageOne', 'First', per), pagePanel('pageTwo', 'Second', per), pagePanel('pageThree', 'Third', childTotal - 2 * per)];

  return {
    formatVersion: 1,
    id: 'proof.P3',
    size: { width: 940, height: 640 },
    datasets: [{ id: 'dsP', columns, initialRows }],
    variables: {
      v0: { type: 'string', default: 'start' },
      v1: { type: 'string', default: 'one' },
      v2: { type: 'int', default: 0 },
    },
    components: [
      { id: 'header', type: 'Panel', layout: { left: 0, top: 0, right: 0, height: 250 }, props: { title: 'Header' }, children: header },
      { id: 'tabs', type: 'Tabs', layout: { left: 0, top: 258, right: 0, bottom: 0 }, children: pages },
    ],
  };
}

// JSON on the way in, so the form really is a plain JSON document.
const definition = JSON.parse(JSON.stringify(buildDefinition())) as FormDefinition;

// Long tasks, recorded from the start of the page.
const longTasks: { start: number; duration: number }[] = [];
let longTaskSupported = true;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
} catch {
  longTaskSupported = false;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function expectedFor(form: FormInstance, ds: AnyDataset, e: Entry): string | boolean {
  const cell = (column: string): string => {
    const index = ds.currentIndex;
    const value = index < 0 ? null : ds.getValue(index, column);
    return value === null || value === undefined ? '' : String(value);
  };
  const x = e.expect;
  switch (x.kind) {
    case 'text':
    case 'number':
    case 'textarea':
    case 'labelColumn':
    case 'radio':
      return cell(x.column);
    case 'check': {
      const index = ds.currentIndex;
      return index >= 0 && ds.getValue(index, x.column) === true;
    }
    case 'combo': {
      const value = cell(x.column);
      return CATEGORIES.find((c) => c.value === value)?.label ?? value;
    }
    case 'labelVar': {
      const vars = form.context.vars as Record<string, unknown>;
      return x.name === 'v0' ? `Var 0: ${String(vars.v0)}` : `Var 1: ${String(vars.v1)}/${String(vars.v2)}`;
    }
    case 'labelSum':
      return `Sum: ${exactSum(ds, x.column)}`;
    case 'labelRow':
      return `Row ${ds.currentIndex + 1} of ${ds.rowCount}`;
  }
}

/** Sums decimal text with BigInt, independently of the library's own decimal code. */
function exactSum(ds: AnyDataset, column: string): string {
  let total = 0n;
  for (let i = 0; i < ds.rowCount; i++) {
    const v = ds.getValue(i, column);
    if (v === null || v === undefined || v === '') continue;
    const s = String(v);
    const negative = s.startsWith('-');
    const [whole = '0', frac = ''] = s.replace(/^[-+]/, '').split('.');
    const scaled = BigInt(whole + frac.padEnd(12, '0').slice(0, 12));
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(13, '0');
  const whole = digits.slice(0, -12);
  const frac = digits.slice(-12).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

interface Mismatch {
  id: string;
  type: string;
  expected: string | boolean;
  actual: string | boolean | null;
}

function actualFor(e: Entry, host: Element): string | boolean | null {
  switch (e.expect.kind) {
    case 'text':
    case 'number':
    case 'combo':
      return host.querySelector<HTMLInputElement>('input')?.value ?? null;
    case 'textarea':
      return host.querySelector<HTMLTextAreaElement>('textarea')?.value ?? null;
    case 'check':
      return host.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked ?? null;
    case 'radio':
      return host.querySelector<HTMLInputElement>('input[type=radio]:checked')?.value ?? '';
    case 'labelSum':
      // The library keeps the column's 12 places in a sum ("1.500000000000"); the oracle trims them.
      // They are the same number, so both sides are compared without trailing fraction zeros.
      return (host.querySelector('.fw-label')?.textContent ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    default:
      return host.querySelector('.fw-label')?.textContent ?? null;
  }
}

function verify(form: FormInstance, ds: AnyDataset, pageFilter?: string): { checked: number; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  let checked = 0;
  for (const e of entries) {
    if (pageFilter && e.page !== pageFilter) continue;
    const host = document.querySelector(`.fw-host[data-id="${e.id}"]`);
    const expected = expectedFor(form, ds, e);
    const actual = host ? actualFor(e, host) : null;
    checked++;
    if (actual !== expected) mismatches.push({ id: e.id, type: e.type, expected, actual });
  }
  return { checked, mismatches };
}

const container = document.getElementById('root');
if (!container) throw new Error('p3.html has no #root element');
const root = createRoot(container);

const timings: Record<string, number> = {};
const tStart = performance.now();
const form = createForm(definition);
const ds = form.getDataset('dsP');
if (!ds) throw new Error('dsP is missing');
timings.createFormMs = performance.now() - tStart;
void form.init();

const tRender = performance.now();
flushSync(() => root.render(<FormView form={form} registry={defaultRegistry} />));
timings.renderCommitMs = performance.now() - tRender;
const renderEnd = performance.now();
const ready = nextFrame().then(() => {
  timings.renderToNextFrameMs = performance.now() - tRender;
  timings.createToNextFrameMs = performance.now() - tStart;
});

const vars = form.context.vars as Record<string, unknown>;

async function runChanges(count: number, seed: number, verifyEvery: number): Promise<unknown> {
  const rand = mulberry32(seed);
  const counts: Record<string, number> = { cell: 0, otherRow: 0, current: 0, variable: 0 };
  const stringColumns = Array.from({ length: TEXT_COLUMNS }, (_, i) => `t${i}`);
  const numberColumns = Array.from({ length: NUMBER_COLUMNS }, (_, i) => `n${i}`);
  const boolColumns = Array.from({ length: BOOL_COLUMNS }, (_, i) => `b${i}`);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const checkpoints: { after: number; checked: number; mismatches: Mismatch[] }[] = [];
  const perChange: number[] = [];
  const windowStart = performance.now();
  let measured = 0;
  for (let i = 1; i <= count; i++) {
    const t0 = performance.now();
    const roll = rand();
    if (roll < 0.5) {
      counts.cell++;
      const row = ds!.currentIndex;
      const which = rand();
      if (which < 0.4) ds!.setValue(row, pick(stringColumns), rand() < 0.03 ? null : words(rand));
      else if (which < 0.8) ds!.setValue(row, pick(numberColumns), rand() < 0.03 ? null : longDecimal(rand));
      else ds!.setValue(row, pick(boolColumns), rand() < 0.5);
    } else if (roll < 0.65) {
      counts.otherRow++;
      ds!.setValue(Math.floor(rand() * ROWS), pick(numberColumns), longDecimal(rand));
    } else if (roll < 0.85) {
      counts.current++;
      ds!.setCurrentIndex(Math.floor(rand() * ROWS));
    } else {
      counts.variable++;
      const which = rand();
      if (which < 0.4) vars.v0 = words(rand);
      else if (which < 0.8) vars.v1 = words(rand);
      else vars.v2 = Math.floor(rand() * 100000);
    }
    await yieldToEventLoop();
    const elapsed = performance.now() - t0;
    perChange.push(elapsed);
    measured += elapsed;
    if (verifyEvery > 0 && i % verifyEvery === 0) {
      await nextFrame();
      checkpoints.push({ after: i, ...verify(form, ds!) });
    }
  }
  const windowEnd = performance.now();
  await nextFrame();
  const final = verify(form, ds!);
  return {
    count,
    counts,
    window: { start: windowStart, end: windowEnd },
    totalMs: measured,
    wallMsIncludingChecks: windowEnd - windowStart,
    maxSingleChangeMs: Math.max(...perChange),
    meanChangeMs: measured / count,
    checkpoints,
    final,
  };
}

declare global {
  interface Window {
    p3: unknown;
  }
}

window.p3 = {
  form,
  ds,
  ready,
  entries,
  timings,
  longTaskSupported,
  renderWindow: { start: tRender, end: renderEnd },
  hostCount: () => document.querySelectorAll('.fw-host').length,
  definitionComponentCount: () => {
    const count = (list: ComponentDefinition[]): number => list.reduce((n, c) => n + 1 + count(c.children ?? []), 0);
    return count(definition.components);
  },
  typeCounts: () => {
    const counts: Record<string, number> = {};
    const walk = (list: ComponentDefinition[]): void => {
      for (const c of list) {
        counts[c.type] = (counts[c.type] ?? 0) + 1;
        walk(c.children ?? []);
      }
    };
    walk(definition.components);
    return counts;
  },
  setValue: (row: number, column: string, value: unknown) => ds.setValue(row, column, value),
  setCurrent: (index: number) => ds.setCurrentIndex(index),
  setVar: (name: string, value: unknown) => {
    vars[name] = value;
  },
  settle: async () => {
    await yieldToEventLoop();
    await nextFrame();
  },
  verify: (pageFilter?: string) => verify(form, ds, pageFilter),
  expected: (id: string) => {
    const e = entries.find((x) => x.id === id);
    return e ? expectedFor(form, ds, e) : null;
  },
  runChanges,
  longTasks: () => longTasks.slice(),
};
