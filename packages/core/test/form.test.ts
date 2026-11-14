import { effect } from '@preact/signals-core';
import { TransactionError } from '../src/tx/contract.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  createForm,
  defineForm,
  openForm,
  type ComponentDefinition,
  type CreateFormOptions,
  type FormDefinition,
  type FormHandler,
  type FormInstance,
  type FormModule,
} from '../src/index.ts';

function definition(extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    formatVersion: 1,
    id: 'test.Form',
    params: { deptCode: { type: 'string', default: 'D1' }, other: { type: 'int' } },
    events: { init: 'onInit', beforeClose: 'onBeforeClose', close: 'onClose' },
    variables: { busy: { type: 'boolean', default: false }, count: { type: 'int', default: 2 } },
    datasets: [
      {
        id: 'dsEmp',
        keys: ['empNo'],
        confirmUnsaved: true,
        columns: [
          { id: 'empNo', type: 'string' },
          { id: 'name', type: 'string' },
          { id: 'salary', type: 'decimal' },
          { id: 'qty', type: 'int' },
          { id: 'ratio', type: 'float' },
          { id: 'active', type: 'boolean' },
          { id: 'hiredOn', type: 'date' },
        ],
        initialRows: [
          { empNo: 'E1', name: 'Ann', salary: '100', qty: 1, active: true },
          { empNo: 'E2', name: 'Bob', salary: '250.50', qty: 2, active: false },
        ],
        sampleRows: [{ empNo: 'S1', name: 'Sample' }],
      },
      { id: 'dsEmpty', columns: [{ id: 'x', type: 'string' }] },
    ],
    components: [
      {
        id: 'nameInput',
        type: 'TextInput',
        layout: { left: 0, top: 0 },
        props: { label: 'Name' },
        bind: { value: 'dsEmp.name' },
        events: { change: 'onChange' },
      },
      {
        id: 'button',
        type: 'Button',
        layout: {},
        props: { text: 'Go', disabled: '=vars.busy', note: '=vars.count * 2' },
        events: { click: 'onClick' },
      },
      {
        id: 'panel',
        type: 'Panel',
        layout: {},
        children: [{ id: 'inner', type: 'TextInput', layout: {}, bind: { value: 'dsEmp.salary' } }],
      },
    ],
    ...extra,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function make(
  handlers: Record<string, FormHandler> = {},
  options: Partial<CreateFormOptions> = {},
  def: FormDefinition = definition(),
) {
  const errors: { error: unknown; where: string }[] = [];
  const module: FormModule = { setup: () => handlers as never };
  const form = createForm(def, {
    module,
    onError: (error, where) => errors.push({ error, where }),
    ...options,
  });
  return { form, errors };
}

function model(form: FormInstance, id: string) {
  const found = form.getComponent(id);
  if (!found) throw new Error(`no component ${id}`);
  return found;
}

function bound(column: string): ComponentDefinition {
  return { id: 'w', type: 'TextInput', layout: {}, bind: { value: `dsEmp.${column}` } };
}

describe('datasets, variables and params', () => {
  it('builds Datasets from initialRows in run mode and sampleRows in design mode', () => {
    const run = make().form;
    expect(run.context.ds.dsEmp.rowCount).toBe(2);
    expect(run.context.ds.dsEmp.keys).toEqual(['empNo']);
    expect(run.context.ds.dsEmp.confirmUnsaved).toBe(true);
    const design = make({}, { mode: 'design' }).form;
    expect(design.context.ds.dsEmp.getValue(0, 'name')).toBe('Sample');
  });

  it('keeps variables in signals and throws on undeclared names', () => {
    const { form } = make();
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(form.context.vars.busy);
    });
    form.context.vars.busy = true;
    stop();
    expect(seen).toEqual([false, true]);
    expect(form.context.vars.count).toBe(2);
    expect(() => form.context.vars.nope).toThrow(/Unknown variable "nope"/);
    expect(() => {
      form.context.vars.nope = 1;
    }).toThrow(/Unknown variable/);
  });

  it('applies param defaults and is read-only', () => {
    const { form } = make({}, { params: { other: 7 } });
    expect(form.context.params.deptCode).toBe('D1');
    expect(form.context.params.other).toBe(7);
    expect(() => {
      form.context.params.deptCode = 'x';
    }).toThrow(/read-only/);
    expect(() => form.context.params.missing).toThrow(/Unknown param/);
    expect(make({}, { params: { deptCode: 'D9' } }).form.context.params.deptCode).toBe('D9');
  });
});

describe('props and bindings', () => {
  it('evaluates expressions and follows variables', () => {
    const { form, errors } = make();
    const button = model(form, 'button');
    expect(button.props.value).toEqual({ text: 'Go', disabled: false, note: 4 });
    form.context.vars.busy = true;
    form.context.vars.count = 5;
    expect(button.props.value).toEqual({ text: 'Go', disabled: true, note: 10 });
    expect(errors).toEqual([]);
  });

  it('follows the current row of a bound Dataset', async () => {
    const { form } = make();
    const input = model(form, 'nameInput');
    expect(input.props.value.value).toBe('Ann');
    expect(input.props.value.disabled).toBeUndefined();
    form.context.ds.dsEmp.setCurrentIndex(1);
    expect(input.props.value.value).toBe('Bob');
    // A cell edit made outside write() reaches props once the invalidation is delivered.
    form.context.ds.dsEmp.setValue(1, 'name', 'Bobby');
    await tick();
    expect(input.props.value.value).toBe('Bobby');
    expect(model(form, 'inner').props.value.value).toBe('250.50');
  });

  it('gives null and disabled with no current row', () => {
    const { form } = make();
    form.context.ds.dsEmp.load([]);
    const props = model(form, 'nameInput').props.value;
    expect(props.value).toBeNull();
    expect(props.disabled).toBe(true);
  });

  it('reads current row, $currentIndex, $rowCount and aggregates in expressions', async () => {
    const def = definition();
    def.components = [
      {
        id: 'probe',
        type: 'Label',
        layout: {},
        props: {
          who: '=ds.dsEmp.name',
          at: '=ds.dsEmp.$currentIndex',
          n: '=ds.dsEmp.$rowCount',
          total: '=sum(ds.dsEmp.salary)',
          maxQty: '=max(ds.dsEmp.qty)',
          p: '=params.deptCode',
        },
      },
    ];
    const { form, errors } = make({}, {}, def);
    const probe = model(form, 'probe');
    expect(probe.props.value).toEqual({ who: 'Ann', at: 0, n: 2, total: '350.50', maxQty: 2, p: 'D1' });
    form.context.ds.dsEmp.setCurrentIndex(1);
    expect(probe.props.value.who).toBe('Bob');
    expect(probe.props.value.at).toBe(1);
    form.context.ds.dsEmp.addRow({ name: 'Cy', salary: '1', qty: 9 });
    await tick();
    expect(probe.props.value.n).toBe(3);
    expect(probe.props.value.total).toBe('351.50');
    expect(probe.props.value.maxQty).toBe(9);
    expect(errors).toEqual([]);
  });

  it('returns the same object until a value changes (shallow-equal cut-off)', async () => {
    const { form } = make();
    const button = model(form, 'button');
    const first = button.props.value;
    form.context.vars.busy = false; // same value
    expect(button.props.value).toBe(first);

    const input = model(form, 'nameInput');
    const before = input.props.value;
    // Another column of the same row changes: the props of this component don't.
    form.context.ds.dsEmp.setValue(0, 'qty', 50);
    await tick();
    expect(input.props.value).toBe(before);

    let runs = 0;
    const stop = effect(() => {
      void button.props.value;
      runs++;
    });
    form.context.vars.busy = false;
    form.context.vars.count = 2;
    expect(runs).toBe(1);
    form.context.vars.busy = true;
    expect(runs).toBe(2);
    stop();
  });

  it('resolves bind.options to plain options and caches them until the Dataset changes', async () => {
    const def = definition();
    def.components = [
      {
        id: 'combo',
        type: 'ComboBox',
        layout: {},
        props: { optionValue: 'empNo', optionLabel: 'name' },
        bind: { options: 'dsEmp', value: 'dsEmp.empNo', dataset: 'dsEmp' },
      },
    ];
    const { form, errors } = make({}, {}, def);
    const combo = model(form, 'combo');
    const options = combo.props.value.options;
    expect(options).toEqual([
      { value: 'E1', label: 'Ann' },
      { value: 'E2', label: 'Bob' },
    ]);
    expect(combo.props.value).not.toHaveProperty('dataset');
    form.context.ds.dsEmp.setValue(0, 'qty', 9);
    await tick();
    expect(combo.props.value.options).toBe(options);
    form.context.ds.dsEmp.setValue(0, 'name', 'Anna');
    await tick();
    expect(combo.props.value.options).toEqual([
      { value: 'E1', label: 'Anna' },
      { value: 'E2', label: 'Bob' },
    ]);
    expect(combo.getBoundDataset()).toBe(form.context.ds.dsEmp);
    expect(form.getDataset('dsEmp')).toBe(form.context.ds.dsEmp);
    expect(errors).toEqual([]);
  });

  it('does not let a bad expression break props, and reports it once', () => {
    const def = definition();
    def.components = [
      {
        id: 'bad',
        type: 'Label',
        layout: {},
        props: { fine: 'yes', broken: '=ds.nope.x', syntax: '=1 +', text: '="a" + 1' },
        bind: { value: 'dsEmp.name' },
      },
    ];
    const { form, errors } = make({}, {}, def);
    const bad = model(form, 'bad');
    expect(bad.props.value.fine).toBe('yes');
    expect(bad.props.value.broken).toBeUndefined();
    expect(bad.props.value.syntax).toBeUndefined();
    expect(bad.props.value.value).toBe('Ann');
    form.context.ds.dsEmp.setCurrentIndex(1);
    expect(bad.props.value.value).toBe('Bob');
    form.context.vars.count = 3;
    void bad.props.value;
    const wheres = errors.map((e) => e.where).sort();
    expect(wheres).toEqual(['bad.broken', 'bad.syntax', 'bad.text']);
  });
});

describe('write', () => {
  const cases: [string, unknown, unknown][] = [
    ['name', 'Zed', 'Zed'],
    ['name', '', null],
    ['qty', ' 42 ', 42],
    ['qty', '1,234', 1234],
    ['ratio', '1.5', 1.5],
    ['active', 'true', true],
    ['active', 'false', false],
    ['hiredOn', '2024-02-29', '2024-02-29'],
    ['qty', 7, 7],
    ['salary', '', null],
  ];

  it.each(cases)('parses %s from %j', (column, text, expected) => {
    const form = createForm(definition({ components: [bound(column)] }), { onError: () => {} });
    const w = model(form, 'w');
    expect(w.write('value', text)).toBe(true);
    expect(form.context.ds.dsEmp.getValue(0, column as 'name')).toBe(expected);
    expect(w.props.value.value).toBe(expected);
  });

  it('keeps an exact long decimal as text', () => {
    const { form } = make();
    const inner = model(form, 'inner');
    const long = '12345678901234567890.123456789';
    expect(inner.write('value', ` ${long} `)).toBe(true);
    expect(form.context.ds.dsEmp.getValue(0, 'salary')).toBe(long);
    expect(inner.props.value.value).toBe(long);
    expect(inner.write('value', '1,234,567.80')).toBe(true);
    expect(form.context.ds.dsEmp.getValue(0, 'salary')).toBe('1234567.80');
  });

  it('returns false and writes nothing for text that cannot be parsed', () => {
    const { form } = make();
    const ds = form.context.ds.dsEmp;
    const inner = model(form, 'inner');
    for (const bad of ['abc', '1.2.3', '1,2', '--1', '1e3']) {
      expect(inner.write('value', bad)).toBe(false);
    }
    expect(ds.getValue(0, 'salary')).toBe('100');
    expect(ds.statusOf(0)).toBe('normal');

    const qty = createForm(definition({ components: [bound('qty')] }));
    const q = model(qty, 'w');
    expect(q.write('value', '1.5')).toBe(false);
    expect(q.write('value', '9007199254740993')).toBe(false);
    expect(q.write('value', {})).toBe(false);
    expect(qty.context.ds.dsEmp.getValue(0, 'qty')).toBe(1);
  });

  it('returns false when a cellChanging handler refuses, and flushes so props update at once', () => {
    const { form } = make();
    const ds = form.context.ds.dsEmp;
    const input = model(form, 'nameInput');
    ds.on('cellChanging', (e) => {
      if (e.detail.newValue === 'No') e.preventDefault();
    });
    expect(input.write('value', 'No')).toBe(false);
    expect(ds.getValue(0, 'name')).toBe('Ann');

    // No tick between the write and the read: the flush happened inside write.
    expect(input.write('value', 'Yes')).toBe(true);
    expect(input.props.value.value).toBe('Yes');
  });

  it('waits for an async refusal', async () => {
    const { form } = make();
    const ds = form.context.ds.dsEmp;
    ds.on('cellChanging', (e) => e.waitUntil(Promise.resolve(false)));
    const result = model(form, 'nameInput').write('value', 'Later');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(false);
    expect(ds.getValue(0, 'name')).toBe('Ann');
  });

  it('returns false with no current row', () => {
    const { form } = make();
    form.context.ds.dsEmp.load([]);
    expect(model(form, 'nameInput').write('value', 'x')).toBe(false);
  });

  it('keeps a local override for unbound props', () => {
    const { form } = make();
    const button = model(form, 'button');
    expect(button.write('text', 'Stop')).toBe(true);
    expect(button.props.value.text).toBe('Stop');
  });
});

describe('accepts and reportError', () => {
  it('answers from the column type, with the same rules as write', () => {
    const decimal = createForm(definition({ components: [bound('salary')] }));
    const w = model(decimal, 'w');
    expect(w.accepts('value', ' 12345678901234567890.123456789 ')).toBe(true);
    expect(w.accepts('value', '1,234.50')).toBe(true);
    expect(w.accepts('value', '')).toBe(true);
    expect(w.accepts('value', 'abc')).toBe(false);
    expect(w.accepts('value', '1,2')).toBe(false);
    expect(w.accepts('value', {})).toBe(false);
    expect(decimal.context.ds.dsEmp.getValue(0, 'salary')).toBe('100');

    const qty = model(createForm(definition({ components: [bound('qty')] })), 'w');
    expect(qty.accepts('value', '42')).toBe(true);
    expect(qty.accepts('value', '1.5')).toBe(false);
    expect(qty.accepts('value', '9007199254740993')).toBe(false);
  });

  it('is true for an unbound prop, false for an unknown bind target, and ignores mode and current row', () => {
    const { form } = make();
    expect(model(form, 'button').accepts('text', 'anything')).toBe(true);
    form.context.ds.dsEmp.load([]);
    expect(model(form, 'nameInput').accepts('value', 'x')).toBe(true);
    expect(model(form, 'inner').accepts('value', 'abc')).toBe(false);

    const bad = createForm(definition({ components: [{ id: 'w', type: 'T', layout: {}, bind: { value: 'dsNope.x' } }] }), {
      onError: () => {},
    });
    expect(model(bad, 'w').accepts('value', 'x')).toBe(false);

    const design = createForm(definition(), { mode: 'design' });
    expect(model(design, 'inner').accepts('value', '1.5')).toBe(true);
    expect(model(design, 'inner').accepts('value', 'abc')).toBe(false);
    expect(model(design, 'inner').write('value', '1.5')).toBe(false);
  });

  it('reportError sends to onError', () => {
    const { form, errors } = make();
    const boom = new Error('boom');
    form.reportError(boom, 'somewhere');
    expect(errors).toEqual([{ error: boom, where: 'somewhere' }]);
  });
});

describe('fire', () => {
  it('calls the handler with the source and detail', () => {
    const onClick = vi.fn();
    const { form } = make({ onClick });
    model(form, 'button').fire('click', { x: 1 });
    expect(onClick).toHaveBeenCalledWith({ source: 'button', detail: { x: 1 } });
    model(form, 'button').fire('unknownEvent');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('sends sync errors and async rejections to onError', async () => {
    const boom = new Error('boom');
    const { form, errors } = make({
      onClick: () => {
        throw boom;
      },
      onChange: () => Promise.reject(boom),
    });
    model(form, 'button').fire('click');
    model(form, 'nameInput').fire('change');
    await tick();
    expect(errors).toEqual([
      { error: boom, where: 'button.click' },
      { error: boom, where: 'nameInput.change' },
    ]);
  });

  it('reports an event that names a handler the script does not have', () => {
    const { form, errors } = make({});
    model(form, 'button').fire('click');
    expect(errors).toHaveLength(1);
  });
});

describe('handles', () => {
  it('queues calls made before a handle exists and runs them on setHandle', () => {
    const { form } = make();
    const focus = vi.fn();
    form.context.c.button!.focus();
    form.context.c.button!.focus();
    expect(focus).not.toHaveBeenCalled();
    model(form, 'button').setHandle({ focus });
    expect(focus).toHaveBeenCalledTimes(2);
    form.context.c.button!.focus();
    expect(focus).toHaveBeenCalledTimes(3);
    expect(() => form.context.c.missing).toThrow(/Unknown component/);
  });
});

describe('lifecycle', () => {
  it('goes loading, initializing, active, and passes params to onInit', async () => {
    const states: string[] = [];
    let release!: () => void;
    const onInit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { form } = make({ onInit });
    const stop = effect(() => {
      states.push(form.state.value);
    });
    const done = form.init();
    expect(form.state.value).toBe('initializing');
    release();
    await done;
    stop();
    expect(states).toEqual(['loading', 'initializing', 'active']);
    const arg = onInit.mock.calls[0] as unknown as [{ params: { deptCode: string } }];
    expect(arg[0].params.deptCode).toBe('D1');
  });

  it('still becomes active when init fails', async () => {
    const boom = new Error('init failed');
    const { form, errors } = make({
      onInit: () => {
        throw boom;
      },
    });
    await form.init();
    expect(form.state.value).toBe('active');
    expect(errors).toEqual([{ error: boom, where: 'init' }]);
  });

  it('activates and deactivates', async () => {
    const { form } = make({ onInit: () => {} });
    await form.init();
    form.deactivate();
    expect(form.state.value).toBe('inactive');
    form.activate();
    expect(form.state.value).toBe('active');
  });

  it('closes in order: beforeClose, abort, close handler', async () => {
    const order: string[] = [];
    const { form } = make({
      onBeforeClose: () => {
        order.push(`before aborted=${form.context.signal.aborted}`);
      },
      onClose: () => {
        order.push(`close aborted=${form.context.signal.aborted} state=${form.state.value}`);
      },
    });
    await form.init();
    await expect(form.close()).resolves.toBe(true);
    expect(order).toEqual(['before aborted=false', 'close aborted=true state=closing']);
    expect(form.state.value).toBe('closed');
    await expect(form.close()).resolves.toBe(true);
    expect(order).toHaveLength(2);
  });

  it.each([
    ['false', () => false],
    ['a promise of false', () => Promise.resolve(false)],
  ])('lets beforeClose veto with %s', async (_name, veto) => {
    const onClose = vi.fn();
    const { form } = make({ onBeforeClose: veto, onClose });
    await form.init();
    form.deactivate();
    await expect(form.close()).resolves.toBe(false);
    expect(form.state.value).toBe('inactive');
    expect(form.context.signal.aborted).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ends Dataset subscriptions when closed', async () => {
    const { form } = make();
    const input = model(form, 'nameInput');
    void input.props.value;
    await form.close();
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(input.props.value.value);
    });
    form.context.ds.dsEmp.setValue(0, 'name', 'After');
    await tick();
    stop();
    expect(seen).toEqual(['Ann']);
  });

  it('closes concurrently only once', async () => {
    const onClose = vi.fn();
    const { form } = make({ onClose });
    await form.init();
    const results = await Promise.all([form.close(), form.close()]);
    expect(results).toEqual([true, true]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports unsaved changes only for confirmUnsaved Datasets', () => {
    const { form } = make();
    expect(form.hasUnsavedChanges()).toBe(false);
    form.context.ds.dsEmp.setValue(0, 'name', 'Changed');
    expect(form.hasUnsavedChanges()).toBe(true);
  });
});

describe('tx', () => {
  it('builds a client from the transport and aborts it with the form', async () => {
    const send = vi.fn(
      (_request: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const { form } = make({}, { transport: { send: send as never } });
    const settled = form.context.tx.call({ service: 'svc' }).catch((e: unknown) => e);
    await tick();
    await form.close();
    expect(await settled).toBeInstanceOf(Error);
  });
});

describe('design mode', () => {
  it('runs no script, builds no transport, and ignores writes and events', async () => {
    const setup = vi.fn(() => ({}) as never);
    const transport = { send: vi.fn() };
    const form = createForm(definition(), { module: { setup }, mode: 'design', transport });
    expect(setup).not.toHaveBeenCalled();
    expect(model(form, 'nameInput').write('value', 'x')).toBe(false);
    expect(model(form, 'button').write('text', 'x')).toBe(false);
    expect(() => model(form, 'button').fire('click')).not.toThrow();
    await expect(form.context.tx.call({ service: 'x' })).rejects.toThrow(/design mode/);
    expect(transport.send).not.toHaveBeenCalled();
    await form.init();
    expect(form.state.value).toBe('active');
  });

  it('openForm does not load the script in design mode', async () => {
    const load = vi.fn();
    const form = await openForm({ definition: definition(), load: load as never }, { mode: 'design' });
    expect(load).not.toHaveBeenCalled();
    expect(form.state.value).toBe('active');
  });

  it('applyPatch keeps model identity and recomputes only that component', () => {
    const form = createForm(definition(), { mode: 'design' });
    const button = model(form, 'button');
    const input = model(form, 'nameInput');
    const buttonProps = button.props.value;
    const inputProps = input.props.value;
    const topLevel = form.components.value;

    form.applyPatch('button', { props: { text: 'Changed', disabled: '=vars.busy' } });

    expect(form.getComponent('button')).toBe(button);
    expect(form.components.value).toBe(topLevel);
    expect(button.definition.value.props?.text).toBe('Changed');
    expect(button.props.value).not.toBe(buttonProps);
    expect(button.props.value).toEqual({ text: 'Changed', disabled: false });
    expect(input.props.value).toBe(inputProps);
    expect(form.definition.value.components[1]?.props?.text).toBe('Changed');
  });

  it('applyPatch reaches nested components and keeps children models', () => {
    const form = createForm(definition(), { mode: 'design' });
    const panel = model(form, 'panel');
    const inner = model(form, 'inner');
    form.applyPatch('inner', { layout: { left: 5 } });
    expect(model(form, 'inner')).toBe(inner);
    expect(panel.children.value[0]).toBe(inner);
    expect(panel.definition.value.children?.[0]?.layout).toEqual({ left: 5 });

    form.applyPatch('panel', {
      children: [
        { id: 'inner', type: 'TextInput', layout: {}, bind: { value: 'dsEmp.salary' } },
        { id: 'extra', type: 'Label', layout: {} },
      ],
    });
    expect(panel.children.value).toHaveLength(2);
    expect(panel.children.value[0]).toBe(inner);
    expect(form.getComponent('extra')).toBeDefined();
  });

  it('applyPatch throws in run mode', () => {
    const { form } = make();
    expect(() => form.applyPatch('button', { layout: {} })).toThrow(/design mode/);
  });

  it('refuses duplicate component ids', () => {
    const def = definition();
    def.components.push({ id: 'button', type: 'Button', layout: {} });
    expect(() => createForm(def)).toThrow(/used twice/);
  });
});

describe('openForm', () => {
  it('loads the script, creates the form and runs init', async () => {
    const onInit = vi.fn();
    const entry = {
      definition: definition(),
      load: async () => defineForm((form) => ({ onInit: ((event: unknown) => onInit(event, form.id)) as FormHandler })),
    };
    const form = await openForm(entry, { params: { deptCode: 'Z' } });
    expect(form.state.value).toBe('active');
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit.mock.calls[0]?.[1]).toBe('test.Form');
  });
});

describe('stage 4 fixes', () => {
  it('writes to a given row and returns false for a stale or deleted row', () => {
    const { form } = make();
    const ds = form.context.ds.dsEmp;
    const input = model(form, 'nameInput');
    const second = ds.rowIdAt(1);
    expect(input.write('value', 'Second', second)).toBe(true);
    expect(ds.getValue(1, 'name')).toBe('Second');
    expect(ds.getValue(0, 'name')).toBe('Ann');
    ds.deleteRow(1);
    expect(input.write('value', 'Gone', second)).toBe(false);
    ds.load([{ name: 'New' }]);
    expect(input.write('value', 'Stale', second)).toBe(false);
    expect(ds.getValue(0, 'name')).toBe('New');
  });

  it('writes and checks cells of the Dataset a dataset binding points at', () => {
    const def = definition();
    def.components = [{ id: 'grid', type: 'Grid', layout: {}, bind: { dataset: 'dsEmp' } }];
    const { form } = make({}, {}, def);
    const grid = model(form, 'grid');
    const ds = form.context.ds.dsEmp;
    const id = ds.rowIdAt(1);
    expect(grid.acceptsCell('salary', '12345678901234567890.123456789')).toBe(true);
    expect(grid.acceptsCell('salary', 'abc')).toBe(false);
    expect(grid.acceptsCell('nope', '1')).toBe(false);
    expect(grid.acceptsCell('salary', '1', 'other')).toBe(false);
    expect(grid.writeCell(id, 'salary', '12345678901234567890.123456789')).toBe(true);
    expect(ds.getValue(1, 'salary')).toBe('12345678901234567890.123456789');
    expect(grid.writeCell(id, 'salary', 'abc')).toBe(false);
    expect(grid.writeCell(id, 'nope', '1')).toBe(false);
    ds.load([]);
    expect(grid.writeCell(id, 'salary', '1')).toBe(false);
  });

  it('resolves boundRow, boundRevision and boundType without extra changes when nothing moved', async () => {
    const { form } = make();
    const ds = form.context.ds.dsEmp;
    const input = model(form, 'nameInput');
    const props = input.props.value;
    expect(props.boundRow).toBe(ds.currentRow);
    expect(props.boundRevision).toBe(ds.revision);
    expect(props.boundType).toBe('string');
    ds.setValue(0, 'qty', 80);
    await tick();
    expect(input.props.value).toBe(props);
    ds.setCurrentIndex(1);
    expect(input.props.value.boundRow).toBe(ds.currentRow);
    ds.revertAll();
    ds.load([{ name: 'n' }]);
    expect(input.props.value.boundRevision).toBe(ds.revision);
    expect(model(form, 'button').props.value).not.toHaveProperty('boundRow');
  });

  it('changes boundRevision on a revert even when nothing was edited', () => {
    const { form } = make();
    const input = model(form, 'nameInput');
    const before = input.props.value.boundRevision;
    form.context.ds.dsEmp.revertAll();
    form.context.ds.dsEmp.flushInvalidate();
    expect(input.props.value.boundRevision).toBe((before as number) + 1);
  });

  it('resolves required from the bound column unless the component sets it', () => {
    const def = definition();
    def.datasets![0]!.columns[1] = { id: 'name', type: 'string', required: true };
    def.components = [
      { id: 'a', type: 'TextInput', layout: {}, bind: { value: 'dsEmp.name' } },
      { id: 'b', type: 'TextInput', layout: {}, props: { required: false }, bind: { value: 'dsEmp.name' } },
      { id: 'c', type: 'TextInput', layout: {}, bind: { value: 'dsEmp.qty' } },
    ];
    const { form } = make({}, {}, def);
    expect(model(form, 'a').props.value.required).toBe(true);
    expect(model(form, 'b').props.value.required).toBe(false);
    expect(model(form, 'c').props.value).not.toHaveProperty('required');
  });

  it('holds a write to an expression prop until the expression changes, so a dialog can reopen', () => {
    const def = definition({ variables: { show: { type: 'boolean', default: false } } });
    def.components = [{ id: 'dialog', type: 'Dialog', layout: {}, props: { open: '=vars.show' } }];
    const { form } = make({}, {}, def);
    const dialog = model(form, 'dialog');
    form.context.vars.show = true;
    expect(dialog.props.value.open).toBe(true);
    dialog.write('open', false);
    expect(dialog.props.value.open).toBe(false);
    form.context.vars.show = false;
    expect(dialog.props.value.open).toBe(false);
    form.context.vars.show = true;
    expect(dialog.props.value.open).toBe(true);
  });

  it('keeps a write to an expression prop while the expression stays the same', () => {
    const def = definition();
    def.components = [{ id: 'b', type: 'Button', layout: {}, props: { text: '=vars.count' } }];
    const { form } = make({}, {}, def);
    const b = model(form, 'b');
    b.write('text', 'typed');
    form.context.vars.busy = true;
    expect(b.props.value.text).toBe('typed');
    form.context.vars.count = 9;
    expect(b.props.value.text).toBe(9);
  });

  it('vetoes the close when beforeClose throws, and reports it', async () => {
    const boom = new Error('guard bug');
    const onClose = vi.fn();
    const { form, errors } = make({
      onInit: () => {},
      onBeforeClose: () => {
        throw boom;
      },
      onClose,
    });
    await form.init();
    await expect(form.close()).resolves.toBe(false);
    expect(form.state.value).toBe('active');
    expect(onClose).not.toHaveBeenCalled();
    expect(errors).toEqual([{ error: boom, where: 'beforeClose' }]);
  });

  it('does not report an aborted TransactionError caused by the form closing', async () => {
    const { form, errors } = make({
      onInit: () => {},
      onBeforeClose: () => {},
      onClose: () => {},
    });
    form.reportError(new TransactionError('aborted', 'cancelled'), 'before');
    expect(errors).toHaveLength(1);
    await form.close();
    form.reportError(new TransactionError('aborted', 'cancelled'), 'after');
    form.reportError(new TransactionError('server', 'real'), 'after');
    expect(errors.map((e) => e.where)).toEqual(['before', 'after']);
  });

  it('coerces variable defaults and reports a bad one as null', () => {
    const def = definition({
      variables: {
        total: { type: 'decimal', default: 5 },
        bad: { type: 'int', default: 'x' },
        none: { type: 'string' },
      },
    });
    const { form, errors } = make({}, {}, def);
    expect(form.context.vars.total).toBe('5');
    expect(form.context.vars.bad).toBeNull();
    expect(form.context.vars.none).toBeNull();
    expect(errors.map((e) => e.where)).toEqual(['variable bad']);
  });
});
