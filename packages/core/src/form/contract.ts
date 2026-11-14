/**
 * The shared contract for the form runtime. See docs/plans/step-2.md.
 * Others build against these types at the same time, so changes must be additive and reported.
 */
import type { ReadonlySignal } from '@preact/signals-core';
import type { ValidationIssue } from '../dataset.ts';
import type { ChangeResult } from '../events.ts';
import type { ExpressionScope } from '../expr/contract.ts';
import type { AnyDataset, DsxRowError, Transport, TransactionError, TxClient } from '../tx/contract.ts';
import type { ComponentDefinition, FormDefinition } from './definition.ts';

export type FormMode = 'run' | 'design';

export type FormState = 'loading' | 'initializing' | 'active' | 'inactive' | 'closing' | 'closed';

/** What generated `*.form.gen.ts` types describe. The defaults allow untyped use. */
export interface FormShape {
  datasets: Record<string, AnyDataset>;
  variables: Record<string, unknown>;
  params: Record<string, unknown>;
  /** What the form hands back to the form that opened it as a popup. Generated only for forms that declare `result`. */
  result?: unknown;
  /** The handler names the form file refers to. */
  handlers: string;
}

/** The result type of a form shape: its `result`, or `unknown` if it declares none. */
export type ResultOf<T extends FormShape> = T extends { result: infer R } ? R : unknown;

/** One validation issue, with the Dataset it belongs to. */
export interface FormIssue extends ValidationIssue {
  dataset: string;
}

export interface ValidateOptions {
  /** The Datasets to check. Defaults to those with `confirmUnsaved`, which are the ones a form saves. */
  datasets?: readonly string[];
}

export interface OpenOptions<S extends FormShape = FormShape> {
  params?: Partial<S['params']>;
  /** The popup's title. Defaults to the form file's `title`, then its `id`. */
  title?: string;
}

export interface ComponentHandle {
  /** A Grid takes a cell (row id and track index) to move its active cell there. Other components ignore it. */
  focus(cell?: { rowId: number; track: number }): void;
}

export interface FormContext<T extends FormShape = FormShape> {
  readonly id: string;
  readonly ds: T['datasets'];
  /** Assigning to a variable updates everything that reads it. */
  readonly vars: T['variables'];
  readonly params: T['params'];
  /** Component handles by id. Calls made before React has committed are queued. */
  readonly c: Readonly<Record<string, ComponentHandle>>;
  readonly tx: TxClient;
  /** Aborted when the form closes. */
  readonly signal: AbortSignal;
  /**
   * Opens another form as a modal popup, above this one, and resolves with what it passes to
   * `close(result)`, or `undefined` if it was cancelled. Rejects if this form wasn't created by a
   * shell, or is closing. This form stays open and keeps its state.
   */
  open<S extends FormShape = FormShape>(entry: FormEntry<S>, options?: OpenOptions<S>): Promise<ResultOf<S> | undefined>;
  /**
   * Closes this form: runs `beforeClose` (which can veto, giving false), closes its popups, aborts
   * its pending calls. In a popup, a successful close resolves the opener's `open` with `result`.
   */
  close(result?: ResultOf<T>): Promise<boolean>;
  /**
   * Validates the rows to save of the Datasets with `confirmUnsaved` (or the ones in `options.datasets`),
   * sets the issues on them (and clears the issues of the ones it checked) and focuses the first in
   * view order: a bound input on the current row, else the Grid cell, else it makes that row current
   * and focuses the input. A Tabs page holding the target is selected first. Returns the issues, in
   * Dataset order then view order. Throws for an unknown Dataset name.
   */
  validate(options?: ValidateOptions): FormIssue[];
  /**
   * Shows server row errors the way `validate` shows client ones: sets them as issues on the
   * Datasets they name, and focuses the first. Takes a `TransactionError` or its `rowErrors`. Errors
   * that name no Dataset, a Dataset this form doesn't have, a stale row or a missing column can't be
   * placed, and are left out of the result. Returns the issues placed.
   */
  showRowErrors(errors: TransactionError | readonly DsxRowError[]): FormIssue[];
}

export interface InitEvent<T extends FormShape = FormShape> {
  params: T['params'];
}

/**
 * The event is `any` so an unannotated `onInit({ params })` in a form script type-checks. With
 * `never`, destructuring it fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormHandler = (event: any) => unknown;

/** Every handler the form file names is required, so a missing one is a compile error. */
export type FormHandlers<T extends FormShape = FormShape> = { [K in T['handlers']]: FormHandler } & {
  [name: string]: FormHandler;
};

export type FormSetup<T extends FormShape = FormShape> = (form: FormContext<T>) => FormHandlers<T>;

export interface FormModule<T extends FormShape = FormShape> {
  readonly setup: FormSetup<T>;
}

/**
 * One component's live state. React reads `props` through `useSyncExternalStore`, and only ever
 * sees plain values, never a Dataset or row (FRAMEWORK.md §5.1).
 */
export interface ComponentModel {
  readonly id: string;
  /** Changes only through `applyPatch` in design mode. */
  readonly definition: ReadonlySignal<ComponentDefinition>;
  /**
   * Literal props, plus `=` expressions evaluated, plus `bind` values read. It keeps the same
   * object until a value actually changes (shallow-equal cut-off), so it's a stable snapshot.
   * A column binding with no current row gives `value: null` and `disabled: true`.
   */
  readonly props: ReadonlySignal<Readonly<Record<string, unknown>>>;
  readonly children: ReadonlySignal<readonly ComponentModel[]>;
  /**
   * Writes a bound prop to its column. Text is parsed to the column's type. False means nothing
   * was written: the value doesn't fit, a handler refused, there's no current row, or this is
   * design mode. Flushes the Dataset's invalidation before returning. With `rowId`, writes that
   * row instead of the current one, and returns false if it's gone or stale.
   */
  write(prop: string, value: unknown, rowId?: number): ChangeResult;
  /**
   * Like `write`, for a Grid cell: writes one column of a given row of the Dataset a
   * Dataset-kind binding (`bind.dataset` by default) points at. False if the row is gone or stale.
   */
  writeCell(rowId: number, column: string, value: unknown, key?: string): ChangeResult;
  /** Like `accepts`, for a column of the bound Dataset. Never throws. */
  acceptsCell(column: string, value: unknown, key?: string): boolean;
  /**
   * True if `write` could store this value: it fits the bound column's type, or the prop isn't
   * bound. Handlers can still refuse it. This lets an input tell text that doesn't fit, which stays
   * on screen marked invalid, from an edit a handler cancelled, which goes back to the bound value.
   * Never throws, and doesn't depend on the mode.
   */
  accepts(prop: string, value: unknown): boolean;
  /** Runs the handler for an event, catching errors so they can't break rendering. No-op in design mode. */
  fire(event: string, detail?: unknown): void;
  /** Set by the host once React has committed. Queued script calls run then. */
  setHandle(handle: ComponentHandle | null): void;
  /**
   * The Dataset a Dataset-kind binding points at (`bind.dataset` by default), for components such
   * as the Grid that work on a whole Dataset. It adds no prop, and React must not hold it in state.
   */
  getBoundDataset(key?: string): AnyDataset | undefined;
  /**
   * The form's expression scope, plus one-segment aggregate paths such as `sum(salary)` on the
   * Dataset bound at `key` (`bind.dataset` by default). Reads follow the Dataset inside a `computed`.
   */
  cellScope(key?: string): ExpressionScope;
}

export interface FormInstance<T extends FormShape = FormShape> {
  readonly id: string;
  readonly mode: FormMode;
  readonly context: FormContext<T>;
  readonly state: ReadonlySignal<FormState>;
  readonly definition: ReadonlySignal<FormDefinition>;
  /** Top-level components. */
  readonly components: ReadonlySignal<readonly ComponentModel[]>;
  getComponent(id: string): ComponentModel | undefined;
  getDataset(id: string): AnyDataset | undefined;
  /** Runs `onInit`, then becomes active. */
  init(): Promise<void>;
  activate(): void;
  deactivate(): void;
  /**
   * Runs `onBeforeClose`, which can veto. Returns false if vetoed. Then closes this form's popups,
   * aborts pending calls and runs `onClose`. A popup's `result` goes to the opener once closed.
   */
  close(result?: unknown): Promise<boolean>;
  validate(options?: ValidateOptions): FormIssue[];
  showRowErrors(errors: TransactionError | readonly DsxRowError[]): FormIssue[];
  /** Sends an error to the form's `onError`, so hosts report through one path. */
  reportError(error: unknown, where: string): void;
  /** True if a Dataset with `confirmUnsaved` has changes. */
  hasUnsavedChanges(): boolean;
  /** Design mode only: changes one component with no remount, unless its type changes. */
  applyPatch(id: string, patch: Partial<ComponentDefinition>): void;
  /**
   * Design mode only: makes the form match a whole new definition, in place. A component with the
   * same id and type keeps its model, wherever it now sits, and gets its new definition. New ones are
   * created, removed ones disposed, and a type change replaces the model. If the Datasets, variables
   * or params change, those are rebuilt and so is every component model. The form's own `id` follows
   * the definition. Throws before changing anything if an id is used twice.
   */
  applyDefinition(next: FormDefinition): void;
  /**
   * Design mode only: shows the component `id` for the designer. The Tabs page holding it becomes
   * the selected one, and a Dialog holding it, or being it, shows in place. `null` restores what the
   * definition says. The definition is never written. Throws for an unknown id.
   */
  reveal(id: string | null): void;
}

export interface CreateFormOptions<T extends FormShape = FormShape> {
  module?: FormModule<T>;
  params?: Partial<T['params']>;
  mode?: FormMode;
  transport?: Transport;
  /** Where script and expression errors go. Defaults to `console.error`. */
  onError?: (error: unknown, where: string) => void;
  /** Set by a shell. Without it, `form.open` rejects. */
  host?: FormHost;
  /** Called once when the form has closed, with the `result` given to `close`. A shell uses it to resolve the opener. */
  onClosed?: (result: unknown) => void;
}

/** What a shell gives a form so it can open popups. Not for scripts. */
export interface FormHost {
  /** Opens `entry` above `opener`. Resolves with the popup's result, or `undefined` if cancelled. */
  openPopup(opener: FormInstance, entry: FormEntry, options: OpenOptions): Promise<unknown>;
  /** Cancels the popups `opener` has open, top first. False if one vetoed. */
  closePopups(opener: FormInstance): Promise<boolean>;
}

/** What importing a `*.form.json` file gives you. The script loads lazily. */
export interface FormEntry<T extends FormShape = FormShape> {
  readonly definition: FormDefinition;
  load(): Promise<FormModule<T>>;
}
