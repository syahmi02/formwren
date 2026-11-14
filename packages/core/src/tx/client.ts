import type { SaveTicket } from '../dataset.ts';
import { coerceValue } from '../values.ts';
import { encodeInput, normalizeInput, normalizeOutput, prepareOutput } from './codec.ts';
import {
  TransactionError,
  type AnyDataset,
  type DsxRequest,
  type DsxRequestDataset,
  type DsxResponse,
  type Transport,
  type TxCallOptions,
  type TxClient,
  type TxResult,
} from './contract.ts';

export const DEFAULT_TIMEOUT_MS = 30_000;

let counter = 0;

function newTxId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${(++counter).toString(36)}-${random}`;
}

interface PendingSave {
  name: string;
  dataset: AnyDataset;
  ticket: SaveTicket;
}

/** Datasets with a `changed` save running, across every client and service. */
const savingDatasets = new Set<AnyDataset>();

/** `owner.signal` aborts every call when the form closes. With no transport, calls reject. */
export function createTxClient(transport: Transport | undefined, owner: { signal: AbortSignal; screen?: string }): TxClient {
  const running = new Set<string>();

  async function call(options: TxCallOptions): Promise<TxResult> {
    if (!transport) throw new TransactionError('no-transport', 'No transport is configured, so the service cannot be called');
    if (running.has(options.service)) {
      throw new TransactionError('duplicate', `A call to "${options.service}" is already running`);
    }
    const changedInputs = Object.entries(options.inputs ?? {})
      .map(([name, raw]) => ({ name, ...normalizeInput(raw) }))
      .filter((input) => input.rows === 'changed');
    const locked: AnyDataset[] = [];
    for (const input of changedInputs) {
      if (savingDatasets.has(input.dataset)) {
        for (const ds of locked) savingDatasets.delete(ds);
        throw new TransactionError('duplicate', `Dataset "${input.dataset.id}" already has a save running`);
      }
      savingDatasets.add(input.dataset);
      locked.push(input.dataset);
    }
    running.add(options.service);

    const controller = new AbortController();
    let reason: 'aborted' | 'timeout' | null = null;
    let sent = false;
    const abortWith = (why: 'aborted' | 'timeout'): void => {
      if (reason === null) reason = why;
      controller.abort();
    };
    const onAbort = (): void => abortWith('aborted');
    const signals = [owner.signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    const timer = setTimeout(() => abortWith('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      for (const signal of signals) {
        if (signal.aborted) abortWith('aborted');
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const failure = (): TransactionError =>
        reason === 'timeout'
          ? new TransactionError('timeout', `"${options.service}" didn't answer in time`, [], false, sent)
          : new TransactionError('aborted', `The call to "${options.service}" was cancelled`, [], false, sent);
      if (controller.signal.aborted) throw failure();

      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
      });
      aborted.catch(() => undefined);

      // An edit still waiting on an async handler must be in this save.
      if (changedInputs.length > 0) {
        await Promise.race([Promise.all(changedInputs.map((input) => input.dataset.settled())), aborted]);
      }

      // Build the request. Nothing here changes a Dataset.
      const saves: PendingSave[] = [];
      let datasets: Record<string, DsxRequestDataset> | undefined;
      for (const [name, raw] of Object.entries(options.inputs ?? {})) {
        const { dataset, rows } = normalizeInput(raw);
        let ticket: SaveTicket | undefined;
        if (rows === 'changed') {
          ticket = dataset.beginSave();
          saves.push({ name, dataset, ticket });
        }
        (datasets ??= {})[name] = encodeInput(name, raw, ticket);
      }
      const request: DsxRequest = { dsx: 1, txId: newTxId(), service: options.service };
      if (options.params) request.params = options.params;
      if (datasets) request.datasets = datasets;

      let response: DsxResponse;
      sent = true;
      try {
        response = await Promise.race([transport.send(request, owner.screen === undefined ? { signal: controller.signal } : { signal: controller.signal, screen: owner.screen }), aborted]);
      } catch (error) {
        if (error instanceof TransactionError) throw error;
        if (controller.signal.aborted) throw failure();
        throw new TransactionError('network', error instanceof Error ? error.message : String(error), [], false, true);
      }

      if (!response || typeof response !== 'object' || !response.status || typeof response.status.ok !== 'boolean') {
        throw new TransactionError('bad-response', 'The response has no status', [], false, true);
      }
      if (!response.status.ok) {
        throw new TransactionError(
          response.status.code ?? 'server-error',
          response.status.message ?? 'The server reported a failure',
          Array.isArray(response.errors) ? response.errors : [],
        );
      }

      // From here the server has committed. Check what can be checked first, but the saves are
      // accepted whatever happens, so the same rows are never sent twice.
      let problem: TransactionError | undefined;
      const noteProblem = (error: unknown): void => {
        if (!problem) {
          problem = error instanceof TransactionError
            ? new TransactionError('bad-response', error.message, [], true)
            : new TransactionError('bad-response', String(error), [], true);
        }
      };

      const loads: { name: string; dataset: AnyDataset; rows: ReturnType<typeof prepareOutput>; append: boolean }[] = [];
      for (const [name, raw] of Object.entries(options.outputs ?? {})) {
        const { dataset, mode } = normalizeOutput(raw);
        try {
          loads.push({ name, dataset, rows: prepareOutput(name, response.datasets?.[name], dataset), append: mode === 'append' });
        } catch (error) {
          noteProblem(error);
        }
      }

      for (const save of saves) {
        let applied: Map<number, Record<string, unknown>> | undefined;
        try {
          applied = prepareApplied(save, response);
        } catch (error) {
          noteProblem(error);
        }
        save.dataset.acceptSave(save.ticket, applied);
      }

      const skippedOutputs: string[] = [];
      if (!problem) {
        for (const load of loads) {
          // Edits made during this save must not be replaced by the server's rows.
          if (saves.some((save) => save.dataset === load.dataset) && load.dataset.hasChanges()) {
            skippedOutputs.push(load.name);
            continue;
          }
          load.dataset.load(load.rows, { append: load.append });
        }
      }
      if (problem) throw problem;

      return { status: response.status, params: response.params ?? {}, skippedOutputs };
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      running.delete(options.service);
      for (const ds of locked) savingDatasets.delete(ds);
    }
  }

  return { call };
}

/** Maps `applied[name][rowId]` to what `acceptSave` wants, checking the values first. */
function prepareApplied(save: PendingSave, response: DsxResponse): Map<number, Record<string, unknown>> | undefined {
  const forInput = response.applied?.[save.name];
  if (!forInput) return undefined;
  const sent = new Set(save.ticket.changes.map((change) => change.rowId));
  const map = new Map<number, Record<string, unknown>>();
  for (const [key, patch] of Object.entries(forInput)) {
    const rowId = Number(key);
    if (!Number.isInteger(rowId) || !sent.has(rowId) || typeof patch !== 'object' || patch === null) {
      throw new TransactionError('bad-response', `"applied" for "${save.name}" names row "${key}", which wasn't sent`);
    }
    const values: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(patch)) {
      const def = save.dataset.columns.find((c) => c.id === column);
      if (!def) throw new TransactionError('bad-response', `"applied" for "${save.name}" names unknown column "${column}"`);
      try {
        values[column] = coerceValue(def, value);
      } catch (error) {
        throw new TransactionError('bad-response', error instanceof Error ? error.message : String(error));
      }
    }
    map.set(rowId, values);
  }
  return map;
}
