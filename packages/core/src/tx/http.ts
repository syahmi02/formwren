import { TransactionError, type DsxRequest, type DsxResponse, type Transport } from './contract.ts';

export interface HttpTransportOptions {
  /** Extra request headers, such as an auth token. A function is called for every request. */
  headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  /** Used instead of the global `fetch`, for tests and special environments. */
  fetch?: typeof fetch;
}

/** The code given to a failure the server sent without one, by HTTP status. */
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'unknown-service',
  409: 'conflict',
  413: 'too-large',
  422: 'invalid',
};

/** Whether an answer that isn't usable DSX leaves it open that the request ran: a 4xx was refused before running. */
function mayHaveRun(status: number): boolean {
  return status < 400 || status >= 500;
}

function isDsxResponse(value: unknown): value is DsxResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'object' && status !== null && typeof (status as { ok?: unknown }).ok === 'boolean';
}

/**
 * Sends each request as `POST {baseUrl}/dsx/v1/tx/{service}` with JSON (FRAMEWORK.md §6.2). It
 * never retries, because after a network failure the outcome of a save is unknown.
 *
 * - Any HTTP status with a DSX body returns that body. A failure without a code gets one from the
 *   HTTP status (409 `conflict`, 404 `unknown-service`, 400 `bad-request`, 422 `invalid`, else
 *   `server-error`), and a body that says `ok: true` with a 4xx/5xx status is `bad-response`.
 * - A 502, 503 or 504 without a DSX body is `network`, like a dropped connection, and both set
 *   `outcomeUnknown`. Any other body that isn't DSX is `bad-response`. A redirect is `session`, because the session
 *   probably expired. A failed fetch is `network`, and an abort is `aborted`.
 */
export function httpTransport(baseUrl: string, options: HttpTransportOptions = {}): Transport {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    async send(request: DsxRequest, { signal, screen }: { signal: AbortSignal; screen?: string }): Promise<DsxResponse> {
      const aborted = (sent = false): TransactionError =>
        new TransactionError('aborted', `The call to "${request.service}" was cancelled`, [], false, sent);
      if (signal.aborted) throw aborted();

      const extra = typeof options.headers === 'function' ? options.headers() : (options.headers ?? {});
      const headers: Record<string, string> = { ...extra, 'content-type': 'application/json', accept: 'application/json' };
      if (screen !== undefined) headers['dsx-screen'] = screen;

      const doFetch = options.fetch ?? globalThis.fetch;
      let response: Response;
      let text: string;
      try {
        response = await doFetch(`${root}/dsx/v1/tx/${encodeURIComponent(request.service)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal,
          redirect: 'manual',
        });
        // Browsers hide a redirect as an "opaque" response, and other runtimes show its 3xx status.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => undefined);
          throw new TransactionError('session', 'The server redirected the request, so the session has probably expired');
        }
        text = await response.text();
      } catch (error) {
        if (error instanceof TransactionError) throw error;
        if (signal.aborted) throw aborted(true);
        throw new TransactionError('network', error instanceof Error ? error.message : String(error), [], false, true);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!isDsxResponse(body)) {
        // A proxy or gateway that lost the server (502, 503, 504) says nothing about whether it ran.
        if (response.status === 502 || response.status === 503 || response.status === 504) {
          throw new TransactionError('network', `The server couldn't be reached (HTTP ${response.status}), so the outcome is unknown`, [], false, true);
        }
        throw new TransactionError('bad-response', `The server answered HTTP ${response.status} with something that isn't DSX`, [], false, mayHaveRun(response.status));
      }
      if (response.status >= 400 && body.status.ok) {
        throw new TransactionError('bad-response', `The server answered HTTP ${response.status} but reported success`, [], false, mayHaveRun(response.status));
      }
      if (!body.status.ok && body.status.code === undefined) {
        body.status.code = CODE_BY_STATUS[response.status] ?? 'server-error';
      }
      return body;
    },
  };
}
