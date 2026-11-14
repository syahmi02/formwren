import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTxClient, httpTransport, TransactionError, type DsxRequest, type DsxResponse } from '../src/index.ts';
import { scenarios } from './dsx-scenarios.ts';
import type { ManifestEntry } from './tx-vectors.test.ts';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A real HTTP server on a random port, which records what it receives. */
async function serve(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: Seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(record);
      handler(req, res, record);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function reply(status: number, body: unknown, type = 'application/json'): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

const request: DsxRequest = { dsx: 1, txId: 'T1', service: 'hr.emp.save', params: { a: 1 } };
const live = { signal: new AbortController().signal };

async function failure(promise: Promise<unknown>): Promise<TransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    return error as TransactionError;
  }
  throw new Error('should have rejected');
}

describe('httpTransport', () => {
  it('POSTs the request as JSON to /dsx/v1/tx/{service}, with the screen and extra headers', async () => {
    const { url, seen } = await serve(reply(200, { status: { ok: true }, params: { saved: 1 } }));
    const transport = httpTransport(`${url}/`, { headers: { authorization: 'Bearer abc' } });
    const response = await transport.send({ ...request, service: 'hr.emp.save' }, { signal: live.signal, screen: 'EmpList' });
    expect(response).toEqual({ status: { ok: true }, params: { saved: 1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/dsx/v1/tx/hr.emp.save');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers['dsx-screen']).toBe('EmpList');
    expect(seen[0]?.headers['authorization']).toBe('Bearer abc');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(request);
  });

  it('leaves out DSX-Screen when no screen is known, and takes headers from a function each time', async () => {
    const { url, seen } = await serve(reply(200, { status: { ok: true } }));
    let n = 0;
    const transport = httpTransport(url, { headers: () => ({ 'x-n': String(++n) }) });
    await transport.send(request, live);
    await transport.send(request, live);
    expect(seen[0]?.headers['dsx-screen']).toBeUndefined();
    expect(seen.map((s) => s.headers['x-n'])).toEqual(['1', '2']);
  });

  it('encodes the service id in the path', async () => {
    const { url, seen } = await serve(reply(200, { status: { ok: true } }));
    await httpTransport(url).send({ ...request, service: 'a b/c' }, live);
    expect(seen[0]?.url).toBe('/dsx/v1/tx/a%20b%2Fc');
  });

  it.each([
    [400, 'bad-request', undefined],
    [401, 'unauthorized', undefined],
    [403, 'forbidden', undefined],
    [404, 'unknown-service', undefined],
    [409, 'conflict', undefined],
    [413, 'too-large', undefined],
    [422, 'invalid', undefined],
    [500, 'server-error', undefined],
    [503, 'server-error', undefined],
    [409, 'conflict', 'conflict'],
    [422, 'required-fields', 'required-fields'],
  ])('HTTP %i with a DSX failure returns it with code %s', async (status, code, sent) => {
    const errors = [{ dataset: 'dsEmp', id: 2, code: 'x', message: 'm' }];
    const { url } = await serve(reply(status, { status: { ok: false, ...(sent ? { code: sent } : {}), message: 'no' }, errors }));
    const response = await httpTransport(url).send(request, live);
    expect(response.status).toEqual({ ok: false, code, message: 'no' });
    expect(response.errors).toEqual(errors);
  });

  it('the client turns each failure status into a TransactionError with the code and row errors', async () => {
    const errors = [{ dataset: 'dsEmp', id: 2, code: 'conflict', message: 'm' }];
    const { url } = await serve(reply(409, { status: { ok: false, message: 'Changed' }, errors }));
    const error = await failure(createTxClient(httpTransport(url), live).call({ service: 'hr.emp.save' }));
    expect(error.code).toBe('conflict');
    expect(error.rowErrors).toEqual(errors);
    expect(error.committed).toBe(false);
  });

  it('passes the form id as the screen through the client', async () => {
    const { url, seen } = await serve(reply(200, { status: { ok: true } }));
    await createTxClient(httpTransport(url), { ...live, screen: 'D1' }).call({ service: 'hr.emp.search' });
    expect(seen[0]?.headers['dsx-screen']).toBe('D1');
  });

  it.each([
    ['an HTML error page', 500, '<html>boom</html>', 'text/html'],
    ['plain text', 500, 'Bad gateway', 'text/plain'],
    ['an empty body', 200, '', 'application/json'],
    ['JSON that is not DSX', 200, '{"hello":"world"}', 'application/json'],
    ['a JSON array', 200, '[]', 'application/json'],
    ['a status without ok', 200, '{"status":{}}', 'application/json'],
    ['success with an error status', 500, '{"status":{"ok":true}}', 'application/json'],
    ['a truncated body', 200, '{"status":{"ok":tr', 'application/json'],
  ])('%s becomes bad-response', async (_name, status, body, type) => {
    const { url } = await serve(reply(status, body, type));
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('bad-response');
    expect(error.committed).toBe(false);
    // A 2xx or 5xx that isn't DSX may have run, so the outcome is unknown. Every answer here is one.
    expect(error.outcomeUnknown).toBe(true);
  });

  it('a 4xx that is not DSX was refused before running, so the outcome is known', async () => {
    const { url } = await serve(reply(413, 'Too big', 'text/plain'));
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('bad-response');
    expect(error.outcomeUnknown).toBe(false);
  });

  it.each([502, 503, 504])('HTTP %i with an empty text/plain body (a proxy that lost the server) is network, outcome unknown', async (status) => {
    const { url } = await serve(reply(status, '', 'text/plain'));
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('network');
    expect(error.outcomeUnknown).toBe(true);
    expect(error.committed).toBe(false);
  });

  it('a 502 with a DSX body is that response, never unknown', async () => {
    const { url } = await serve(reply(502, { status: { ok: false, code: 'upstream', message: 'x' } }));
    const response = await httpTransport(url).send(request, live);
    expect(response.status.code).toBe('upstream');
    const error = await failure(createTxClient(httpTransport(url), live).call({ service: 'a.b' }));
    expect(error.code).toBe('upstream');
    expect(error.outcomeUnknown).toBe(false);
  });

  it('a body cut off mid-response is network, outcome unknown', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"status":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('network');
    expect(error.outcomeUnknown).toBe(true);
  });

  it('through the client a 502 keeps the edits and says the outcome is unknown', async () => {
    const { url } = await serve(reply(502, '', 'text/plain'));
    const built = scenarios['save-emp-changed']!();
    const error = await failure(createTxClient(httpTransport(url), live).call(built.call));
    expect(error.code).toBe('network');
    expect(error.outcomeUnknown).toBe(true);
    expect(built.datasets['dsEmp']!.hasChanges()).toBe(true);
  });

  it('known outcomes: a DSX failure, a pre-aborted call and a redirect are not unknown', async () => {
    const { url } = await serve(reply(409, { status: { ok: false, code: 'conflict' } }));
    expect((await failure(createTxClient(httpTransport(url), live).call({ service: 'a.b' }))).outcomeUnknown).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const early = await failure(httpTransport(url).send(request, { signal: controller.signal }));
    expect(early.outcomeUnknown).toBe(false);
    const redirect = await serve((_req, res) => {
      res.writeHead(302, { location: '/login' });
      res.end();
    });
    expect((await failure(httpTransport(redirect.url).send(request, live))).outcomeUnknown).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])('a %i redirect becomes session, and is not followed', async (status) => {
    const target = await serve(reply(200, { status: { ok: true } }));
    const { url } = await serve((_req, res) => {
      res.writeHead(status, { location: `${target.url}/login` });
      res.end();
    });
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('session');
    expect(target.seen).toHaveLength(0);
  });

  it('a refused connection becomes network, with no retry', async () => {
    const { url } = await serve(reply(200, {}));
    await closeAll();
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('network');
    expect(error.outcomeUnknown).toBe(true);
  });

  it('a connection dropped mid-request becomes network and is not retried', async () => {
    const { url, seen } = await serve((req) => req.socket.destroy());
    const error = await failure(httpTransport(url).send(request, live));
    expect(error.code).toBe('network');
    expect(seen).toHaveLength(1);
  });

  it('a server error is not retried', async () => {
    const { url, seen } = await serve(reply(500, { status: { ok: false, message: 'x' } }));
    await httpTransport(url).send(request, live);
    expect(seen).toHaveLength(1);
  });

  it('an abort while the server is still answering becomes aborted', async () => {
    const { url, seen } = await serve(() => undefined); // never answers
    const controller = new AbortController();
    const pending = httpTransport(url).send(request, { signal: controller.signal });
    const result = failure(pending);
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const error = await result;
    expect(error.code).toBe('aborted');
    expect(error.outcomeUnknown).toBe(true);
  });

  it('an abort while the body is arriving becomes aborted', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"status":'); // the rest never comes
    });
    const controller = new AbortController();
    const result = failure(httpTransport(url).send(request, { signal: controller.signal }));
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect((await result).code).toBe('aborted');
  });

  it('an abort before sending never reaches the server', async () => {
    const { url, seen } = await serve(reply(200, { status: { ok: true } }));
    const controller = new AbortController();
    controller.abort();
    const error = await failure(httpTransport(url).send(request, { signal: controller.signal }));
    expect(error.code).toBe('aborted');
    expect(error.outcomeUnknown).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('through the client, an abort mid-request rejects with aborted and a timeout with timeout', async () => {
    const { url } = await serve(() => undefined);
    const controller = new AbortController();
    const first = failure(createTxClient(httpTransport(url), live).call({ service: 'a.b', signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    const aborted = await first;
    expect(aborted.code).toBe('aborted');
    expect(aborted.outcomeUnknown).toBe(true);
    const second = await failure(createTxClient(httpTransport(url), live).call({ service: 'a.b', timeoutMs: 40 }));
    expect(second.code).toBe('timeout');
    expect(second.outcomeUnknown).toBe(true);
  });
});

async function closeAll(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

describe('the golden vectors over HTTP', () => {
  const dir = new URL('./fixtures/dsx/', import.meta.url);
  const { vectors } = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { vectors: Record<string, ManifestEntry> };

  it.each(Object.entries(vectors).filter(([name]) => name in scenarios))(
    '%s: served with its HTTP status, the client sees what the vector says',
    async (name, entry) => {
      const response = JSON.parse(readFileSync(new URL(`${name}.response.json`, dir), 'utf8')) as DsxResponse;
      const { url } = await serve(reply(entry.http, response));
      const built = scenarios[name]!();
      const outcome = await createTxClient(httpTransport(url), live)
        .call(built.call)
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      if (entry.http < 400) {
        expect(outcome.ok).toBe(true);
      } else {
        expect(outcome.ok).toBe(false);
        const error = (outcome as { error: TransactionError }).error;
        expect(error).toBeInstanceOf(TransactionError);
        expect(error.code).toBe(response.status.code);
        expect(error.rowErrors).toEqual(response.errors ?? []);
      }
    },
  );
});
