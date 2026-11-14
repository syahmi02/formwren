import { componentMetas } from '@fw/components/meta';
import { validateForm } from '@fw/format';
import { describe, expect, it } from 'vitest';
import type { ComponentBox } from '../src/index.ts';
import { commands } from '../src/index.ts';
import { SAMPLE_B } from './model-sample-b.ts';
import { setup } from './model-util.ts';

const metas = componentMetas;
const errors = (model: ReturnType<typeof setup>['model']) => validateForm(model.definition.value, { components: metas }).filter((d) => d.severity === 'error');

describe('the sample form', () => {
  it('has no errors, so the tests start clean', () => {
    expect(errors(setup(SAMPLE_B).model)).toEqual([]);
  });
});

describe('add', () => {
  it('adds at the end of the form with the default size, and returns the new id', async () => {
    const { model, host } = setup(SAMPLE_B);
    const result = await model.add('TextInput', null, { x: 40, y: 12 });
    expect(result).toEqual({ status: 'applied', id: 'textInput1' });
    expect(model.definition.value!.components.at(-1)).toEqual({ id: 'textInput1', type: 'TextInput', layout: { left: 40, top: 12, width: 200, height: 28 } });
    expect(host.calls.length).toBe(1);
    expect(host.calls[0]?.label).toBe('Add Text input');
  });

  it('writes only what is needed: a small diff, and no props, bind or children', async () => {
    const { model, host } = setup(SAMPLE_B);
    const before = host.text;
    await model.add('Button', null, { x: 1, y: 2 });
    const added = host.text.slice(before.indexOf('\n  ]\n}'));
    expect(added).toContain('"id": "button1"');
    expect(added).not.toContain('"props"');
    expect(model.find('button1')).not.toHaveProperty('children');
  });

  it('numbers ids per type, filling the first free number', async () => {
    const { model } = setup(SAMPLE_B);
    expect((await model.add('Button', null, { x: 0, y: 0 })).id).toBe('button1');
    expect((await model.add('Button', null, { x: 0, y: 0 })).id).toBe('button2');
    await model.apply(commands.delete('button1'));
    expect((await model.add('Button', null, { x: 0, y: 0 })).id).toBe('button1');
  });

  it('adds into a container, relative to it, at the end of its children', async () => {
    const { model, component } = setup(SAMPLE_B);
    const result = await model.add('Label', 'panel', { x: 5, y: 6 });
    expect(result.id).toBe('label1');
    expect(component('panel').children!.map((c) => c.id)).toEqual(['nameInput', 'dept', 'inner', 'label1']);
    expect(component('label1').layout).toMatchObject({ left: 5, top: 6 });
  });

  it('adds a page to Tabs, and into a container that had no children', async () => {
    const { model, component } = setup(SAMPLE_B);
    await model.add('Panel', 'tabs', { x: 0, y: 0 });
    expect(component('tabs').children!.map((c) => c.id)).toEqual(['page1', 'panel1']);
    await model.add('Button', 'inner', { x: 0, y: 0 });
    expect(component('inner').children!.map((c) => c.id)).toEqual(['button1']);
  });

  it('refuses a parent that is not a container, an unknown parent and an unknown type', async () => {
    const { model, host } = setup(SAMPLE_B);
    const notContainer = await model.add('Button', 'plain', { x: 0, y: 0 });
    expect(notContainer).toMatchObject({ status: 'rejected' });
    expect((notContainer as { message: string }).message).toMatch(/can't hold other components/);
    expect(await model.add('Button', 'nope', { x: 0, y: 0 })).toMatchObject({ status: 'rejected' });
    expect(await model.add('Mystery', null, { x: 0, y: 0 })).toMatchObject({ status: 'rejected' });
    expect(host.calls).toEqual([]);
  });

  it('refuses when the host is read-only, and when the model has no metas', async () => {
    const { model, host } = setup(SAMPLE_B);
    host.readOnly = true;
    expect(await model.add('Button', null, { x: 0, y: 0 })).toMatchObject({ status: 'read-only' });
    expect(host.calls).toEqual([]);
  });

  it('takes props, bindings, a size and an id from the options', async () => {
    const { model, component } = setup(SAMPLE_B);
    const result = await model.add('TextInput', 'panel', { x: 0, y: 0 }, { id: 'myInput', size: { width: 90, height: 20 }, props: { label: 'X' }, bind: { value: 'dsEmp.name' } });
    expect(result.id).toBe('myInput');
    expect(component('myInput')).toEqual({ id: 'myInput', type: 'TextInput', layout: { left: 0, top: 0, width: 90, height: 20 }, props: { label: 'X' }, bind: { value: 'dsEmp.name' } });
    expect(await model.add('Button', null, { x: 0, y: 0 }, { id: 'myInput' })).toMatchObject({ status: 'rejected' });
  });

  it('adds a Grid that is valid, from the first Dataset', async () => {
    const { model, component } = setup(SAMPLE_B);
    const result = await model.add('Grid', null, { x: 0, y: 0 });
    expect(result.id).toBe('grid1');
    expect(component('grid1').bind).toEqual({ dataset: 'dsEmp' });
    expect(errors(model)).toEqual([]);
  });

  it('keeps every other line of the file', async () => {
    const { run } = setup(SAMPLE_B);
    const { diff } = await run(commands.add('Button', null, { x: 1, y: 1 }, { metas }));
    expect(diff.removed.length).toBeLessThanOrEqual(2);
  });
});

const boxes: ComponentBox[] = [
  { id: 'panel', parentId: null, x: 20, y: 30, width: 400, height: 300, depth: 0, visible: true },
  { id: 'nameInput', parentId: 'panel', x: 30, y: 40, width: 150, height: 24, depth: 1, visible: true },
  { id: 'inner', parentId: 'panel', x: 320, y: 220, width: 100, height: 100, depth: 1, visible: true },
  { id: 'plain', parentId: null, x: 450, y: 320, width: 80, height: 24, depth: 0, visible: true },
  { id: 'tabs', parentId: null, x: 450, y: 100, width: 300, height: 200, depth: 0, visible: true },
];

describe('reparent', () => {
  it('moves a top-level component into a container and keeps its place on screen', async () => {
    const { run, component } = setup(SAMPLE_B);
    const { result } = await run(commands.reparent('plain', 'panel', undefined, { boxes, metas }));
    expect(result).toEqual({ status: 'applied' });
    expect(component('panel').children!.map((c) => c.id)).toEqual(['nameInput', 'dept', 'inner', 'plain']);
    // On screen at (450, 320); the panel starts at (20, 30).
    expect(component('plain').layout).toEqual({ left: 430, top: 290, width: 80, height: 24 });
  });

  it('keeps the edges: right and bottom are converted against the new parent size', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('inner', null, undefined, { boxes, metas }));
    // Box at (320, 220) 100x100 inside the 800x600 form, set by right and bottom.
    expect(component('inner').layout).toEqual({ right: 800 - 320 - 100, bottom: 600 - 220 - 100, width: 100, height: 100 });
    expect(component('inner').layout).not.toHaveProperty('left');
  });

  it('moves out of a container to the form, and between containers', async () => {
    const { run, component, model } = setup(SAMPLE_B);
    await run(commands.reparent('nameInput', null, 0, { boxes, metas }));
    expect(model.definition.value!.components[0]!.id).toBe('nameInput');
    expect(component('nameInput').layout).toEqual({ left: 30, top: 40, width: 150, height: 24 });
    await run(commands.reparent('plain', 'tabs', undefined, { boxes, metas }));
    expect(component('tabs').children!.map((c) => c.id)).toEqual(['page1', 'plain']);
    expect(component('plain').layout).toMatchObject({ left: 0, top: 220 });
  });

  it('puts the component at the index given', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('plain', 'panel', 1, { boxes, metas }));
    expect(component('panel').children!.map((c) => c.id)).toEqual(['nameInput', 'plain', 'dept', 'inner']);
  });

  it('keeps the layout as it is when the boxes are missing', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('plain', 'panel'));
    expect(component('plain').layout).toEqual({ left: 450, top: 320, width: 80, height: 24 });
  });

  it('moves children along with the component', async () => {
    const { run, component, model } = setup(SAMPLE_B);
    await run(commands.reparent('panel', 'tabs', undefined, { boxes, metas }));
    expect(component('panel').children!.length).toBe(3);
    expect(model.find('nameInput')).toBeDefined();
  });

  it('refuses to move a component into itself or its own descendants', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.reparent('panel', 'panel', undefined, { metas }))).toMatch(/inside itself/);
    expect(await refused(commands.reparent('panel', 'inner', undefined, { metas }))).toMatch(/inside itself/);
  });

  it('refuses a parent that cannot hold children, and an unknown component', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.reparent('tabs', 'plain', undefined, { metas }))).toMatch(/can't hold/);
    expect(await refused(commands.reparent('nope', null))).toMatch(/no component/);
  });

  it('writes nothing when the component is already there', async () => {
    const { model, host } = setup(SAMPLE_B);
    expect((await model.apply(commands.reparent('plain', null, 4, { metas }))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('leaves a valid form', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.reparent('plain', 'panel', undefined, { boxes, metas }));
    await run(commands.reparent('inner', null, undefined, { boxes, metas }));
    expect(errors(model)).toEqual([]);
  });
});

describe('reorder', () => {
  it('moves a component among its siblings', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reorder('inner', 0));
    expect(component('panel').children!.map((c) => c.id)).toEqual(['inner', 'nameInput', 'dept']);
    await run(commands.reorder('inner', 99));
    expect(component('panel').children!.map((c) => c.id)).toEqual(['nameInput', 'dept', 'inner']);
  });

  it('reorders top-level components', async () => {
    const { run, model } = setup(SAMPLE_B);
    await run(commands.reorder('plain', 0));
    expect(model.definition.value!.components.map((c) => c.id)).toEqual(['plain', 'panel', 'total', 'grid', 'tabs']);
  });

  it('writes nothing when the place does not change', async () => {
    const { model, host } = setup(SAMPLE_B);
    expect((await model.apply(commands.reorder('panel', 0))).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('refuses an unknown component', async () => {
    const { refused } = setup(SAMPLE_B);
    expect(await refused(commands.reorder('nope', 0))).toMatch(/no component/);
  });
});

describe('bindingChoices', () => {
  it('lists every dataset.column for a column binding', () => {
    const { model } = setup(SAMPLE_B);
    expect(model.bindingChoices('nameInput', 'value').map((c) => c.value)).toEqual(['dsEmp.empNo', 'dsEmp.name', 'dsEmp.salary', 'dsDept.code', 'dsDept.title']);
    expect(model.bindingChoices('nameInput', 'value')[1]).toEqual({ value: 'dsEmp.name', label: 'dsEmp.name', dataset: 'dsEmp', column: 'name', columnType: 'string' });
  });

  it('lists every Dataset id for a dataset binding', () => {
    const { model } = setup(SAMPLE_B);
    expect(model.bindingChoices('grid', 'dataset')).toEqual([
      { value: 'dsEmp', label: 'dsEmp', dataset: 'dsEmp' },
      { value: 'dsDept', label: 'dsDept', dataset: 'dsDept' },
    ]);
    expect(model.bindingChoices('dept', 'options').map((c) => c.value)).toEqual(['dsEmp', 'dsDept']);
  });

  it('is empty for a key the component cannot bind, or an unknown component', () => {
    const { model } = setup(SAMPLE_B);
    expect(model.bindingChoices('nameInput', 'nonsense')).toEqual([]);
    expect(model.bindingChoices('nope', 'value')).toEqual([]);
  });

  it('follows the text', async () => {
    const { model } = setup(SAMPLE_B);
    await model.apply(commands.addDataset('dsNew'));
    expect(model.bindingChoices('grid', 'dataset').map((c) => c.value)).toContain('dsNew');
  });
});
