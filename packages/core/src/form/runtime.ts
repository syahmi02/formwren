import { batch, computed, signal, type Signal } from '@preact/signals-core';
import { Dataset, type ValidationIssue } from '../dataset.ts';
import { coerceValue, type CellValue } from '../values.ts';
import type { AggregateName, ExpressionScope } from '../expr/index.ts';
import { createTxClient } from '../tx/index.ts';
import { TransactionError, type AnyDataset, type DsxRowError, type TxClient } from '../tx/contract.ts';
import type {
  ComponentHandle,
  CreateFormOptions,
  FormContext,
  FormEntry,
  FormHandler,
  FormInstance,
  FormIssue,
  FormShape,
  FormState,
  OpenOptions,
  ResultOf,
  ValidateOptions,
} from './contract.ts';
import type { ComponentDefinition, FormDefinition, GridProps } from './definition.ts';
import { placeGridCells } from './grid.ts';
import { ModelImpl, type ModelHost } from './model.ts';

/** Names that tooling probes on any object. They aren't mistakes, so they don't throw. */
const PROBES = new Set(['then', 'toJSON', '$$typeof', 'asymmetricMatch']);

/** A record that throws on a name it doesn't know, instead of quietly giving undefined. */
function strictRecord(
  kind: string,
  declared: ReadonlySet<string>,
  read: (name: string) => unknown,
  write?: (name: string, value: unknown) => void,
): Record<string, unknown> {
  const check = (name: string): void => {
    if (!declared.has(name)) {
      const known = [...declared].join(', ') || 'none';
      throw new Error(`Unknown ${kind} "${name}". This form declares: ${known}`);
    }
  };
  return new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      if (!declared.has(key) && PROBES.has(key)) return undefined;
      check(key);
      return read(key);
    },
    set(_target, key, value) {
      if (typeof key === 'symbol') return false;
      if (!write) throw new Error(`The ${kind} "${key}" is read-only`);
      check(key);
      write(key, value);
      return true;
    },
    has: (_target, key) => typeof key === 'string' && declared.has(key),
    ownKeys: () => [...declared],
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === 'string' && declared.has(key)
        ? { value: read(key), enumerable: true, configurable: true, writable: write !== undefined }
        : undefined,
    deleteProperty(_target, key) {
      throw new Error(`The ${kind} "${String(key)}" can't be deleted`);
    },
    defineProperty: () => false,
  });
}

function notAvailableInDesign(): TxClient {
  return { call: () => Promise.reject(new Error('Transactions are not available in design mode')) };
}

export function createForm<T extends FormShape = FormShape>(
  definition: FormDefinition,
  options: CreateFormOptions<T> = {},
): FormInstance<T> {
  const mode = options.mode ?? 'run';
  const userOnError = options.onError ?? ((error: unknown, where: string) => console.error(`[${definition.id}] ${where}`, error));
  const report = (error: unknown, where: string): void => {
    // Calls cut short because the form is closing are expected, not errors.
    if (error instanceof TransactionError && error.code === 'aborted' && controller.signal.aborted) return;
    try {
      userOnError(error, where);
    } catch {
      // A broken error handler must not break the form.
    }
  };

  const controller = new AbortController();
  const state = signal<FormState>('loading');
  const subscriptions: (() => void)[] = [];

  // Datasets, with one version signal each so expressions and bindings can follow them.
  const datasets = new Map<string, AnyDataset>();
  const versions = new Map<string, Signal<number>>();
  /** The unsubscribe functions of the Datasets' listeners, so a design-mode rebuild can drop them. */
  const datasetSubscriptions: (() => void)[] = [];
  const buildDatasets = (defs: readonly NonNullable<FormDefinition['datasets']>[number][]): void => {
    for (const unsubscribe of datasetSubscriptions.splice(0)) unsubscribe();
    datasets.clear();
    versions.clear();
    for (const def of defs) {
      if (datasets.has(def.id)) throw new Error(`Dataset id "${def.id}" is used twice`);
      const ds = new Dataset({
        id: def.id,
        columns: def.columns,
        keys: def.keys,
        confirmUnsaved: def.confirmUnsaved,
        initialRows: mode === 'design' ? def.sampleRows : def.initialRows,
      });
      const version = signal(0);
      const bump = (): void => {
        version.value++;
      };
      datasetSubscriptions.push(ds.onInvalidate(bump), ds.on('currentRowChanged', bump));
      datasets.set(def.id, ds);
      versions.set(def.id, version);
    }
  };
  buildDatasets(definition.datasets ?? []);
  subscriptions.push(() => {
    for (const unsubscribe of datasetSubscriptions.splice(0)) unsubscribe();
  });

  // Variables and params.
  const variableSignals = new Map<string, Signal<unknown>>();
  const declaredVariables = new Set<string>();
  const buildVariables = (specs: NonNullable<FormDefinition['variables']>): void => {
    variableSignals.clear();
    declaredVariables.clear();
    for (const [name, spec] of Object.entries(specs)) {
      let initial: CellValue = null;
      try {
        initial = coerceValue({ id: name, type: spec.type }, spec.default);
      } catch (error) {
        report(error, `variable ${name}`);
      }
      variableSignals.set(name, signal(initial));
      declaredVariables.add(name);
    }
  };
  buildVariables(definition.variables ?? {});
  const vars = strictRecord(
    'variable',
    declaredVariables,
    (name) => (variableSignals.get(name) as Signal<unknown>).value,
    (name, value) => {
      (variableSignals.get(name) as Signal<unknown>).value = value;
    },
  );

  const paramValues = new Map<string, unknown>();
  const declaredParams = new Set<string>();
  const buildParams = (specs: NonNullable<FormDefinition['params']>): void => {
    paramValues.clear();
    declaredParams.clear();
    for (const name of Object.keys(specs)) declaredParams.add(name);
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.default !== undefined) paramValues.set(name, spec.default);
    }
    for (const [name, value] of Object.entries(options.params ?? {})) {
      if (value === undefined) continue;
      paramValues.set(name, value);
      declaredParams.add(name);
    }
  };
  buildParams(definition.params ?? {});
  const params = strictRecord('param', declaredParams, (name) => paramValues.get(name));

  const requireDataset = (name: string | undefined): AnyDataset => {
    const ds = name === undefined ? undefined : datasets.get(name);
    if (!ds) throw new Error(`Unknown Dataset "${String(name)}"`);
    return ds;
  };
  const trackDataset = (name: string): void => {
    void versions.get(name)?.value;
  };

  const scope: ExpressionScope = {
    read(path) {
      const [root, name, member] = path;
      if (root === 'vars' && path.length === 2) return (vars as Record<string, unknown>)[name as string];
      if (root === 'params' && path.length === 2) return (params as Record<string, unknown>)[name as string];
      if (root === 'ds' && path.length === 3) {
        const ds = requireDataset(name);
        trackDataset(ds.id);
        if (member === '$currentIndex') return ds.currentIndex;
        if (member === '$rowCount') return ds.rowCount;
        if (!ds.columns.some((c) => c.id === member)) throw new Error(`Dataset "${ds.id}" has no column "${String(member)}"`);
        const row = ds.currentRow;
        return row === null ? null : ds.getValueById(row, member as string);
      }
      throw new Error(`Can't read "${path.join('.')}"`);
    },
    aggregate(aggregate: AggregateName, path) {
      if (path[0] !== 'ds' || path.length !== 3) throw new Error(`Can't aggregate "${path.join('.')}"`);
      const ds = requireDataset(path[1]);
      trackDataset(ds.id);
      return ds[aggregate](path[2] as string);
    },
  };

  // Components.
  const registry = new Map<string, ModelImpl>();
  let handlers: Readonly<Record<string, FormHandler>> = {};
  const host: ModelHost = {
    mode,
    scope,
    hasModule: mode === 'run' && options.module !== undefined,
    report,
    dataset: (id) => datasets.get(id),
    track: trackDataset,
    handler: (name) => handlers[name],
    register(model) {
      if (registry.has(model.id)) throw new Error(`Component id "${model.id}" is used twice`);
      registry.set(model.id, model);
    },
    unregister: (id) => {
      registry.delete(id);
    },
  };
  const components = signal<readonly ModelImpl[]>([]);
  components.value = ModelImpl.syncList(host, [], definition.components);

  /** Everything in the definition except the components, which the models hold. Changes only in design mode. */
  const base = signal<FormDefinition>(definition);
  const currentDefinition = computed<FormDefinition>(() => ({
    ...base.value,
    components: components.value.map((model) => model.definition.value),
  }));

  const handleCache = new Map<string, ComponentHandle>();
  const handles = new Proxy({} as Record<string, ComponentHandle>, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      let handle = handleCache.get(key);
      if (!handle) {
        const model = registry.get(key);
        if (!model) {
          if (PROBES.has(key)) return undefined;
          throw new Error(`Unknown component "${key}"`);
        }
        handle = model.handle;
        handleCache.set(key, handle);
      }
      return handle;
    },
  });

  const tx = mode === 'design' ? notAvailableInDesign() : createTxClient(options.transport, { signal: controller.signal, screen: definition.id });

  const context = {
    id: definition.id,
    ds: Object.fromEntries(datasets) as T['datasets'],
    vars: vars as T['variables'],
    params: params as T['params'],
    c: handles,
    tx,
    signal: controller.signal,
    open: (entry: FormEntry, openOptions?: OpenOptions) => {
      if (!options.host) {
        return Promise.reject(new Error(`Form "${definition.id}" can't open a popup because it wasn't created by a shell`));
      }
      if (state.value === 'closing' || state.value === 'closed') {
        return Promise.reject(new Error(`Form "${definition.id}" is closing, so it can't open a popup`));
      }
      return options.host.openPopup(form as unknown as FormInstance, entry, openOptions ?? {});
    },
    close: (result?: ResultOf<T>) => form.close(result),
    validate: (validateOptions) => form.validate(validateOptions),
    showRowErrors: (errors) => form.showRowErrors(errors),
  } as FormContext<T>;

  if (mode === 'run' && options.module) {
    handlers = options.module.setup(context) as Readonly<Record<string, FormHandler>>;
  }

  /** Runs the handler a lifecycle event names. Design mode runs nothing. */
  const lifecycle = (event: 'init' | 'beforeClose' | 'close', payload: unknown): unknown => {
    if (mode === 'design') return undefined;
    const name = base.peek().events?.[event];
    if (!name) return undefined;
    const handler = handlers[name];
    if (!handler) {
      if (options.module) report(new Error(`The form script has no handler "${name}", which the form uses for "${event}"`), event);
      return undefined;
    }
    return handler(payload as never);
  };

  // Validation and focus.
  /** The models from a top-level component down to the first input bound to a column. */
  const findInput = (models: readonly ModelImpl[], target: string, trail: ModelImpl[] = []): ModelImpl[] | undefined => {
    for (const model of models) {
      const bind = model.definition.peek().bind ?? {};
      if (Object.entries(bind).some(([key, value]) => key !== 'dataset' && key !== 'options' && value === target)) return [...trail, model];
      const inner = findInput(model.children.peek(), target, [...trail, model]);
      if (inner) return inner;
    }
    return undefined;
  };
  const findGrid = (models: readonly ModelImpl[], datasetId: string, trail: ModelImpl[] = []): ModelImpl[] | undefined => {
    for (const model of models) {
      const def = model.definition.peek();
      if (def.type === 'Grid' && def.bind?.dataset === datasetId) return [...trail, model];
      const inner = findGrid(model.children.peek(), datasetId, [...trail, model]);
      if (inner) return inner;
    }
    return undefined;
  };
  /** The track of the record cell that shows a column, from the Grid definition. */
  const trackOf = (grid: ModelImpl, column: string): number | undefined => {
    const props = grid.definition.peek().props as Partial<GridProps> | undefined;
    const tracks = props?.columns?.length ?? 0;
    const recordRow = props?.recordRows?.[0];
    if (!recordRow) return undefined;
    return placeGridCells([recordRow], tracks).cells.find((placed) => placed.cell.field === column)?.column;
  };
  /** Selects the Tabs page that holds the last model of the trail, through the Tabs model. True if a page changed. */
  const revealPage = (trail: readonly ModelImpl[]): boolean => {
    let changed = false;
    for (let i = 0; i < trail.length - 1; i++) {
      const parent = trail[i] as ModelImpl;
      if (parent.definition.peek().type !== 'Tabs') continue;
      const page = parent.children.peek().indexOf(trail[i + 1] as ModelImpl);
      const shown = parent.props.peek().selectedIndex;
      if (page < 0 || page === (typeof shown === 'number' ? shown : 0)) continue;
      if (parent.write('selectedIndex', page) === true) {
        parent.fire('change', { selectedIndex: page });
        changed = true;
      }
    }
    return changed;
  };
  const focusModel = (trail: readonly ModelImpl[], focus: (model: ModelImpl) => void): void => {
    const model = trail[trail.length - 1] as ModelImpl;
    // A page that was just shown, or a row just made current, needs a render before focus can land.
    if (revealPage(trail)) setTimeout(() => focus(model), 0);
    else focus(model);
  };
  const focusIssue = (issue: FormIssue): void => {
    try {
      const ds = datasets.get(issue.dataset);
      if (!ds) return;
      const roots = components.peek();
      const input = findInput(roots, `${issue.dataset}.${issue.column}`);
      if (input && ds.currentRow === issue.rowId) {
        focusModel(input, (model) => model.handle.focus());
        return;
      }
      const grid = findGrid(roots, issue.dataset);
      const track = grid ? trackOf(grid.at(-1) as ModelImpl, issue.column) : undefined;
      if (grid && track !== undefined) {
        focusModel(grid, (model) => model.handle.focus({ rowId: issue.rowId, track }));
        return;
      }
      if (!input) return;
      // No Grid cell to go to: show the row in the form's inputs, if the Dataset's handlers allow it.
      const index = ds.indexOfRow(issue.rowId);
      if (index < 0) return;
      const moved = ds.setCurrentIndex(index);
      const land = (ok: boolean): void => {
        if (!ok) return;
        ds.flushInvalidate();
        revealPage(input);
        setTimeout(() => {
          try {
            (input[input.length - 1] as ModelImpl).handle.focus();
          } catch (error) {
            report(error, 'validate.focus');
          }
        }, 0);
      };
      if (typeof moved === 'boolean') land(moved);
      else moved.then(land, () => undefined);
    } catch (error) {
      report(error, 'validate.focus');
    }
  };
  const show = (byDataset: Map<string, ValidationIssue[]>): FormIssue[] => {
    const all: FormIssue[] = [];
    for (const [id, issues] of byDataset) {
      const ds = datasets.get(id) as AnyDataset;
      ds.setIssues(issues);
      ds.flushInvalidate();
      // View order, so "first" is the first the user sees. Hidden rows go last.
      const placed = ds
        .issues()
        .map((issue) => ({ issue: { ...issue, dataset: id }, at: ds.indexOfRow(issue.rowId) }))
        .sort((a, b) => (a.at < 0 ? Infinity : a.at) - (b.at < 0 ? Infinity : b.at));
      all.push(...placed.map((entry) => entry.issue));
    }
    const first = all[0];
    if (first) focusIssue(first);
    return all;
  };

  let initFinished = false;
  let closing: Promise<boolean> | undefined;

  // Design reveal: Tabs pages and Dialogs shown for the designer, as values the models show, never written to the definition.
  let revealed: string | null = null;
  let revealedModels: { model: ModelImpl; prop: string }[] = [];
  const reveal = (id: string | null): void => {
    const wanted: { model: ModelImpl; prop: string; value: unknown }[] = [];
    const trail = id === null ? undefined : trailTo(components.peek(), id);
    if (id !== null && !trail) throw new Error(`Unknown component "${id}"`);
    for (let i = 0; trail && i < trail.length; i++) {
      const model = trail[i] as ModelImpl;
      const type = model.definition.peek().type;
      if (type === 'Dialog') wanted.push({ model, prop: 'open', value: true });
      const inner = trail[i + 1];
      if (type === 'Tabs' && inner) wanted.push({ model, prop: 'selectedIndex', value: model.children.peek().indexOf(inner) });
    }
    batch(() => {
      for (const { model, prop } of revealedModels) {
        if (!wanted.some((w) => w.model === model && w.prop === prop)) model.setDesignValue(prop, undefined);
      }
      for (const { model, prop, value } of wanted) model.setDesignValue(prop, value);
    });
    revealed = id;
    revealedModels = wanted.map(({ model, prop }) => ({ model, prop }));
  };

  const form: FormInstance<T> = {
    get id() {
      return base.peek().id;
    },
    mode,
    context,
    state,
    definition: currentDefinition,
    components,
    getComponent: (id) => registry.get(id),
    getDataset: (id) => datasets.get(id),
    reportError: report,

    async init() {
      if (state.value !== 'loading') return;
      state.value = 'initializing';
      try {
        await lifecycle('init', { params });
      } catch (error) {
        report(error, 'init');
      }
      initFinished = true;
      if (state.value === 'initializing') state.value = 'active';
    },

    activate() {
      if (state.value === 'inactive') state.value = 'active';
    },

    deactivate() {
      if (state.value === 'active') state.value = 'inactive';
    },

    validate(validateOptions?: ValidateOptions) {
      const byDataset = new Map<string, ValidationIssue[]>();
      const named = validateOptions?.datasets;
      if (named) {
        for (const id of named) if (!datasets.has(id)) throw new Error(`Unknown Dataset "${id}"`);
      }
      for (const [id, ds] of datasets) {
        if (named ? named.includes(id) : ds.confirmUnsaved) byDataset.set(id, ds.validate());
      }
      return show(byDataset);
    },

    showRowErrors(errors) {
      const list = errors instanceof TransactionError ? errors.rowErrors : errors;
      const byDataset = new Map<string, ValidationIssue[]>();
      for (const error of list as readonly DsxRowError[]) {
        const ds = error.dataset === undefined ? undefined : datasets.get(error.dataset);
        if (!ds || error.id === undefined || error.column === undefined || !ds.columns.some((c) => c.id === error.column)) continue;
        try {
          ds.statusOf(error.id);
        } catch {
          continue;
        }
        const issues = byDataset.get(ds.id) ?? [];
        issues.push({ rowId: error.id, column: error.column, code: error.code, message: error.message });
        byDataset.set(ds.id, issues);
      }
      return show(byDataset);
    },

    close(result?: unknown) {
      if (state.value === 'closed') return Promise.resolve(true);
      if (closing) return closing;
      closing = (async () => {
        const previous = state.value;
        state.value = 'closing';
        let vetoed = false;
        try {
          vetoed = (await lifecycle('beforeClose', {})) === false;
        } catch (error) {
          // A guard that crashes must not let unsaved edits be dropped.
          report(error, 'beforeClose');
          vetoed = true;
        }
        if (vetoed) {
          state.value = previous === 'initializing' && initFinished ? 'active' : previous;
          return false;
        }
        if (options.host) {
          let popupsClosed = false;
          try {
            popupsClosed = await options.host.closePopups(form as unknown as FormInstance);
          } catch (error) {
            report(error, 'closePopups');
          }
          if (!popupsClosed) {
            state.value = previous === 'initializing' && initFinished ? 'active' : previous;
            return false;
          }
        }
        controller.abort();
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        try {
          await lifecycle('close', {});
        } catch (error) {
          report(error, 'close');
        }
        state.value = 'closed';
        try {
          options.onClosed?.(result);
        } catch (error) {
          report(error, 'onClosed');
        }
        return true;
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },

    hasUnsavedChanges() {
      for (const ds of datasets.values()) if (ds.confirmUnsaved && ds.hasChanges()) return true;
      return false;
    },

    applyDefinition(next: FormDefinition) {
      if (mode !== 'design') throw new Error('applyDefinition is only available in design mode');
      const previous = base.peek();
      // Fail before changing anything.
      const ids = new Set<string>();
      const check = (list: readonly ComponentDefinition[]): void => {
        for (const def of list) {
          if (ids.has(def.id)) throw new Error(`Component id "${def.id}" is used twice`);
          ids.add(def.id);
          check(def.children ?? []);
        }
      };
      check(next.components);
      const datasetIds = new Set<string>();
      for (const def of next.datasets ?? []) {
        if (datasetIds.has(def.id)) throw new Error(`Dataset id "${def.id}" is used twice`);
        datasetIds.add(def.id);
      }
      // A change to the Datasets, variables or params rebuilds them, and every model with them,
      // since models read Datasets and variables when they are made. In design mode that is cheap.
      const environmentChanged =
        !sameJson(previous.datasets ?? [], next.datasets ?? []) ||
        !sameJson(previous.variables ?? {}, next.variables ?? {}) ||
        !sameJson(previous.params ?? {}, next.params ?? {});
      batch(() => {
        if (environmentChanged) {
          buildDatasets(next.datasets ?? []);
          buildVariables(next.variables ?? {});
          buildParams(next.params ?? {});
          const ds = context.ds as Record<string, AnyDataset>;
          for (const key of Object.keys(ds)) delete ds[key];
          for (const [id, dataset] of datasets) ds[id] = dataset;
        }
        components.value = ModelImpl.rebuildTree(host, registry, next.components, !environmentChanged);
        base.value = next;
      });
      // Models may have been replaced, so show the revealed component again.
      reveal(revealed !== null && registry.has(revealed) ? revealed : null);
    },

    reveal(id: string | null) {
      if (mode !== 'design') throw new Error('reveal is only available in design mode');
      reveal(id);
    },

    applyPatch(id: string, patch: Partial<ComponentDefinition>) {
      if (mode !== 'design') throw new Error('applyPatch is only available in design mode');
      const model = registry.get(id);
      if (!model) throw new Error(`Unknown component "${id}"`);
      batch(() => {
        model.applyPatch(patch);
      });
    },
  };
  return form;
}

/** The models from a top-level component down to the one with this id. */
function trailTo(models: readonly ModelImpl[], id: string, trail: ModelImpl[] = []): ModelImpl[] | undefined {
  for (const model of models) {
    if (model.id === id) return [...trail, model];
    const inner = trailTo(model.children.peek(), id, [...trail, model]);
    if (inner) return inner;
  }
  return undefined;
}

/** Deep equality of plain JSON values. Key order doesn't matter. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Loads the script, creates the form and runs init. */
export async function openForm<T extends FormShape = FormShape>(
  entry: FormEntry<T>,
  options: Omit<CreateFormOptions<T>, 'module'> = {},
): Promise<FormInstance<T>> {
  // Design mode runs no script, so it doesn't even import it.
  const module = options.mode === 'design' ? undefined : await entry.load();
  const form = createForm<T>(entry.definition, { ...options, module });
  await form.init();
  return form;
}
