import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormTextError, diffFormText, openFormText, printForm, writeFormText } from '../src/index.ts';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const canonical = fixture('EmpSearch.form.json');
const handFormatted = fixture('hand-formatted.form.json');

/* eslint-disable @typescript-eslint/no-explicit-any */
function parse(text: string): any {
  const opened = openFormText(text);
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

function edit(text: string, change: (form: any) => void): string {
  const form = parse(text);
  change(form);
  const result = writeFormText(text, form);
  expect(parse(result)).toEqual(form);
  expect(diffFormText(result, form)).toEqual([]);
  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The lines removed and added, assuming one contiguous change. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

describe('standard layout', () => {
  it('prints the fixture exactly', () => {
    expect(printForm(parse(canonical))).toBe(canonical);
  });

  it('gives the same text whatever order keys arrive in', () => {
    const form = parse(canonical);
    const reversed = Object.fromEntries(Object.entries(form).reverse());
    expect(printForm(reversed)).toBe(canonical);
  });

  it('normalizes a hand-formatted file, and is stable after that', () => {
    const once = printForm(parse(handFormatted));
    expect(printForm(parse(once))).toBe(once);
    expect(parse(once)).toEqual(parse(handFormatted));
  });

  it('puts unknown keys after known ones', () => {
    const text = printForm({ zzz: 1, id: 'a', formatVersion: 1, components: [] });
    expect(Object.keys(parse(text))).toEqual(['formatVersion', 'id', 'components', 'zzz']);
    expect(text.indexOf('"zzz"')).toBeGreaterThan(text.indexOf('"components"'));
  });

  it('refuses values JSON cannot hold exactly', () => {
    expect(() => printForm({ a: Number.NaN })).toThrow(/NaN/);
    expect(() => printForm({ a: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
    expect(() => printForm({ a: () => 1 })).toThrow(/function/);
    expect(() => printForm({ a: new Date(0) })).toThrow(/non-plain/);
    expect(() => printForm({ a: [undefined] })).toThrow();
  });
});

describe('saving with no change', () => {
  const variants: [string, string][] = [
    ['standard', canonical],
    ['hand-formatted', handFormatted],
    ['CRLF', canonical.replace(/\n/g, '\r\n')],
    ['byte order mark', `﻿${canonical}`],
    ['no final newline', canonical.trimEnd()],
    ['keys in another order', '{"components": [], "id": "a", "formatVersion": 1}'],
  ];

  it.each(variants)('gives no edits: %s', (_name, text) => {
    expect(diffFormText(text, parse(text))).toEqual([]);
    expect(writeFormText(text, parse(text))).toBe(text);
  });

  it('ignores a property set to undefined', () => {
    const form = parse(canonical);
    form.nothing = undefined;
    expect(diffFormText(canonical, form)).toEqual([]);
  });
});

describe('changing one property is a one-line diff', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const canonicalChanges: [string, (form: any) => void][] = [
    ['top-level string', (f) => (f.title = 'New title')],
    ['size', (f) => (f.size.width = 800)],
    ['form event', (f) => (f.events.init = 'other')],
    ['parameter', (f) => (f.params.deptCode.type = 'int')],
    ['dataset flag', (f) => (f.datasets[1].confirmUnsaved = false)],
    ['dataset keys', (f) => (f.datasets[1].keys = ['empNo', 'empName'])],
    ['column size', (f) => (f.datasets[0].columns[1].size = 99)],
    ['component layout', (f) => (f.components[0].layout.left = 99)],
    ['component prop', (f) => (f.components[1].props.text = 'Find')],
    ['binding', (f) => (f.components[0].bind.value = 'dsCond.deptCode')],
    ['component event', (f) => (f.components[1].events.click = 'other')],
    ['grid column width', (f) => (f.components[2].props.columns[1].width = 200)],
    ['header cell', (f) => (f.components[2].props.headerRows[0].cells[1].text = 'Pay')],
    ['record cell', (f) => (f.components[2].props.recordRows[0].cells[2].format = '0.00')],
    ['footer cell', (f) => (f.components[2].props.footerRows[0].cells[0].colSpan = 1)],
    ['variable default', (f) => (f.variables.busy.default = true)],
    ['new key on a one-line object', (f) => (f.components[0].props.placeholder = 'Type')],
    ['removed key on a one-line object', (f) => delete f.components[0].props.maxLength],
    ['string with quotes and unicode', (f) => (f.title = 'A "quoted" \\ title – é')],
  ];

  it.each(canonicalChanges)('standard file: %s', (_name, change) => {
    const { removed, added } = changedLines(canonical, edit(canonical, change));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  const handChanges: [string, (form: any) => void][] = [
    ['top-level string', (f) => (f.title = 'New title')],
    ['column', (f) => (f.datasets[0].columns[0].size = 20)],
    ['compact column', (f) => (f.datasets[0].columns[1].type = 'date')],
    ['layout with an unknown key', (f) => (f.components[0].layout.top = 17)],
    ['nested child', (f) => (f.components[1].children[0].props.text = 'Bye')],
    ['grid column on a shared line', (f) => (f.components[2].props.columns[0].width = 91)],
    ['cell on a shared line', (f) => (f.components[2].props.recordRows[0].cells[1].editor = 'number')],
    ['two values on one line', (f) => (f.id = 'hr.Other')],
  ];

  it.each(handChanges)('hand-formatted file: %s', (_name, change) => {
    const { removed, added } = changedLines(handFormatted, edit(handFormatted, change));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('touches only the changed value, not the whole line', () => {
    const line = canonical.split('\n').find((text) => text.includes('"empNameInput"')) as string;
    const form = parse(canonical);
    form.components[0].layout.left = 99;
    const edits = diffFormText(canonical, form);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe('99');
    expect(line).toContain('empNameInput');
  });
});

describe('adding and removing', () => {
  const button = {
    id: 'newButton',
    type: 'Button',
    layout: { left: 1, top: 2, width: 3, height: 4 },
    props: { text: 'New' },
  };
  /** A component's six lines, as a diff reports them. Its braces can match neighbouring lines. */
  const BLOCK_LINES = 6;

  it('inserts a component between others as one block, touching no other line', () => {
    const after = edit(canonical, (form) => form.components.splice(1, 0, button));
    const { removed, added } = changedLines(canonical, after);
    expect(removed).toEqual([]);
    expect(added).toHaveLength(BLOCK_LINES);
    expect(added).toContain('      "id": "newButton",');
    expect(added).toContain('      "layout": { "left": 1, "top": 2, "width": 3, "height": 4 },');
  });

  it('adds a component at the end, changing no line except the comma before it', () => {
    const after = edit(canonical, (form) => form.components.push(button));
    const { removed, added } = changedLines(canonical, after);
    expect(removed).toEqual([]);
    expect(added[0]).toBe('    },');
    expect(added).toHaveLength(BLOCK_LINES);
    expect(after).toContain('"props": { "text": "New" }\n    }\n  ],');
  });

  it('adds the first component to an empty list', () => {
    const empty = printForm({ formatVersion: 1, id: 'a', components: [] });
    const after = edit(empty, (form) => form.components.push(button));
    expect(after).toBe(printForm({ formatVersion: 1, id: 'a', components: [button] }));
  });

  it('removes a component from the middle as one block, touching no other line', () => {
    const after = edit(canonical, (form) => form.components.splice(1, 1));
    const { removed, added } = changedLines(canonical, after);
    expect(added).toEqual([]);
    expect(removed).toHaveLength(7); // This component also has an events line.
    expect(removed).toContain('      "id": "searchButton",');
  });

  it('removes the last component and its comma', () => {
    const after = edit(canonical, (form) => form.components.pop());
    expect(after).toContain('"click": "onSearch" }\n    }\n  ],');
  });

  it('removes every component', () => {
    const after = edit(canonical, (form) => (form.components = []));
    expect(after).toContain('"components": [],');
  });

  it('adds a key in its standard place, without moving anything', () => {
    const after = edit(canonical, (form) => {
      form.components[1].bind = { value: 'dsCond.empName' };
    });
    const { removed, added } = changedLines(canonical, after);
    expect(removed).toEqual([]);
    expect(added).toEqual(['      "bind": { "value": "dsCond.empName" },']);
  });

  it('adds a key to a one-line object in its standard place', () => {
    const after = edit(canonical, (form) => {
      delete form.components[0].layout.top;
      form.components[0].layout.bottom = 5;
    });
    expect(after).toContain('"layout": { "left": 16, "bottom": 5, "width": 200, "height": 28 }');
  });

  it('removes a key with a one-line diff when it is not last', () => {
    const after = edit(canonical, (form) => delete form.title);
    const { removed, added } = changedLines(canonical, after);
    expect(removed).toEqual(['  "title": "Employee search",']);
    expect(added).toEqual([]);
  });

  it('moves a component without disturbing the others', () => {
    const after = edit(canonical, (form) => form.components.reverse());
    expect(after.indexOf('"empGrid"')).toBeLessThan(after.indexOf('"empNameInput"'));
    expect(after).toContain('"layout": { "left": 16, "top": 56, "right": 16, "bottom": 16 }');
  });

  it('changes a component and adds a sibling in the same save', () => {
    const after = edit(canonical, (form) => {
      form.components[0].layout.left = 99;
      form.components.unshift(button);
    });
    expect(after).toContain('"left": 99');
    expect(after.indexOf('"newButton"')).toBeLessThan(after.indexOf('"empNameInput"'));
  });

  it('adds a cell without rewriting the other cells', () => {
    const after = edit(canonical, (form) => {
      form.components[2].props.recordRows[0].cells.push({ field: 'hiredOn' });
    });
    const { removed, added } = changedLines(canonical, after);
    expect(removed).toEqual(['              { "field": "salary", "format": "#,##0" }']);
    expect(added).toEqual(['              { "field": "salary", "format": "#,##0" },', '              { "field": "hiredOn" }']);
  });

  it('gives Grid props the standard Grid layout when added', () => {
    const after = edit(canonical, (form) => {
      form.components.push({
        id: 'g2',
        type: 'Grid',
        layout: { left: 0, top: 0, width: 1, height: 1 },
        props: { columns: [{ id: 'c', width: 1 }], recordRows: [{ cells: [{ field: 'empNo' }] }] },
      });
    });
    expect(after).toContain('          { "id": "c", "width": 1 }\n');
    expect(after).toContain('              { "field": "empNo" }\n');
  });
});

describe('unknown keys and formatting survive', () => {
  it('keeps unknown keys at every level through unrelated edits', () => {
    const after = edit(handFormatted, (form) => {
      form.title = 'Changed';
      form.components[0].layout.top = 99;
      form.components[2].props.recordRows[0].cells[0].format = 'x';
    });
    expect(after).toContain('"customTopLevel": { "keep": ["me", 1, true, null] }');
    expect(after).toContain('"futureColumnOption": "x"');
    expect(after).toContain('"futureEdge": 1');
    expect(after).toContain('"futureCellOption": [1, 2]');
  });

  it('keeps the original spacing around unrelated parts', () => {
    const after = edit(handFormatted, (form) => (form.title = 'Changed'));
    expect(after).toContain('"formatVersion": 1,   "id": "hr.Hand"');
    expect(after).toContain('{"id":"empName","type":"string"},\n\n');
    expect(after.replace('"title": "Changed"', '"title": "Formatted by hand"')).toBe(handFormatted);
  });

  it('keeps the file key order', () => {
    const after = edit(handFormatted, (form) => (form.components[2].bind.dataset = 'dsEmp2'));
    expect(after.indexOf('"bind"', after.indexOf('empGrid'))).toBeLessThan(after.indexOf('"props"', after.indexOf('empGrid')));
  });

  it('adds unknown keys after known ones, keeping their value exactly', () => {
    const after = edit(canonical, (form) => (form.components[0].futureThing = { deep: [1, { x: null }] }));
    expect(parse(after).components[0].futureThing).toEqual({ deep: [1, { x: null }] });
    expect(after.indexOf('futureThing')).toBeGreaterThan(after.indexOf('"bind"'));
  });

  it('matches the surrounding style when adding to compact text', () => {
    const compact = '{"formatVersion":1,"id":"a","components":[{"id":"x","type":"T","layout":{"left":1,"top":1,"width":1,"height":1}}]}';
    const after = edit(compact, (form) => form.components.push({ id: 'y', type: 'T', layout: { left: 2 } }));
    expect(after.includes('\n')).toBe(false);
  });

  it('keeps line endings, the byte order mark and the end of the file', () => {
    const crlf = canonical.replace(/\n/g, '\r\n');
    const after = edit(crlf, (form) => {
      form.components.push({ id: 'n', type: 'T', layout: { left: 1, top: 1, width: 1, height: 1 } });
    });
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after.endsWith('}\r\n')).toBe(true);

    const withMark = edit(`﻿${canonical}`, (form) => (form.title = 'x'));
    expect(withMark.charCodeAt(0)).toBe(0xfeff);

    const noNewline = edit(canonical.trimEnd(), (form) => (form.title = 'x'));
    expect(noNewline.endsWith('}')).toBe(true);
  });
});

describe('files that must not be overwritten', () => {
  const conflicted = canonical.replace(
    '"title": "Employee search",',
    '<<<<<<< HEAD\n  "title": "Mine",\n=======\n  "title": "Theirs",\n>>>>>>> branch\n',
  );

  it('recognizes a merge conflict', () => {
    expect(openFormText(conflicted).status).toBe('conflict');
    expect(openFormText(conflicted.replace(/\n/g, '\r\n')).status).toBe('conflict');
  });

  it('refuses to write over a merge conflict', () => {
    expect(() => writeFormText(conflicted, parse(canonical))).toThrow(FormTextError);
    expect(() => diffFormText(conflicted, parse(canonical))).toThrow(/conflict markers/);
  });

  it.each([
    ['syntax error', '{"a": }'],
    ['trailing comma', '{"a": 1,}'],
    ['comment', '{"a": 1 /* no */}'],
    ['truncated', '{"a": 1'],
    ['empty', ''],
    ['not an object', '[1, 2]'],
    ['duplicate key', '{"a": 1, "a": 2}'],
    ['nested duplicate key', '{"a": {"b": 1, "b": 2}}'],
    ['__proto__', '{"__proto__": {"x": 1}}'],
    ['number too large to hold', '{"a": 1e999}'],
  ])('refuses a bad file: %s', (_name, text) => {
    expect(openFormText(text).status).toBe('invalid');
    expect(() => writeFormText(text, {})).toThrow(FormTextError);
  });

  it('says where the problem is', () => {
    const opened = openFormText('{\n  "a": 1,\n  "a": 2\n}');
    expect(opened).toMatchObject({ status: 'invalid', line: 3, column: 3 });
  });

  it("doesn't mistake a value containing marker-like text for a conflict", () => {
    expect(openFormText('{"a": "<<<<<<< HEAD"}').status).toBe('ok');
  });
});

describe('random edits', () => {
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  function containers(value: any, out: any[] = []): any[] {
    if (value !== null && typeof value === 'object') {
      out.push(value);
      for (const child of Object.values(value)) containers(child, out);
    }
    return out;
  }

  function mutate(form: any, next: () => number): void {
    const pick = (limit: number) => Math.floor(next() * limit);
    const all = containers(form);
    const target = all[pick(all.length)];
    const values: any[] = [pick(100), `s${pick(100)}`, true, null, {}, [], { id: `n${pick(100)}`, a: 1 }, [1, [2]], { b: { c: [] } }];
    const value = values[pick(values.length)];
    if (Array.isArray(target)) {
      const op = pick(4);
      if (op === 0 || target.length === 0) target.splice(pick(target.length + 1), 0, value);
      else if (op === 1) target.splice(pick(target.length), 1);
      else if (op === 2) target[pick(target.length)] = value;
      else {
        const i = pick(target.length);
        const j = pick(target.length);
        [target[i], target[j]] = [target[j], target[i]];
      }
    } else {
      const keys = Object.keys(target);
      const op = pick(3);
      if (op === 0 || keys.length === 0) target[`k${pick(50)}`] = value;
      else if (op === 1 && target !== form) delete target[keys[pick(keys.length)] as string];
      else target[keys[pick(keys.length)] as string] = value;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it.each([
    ['standard', canonical],
    ['hand-formatted', handFormatted],
    ['CRLF', handFormatted.replace(/\n/g, '\r\n')],
  ])('always writes text that holds exactly the intended form: %s', (_name, start) => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      let text = start;
      for (let step = 0; step < 15; step++) {
        const form = parse(text);
        for (let i = Math.floor(next() * 3) + 1; i > 0; i--) mutate(form, next);
        const written = writeFormText(text, form);
        expect(parse(written), `seed ${seed} step ${step}`).toEqual(form);
        expect(diffFormText(written, form), `seed ${seed} step ${step}`).toEqual([]);
        text = written;
      }
    }
  });

  it('leaves every untouched line alone when one scalar changes anywhere', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const form = parse(canonical);
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const scalars: [any, string | number][] = [];
      for (const container of containers(form)) {
        for (const key of Object.keys(container)) {
          const value = container[key];
          if (value === null || typeof value !== 'object') {
            scalars.push([container, Array.isArray(container) ? Number(key) : key]);
          }
        }
      }
      const [owner, key] = scalars[Math.floor(next() * scalars.length)] as [Record<string | number, unknown>, string | number];
      owner[key] = `changed-${seed}`;
      const { removed, added } = changedLines(canonical, writeFormText(canonical, form));
      expect(removed, `seed ${seed}`).toHaveLength(1);
      expect(added, `seed ${seed}`).toHaveLength(1);
    }
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('renamed keys', () => {
  const text = [
    '{',
    '  "formatVersion": 1,',
    '  "id": "a.B",',
    '  "components": [],',
    '  "rows": [',
    '    { "name": "Ann", "qty": 1 },',
    '    { "name": "Bob", "qty": 2 }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const rename = (next: (form: any) => void): string => writeFormText(text, (() => { const form = parse(text); next(form); return form; })());
  const reKey = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key === from ? to : key, value]));

  it('rewrites a renamed key in place, keeping the order', () => {
    const out = rename((form) => {
      form.rows = form.rows.map((row: any) => reKey(row, 'name', 'title'));
    });
    expect(out).toBe(text.replaceAll('"name"', '"title"'));
    expect(Object.keys(parse(out).rows[1])).toEqual(['title', 'qty']);
  });

  it('rewrites a renamed key and a changed value together', () => {
    const out = rename((form) => {
      form.rows[0] = { ...reKey(form.rows[0], 'name', 'title'), title: 'Anna' };
    });
    expect(out).toBe(text.replace('{ "name": "Ann", "qty": 1 }', '{ "title": "Anna", "qty": 1 }'));
  });

  it('does not treat a remove and an add at different positions as a rename', () => {
    const out = rename((form) => {
      form.rows[0] = { name: undefined, qty: 1, title: 'Ann' };
      delete form.rows[0].name;
    });
    expect(parse(out).rows[0]).toEqual({ qty: 1, title: 'Ann' });
    expect(Object.keys(parse(out).rows[0])).toEqual(['qty', 'title']);
  });

  it('does not pair keys when the counts differ', () => {
    const out = rename((form) => {
      form.rows[0] = { title: 'Ann', other: true, qty: 1 };
    });
    expect(parse(out).rows[0]).toEqual({ title: 'Ann', other: true, qty: 1 });
  });
});
