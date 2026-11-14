import type { DsxRequest, DsxResponse, Transport } from './contract.ts';

export type FixtureResponse = DsxResponse | ((request: DsxRequest) => DsxResponse);

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The call was aborted', 'AbortError');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Answers from saved responses, by service id, for preview, demos and tests (FR-066). */
export function fixtureTransport(responses: Readonly<Record<string, FixtureResponse>>, options: { delayMs?: number } = {}): Transport {
  return {
    async send(request, { signal }) {
      if (signal.aborted) throw abortError(signal);
      // A real wire trip, so a request that wouldn't survive JSON fails here too.
      const wire = JSON.parse(JSON.stringify(request)) as DsxRequest;
      if (options.delayMs && options.delayMs > 0) await wait(options.delayMs, signal);
      if (signal.aborted) throw abortError(signal);

      if (!Object.hasOwn(responses, wire.service)) {
        return { status: { ok: false, code: 'unknown-service', message: `No fixture for service "${wire.service}"` } };
      }
      const entry = responses[wire.service] as FixtureResponse;
      const response = typeof entry === 'function' ? entry(wire) : entry;
      return JSON.parse(JSON.stringify(response)) as DsxResponse;
    },
  };
}
