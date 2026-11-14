import { batch, computed, signal, type ComponentDefinition, type ComponentMeta, type FormDefinition, type ReadonlySignal } from '@fw/core';
import { checkSchema, diffFormText, openFormText, validateForm, type Diagnostic } from '@fw/format';
import type { DesignerHost } from '../contract.ts';
import { commands, componentIds, findComponent, type Command } from './commands.ts';
import type { AddOptions } from './structure.ts';

/** What the text is: a form the designer can edit, or a file it must leave alone. */
export type ModelStatus =
  | { status: 'ok' }
  | { status: 'conflict'; message: string }
  | { status: 'invalid'; message: string; line: number; column: number };

/** What `apply` did. Only `applied` wrote anything. */
export type ApplyResult =
  | { status: 'applied' }
  /** The command changed nothing, so nothing was written. */
  | { status: 'unchanged' }
  /** The file is read-only: a conflict, invalid JSON, or a read-only host. */
  | { status: 'read-only'; message: string }
  /** The command can't be done, for example a duplicate id. */
  | { status: 'rejected'; message: string }
  /** The host didn't take the edits, usually because the text changed. The model has re-read the text. */
  | { status: 'refused' };

/** One thing the binding picker can offer. */
export interface BindingChoice {
  /** What goes in `bind`: `dataset.column`, or a Dataset id. */
  value: string;
  label: string;
  dataset: string;
  /** Set for column choices. */
  column?: string;
  columnType?: string;
}

/** What `add` did: the result, and the new id when it was applied. */
export type AddResult = ApplyResult & { id?: string };

export interface DesignerModelOptions {
  /** What each component type accepts, such as `componentMetas` from `@fw/components`. Used for the diagnostics. */
  metas?: Readonly<Record<string, ComponentMeta>>;
  /** The clock for nudge merging, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Nudges closer together than this, on the same selection, are one undo step. Defaults to 500. */
  nudgeWindowMs?: number;
}

export interface DesignerModel {
  readonly host: DesignerHost;
  /** The text as last read. */
  readonly text: ReadonlySignal<string>;
  readonly status: ReadonlySignal<ModelStatus>;
  /** The form parsed from the text. While `status` isn't ok it keeps the last good one, or is null if there never was one. */
  readonly definition: ReadonlySignal<FormDefinition | null>;
  /** True if nothing may be written: `status` isn't ok, or the host is read-only. */
  readonly readOnly: ReadonlySignal<boolean>;
  /** Why it is read-only, for a banner, or null. */
  readonly readOnlyReason: ReadonlySignal<string | null>;
  /** Schema and meaning problems with the current text. Empty unless `status` is ok. */
  readonly diagnostics: ReadonlySignal<readonly Diagnostic[]>;
  /** The diagnostics that belong to one component itself, not to what is inside it. */
  diagnosticsOf(id: string): Diagnostic[];
  /** The component with this id in the current form. */
  find(id: string): ComponentDefinition | undefined;

  /** The selected ids. Ids that no longer exist are dropped after every text change. */
  readonly selection: ReadonlySignal<readonly string[]>;
  select(ids: readonly string[]): void;
  clearSelection(): void;

  /** Runs a command: next form, then `diffFormText`, then `host.applyEdits`. Writes nothing when read-only or when nothing changes. */
  apply(command: Command): Promise<ApplyResult>;
  /**
   * Adds a component of `type` at the end of a parent (null is the form), `position` relative to
   * the parent. Size and defaults come from the metas given to the model. The result holds the new
   * id when it was applied.
   */
  add(type: string, parentId: string | null, position: { x: number; y: number }, options?: Omit<AddOptions, 'metas'>): Promise<AddResult>;
  /** What the picker can offer for a binding key of a component, from its meta. Empty for an unknown component or key. */
  bindingChoices(componentId: string, key: string): BindingChoice[];
  /** Moves the selection by (dx, dy) pixels. Nudges on the same selection within the window merge into one undo step. */
  nudge(dx: number, dy: number): Promise<ApplyResult>;

  /** Stops listening to the host. */
  dispose(): void;
}

interface Parsed {
  status: ModelStatus;
  value: FormDefinition | null;
}

/** The part of a parsed JSON node the locator needs. */
interface JsonNode {
  type: string;
  offset: number;
  children?: JsonNode[];
}

/** The node at a diagnostic path such as `components[2].layout`, or the nearest one above it. */
function locate(root: JsonNode, path: string): JsonNode {
  let node = root;
  for (const match of path.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    const next =
      match[1] !== undefined
        ? node.children?.[Number(match[1])]
        : node.children?.find((property) => property.type === 'property' && (property.children?.[0] as { value?: unknown } | undefined)?.value === match[2])?.children?.[1];
    if (!next) break;
    node = next;
  }
  return node;
}

function parse(text: string): Parsed {
  const opened = openFormText(text);
  if (opened.status === 'conflict') return { status: { status: 'conflict', message: opened.message }, value: null };
  if (opened.status === 'invalid') return { status: { status: 'invalid', message: opened.message, line: opened.line, column: opened.column }, value: null };
  // Valid JSON can still be the wrong shape (no components, children that aren't a list). Such a file stays read-only.
  let first: Diagnostic | undefined;
  try {
    first = checkSchema(opened.value).find((d) => d.severity === 'error');
  } catch (error) {
    first = { severity: 'error', path: '', message: error instanceof Error ? error.message : String(error) };
  }
  if (first) {
    const offset = locate(opened.root as unknown as JsonNode, first.path).offset;
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    const where = first.path === '' ? '' : `${first.path}: `;
    return { status: { status: 'invalid', message: `Line ${line}, column ${column}: ${where}${first.message}`, line, column }, value: null };
  }
  return { status: { status: 'ok' }, value: opened.value as unknown as FormDefinition };
}

export function createDesignerModel(host: DesignerHost, options: DesignerModelOptions = {}): DesignerModel {
  const now = options.now ?? Date.now;
  const windowMs = options.nudgeWindowMs ?? 500;

  const text = signal(host.readText());
  const parsed = signal<Parsed>(parse(text.peek()));
  const lastGood = signal<FormDefinition | null>(parsed.peek().value);
  const selection = signal<readonly string[]>([]);

  const status = computed(() => parsed.value.status);
  const definition = computed(() => lastGood.value);
  const readOnlyReason = computed<string | null>(() => {
    const current = parsed.value.status;
    if (current.status !== 'ok') return current.message;
    return host.readOnly ? `${host.fileName} is read-only.` : null;
  });
  const readOnly = computed(() => readOnlyReason.value !== null);
  const diagnostics = computed<readonly Diagnostic[]>(() => {
    const current = parsed.value;
    if (current.status.status !== 'ok') return [];
    return validateForm(current.value, { components: options.metas });
  });

  /** Takes in new text: parse, keep the last good form, and drop selected ids that are gone. */
  const take = (next: string): void => {
    if (next === text.peek()) return;
    batch(() => {
      const result = parse(next);
      text.value = next;
      parsed.value = result;
      if (result.value) {
        lastGood.value = result.value;
        const exist = new Set(componentIds(result.value));
        const kept = selection.peek().filter((id) => exist.has(id));
        if (kept.length !== selection.peek().length) selection.value = kept;
      }
    });
  };
  const unsubscribe = host.onDidChangeText((changed) => take(changed));

  // One nudge in flight at a time, so bursts apply in order.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <R>(job: () => Promise<R>): Promise<R> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };

  let pendingNudge: { key: string; at: number; text: string } | null = null;

  const run = async (command: Command, merge: boolean): Promise<ApplyResult> => {
    take(host.readText());
    const current = parsed.peek();
    if (current.status.status !== 'ok' || !current.value) return { status: 'read-only', message: current.status.status === 'ok' ? '' : current.status.message };
    if (host.readOnly) return { status: 'read-only', message: `${host.fileName} is read-only.` };
    const before = text.peek();
    let edits;
    try {
      const next = command.run(current.value);
      if (next === current.value) return { status: 'unchanged' };
      edits = diffFormText(before, next);
    } catch (error) {
      return { status: 'rejected', message: error instanceof Error ? error.message : String(error) };
    }
    if (edits.length === 0) return { status: 'unchanged' };
    let accepted: boolean;
    try {
      accepted = await host.applyEdits(edits, command.label, merge ? { mergeWithPrevious: true } : undefined);
    } catch (error) {
      take(host.readText());
      return { status: 'rejected', message: error instanceof Error ? error.message : String(error) };
    }
    take(host.readText());
    return accepted ? { status: 'applied' } : { status: 'refused' };
  };

  const model: DesignerModel = {
    host,
    text,
    status,
    definition,
    readOnly,
    readOnlyReason,
    diagnostics,
    diagnosticsOf(id) {
      const form = parsed.peek().value;
      const found = form && findComponent(form, id);
      if (!found) return [];
      const inner = `${found.path}.children`;
      return diagnostics.peek().filter((d) => (d.path === found.path || d.path.startsWith(`${found.path}.`) || d.path.startsWith(`${found.path}[`)) && !d.path.startsWith(inner));
    },
    find: (id) => {
      const form = parsed.peek().value;
      return form ? findComponent(form, id)?.component : undefined;
    },
    selection,
    select(ids) {
      const form = parsed.peek().value;
      const exist = new Set(form ? componentIds(form) : []);
      const next = [...new Set(ids)].filter((id) => exist.has(id));
      const same = next.length === selection.peek().length && next.every((id, i) => id === selection.peek()[i]);
      if (!same) selection.value = next;
    },
    clearSelection() {
      if (selection.peek().length > 0) selection.value = [];
    },
    apply: (command) => enqueue(() => run(command, false)),
    add(type, parentId, position, addOptions = {}) {
      const metas = options.metas;
      if (!metas) return Promise.resolve({ status: 'rejected', message: 'The designer has no component list, so it cannot add components' });
      const command = commands.add(type, parentId, position, { ...addOptions, metas });
      return enqueue(async () => {
        take(host.readText());
        const form = parsed.peek().value;
        const id = form ? command.newId(form) : undefined;
        const result = await run(command, false);
        return result.status === 'applied' ? { ...result, id } : result;
      });
    },
    bindingChoices(componentId, key) {
      const form = parsed.peek().value ?? lastGood.peek();
      const component = form && findComponent(form, componentId)?.component;
      if (!form || !component) return [];
      const kind = options.metas?.[component.type]?.bindings[key] ?? (options.metas?.[component.type] ? undefined : key === 'dataset' || key === 'options' ? 'dataset' : 'column');
      const datasets = form.datasets ?? [];
      if (kind === 'dataset') return datasets.map((dataset) => ({ value: dataset.id, label: dataset.id, dataset: dataset.id }));
      if (kind === 'column') {
        return datasets.flatMap((dataset) =>
          dataset.columns.map((column) => ({ value: `${dataset.id}.${column.id}`, label: `${dataset.id}.${column.id}`, dataset: dataset.id, column: column.id, columnType: column.type })),
        );
      }
      return [];
    },
    nudge(dx, dy) {
      const ids = selection.peek();
      if (ids.length === 0) return Promise.resolve({ status: 'unchanged' } as const);
      const command = commands.move(ids, dx, dy);
      return enqueue(async () => {
        take(host.readText());
        const key = ids.join('\u0000');
        const at = now();
        const merge =
          host.canMergeEdits === true &&
          pendingNudge !== null &&
          pendingNudge.key === key &&
          at - pendingNudge.at <= windowMs &&
          // Anything else that changed the text in between ends the burst.
          pendingNudge.text === host.readText();
        const result = await run(command, merge);
        pendingNudge = result.status === 'applied' ? { key, at, text: host.readText() } : null;
        return result;
      });
    },
    dispose: unsubscribe,
  };
  return model;
}
