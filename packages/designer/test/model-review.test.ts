import { describe, expect, it } from 'vitest';
import { commands, componentIds, findComponent, type ComponentBox } from '../src/index.ts';
import { SAMPLE, memoryHost } from './model-host.ts';
import { SAMPLE_B } from './model-sample-b.ts';
import { createDesignerModel } from '../src/index.ts';
import { componentMetas } from '@fw/components/meta';
import { setup } from './model-util.ts';

const metas = componentMetas;

describe('a file with the wrong shape', () => {
  const noComponents = '{\n  "formatVersion": 1,\n  "id": "a.B"\n}\n';
  const badChildren = SAMPLE.replace('"children": [', '"children": {}, "was": [');

  it('is invalid and read-only, with a reason, a line and a column, and does not throw', () => {
    const model = createDesignerModel(memoryHost(noComponents));
    const status = model.status.value;
    expect(status.status).toBe('invalid');
    if (status.status === 'invalid') {
      expect(status.message).toMatch(/components/);
      expect(status.line).toBeGreaterThan(0);
    }
    expect(model.readOnly.value).toBe(true);
    expect(model.definition.value).toBeNull();
  });

  it('is invalid for children that are not a list, pointing at them', () => {
    const model = createDesignerModel(memoryHost(badChildren));
    const status = model.status.value;
    expect(status.status).toBe('invalid');
    if (status.status === 'invalid') expect(status.message).toMatch(/children/);
  });

  it('does not crash when the text changes to a wrong shape, and recovers when fixed', async () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    model.select(['go']);
    expect(() => host.setText(noComponents)).not.toThrow();
    expect(model.status.value.status).toBe('invalid');
    expect(model.readOnly.value).toBe(true);
    expect(model.selection.value).toEqual(['go']);
    expect((await model.apply(commands.move('title', 1, 1))).status).toBe('read-only');
    host.setText(SAMPLE);
    expect(model.status.value).toEqual({ status: 'ok' });
    expect(model.readOnly.value).toBe(false);
    expect((await model.apply(commands.move('title', 1, 1))).status).toBe('applied');
  });

  it('never throws from the tree walks', () => {
    const odd = { formatVersion: 1, id: 'x', components: [null, { id: 'a', type: 'T', layout: {}, children: {} }, { id: 'b', children: [3, { id: 'c' }] }] } as never;
    expect(componentIds(odd)).toEqual(['a', 'b', 'c']);
    expect(findComponent(odd, 'c')?.path).toBe('components[2].children[1]');
    expect(componentIds({} as never)).toEqual([]);
    expect(findComponent({ components: 'no' } as never, 'a')).toBeUndefined();
  });
});

const boxes = (extra: Partial<ComponentBox> = {}): ComponentBox[] => [
  { id: 'panel', parentId: null, x: 20, y: 30, width: 400, height: 300, depth: 0, visible: true, content: { x: 21, y: 55, width: 398, height: 274 }, ...extra },
  { id: 'plain', parentId: null, x: 450, y: 320, width: 80, height: 24, depth: 0, visible: true },
  { id: 'inner', parentId: 'panel', x: 300, y: 200, width: 100, height: 100, depth: 1, visible: true },
  { id: 'tabs', parentId: null, x: 450, y: 100, width: 300, height: 200, depth: 0, visible: true, content: { x: 450, y: 130, width: 300, height: 170 } },
  { id: 'page1', parentId: 'tabs', x: 0, y: 0, width: 0, height: 0, depth: 1, visible: false },
];

describe('reparent frames', () => {
  it('uses the container content box, not its outer box', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('plain', 'panel', undefined, { boxes: boxes(), metas }));
    // On screen at (450, 320); the content area starts at (21, 55).
    expect(component('plain').layout).toEqual({ left: 429, top: 265, width: 80, height: 24 });
  });

  it('converts right and bottom against the content size', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('inner', null, undefined, { boxes: boxes(), metas, formSize: { width: 1000, height: 700 } }));
    expect(component('inner').layout).toEqual({ right: 1000 - 300 - 100, bottom: 700 - 200 - 100, width: 100, height: 100 });
    await run(commands.reparent('inner', 'panel', undefined, { boxes: [...boxes().filter((b) => b.id !== 'inner'), { id: 'inner', parentId: null, x: 300, y: 200, width: 100, height: 100, depth: 0, visible: true }], metas }));
    expect(component('inner').layout).toEqual({ right: 398 - (300 - 21) - 100, bottom: 274 - (200 - 55) - 100, width: 100, height: 100 });
  });

  it('falls back to the outer box when there is no content box', async () => {
    const { run, component } = setup(SAMPLE_B);
    const plain = boxes().map((b) => (b.id === 'panel' ? { ...b, content: undefined } : b));
    await run(commands.reparent('plain', 'panel', undefined, { boxes: plain, metas }));
    expect(component('plain').layout).toMatchObject({ left: 430, top: 290 });
  });

  it('keeps the layout when the new parent is hidden', async () => {
    const { run, component } = setup(SAMPLE_B);
    await run(commands.reparent('plain', 'page1', undefined, { boxes: boxes(), metas }));
    expect(component('plain').layout).toEqual({ left: 450, top: 320, width: 80, height: 24 });
    expect(component('page1').children!.map((c) => c.id)).toEqual(['plain']);
  });

  it('keeps the layout when the component itself is hidden', async () => {
    const { run, component } = setup(SAMPLE_B);
    const hidden = boxes().map((b) => (b.id === 'plain' ? { ...b, visible: false } : b));
    await run(commands.reparent('plain', 'panel', undefined, { boxes: hidden, metas }));
    expect(component('plain').layout).toEqual({ left: 450, top: 320, width: 80, height: 24 });
  });

  it('uses formSize for the form itself, ahead of form.size, and without form.size', async () => {
    const withSize = setup(SAMPLE_B);
    await withSize.run(commands.reparent('inner', null, undefined, { boxes: boxes(), metas, formSize: { width: 1200, height: 900 } }));
    expect(withSize.component('inner').layout.right).toBe(1200 - 300 - 100);
    const noSize = setup(SAMPLE_B.replace('  "size": { "width": 800, "height": 600 },\n', ''));
    expect(noSize.model.definition.value!.size).toBeUndefined();
    await noSize.run(commands.reparent('inner', null, undefined, { boxes: boxes(), metas, formSize: { width: 1200, height: 900 } }));
    expect(noSize.component('inner').layout).toEqual({ right: 800, bottom: 600, width: 100, height: 100 });
    // Neither: the layout is kept.
    const neither = setup(SAMPLE_B.replace('  "size": { "width": 800, "height": 600 },\n', ''));
    await neither.run(commands.reparent('inner', null, undefined, { boxes: boxes(), metas }));
    expect(neither.component('inner').layout).toEqual({ right: 10, bottom: 10, width: 100, height: 100 });
  });
});
