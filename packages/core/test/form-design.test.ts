import { effect } from '@preact/signals-core';
import { describe, expect, it } from 'vitest';
import { createForm, type ComponentDefinition, type FormDefinition, type FormInstance } from '../src/index.ts';

const box = { left: 0, top: 0, width: 100, height: 20 };

function node(id: string, type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return { id, type, layout: { ...box }, ...extra };
}

function form(components: ComponentDefinition[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { formatVersion: 1, id: 'design.Form', components, ...extra };
}

function design(def: FormDefinition): FormInstance {
  return createForm(def, { mode: 'design' });
}

function ids(models: readonly { id: string }[]): string[] {
  return models.map((model) => model.id);
}

const tree = (): FormDefinition =>
  form([
    node('a', 'Button', { props: { text: 'A' } }),
    node('panel', 'Panel', { children: [node('b', 'Button'), node('c', 'Button')] }),
    node('d', 'Button'),
  ]);

describe('applyDefinition', () => {
  it('is design mode only', () => {
    const run = createForm(tree());
    expect(() => run.applyDefinition(tree())).toThrow(/design mode/);
    expect(() => run.reveal(null)).toThrow(/design mode/);
  });

  it('keeps the model and identity of unchanged components, and applies new props', () => {
    const f = design(tree());
    const a = f.getComponent('a')!;
    const b = f.getComponent('b')!;
    const panel = f.getComponent('panel')!;
    const next = tree();
    (next.components[0] as ComponentDefinition).props = { text: 'Changed' };
    f.applyDefinition(next);
    expect(f.getComponent('a')).toBe(a);
    expect(f.getComponent('b')).toBe(b);
    expect(f.getComponent('panel')).toBe(panel);
    expect(a.props.value.text).toBe('Changed');
    expect(f.definition.value.components[0]?.props?.text).toBe('Changed');
  });

  it('is reactive: a changed definition notifies the component and the form', () => {
    const f = design(tree());
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(f.getComponent('a')!.props.value.text);
    });
    const next = tree();
    (next.components[0] as ComponentDefinition).props = { text: 'X' };
    f.applyDefinition(next);
    stop();
    expect(seen).toEqual(['A', 'X']);
  });

  it('does not touch a model whose definition did not change', () => {
    const f = design(tree());
    const d = f.getComponent('d')!;
    let runs = 0;
    const stop = effect(() => {
      void d.props.value;
      runs++;
    });
    f.applyDefinition(tree());
    stop();
    expect(runs).toBe(1);
  });

  it('creates new components, in nested places too', () => {
    const f = design(tree());
    const next = tree();
    next.components.push(node('e', 'TextInput'));
    (next.components[1] as ComponentDefinition).children!.push(node('f', 'Button'));
    f.applyDefinition(next);
    expect(ids(f.components.value)).toEqual(['a', 'panel', 'd', 'e']);
    expect(ids(f.getComponent('panel')!.children.value)).toEqual(['b', 'c', 'f']);
    expect(f.getComponent('f')).toBeDefined();
    expect(f.definition.value).toEqual(next);
  });

  it('disposes removed components with their children', () => {
    const f = design(tree());
    const next = form([node('a', 'Button'), node('d', 'Button')]);
    f.applyDefinition(next);
    expect(ids(f.components.value)).toEqual(['a', 'd']);
    expect(f.getComponent('panel')).toBeUndefined();
    expect(f.getComponent('b')).toBeUndefined();
    expect(f.getComponent('c')).toBeUndefined();
    expect(() => f.context.c.b).toThrow(/Unknown component/);
  });

  it('replaces the model when the type changes, and keeps its children', () => {
    const f = design(tree());
    const panel = f.getComponent('panel')!;
    const b = f.getComponent('b')!;
    const next = tree();
    (next.components[1] as ComponentDefinition).type = 'Tabs';
    f.applyDefinition(next);
    const replaced = f.getComponent('panel')!;
    expect(replaced).not.toBe(panel);
    expect(replaced.definition.value.type).toBe('Tabs');
    expect(f.getComponent('b')).toBe(b);
    expect(ids(replaced.children.value)).toEqual(['b', 'c']);
    expect(f.components.value[1]).toBe(replaced);
  });

  it('rebuilds the order of top-level components and of children', () => {
    const f = design(tree());
    const a = f.getComponent('a')!;
    const next = form([
      node('d', 'Button'),
      node('panel', 'Panel', { children: [node('c', 'Button'), node('b', 'Button')] }),
      node('a', 'Button', { props: { text: 'A' } }),
    ]);
    f.applyDefinition(next);
    expect(ids(f.components.value)).toEqual(['d', 'panel', 'a']);
    expect(ids(f.getComponent('panel')!.children.value)).toEqual(['c', 'b']);
    expect(f.getComponent('a')).toBe(a);
    expect(f.definition.value).toEqual(next);
  });

  it('re-parents without an id clash, keeping the model', () => {
    const f = design(tree());
    const b = f.getComponent('b')!;
    // b moves out to the top level, d moves into the panel, and c moves into d (now a Panel).
    const next = form([
      node('a', 'Button', { props: { text: 'A' } }),
      node('b', 'Button'),
      node('panel', 'Panel', { children: [node('d', 'Panel', { children: [node('c', 'Button')] })] }),
    ]);
    // d was a Button, so it becomes a new Panel model. c and b keep theirs.
    const c = f.getComponent('c')!;
    f.applyDefinition(next);
    expect(f.getComponent('b')).toBe(b);
    expect(f.getComponent('c')).toBe(c);
    expect(ids(f.components.value)).toEqual(['a', 'b', 'panel']);
    expect(ids(f.getComponent('panel')!.children.value)).toEqual(['d']);
    expect(ids(f.getComponent('d')!.children.value)).toEqual(['c']);
    expect(f.definition.value).toEqual(next);
  });

  it('moves a component into a sibling that comes earlier in the order', () => {
    const f = design(form([node('x', 'Button'), node('p', 'Panel', { children: [] }), node('q', 'Panel', { children: [node('y', 'Button')] })]));
    const y = f.getComponent('y')!;
    f.applyDefinition(form([node('x', 'Button'), node('p', 'Panel', { children: [node('y', 'Button')] }), node('q', 'Panel', { children: [] })]));
    expect(f.getComponent('y')).toBe(y);
    expect(ids(f.getComponent('p')!.children.value)).toEqual(['y']);
    expect(ids(f.getComponent('q')!.children.value)).toEqual([]);
  });

  it('refuses duplicate ids and leaves the form as it was', () => {
    const f = design(tree());
    const before = f.definition.value;
    const bad = form([node('a', 'Button'), node('a', 'Button')]);
    expect(() => f.applyDefinition(bad)).toThrow(/used twice/);
    expect(f.definition.value).toEqual(before);
    expect(ids(f.components.value)).toEqual(['a', 'panel', 'd']);
  });

  it('applies changes to the form itself: title, size, events', () => {
    const f = design(tree());
    f.applyDefinition({ ...tree(), title: 'New', size: { width: 400, height: 300 }, events: { init: 'onInit' } });
    expect(f.definition.value.title).toBe('New');
    expect(f.definition.value.size).toEqual({ width: 400, height: 300 });
  });

  it('keeps Datasets and component models when only components change', () => {
    const datasets = [{ id: 'ds', columns: [{ id: 'n', type: 'string' as const }], sampleRows: [{ n: 'x' }] }];
    const f = design(form([node('a', 'Button')], { datasets }));
    const ds = f.getDataset('ds');
    const a = f.getComponent('a')!;
    f.applyDefinition(form([node('a', 'Button'), node('b', 'Button')], { datasets: structuredClone(datasets) }));
    expect(f.getDataset('ds')).toBe(ds);
    expect(f.getComponent('a')).toBe(a);
  });

  it('rebuilds Datasets, and every model, when the Datasets change', () => {
    const f = design(
      form(
        [node('a', 'TextInput', { bind: { value: 'ds.n' } })],
        { datasets: [{ id: 'ds', columns: [{ id: 'n', type: 'string' }], sampleRows: [{ n: 'one' }] }] },
      ),
    );
    const a = f.getComponent('a')!;
    expect(a.props.value.value).toBe('one');
    const oldDs = f.getDataset('ds');
    f.applyDefinition(
      form(
        [node('a', 'TextInput', { bind: { value: 'ds.m' } })],
        { datasets: [{ id: 'ds', columns: [{ id: 'm', type: 'string' }], sampleRows: [{ m: 'two' }] }] },
      ),
    );
    expect(f.getDataset('ds')).not.toBe(oldDs);
    expect(f.context.ds.ds).toBe(f.getDataset('ds'));
    const rebuilt = f.getComponent('a')!;
    expect(rebuilt).not.toBe(a);
    expect(rebuilt.props.value.value).toBe('two');
  });

  it('adds and removes Datasets', () => {
    const f = design(form([node('a', 'Button')]));
    expect(f.getDataset('ds')).toBeUndefined();
    f.applyDefinition(form([node('a', 'Button')], { datasets: [{ id: 'ds', columns: [{ id: 'n', type: 'string' }] }] }));
    expect(f.getDataset('ds')).toBeDefined();
    expect(Object.keys(f.context.ds)).toEqual(['ds']);
    f.applyDefinition(form([node('a', 'Button')]));
    expect(f.getDataset('ds')).toBeUndefined();
    expect(Object.keys(f.context.ds)).toEqual([]);
  });

  it('updates variables, which expressions read', () => {
    const f = design(form([node('a', 'Label', { props: { text: '=vars.n' } })], { variables: { n: { type: 'int', default: 1 } } }));
    expect(f.getComponent('a')!.props.value.text).toBe(1);
    f.applyDefinition(form([node('a', 'Label', { props: { text: '=vars.n' } })], { variables: { n: { type: 'int', default: 5 } } }));
    expect(f.getComponent('a')!.props.value.text).toBe(5);
  });

  it('follows a changed form id', () => {
    const f = design(tree());
    f.applyDefinition({ ...tree(), id: 'design.Other' });
    expect(f.id).toBe('design.Other');
  });

  it('survives many random edits and always matches the target', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const random = (): FormDefinition => {
      const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].sort(() => rand(3) - 1);
      const take = pool.slice(0, 2 + rand(5));
      const comps: ComponentDefinition[] = [];
      const containers: ComponentDefinition[] = [];
      for (const id of take) {
        const container = rand(3) === 0;
        const def = node(id, container ? 'Panel' : 'Button', container ? { children: [] } : {});
        const host = containers[rand(containers.length + 1)];
        (host ? host.children! : comps).push(def);
        if (container) containers.push(def);
      }
      return form(comps);
    };
    const f = design(random());
    for (let i = 0; i < 200; i++) {
      const next = random();
      f.applyDefinition(next);
      expect(f.definition.value.components).toEqual(next.components);
      const all: string[] = [];
      const walk = (list: ComponentDefinition[]): void => {
        for (const c of list) {
          all.push(c.id);
          expect(f.getComponent(c.id)).toBeDefined();
          walk(c.children ?? []);
        }
      };
      walk(next.components);
      expect(all.length).toBe(new Set(all).size);
    }
  });
});

describe('reveal', () => {
  const revealForm = (): FormDefinition =>
    form([
      node('tabs', 'Tabs', {
        props: { selectedIndex: 0 },
        children: [
          node('p1', 'Panel', { children: [node('x', 'Button')] }),
          node('p2', 'Panel', { children: [node('y', 'Button'), node('inner', 'Tabs', { children: [node('q1', 'Panel'), node('q2', 'Panel', { children: [node('deep', 'Button')] })] })] }),
        ],
      }),
      node('dlg', 'Dialog', { props: { open: false }, children: [node('inDlg', 'Button')] }),
      node('free', 'Button'),
    ]);

  it('selects the Tabs page that holds a component, without writing the definition', () => {
    const f = design(revealForm());
    const before = structuredClone(f.definition.value);
    f.reveal('y');
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(1);
    expect(f.definition.value).toEqual(before);
    expect(f.getComponent('tabs')!.definition.value.props?.selectedIndex).toBe(0);
  });

  it('reveals the page itself, and nested Tabs on the way down', () => {
    const f = design(revealForm());
    f.reveal('p2');
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(1);
    f.reveal('deep');
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(1);
    expect(f.getComponent('inner')!.props.value.selectedIndex).toBe(1);
  });

  it('shows a Dialog that holds the component, or is the component', () => {
    const f = design(revealForm());
    f.reveal('inDlg');
    expect(f.getComponent('dlg')!.props.value.open).toBe(true);
    f.reveal('free');
    expect(f.getComponent('dlg')!.props.value.open).toBe(false);
    f.reveal('dlg');
    expect(f.getComponent('dlg')!.props.value.open).toBe(true);
  });

  it('null restores the definition, and moving the reveal restores the previous one', () => {
    const f = design(revealForm());
    f.reveal('deep');
    f.reveal('x');
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(0);
    expect(f.getComponent('inner')!.props.value.selectedIndex).toBeUndefined();
    f.reveal('inDlg');
    f.reveal(null);
    expect(f.getComponent('dlg')!.props.value.open).toBe(false);
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(0);
  });

  it('wins over a binding and an expression, and is reactive', () => {
    const f = design(form([node('tabs', 'Tabs', { props: { selectedIndex: '=1 - 1' }, children: [node('p1', 'Panel'), node('p2', 'Panel')] })]));
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(f.getComponent('tabs')!.props.value.selectedIndex);
    });
    f.reveal('p2');
    f.reveal(null);
    stop();
    expect(seen).toEqual([0, 1, 0]);
  });

  it('throws for an unknown id and changes nothing', () => {
    const f = design(revealForm());
    f.reveal('y');
    expect(() => f.reveal('nope')).toThrow(/Unknown component/);
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(1);
  });

  it('survives applyDefinition: kept, moved or removed', () => {
    const f = design(revealForm());
    f.reveal('y');
    f.applyDefinition(revealForm());
    expect(f.getComponent('tabs')!.props.value.selectedIndex).toBe(1);
    const gone = revealForm();
    gone.components.shift();
    f.applyDefinition(gone);
    expect(f.getComponent('dlg')!.props.value.open).toBe(false);
    // A replaced model shows the reveal again.
    f.reveal('inDlg');
    const retyped = revealForm();
    (retyped.components[1] as ComponentDefinition).type = 'Dialog';
    (retyped.components[1] as ComponentDefinition).props = { open: false, title: 'T' };
    f.applyDefinition(retyped);
    expect(f.getComponent('dlg')!.props.value.open).toBe(true);
  });
});
