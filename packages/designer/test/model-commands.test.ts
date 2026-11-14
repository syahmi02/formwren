import { describe, expect, it } from 'vitest';
import { commands, createDesignerModel, moveLayout, resizeLayout, type Command } from '../src/index.ts';
import { SAMPLE, memoryHost } from './model-host.ts';

/** The lines that are in only one of two texts. A changed line counts as one removed and one added. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before.split('\n'));
  const b = count(after.split('\n'));
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) removed.push(line);
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) added.push(line);
  return { removed, added };
}

function setup(text = SAMPLE) {
  const host = memoryHost(text);
  const model = createDesignerModel(host);
  const run = async (command: Command) => {
    const before = host.text;
    const result = await model.apply(command);
    return { result, before, after: host.text, diff: changedLines(before, host.text) };
  };
  const layoutOf = (id: string) => model.find(id)!.layout;
  return { host, model, run, layoutOf };
}

describe('layout maths', () => {
  it('moves only the edges that exist', () => {
    expect(moveLayout({ left: 10, top: 20, width: 5, height: 6 }, 3, -4)).toEqual({ left: 13, top: 16, width: 5, height: 6 });
    expect(moveLayout({ right: 10, bottom: 20, width: 5, height: 6 }, 3, -4)).toEqual({ right: 7, bottom: 24, width: 5, height: 6 });
    expect(moveLayout({ left: 8, right: 8, top: 1, height: 5 }, 4, 0)).toEqual({ left: 12, right: 4, top: 1, height: 5 });
    expect(moveLayout({ width: 5, height: 6 }, 4, 4)).toEqual({ width: 5, height: 6 });
  });

  it('resizes with left and width', () => {
    const layout = { left: 10, top: 10, width: 100, height: 50 };
    expect(resizeLayout(layout, 'se', 10, 5)).toEqual({ left: 10, top: 10, width: 110, height: 55 });
    expect(resizeLayout(layout, 'nw', 10, 5)).toEqual({ left: 20, top: 15, width: 90, height: 45 });
    expect(resizeLayout(layout, 'e', -20, 99)).toEqual({ left: 10, top: 10, width: 80, height: 50 });
    expect(resizeLayout(layout, 'n', 99, -7)).toEqual({ left: 10, top: 3, width: 100, height: 57 });
  });

  it('resizes with right and bottom so the opposite side stays', () => {
    const layout = { right: 10, bottom: 10, width: 100, height: 50 };
    // East handle out by 6: the right side moves 6 closer to the parent's edge.
    expect(resizeLayout(layout, 'e', 6, 0)).toEqual({ right: 4, bottom: 10, width: 106, height: 50 });
    // West handle left by 6: the right side stays, the box grows.
    expect(resizeLayout(layout, 'w', -6, 0)).toEqual({ right: 10, bottom: 10, width: 106, height: 50 });
    expect(resizeLayout(layout, 'n', 0, -4)).toEqual({ right: 10, bottom: 10, width: 100, height: 54 });
    expect(resizeLayout(layout, 's', 0, 4)).toEqual({ right: 10, bottom: 6, width: 100, height: 54 });
  });

  it('resizes with both edges and no size', () => {
    const layout = { left: 8, right: 8, top: 8, height: 20 };
    expect(resizeLayout(layout, 'e', 5, 0)).toEqual({ left: 8, right: 3, top: 8, height: 20 });
    expect(resizeLayout(layout, 'w', 5, 0)).toEqual({ left: 13, right: 8, top: 8, height: 20 });
    // The vertical edge it doesn't have (`bottom`) is not added.
    expect(Object.keys(resizeLayout(layout, 'se', 5, 5))).not.toContain('bottom');
  });

  it('clamps to the minimum size and never pushes below it', () => {
    const layout = { left: 10, top: 10, width: 40, height: 20 };
    expect(resizeLayout(layout, 'e', -100, 0)).toEqual({ ...layout, width: 8 });
    expect(resizeLayout(layout, 'w', 100, 0)).toEqual({ ...layout, left: 42, width: 8 });
    expect(resizeLayout(layout, 'n', 0, 100, { min: 12 })).toEqual({ ...layout, top: 18, height: 12 });
    // Already below the minimum: shrinking is a no-op, growing works.
    const tiny = { left: 0, top: 0, width: 4, height: 4 };
    expect(resizeLayout(tiny, 'e', -2, 0)).toEqual(tiny);
    expect(resizeLayout(tiny, 'e', 2, 0)).toEqual({ ...tiny, width: 6 });
    // Both edges: clamp with the size that was measured.
    expect(resizeLayout({ left: 0, right: 0, top: 0, height: 9 }, 'w', 95, 0, { size: { width: 100, height: 9 } })).toEqual({ left: 92, right: 0, top: 0, height: 9 });
  });
});

describe('commands on real text', () => {
  it('move changes the one line of the layout', async () => {
    const { run, layoutOf } = setup();
    const { result, diff } = await run(commands.move('title', 8, -4));
    expect(result).toEqual({ status: 'applied' });
    expect(diff.removed).toEqual(['      "layout": { "left": 16, "top": 16, "width": 200, "height": 24 },']);
    expect(diff.added).toEqual(['      "layout": { "left": 24, "top": 12, "width": 200, "height": 24 },']);
    expect(layoutOf('title')).toEqual({ left: 24, top: 12, width: 200, height: 24 });
  });

  it('move keeps right and bottom edges', async () => {
    const { run, layoutOf } = setup();
    const { diff } = await run(commands.move('box', 10, 6));
    expect(diff.added).toEqual(['      "layout": { "right": 6, "bottom": 10, "width": 300, "height": 200 },']);
    expect(layoutOf('box')).toEqual({ right: 6, bottom: 10, width: 300, height: 200 });
  });

  it('works for nested components, relative to the parent', async () => {
    const { run, layoutOf } = setup();
    const { diff } = await run(commands.move('go', 5, 5));
    expect(diff.added).toEqual(['          "layout": { "left": 13, "top": 45, "width": 80, "height": 24 },']);
    expect(layoutOf('go')).toEqual({ left: 13, top: 45, width: 80, height: 24 });
    expect(layoutOf('box')).toEqual({ right: 16, bottom: 16, width: 300, height: 200 });
  });

  it('moving a parent and its child together moves the child once', async () => {
    const { run, layoutOf } = setup();
    await run(commands.move(['box', 'go'], 4, 0));
    expect(layoutOf('box').right).toBe(12);
    expect(layoutOf('go').left).toBe(8);
  });

  it('resize keeps the edges of a nested component that has both sides', async () => {
    const { run, layoutOf } = setup();
    const { diff } = await run(commands.resize('name', 'se', 10, 6));
    expect(layoutOf('name')).toEqual({ left: 8, top: 8, right: -2, height: 30 });
    expect(diff.added.length).toBe(1);
  });

  it('resize clamps to a minimum size', async () => {
    const { run, layoutOf } = setup();
    await run(commands.resize('go', 'w', 500, 0));
    expect(layoutOf('go')).toEqual({ left: 80, top: 40, width: 8, height: 24 });
  });

  it('setLayout sets and removes edges, and rejects a non-number', async () => {
    const { run, layoutOf, model } = setup();
    await run(commands.setLayout('other', { left: 10, width: undefined, right: 20 }));
    expect(layoutOf('other')).toEqual({ left: 10, top: 16, height: 24, right: 20 });
    const bad = await model.apply(commands.setLayout('other', { left: Number.NaN }));
    expect(bad.status).toBe('rejected');
  });

  it('setProp changes one line, adds a prop, and removes one with undefined', async () => {
    const { run, model } = setup();
    let step = await run(commands.setProp('title', 'text', 'Staff'));
    expect(step.diff).toEqual({ removed: ['      "props": { "text": "Employees" }'], added: ['      "props": { "text": "Staff" }'] });
    step = await run(commands.setProp('title', 'maxLength', 5));
    expect(model.find('title')!.props).toEqual({ text: 'Staff', maxLength: 5 });
    step = await run(commands.setProp('title', 'maxLength', undefined));
    expect(model.find('title')!.props).toEqual({ text: 'Staff' });
    step = await run(commands.setProp('title', 'text', undefined));
    expect(model.find('title')!.props).toBeUndefined();
    expect(step.after).not.toContain('"props": {}');
  });

  it('setProp with an expression and an object value', async () => {
    const { run, model } = setup();
    await run(commands.setProp('go', 'text', '=ds.dsEmp.name'));
    await run(commands.setProp('go', 'options', [{ value: 1, label: 'One' }]));
    expect(model.find('go')!.props).toEqual({ text: '=ds.dsEmp.name', options: [{ value: 1, label: 'One' }] });
  });

  it('setId renames, and rejects duplicates and bad names', async () => {
    const { run, host, model } = setup();
    const step = await run(commands.setId('title', 'heading'));
    expect(step.diff).toEqual({ removed: ['      "id": "title",'], added: ['      "id": "heading",'] });
    expect(model.find('heading')).toBeDefined();
    const dup = await model.apply(commands.setId('heading', 'go'));
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { message: string }).message).toMatch(/already used/);
    expect((await model.apply(commands.setId('heading', 'two words'))).status).toBe('rejected');
    expect((await model.apply(commands.setId('heading', 'heading'))).status).toBe('unchanged');
    expect(host.calls.length).toBe(1);
  });

  it('delete removes a component with its children, and several at once', async () => {
    const { run, model } = setup();
    await run(commands.delete('box'));
    expect(model.find('box')).toBeUndefined();
    expect(model.find('name')).toBeUndefined();
    expect(model.find('go')).toBeUndefined();
    expect(model.find('title')).toBeDefined();
    await run(commands.delete(['title', 'other', 'unknown']));
    expect(model.definition.value!.components).toEqual([]);
  });

  it('delete of a nested component leaves its parent and siblings', async () => {
    const { run, model } = setup();
    const step = await run(commands.delete('go'));
    expect(model.find('go')).toBeUndefined();
    expect(model.find('name')).toBeDefined();
    expect(step.diff.removed.some((line) => line.includes('"go"'))).toBe(true);
    expect(step.diff.added.every((line) => !line.includes('"go"'))).toBe(true);
  });

  it('delete of an unknown id writes nothing', async () => {
    const { model, host } = setup();
    expect((await model.apply(commands.delete('nope'))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('setEvent sets, changes and removes a handler', async () => {
    const { run, model } = setup();
    await run(commands.setEvent('go', 'click', 'onGo'));
    expect(model.find('go')!.events).toEqual({ click: 'onGo' });
    await run(commands.setEvent('name', 'change', 'onNameChanged'));
    expect(model.find('name')!.events).toEqual({ change: 'onNameChanged' });
    await run(commands.setEvent('name', 'change', undefined));
    expect(model.find('name')!.events).toBeUndefined();
  });

  it('setBinding sets, changes and removes a binding', async () => {
    const { run, model } = setup();
    await run(commands.setBinding('go', 'disabled', 'dsEmp.name'));
    expect(model.find('go')!.bind).toEqual({ disabled: 'dsEmp.name' });
    await run(commands.setBinding('name', 'value', undefined));
    expect(model.find('name')!.bind).toBeUndefined();
  });

  it('an unknown component id is rejected', async () => {
    const { model, host } = setup();
    const result = await model.apply(commands.move('nope', 1, 1));
    expect(result).toMatchObject({ status: 'rejected' });
    expect(host.calls).toEqual([]);
  });

  it('a move of zero, or a no-op prop change, writes nothing', async () => {
    const { model, host } = setup();
    expect((await model.apply(commands.move('title', 0, 0))).status).toBe('unchanged');
    expect((await model.apply(commands.setProp('title', 'text', 'Employees'))).status).toBe('unchanged');
    expect((await model.apply(commands.setProp('title', 'nothing', undefined))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('passes the label to the host', async () => {
    const { model, host } = setup();
    await model.apply(commands.move('title', 1, 0));
    expect(host.calls[0]?.label).toBe('Move title');
  });

  it('keeps the rest of the file as it was, such as CRLF line endings', async () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const { model, host } = setup(crlf);
    await model.apply(commands.move('title', 8, 0));
    expect(host.text).toBe(crlf.replace('"left": 16, "top": 16, "width": 200', '"left": 24, "top": 16, "width": 200'));
  });
});
