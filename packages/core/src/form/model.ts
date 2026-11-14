import { computed, signal, untracked, type ReadonlySignal, type Signal } from '@preact/signals-core';
import type { ChangeResult } from '../events.ts';
import { compileExpression, isExpression, type AggregateName, type CompiledExpression, type ExpressionScope } from '../expr/index.ts';
import { readOptions } from '../options.ts';
import type { ColumnDef } from '../values.ts';
import type { AnyDataset } from '../tx/contract.ts';
import type { ComponentHandle, ComponentModel, FormHandler, FormMode } from './contract.ts';
import type { ComponentDefinition } from './definition.ts';
import { shallowEqual, toCellValue } from './text.ts';

/** What a component model needs from its form. */
export interface ModelHost {
  readonly mode: FormMode;
  readonly scope: ExpressionScope;
  /** True when a form script was loaded, so a handler name with no function behind it is a mistake. */
  readonly hasModule: boolean;
  report(error: unknown, where: string): void;
  dataset(id: string): AnyDataset | undefined;
  /** Reads the Dataset's version signal, so a surrounding `computed` follows the Dataset. */
  track(datasetId: string): void;
  handler(name: string): FormHandler | undefined;
  register(model: ModelImpl): void;
  unregister(id: string): void;
}

interface Override {
  value: unknown;
  /** The expression's value when written. The override holds until the expression gives something else. */
  base: unknown;
  expression: boolean;
}

interface Option {
  value: unknown;
  label: string;
}

interface OptionsCache {
  dataset: AnyDataset;
  version: number;
  valueColumn: string;
  labelColumn: string;
  list: Option[];
}

function sameOptions(a: readonly Option[], b: readonly Option[]): boolean {
  return a.length === b.length && a.every((option, i) => option.value === b[i]?.value && option.label === b[i]?.label);
}

function splitBind(target: string): { dataset: string; column: string } | null {
  const dot = target.indexOf('.');
  return dot > 0 ? { dataset: target.slice(0, dot), column: target.slice(dot + 1) } : null;
}

export class ModelImpl implements ComponentModel {
  readonly id: string;
  readonly definition: ReadonlySignal<ComponentDefinition>;
  readonly props: ReadonlySignal<Readonly<Record<string, unknown>>>;
  readonly children: ReadonlySignal<readonly ModelImpl[]>;
  /** What scripts get from `form.c.id`. */
  readonly handle: ComponentHandle;

  readonly #host: ModelHost;
  readonly #def: Signal<ComponentDefinition>;
  readonly #children: Signal<readonly ModelImpl[]>;
  readonly #overrides = signal<Readonly<Record<string, Override>>>({});
  /** Design reveal values. They win over everything else and never touch the definition. */
  readonly #design = signal<Readonly<Record<string, unknown>>>({});
  /** Overrides on expression props whose expression has since changed value. They never come back. */
  readonly #expired = new WeakSet<Override>();
  readonly #compiled: ReadonlySignal<ReadonlyMap<string, CompiledExpression | null>>;
  readonly #reported = new Set<string>();
  #last: Readonly<Record<string, unknown>> | null = null;
  #optionsCache: OptionsCache | null = null;
  #handle: ComponentHandle | null = null;
  #queued: ((handle: ComponentHandle) => void)[] = [];

  /** With `shallow`, the children are left for the caller to set (see `rebuildTree`). */
  constructor(host: ModelHost, definition: ComponentDefinition, shallow = false) {
    this.#host = host;
    this.id = definition.id;
    this.#def = signal(definition);
    this.#children = signal([]);
    this.children = this.#children;
    host.register(this);
    if (!shallow) this.#syncChildren(definition.children ?? []);

    // A parent's definition includes its children's current definitions, so it never goes stale.
    this.definition = computed(() => {
      const own = this.#def.value;
      return own.children ? { ...own, children: this.#children.value.map((child) => child.definition.value) } : own;
    });

    this.#compiled = computed(() => {
      const compiled = new Map<string, CompiledExpression | null>();
      for (const [prop, value] of Object.entries(this.#def.value.props ?? {})) {
        if (!isExpression(value)) continue;
        try {
          compiled.set(prop, compileExpression(value));
        } catch (error) {
          this.#reportOnce(`${prop}|${value}`, error, `${this.id}.${prop}`);
          compiled.set(prop, null);
        }
      }
      return compiled;
    });

    this.props = computed(() => {
      const next = this.#compute();
      const last = this.#last;
      if (last && shallowEqual(last, next)) return last;
      this.#last = next;
      return next;
    });

    this.handle = {
      focus: (cell) => {
        this.#callHandle((handle) => handle.focus(cell));
      },
    };
  }

  #reportOnce(key: string, error: unknown, where: string): void {
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    untracked(() => this.#host.report(error, where));
  }

  #compute(): Record<string, unknown> {
    const def = this.#def.value;
    const compiled = this.#compiled.value;
    const out: Record<string, unknown> = {};

    for (const [prop, value] of Object.entries(def.props ?? {})) {
      if (!isExpression(value)) {
        out[prop] = value;
        continue;
      }
      const expression = compiled.get(prop);
      out[prop] = expression ? this.#evaluate(prop, expression) : undefined;
    }
    for (const [prop, override] of Object.entries(this.#overrides.value)) {
      if (this.#expired.has(override)) continue;
      if (override.expression && !Object.is(override.base, out[prop])) {
        this.#expired.add(override);
        continue;
      }
      out[prop] = override.value;
    }

    let missingRow = false;
    let primary: { dataset: string; column: string } | null = null;
    for (const [key, target] of Object.entries(def.bind ?? {})) {
      if (key === 'dataset') continue;
      const column = splitBind(target);
      if (column) {
        const result = this.#readColumn(key, target, column.dataset, column.column);
        out[key] = result.value;
        if (result.missingRow) missingRow = true;
        if (key === 'value' || !primary) primary = column;
      } else if (key === 'options') {
        out.options = this.#readOptions(target, out);
      }
    }
    if (missingRow) out.disabled = true;
    const bound = primary && this.#host.dataset(primary.dataset);
    const boundColumn = bound && primary ? bound.columns.find((c) => c.id === primary.column) : undefined;
    if (bound && boundColumn) {
      out.boundRow = bound.currentRow;
      out.boundRevision = bound.revision;
      out.boundType = boundColumn.type;
      if (boundColumn.required && !('required' in out)) out.required = true;
      if (bound.currentRow !== null && !('errorMessage' in out)) {
        const issue = bound.issueAt(bound.currentRow, boundColumn.id);
        if (issue) out.errorMessage = issue.message;
      }
    }
    for (const [prop, value] of Object.entries(this.#design.value)) out[prop] = value;
    return out;
  }

  #evaluate(prop: string, expression: CompiledExpression): unknown {
    try {
      return expression.evaluate(this.#host.scope);
    } catch (error) {
      this.#reportOnce(`${prop}|${expression.source}`, error, `${this.id}.${prop}`);
      return undefined;
    }
  }

  #readColumn(key: string, target: string, datasetId: string, column: string): { value: unknown; missingRow: boolean } {
    const ds = this.#host.dataset(datasetId);
    if (!ds || !ds.columns.some((c) => c.id === column)) {
      this.#reportOnce(`bind|${key}|${target}`, new Error(`Component "${this.id}" binds "${key}" to "${target}", which doesn't exist`), `${this.id}.bind.${key}`);
      return { value: null, missingRow: true };
    }
    this.#host.track(datasetId);
    const row = ds.currentRow;
    if (row === null) return { value: null, missingRow: true };
    return { value: ds.getValueById(row, column), missingRow: false };
  }

  #readOptions(datasetId: string, props: Record<string, unknown>): Option[] {
    const ds = this.#host.dataset(datasetId);
    const valueColumn = props.optionValue;
    const labelColumn = props.optionLabel ?? valueColumn;
    if (
      !ds ||
      typeof valueColumn !== 'string' ||
      typeof labelColumn !== 'string' ||
      !ds.columns.some((c) => c.id === valueColumn) ||
      !ds.columns.some((c) => c.id === labelColumn)
    ) {
      this.#reportOnce(
        `options|${datasetId}`,
        new Error(`Component "${this.id}" has options from "${datasetId}", which needs a Dataset and valid optionValue and optionLabel columns`),
        `${this.id}.bind.options`,
      );
      return this.#optionsCache?.list ?? [];
    }
    this.#host.track(datasetId);
    const cache = this.#optionsCache;
    if (cache && cache.dataset === ds && cache.version === ds.version && cache.valueColumn === valueColumn && cache.labelColumn === labelColumn) {
      return cache.list;
    }
    const list: Option[] = readOptions(ds, valueColumn, labelColumn);
    // A change elsewhere in the Dataset leaves the options as they were, so keep the same array.
    const keep = cache && sameOptions(cache.list, list) ? cache.list : list;
    this.#optionsCache = { dataset: ds, version: ds.version, valueColumn, labelColumn, list: keep };
    return keep;
  }

  /** The Dataset a Dataset-kind binding such as `bind.dataset` points at. */
  getBoundDataset(key = 'dataset'): AnyDataset | undefined {
    const target = this.#def.peek().bind?.[key];
    return target === undefined ? undefined : this.#host.dataset(target);
  }

  cellScope(key = 'dataset'): ExpressionScope {
    const base = this.#host.scope;
    return {
      read: (path) => base.read(path),
      aggregate: (name: AggregateName, path) => {
        if (path.length !== 1) return base.aggregate(name, path);
        const ds = this.getBoundDataset(key);
        if (!ds) throw new Error(`Component "${this.id}" has no Dataset bound at "${key}" for ${name}(${path[0]})`);
        const column = path[0] as string;
        if (!ds.columns.some((c) => c.id === column)) throw new Error(`Dataset "${ds.id}" has no column "${column}"`);
        this.#host.track(ds.id);
        return ds[name](column);
      },
    };
  }

  /** True if `write` could store this value. Uses the same parsing as `write`, and never throws. */
  accepts(prop: string, value: unknown): boolean {
    try {
      const target = this.#def.peek().bind?.[prop];
      const column = target === undefined ? null : splitBind(target);
      if (!column) return true;
      const def = this.#host.dataset(column.dataset)?.columns.find((c) => c.id === column.column);
      if (!def) return false;
      toCellValue(def, value);
      return true;
    } catch {
      return false;
    }
  }

  acceptsCell(column: string, value: unknown, key = 'dataset'): boolean {
    try {
      const def = this.getBoundDataset(key)?.columns.find((c) => c.id === column);
      if (!def) return false;
      toCellValue(def, value);
      return true;
    } catch {
      return false;
    }
  }

  writeCell(rowId: number, column: string, value: unknown, key = 'dataset'): ChangeResult {
    if (this.#host.mode === 'design') return false;
    const ds = this.getBoundDataset(key);
    const def = ds?.columns.find((c) => c.id === column);
    if (!ds || !def) return false;
    return this.#store(ds, def, rowId, value, `${this.id}.writeCell.${column}`);
  }

  /** The one path that puts a value into a Dataset cell. Never throws. */
  #store(ds: AnyDataset, def: ColumnDef, rowId: number, value: unknown, where: string): ChangeResult {
    try {
      // A stale or deleted row has nothing to write to.
      if (ds.statusOf(rowId) === 'deleted') return false;
    } catch {
      return false;
    }
    let parsed;
    try {
      parsed = toCellValue(def, value);
    } catch {
      return false;
    }
    let result: ChangeResult;
    try {
      result = ds.setValueById(rowId, def.id, parsed);
    } catch (error) {
      this.#host.report(error, where);
      return false;
    }
    if (typeof result === 'boolean') {
      ds.flushInvalidate();
      return result;
    }
    return result.then(
      (accepted) => {
        ds.flushInvalidate();
        return accepted;
      },
      (error: unknown) => {
        this.#host.report(error, where);
        return false;
      },
    );
  }

  write(prop: string, value: unknown, rowId?: number): ChangeResult {
    if (this.#host.mode === 'design') return false;
    const target = this.#def.peek().bind?.[prop];
    const column = target === undefined ? null : splitBind(target);
    if (!column) {
      this.#setOverride(prop, value);
      return true;
    }

    const ds = this.#host.dataset(column.dataset);
    const def = ds?.columns.find((c) => c.id === column.column);
    if (!ds || !def) return false;
    const row = rowId ?? ds.currentRow;
    if (row === null) return false;
    return this.#store(ds, def, row, value, `${this.id}.write.${prop}`);
  }

  #setOverride(prop: string, value: unknown): void {
    const expression = this.#compiled.peek().get(prop);
    const base = expression ? untracked(() => this.#evaluate(prop, expression)) : undefined;
    this.#overrides.value = { ...this.#overrides.peek(), [prop]: { value, base, expression: expression !== undefined } };
  }

  fire(event: string, detail?: unknown): void {
    if (this.#host.mode === 'design') return;
    const name = this.#def.peek().events?.[event];
    if (!name) return;
    const where = `${this.id}.${event}`;
    const handler = this.#host.handler(name);
    if (!handler) {
      if (this.#host.hasModule) this.#host.report(new Error(`The form script has no handler "${name}", which "${this.id}" uses for "${event}"`), where);
      return;
    }
    try {
      const result: unknown = handler({ source: this.id, detail } as never);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, (error: unknown) => this.#host.report(error, where));
      }
    } catch (error) {
      this.#host.report(error, where);
    }
  }

  setHandle(handle: ComponentHandle | null): void {
    this.#handle = handle;
    if (!handle) return;
    const queued = this.#queued;
    this.#queued = [];
    for (const call of queued) {
      try {
        call(handle);
      } catch (error) {
        this.#host.report(error, `${this.id}.handle`);
      }
    }
  }

  #callHandle(call: (handle: ComponentHandle) => void): void {
    if (this.#handle) call(this.#handle);
    else this.#queued.push(call);
  }

  /** Design mode: changes this component in place. Its model and identity survive. */
  applyPatch(patch: Partial<ComponentDefinition>): void {
    if (patch.id !== undefined && patch.id !== this.id) throw new Error(`Component ids are permanent, so "${this.id}" can't become "${patch.id}"`);
    const next: ComponentDefinition = { ...this.#def.peek() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    this.#adopt(next);
  }

  /** Design mode: shows `prop` as `value` without touching the definition. `undefined` restores the definition's own value. */
  setDesignValue(prop: string, value: unknown): void {
    const current = this.#design.peek();
    if (value === undefined) {
      if (!(prop in current)) return;
      const rest = { ...current };
      delete rest[prop];
      this.#design.value = rest;
    } else if (current[prop] !== value || !(prop in current)) {
      this.#design.value = { ...current, [prop]: value };
    }
  }

  /** Takes a new definition, reusing child models whose ids stay. */
  #adopt(next: ComponentDefinition): void {
    this.#def.value = next;
    this.#syncChildren(next.children ?? []);
  }

  #syncChildren(defs: readonly ComponentDefinition[]): void {
    this.#children.value = ModelImpl.syncList(this.#host, this.#children.peek(), defs);
  }

  /** Design mode, used by `rebuildTree`: takes a definition and an already built list of children. */
  #setTree(def: ComponentDefinition, children: readonly ModelImpl[]): void {
    this.#def.value = def;
    const previous = this.#children.peek();
    if (previous.length !== children.length || previous.some((child, i) => child !== children[i])) this.#children.value = children;
  }

  dispose(): void {
    for (const child of this.#children.peek()) child.dispose();
    this.#host.unregister(this.id);
  }

  /** Builds models for a list of definitions, reusing the model of any id that was already there. */
  static syncList(host: ModelHost, previous: readonly ModelImpl[], defs: readonly ComponentDefinition[]): ModelImpl[] {
    const seen = new Set<string>();
    const existing = new Map(previous.map((model) => [model.id, model]));
    const models = defs.map((def) => {
      if (seen.has(def.id)) throw new Error(`Component id "${def.id}" is used twice`);
      seen.add(def.id);
      const reuse = existing.get(def.id);
      if (reuse) {
        reuse.#adopt(def);
        return reuse;
      }
      return new ModelImpl(host, def);
    });
    for (const [id, model] of existing) if (!seen.has(id)) model.dispose();
    return models;
  }

  /**
   * Design mode: makes the models match `defs`, in place. A model whose id and type are unchanged
   * is kept, wherever it now sits, and gets its new definition. Others are created or disposed.
   * Models that go are unregistered before any new one registers, so a re-parented id never clashes.
   * With `reuse` false, every model is replaced.
   */
  static rebuildTree(host: ModelHost, registry: ReadonlyMap<string, ModelImpl>, defs: readonly ComponentDefinition[], reuse: boolean): ModelImpl[] {
    const flat = new Map<string, ComponentDefinition>();
    const walk = (list: readonly ComponentDefinition[]): void => {
      for (const def of list) {
        if (flat.has(def.id)) throw new Error(`Component id "${def.id}" is used twice`);
        flat.set(def.id, def);
        walk(def.children ?? []);
      }
    };
    walk(defs);

    const kept = new Map<string, ModelImpl>();
    const gone: ModelImpl[] = [];
    for (const [id, model] of [...registry]) {
      const def = flat.get(id);
      if (reuse && def && def.type === model.#def.peek().type) kept.set(id, model);
      else gone.push(model);
    }
    for (const model of gone) host.unregister(model.id);
    const models = new Map(kept);
    for (const [id, def] of flat) if (!models.has(id)) models.set(id, new ModelImpl(host, def, true));
    for (const [id, def] of flat) {
      const children = (def.children ?? []).map((child) => models.get(child.id) as ModelImpl);
      (models.get(id) as ModelImpl).#setTree(def, children);
    }
    return defs.map((def) => models.get(def.id) as ModelImpl);
  }
}
