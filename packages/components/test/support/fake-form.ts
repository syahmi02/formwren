/**
 * A small test double for `createForm`, which another agent is writing. It follows
 * packages/core/src/form/contract.ts using real signals. It is not the real runtime:
 * there are no Datasets, expressions or scripts.
 */
import type { ChangeResult, ComponentDefinition, ComponentHandle, ComponentModel, FormDefinition, FormInstance, FormMode } from '@fw/core';
import { signal } from '@preact/signals-core';

export interface FakeModel extends ComponentModel {
  readonly writes: { prop: string; value: unknown; rowId?: number }[];
  readonly fires: { event: string; detail: unknown }[];
  readonly handle: ComponentHandle | null;
  /** Merges into the resolved props. Keeps the same object if nothing changed, like the real model. */
  setProps(patch: Record<string, unknown>): void;
  /** Like `c.focus()` from a script: queued until React has committed. */
  focus(): void;
  /** Replaces the definition, as `applyPatch` does in design mode. */
  patchDefinition(patch: Partial<ComponentDefinition>): void;
  /** What `write` returns for a prop that is not bound. */
  refuseWrites: boolean;
  /** When set, `write` returns this promise and stores nothing, to test slow handlers. */
  asyncWrite: Promise<boolean> | null;
}

export interface FakeForm {
  form: FormInstance;
  model(id: string): FakeModel;
  errors: { error: unknown; where: string }[];
  setComponents(defs: ComponentDefinition[]): void;
}

function build(def: ComponentDefinition, all: Map<string, FakeModel>): FakeModel {
  const definition = signal<ComponentDefinition>(def);
  const props = signal<Readonly<Record<string, unknown>>>({ ...(def.props ?? {}) });
  const kids = (def.children ?? []).map((child) => build(child, all));
  const children = signal<readonly ComponentModel[]>(kids);
  let handle: ComponentHandle | null = null;
  const queued: (() => void)[] = [];

  const model: FakeModel = {
    id: def.id,
    definition,
    props,
    children,
    writes: [],
    fires: [],
    refuseWrites: false,
    asyncWrite: null,
    cellScope: () => ({
      read: () => undefined,
      aggregate: () => {
        throw new Error('The fake form has no aggregates');
      },
    }),
    get handle() {
      return handle;
    },
    write(prop: string, value: unknown, rowId?: number): ChangeResult {
      model.writes.push({ prop, value, ...(rowId === undefined ? {} : { rowId }) });
      if (model.asyncWrite) return model.asyncWrite;
      // Like the real model: an unbound prop stores the value as an override and returns true.
      if (model.refuseWrites) return false;
      model.setProps({ [prop]: value });
      return true;
    },
    fire(event: string, detail?: unknown): void {
      model.fires.push({ event, detail });
    },
    setHandle(next: ComponentHandle | null): void {
      handle = next;
      if (next) while (queued.length > 0) queued.shift()!();
    },
    setProps(patch: Record<string, unknown>): void {
      const current = props.peek();
      if (Object.entries(patch).every(([key, value]) => Object.is(current[key], value))) return;
      props.value = { ...current, ...patch };
    },
    getBoundDataset: () => undefined,
    writeCell: () => false,
    acceptsCell: () => false,
    accepts: () => !model.refuseWrites,
    focus(): void {
      if (handle) handle.focus();
      else queued.push(() => handle?.focus());
    },
    patchDefinition(patch: Partial<ComponentDefinition>): void {
      definition.value = { ...definition.peek(), ...patch };
    },
  };
  all.set(def.id, model);
  return model;
}

export function createFakeForm(
  components: ComponentDefinition[],
  options: { mode?: FormMode; size?: { width: number; height: number } } = {},
): FakeForm {
  const all = new Map<string, FakeModel>();
  const errors: { error: unknown; where: string }[] = [];
  const roots = signal<readonly ComponentModel[]>(components.map((def) => build(def, all)));
  const formDefinition: FormDefinition = { formatVersion: 1, id: 'fake', components, ...(options.size ? { size: options.size } : {}) };
  const form = {
    id: 'fake',
    mode: options.mode ?? 'run',
    definition: signal(formDefinition),
    components: roots,
    getComponent: (id: string) => all.get(id),
    reportError: (error: unknown, where: string) => {
      errors.push({ error, where });
    },
  } as unknown as FormInstance;
  return {
    form,
    errors,
    model(id) {
      const found = all.get(id);
      if (!found) throw new Error(`No fake component ${id}`);
      return found;
    },
    setComponents(defs) {
      roots.value = defs.map((def) => build(def, all));
    },
  };
}

/** Shorthand for a definition. */
export function def(
  id: string,
  type: string,
  props: Record<string, unknown> = {},
  extra: Partial<ComponentDefinition> = {},
): ComponentDefinition {
  return { id, type, layout: { left: 0, top: 0, width: 100, height: 20 }, props, ...extra };
}
