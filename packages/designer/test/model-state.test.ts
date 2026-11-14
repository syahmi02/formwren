import { describe, expect, it } from 'vitest';
import { commands, createDesignerModel } from '../src/index.ts';
import { SAMPLE, memoryHost } from './model-host.ts';

describe('parsing and status', () => {
  it('parses the text and is writable', () => {
    const model = createDesignerModel(memoryHost(SAMPLE));
    expect(model.status.value).toEqual({ status: 'ok' });
    expect(model.definition.value?.id).toBe('demo.Form');
    expect(model.readOnly.value).toBe(false);
    expect(model.readOnlyReason.value).toBeNull();
  });

  it('is read-only for invalid JSON, with a line and column, and refuses to write', async () => {
    const host = memoryHost(SAMPLE.replace('"id": "title",', '"id": "title" "x": 1,'));
    const model = createDesignerModel(host);
    const status = model.status.value;
    expect(status.status).toBe('invalid');
    if (status.status === 'invalid') {
      expect(status.line).toBeGreaterThan(0);
      expect(status.column).toBeGreaterThan(0);
      expect(status.message).toMatch(/Line/);
    }
    expect(model.readOnly.value).toBe(true);
    expect(model.definition.value).toBeNull();
    const result = await model.apply(commands.move('title', 1, 1));
    expect(result.status).toBe('read-only');
    expect(host.calls).toEqual([]);
  });

  it('is read-only for merge conflicts', async () => {
    const host = memoryHost(`<<<<<<< HEAD\n${SAMPLE}=======\n${SAMPLE}>>>>>>> other\n`);
    const model = createDesignerModel(host);
    expect(model.status.value.status).toBe('conflict');
    expect(model.readOnly.value).toBe(true);
    expect((await model.apply(commands.move('title', 1, 1))).status).toBe('read-only');
    expect(host.calls).toEqual([]);
  });

  it('is read-only when the host is, though the text is fine', async () => {
    const host = memoryHost(SAMPLE);
    host.readOnly = true;
    const model = createDesignerModel(host);
    expect(model.status.value.status).toBe('ok');
    expect(model.readOnly.value).toBe(true);
    expect(model.readOnlyReason.value).toMatch(/read-only/);
    expect((await model.apply(commands.move('title', 1, 1))).status).toBe('read-only');
    expect(host.calls).toEqual([]);
  });

  it('recovers when the text becomes valid, and keeps the last good form while it is not', () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    host.setText('{ broken');
    expect(model.status.value.status).toBe('invalid');
    expect(model.readOnly.value).toBe(true);
    expect(model.definition.value?.id).toBe('demo.Form');
    host.setText(SAMPLE.replace('demo.Form', 'demo.Other'));
    expect(model.status.value).toEqual({ status: 'ok' });
    expect(model.definition.value?.id).toBe('demo.Other');
    expect(model.readOnly.value).toBe(false);
  });

  it('follows an outside text change and uses the new text for the next command', async () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    host.setText(SAMPLE.replace('"left": 16, "top": 16', '"left": 50, "top": 16'));
    expect(model.find('title')!.layout.left).toBe(50);
    await model.apply(commands.move('title', 1, 0));
    expect(model.find('title')!.layout.left).toBe(51);
  });

  it('notices text changed behind its back when a command runs', async () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    host.text = SAMPLE.replace('"left": 16, "top": 16', '"left": 60, "top": 16');
    await model.apply(commands.move('title', 1, 0));
    expect(model.find('title')!.layout.left).toBe(61);
  });

  it('re-reads after the host refuses', async () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    host.refuseNext = true;
    const result = await model.apply(commands.move('title', 1, 0));
    expect(result.status).toBe('refused');
    expect(model.find('title')!.layout.left).toBe(16);
  });

  it('stops listening after dispose', () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    model.dispose();
    host.setText(SAMPLE.replace('demo.Form', 'demo.Other'));
    expect(model.definition.value?.id).toBe('demo.Form');
  });
});

describe('diagnostics', () => {
  const metas = {
    Label: {
      type: 'Label',
      displayName: 'Label',
      category: 'display' as const,
      container: false,
      defaultSize: { width: 100, height: 24 },
      props: { text: { kind: 'string' as const, description: 'Text.' } },
      bindings: {},
      events: {},
    },
  };

  it('is empty for a good form, and has entries for a bad one', () => {
    const good = createDesignerModel(memoryHost(SAMPLE));
    expect(good.diagnostics.value.filter((d) => d.severity === 'error')).toEqual([]);
    const host = memoryHost(SAMPLE.replace('"text": "Employees"', '"text": "Employees", "nonsense": 1'));
    const model = createDesignerModel(host, { metas });
    expect(model.diagnostics.value.some((d) => d.message.includes('nonsense'))).toBe(true);
  });

  it('links diagnostics to a component and not to the ones inside it', () => {
    const host = memoryHost(SAMPLE.replace('"text": "Employees"', '"text": "Employees", "nonsense": 1').replace('"text": "Go"', '"text": "Go", "oops": 1'));
    const model = createDesignerModel(host, { metas: { ...metas, Button: { ...metas.Label, type: 'Button', displayName: 'Button' } } });
    expect(model.diagnosticsOf('title').some((d) => d.message.includes('nonsense'))).toBe(true);
    expect(model.diagnosticsOf('other')).toEqual([]);
    // "go" is inside "box", so box doesn't report it.
    expect(model.diagnosticsOf('go').some((d) => d.message.includes('oops'))).toBe(true);
    expect(model.diagnosticsOf('box').some((d) => d.message.includes('oops'))).toBe(false);
  });

  it('is empty while the file is read-only', () => {
    const model = createDesignerModel(memoryHost('{ broken'), { metas });
    expect(model.diagnostics.value).toEqual([]);
  });
});

describe('selection', () => {
  it('holds a list, ignores unknown ids and duplicates, and clears', () => {
    const model = createDesignerModel(memoryHost(SAMPLE));
    model.select(['go']);
    expect(model.selection.value).toEqual(['go']);
    model.select(['title', 'nope', 'title', 'name']);
    expect(model.selection.value).toEqual(['title', 'name']);
    model.clearSelection();
    expect(model.selection.value).toEqual([]);
  });

  it('keeps the same array when nothing changes', () => {
    const model = createDesignerModel(memoryHost(SAMPLE));
    model.select(['go']);
    const first = model.selection.value;
    model.select(['go']);
    expect(model.selection.value).toBe(first);
  });

  it('drops ids that disappear after an outside text change', () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    model.select(['go', 'title']);
    host.setText(SAMPLE.replace('"id": "go"', '"id": "gone"'));
    expect(model.selection.value).toEqual(['title']);
  });

  it('drops ids after the designer renames or deletes them, and after undo restores them nothing comes back', async () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    model.select(['title', 'go']);
    await model.apply(commands.delete('box'));
    expect(model.selection.value).toEqual(['title']);
    await model.apply(commands.setId('title', 'heading'));
    expect(model.selection.value).toEqual([]);
    host.setText(SAMPLE);
    expect(model.selection.value).toEqual([]);
  });

  it('keeps the selection while the text is invalid', () => {
    const host = memoryHost(SAMPLE);
    const model = createDesignerModel(host);
    model.select(['go']);
    host.setText('{ broken');
    expect(model.selection.value).toEqual(['go']);
    host.setText(SAMPLE);
    expect(model.selection.value).toEqual(['go']);
  });
});

describe('nudge', () => {
  function nudger(canMerge = true) {
    const host = memoryHost(SAMPLE);
    host.canMergeEdits = canMerge;
    let time = 1000;
    const model = createDesignerModel(host, { now: () => time });
    return {
      host,
      model,
      at: (ms: number) => {
        time = ms;
      },
    };
  }

  it('does nothing without a selection', async () => {
    const { model, host } = nudger();
    expect((await model.nudge(1, 0)).status).toBe('unchanged');
    expect(host.calls).toEqual([]);
  });

  it('moves the whole selection', async () => {
    const { model, host } = nudger();
    model.select(['title', 'other']);
    await model.nudge(1, 8);
    expect(model.find('title')!.layout).toMatchObject({ left: 17, top: 24 });
    expect(model.find('other')!.layout).toMatchObject({ left: 401, top: 24 });
    expect(host.calls.length).toBe(1);
  });

  it('merges a burst within 500 ms into one undo step', async () => {
    const { model, host, at } = nudger();
    model.select(['title']);
    await model.nudge(1, 0);
    at(1300);
    await model.nudge(1, 0);
    at(1700);
    await model.nudge(1, 0);
    expect(model.find('title')!.layout.left).toBe(19);
    expect(host.calls.map((c) => c.options?.mergeWithPrevious ?? false)).toEqual([false, true, true]);
  });

  it('starts a new step after a pause of more than 500 ms', async () => {
    const { model, host, at } = nudger();
    model.select(['title']);
    await model.nudge(1, 0);
    at(1501);
    await model.nudge(1, 0);
    expect(host.calls.map((c) => c.options?.mergeWithPrevious ?? false)).toEqual([false, false]);
  });

  it('starts a new step for a different selection', async () => {
    const { model, host } = nudger();
    model.select(['title']);
    await model.nudge(1, 0);
    model.select(['other']);
    await model.nudge(1, 0);
    expect(host.calls.map((c) => c.options?.mergeWithPrevious ?? false)).toEqual([false, false]);
  });

  it('starts a new step after any other change to the text, such as undo', async () => {
    const { model, host } = nudger();
    model.select(['title']);
    await model.nudge(1, 0);
    host.setText(SAMPLE);
    await model.nudge(1, 0);
    expect(host.calls.map((c) => c.options?.mergeWithPrevious ?? false)).toEqual([false, false]);
  });

  it('starts a new step after another command', async () => {
    const { model, host } = nudger();
    model.select(['title']);
    await model.nudge(1, 0);
    await model.apply(commands.setProp('title', 'text', 'X'));
    await model.nudge(1, 0);
    expect(host.calls.map((c) => c.options?.mergeWithPrevious ?? false)).toEqual([false, false, false]);
  });

  it('makes separate steps when the host cannot merge, and still moves correctly', async () => {
    const { model, host } = nudger(false);
    model.select(['title']);
    await model.nudge(1, 0);
    await model.nudge(1, 0);
    expect(host.calls.map((c) => c.options)).toEqual([undefined, undefined]);
    expect(model.find('title')!.layout.left).toBe(18);
  });

  it('applies nudges fired without waiting in order', async () => {
    const { model, host } = nudger();
    model.select(['title']);
    const all = await Promise.all([model.nudge(1, 0), model.nudge(1, 0), model.nudge(1, 0)]);
    expect(all.every((r) => r.status === 'applied')).toBe(true);
    expect(model.find('title')!.layout.left).toBe(19);
    expect(host.calls.length).toBe(3);
  });

  it('does not write when read-only', async () => {
    const { model, host } = nudger();
    model.select(['title']);
    host.readOnly = true;
    expect((await model.nudge(1, 0)).status).toBe('read-only');
    expect(host.calls).toEqual([]);
  });
});
