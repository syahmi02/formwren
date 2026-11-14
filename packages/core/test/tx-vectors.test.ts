import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTxClient, TransactionError, type DsxRequest, type DsxResponse, type Transport } from '../src/index.ts';
import { rawRequests, scenarios, type Built } from './dsx-scenarios.ts';

const dir = new URL('./fixtures/dsx/', import.meta.url);
const UPDATE = process.env['UPDATE_VECTORS'] === '1';

export interface ManifestEntry {
  http: number;
  /** Whether the real server must pass it. Client-only vectors test the client's tolerance. */
  conformance: boolean;
  note: string;
  service: string;
  request?: string;
  response?: string;
}

function readManifest(): { vectors: Record<string, ManifestEntry> } {
  return JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { vectors: Record<string, ManifestEntry> };
}

function load<T>(name: string, kind: 'request' | 'response'): T {
  return JSON.parse(readFileSync(new URL(`${name}.${kind}.json`, dir), 'utf8')) as T;
}

/** Records the request as it travels, and answers with the golden response. */
function recorder(response: DsxResponse): { transport: Transport; sent: () => DsxRequest } {
  let last: DsxRequest | undefined;
  return {
    transport: {
      async send(request) {
        last = JSON.parse(JSON.stringify(request)) as DsxRequest;
        return response;
      },
    },
    sent: () => ({ ...(last as DsxRequest), txId: 'TX' }),
  };
}

const signal = { signal: new AbortController().signal };

async function failure(promise: Promise<unknown>): Promise<TransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    return error as TransactionError;
  }
  throw new Error('should have rejected');
}

function scenario(name: string): Built {
  const build = scenarios[name];
  if (!build) throw new Error(`No scenario "${name}"`);
  return build();
}

/** What the client would send for a scenario, whatever the response. */
async function requestOf(name: string): Promise<DsxRequest> {
  const rec = recorder({ status: { ok: true } });
  await createTxClient(rec.transport, signal)
    .call(scenario(name).call)
    .catch(() => undefined);
  return rec.sent();
}

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

describe('DSX vector files', () => {
  const { vectors } = readManifest();
  const names = Object.keys(vectors);

  it('every vector in the manifest has its files, and every file is in the manifest', () => {
    const files = readdirSync(dir).filter((f) => f !== 'manifest.json');
    const expected = new Set<string>();
    for (const [name, entry] of Object.entries(vectors)) {
      expected.add(entry.request ?? `${name}.request.json`);
      expected.add(entry.response ?? `${name}.response.json`);
    }
    expect(files.sort()).toEqual([...expected].sort());
  });

  it.each(names)('%s: the HTTP status agrees with the response', (name) => {
    const entry = vectors[name] as ManifestEntry;
    const response = JSON.parse(readFileSync(new URL(entry.response ?? `${name}.response.json`, dir), 'utf8')) as DsxResponse;
    expect(response.status.ok).toBe(entry.http < 400);
    const codes: Record<number, string> = { 400: 'bad-request', 404: 'unknown-service', 409: 'conflict', 422: 'invalid' };
    if (entry.http in codes) expect(response.status.code).toBe(codes[entry.http]);
    if (entry.http === 200) expect(response.errors).toBeUndefined();
    expect(entry.note.length).toBeGreaterThan(10);
  });

  const built = names.filter((name) => name in scenarios);
  it('every vector is built by a scenario or is a raw request', () => {
    expect(names.filter((n) => !built.includes(n)).sort()).toEqual([...rawRequests].sort());
  });

  // The requests are what the client encoder produces, so a vector can't drift from the client.
  it.each(built)('%s: the request file is what the client sends', async (name) => {
    const sent = await requestOf(name);
    const file = new URL(`${name}.request.json`, dir);
    if (UPDATE) writeFileSync(file, stable(sent));
    expect(existsSync(file)).toBe(true);
    expect(sent).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
});

describe('DSX golden vectors, client side', () => {
  it('search-emp: params go out, a reordered response with extra and missing columns lands by id', async () => {
    const rec = recorder(load<DsxResponse>('search-emp', 'response'));
    const built = scenario('search-emp');
    const ds = built.datasets['dsEmp']!;
    const result = await createTxClient(rec.transport, signal).call(built.call);
    expect(rec.sent()).toEqual(load('search-emp', 'request'));
    expect(result.params).toEqual({ total: 2 });
    expect(ds.rowCount).toBe(2);
    expect(ds.getValue(0, 'empNo')).toBe('E1001');
    expect(ds.getValue(0, 'empName')).toBe('Minju Kim');
    expect(ds.getValue(0, 'salary')).toBe('5200000');
    expect(ds.getValue(0, 'ver')).toBe(null);
    expect(ds.getValue(1, 'empName')).toBe('Seojun Park');
  });

  it('save-emp-changed: I, U and D go out as changes, the version flag is sent, and applied lands', async () => {
    const rec = recorder(load<DsxResponse>('save-emp-changed', 'response'));
    const built = scenario('save-emp-changed');
    const ds = built.datasets['dsEmp']!;
    await createTxClient(rec.transport, signal).call(built.call);
    const request = rec.sent();
    expect(request).toEqual(load('save-emp-changed', 'request'));
    expect(request.datasets?.['dsEmp']?.columns.filter((c) => c.version)).toEqual([{ id: 'ver', type: 'int', version: true }]);
    expect(ds.hasChanges()).toBe(false);
    expect(ds.getValue(0, 'ver')).toBe(8);
    expect(ds.getValue(2, 'empNo')).toBe('E1003');
    expect(ds.getValue(2, 'ver')).toBe(1);
  });

  it('replace-emp-conflict: live ids go out, and the error id is a real id, not a position', async () => {
    const rec = recorder(load<DsxResponse>('replace-emp-conflict', 'response'));
    const built = scenario('replace-emp-conflict');
    const ds = built.datasets['dsEmp']!;
    const error = await failure(createTxClient(rec.transport, signal).call(built.call));
    expect(rec.sent()).toEqual(load('replace-emp-conflict', 'request'));
    const expected = load<DsxResponse>('replace-emp-conflict', 'response');
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(expected.status.message);
    expect(error.rowErrors).toEqual(expected.errors);
    const sent = rec.sent().datasets?.['dsEmp'];
    expect(sent?.ids).toContain(error.rowErrors[0]?.id);
    expect(ds.indexOfRow(error.rowErrors[0]?.id as number)).not.toBe(error.rowErrors[0]?.id);
  });

  it('save-emp-conflict: a version conflict keeps every edit for a retry', async () => {
    const rec = recorder(load<DsxResponse>('save-emp-conflict', 'response'));
    const built = scenario('save-emp-conflict');
    const ds = built.datasets['dsEmp']!;
    const error = await failure(createTxClient(rec.transport, signal).call(built.call));
    expect(rec.sent()).toEqual(load('save-emp-conflict', 'request'));
    expect(error.code).toBe('conflict');
    expect(error.committed).toBe(false);
    expect(error.rowErrors).toEqual(load<DsxResponse>('save-emp-conflict', 'response').errors);
    expect(ds.statusOf(0)).toBe('updated');
    expect(ds.statusOf(2)).toBe('updated');
    expect(ds.getValueById(2, 'empName')).toBe('Ara C.');
  });

  it('save-two-datasets: two changed inputs in one request, applied lands in each', async () => {
    const rec = recorder(load<DsxResponse>('save-two-datasets', 'response'));
    const built = scenario('save-two-datasets');
    const dsEmp = built.datasets['dsEmp']!;
    const dsDept = built.datasets['dsDept']!;
    await createTxClient(rec.transport, signal).call(built.call);
    expect(rec.sent()).toEqual(load('save-two-datasets', 'request'));
    expect(dsEmp.hasChanges()).toBe(false);
    expect(dsDept.hasChanges()).toBe(false);
    expect(dsEmp.getValue(0, 'ver')).toBe(8);
    expect(dsDept.getValueById(2, 'deptCode')).toBe('D030');
  });

  it('insert-generated-key: each new row gets its own key from applied', async () => {
    const rec = recorder(load<DsxResponse>('insert-generated-key', 'response'));
    const built = scenario('insert-generated-key');
    const dsDept = built.datasets['dsDept']!;
    await createTxClient(rec.transport, signal).call(built.call);
    expect(dsDept.getValueById(2, 'deptCode')).toBe('D030');
    expect(dsDept.getValueById(3, 'deptCode')).toBe('D040');
    expect(dsDept.hasChanges()).toBe(false);
  });

  it.each([
    ['dept-conflict-all-columns', 'conflict'],
    ['save-emp-invalid', 'invalid'],
    ['unknown-service', 'unknown-service'],
    ['unknown-column', 'bad-request'],
  ])('%s: rejects with %s, row errors intact, and the edits are kept', async (name, code) => {
    const response = load<DsxResponse>(name, 'response');
    const rec = recorder(response);
    const built = scenario(name as string);
    const error = await failure(createTxClient(rec.transport, signal).call(built.call));
    expect(rec.sent()).toEqual(load(name as string, 'request'));
    expect(error.code).toBe(code);
    expect(error.rowErrors).toEqual(response.errors ?? []);
    if (name !== 'unknown-service') {
      for (const ds of Object.values(built.datasets)) expect(ds.hasChanges()).toBe(true);
    }
  });

  it('p4-types-load: long decimals, dates, fractions, empty vs null and safe-limit ints arrive exactly', async () => {
    const rec = recorder(load<DsxResponse>('p4-types-load', 'response'));
    const built = scenario('p4-types-load');
    const ds = built.datasets['dsT']!;
    await createTxClient(rec.transport, signal).call(built.call);
    expect(rec.sent()).toEqual(load('p4-types-load', 'request'));
    expect(ds.getValue(0, 'amount')).toBe('12345678901234567890.1234567890');
    expect(ds.getValue(0, 'stamp')).toBe('2024-02-29T23:59:59.123456');
    expect(ds.getValue(0, 'note')).toBe('');
    expect(ds.getValue(0, 'count')).toBe(Number.MAX_SAFE_INTEGER);
    expect(ds.getValue(1, 'amount')).toBe('-0.0000000001');
    expect(ds.getValue(1, 'stamp')).toBe('2000-01-01T00:00:00.000');
    expect(ds.getValue(1, 'note')).toBe(null);
    expect(ds.getValue(1, 'count')).toBe(Number.MIN_SAFE_INTEGER);
    expect(ds.getValue(2, 'amount')).toBe('0.10');
    expect(ds.getValue(2, 'note')).toBe(' padded ');
    expect(ds.getValue(2, 'day')).toBe(null);
  });

  it('p4-types-update: originals keep the empty string and null apart', () => {
    const request = load<DsxRequest>('p4-types-update', 'request');
    const changes = request.datasets?.['dsT']?.changes ?? [];
    expect(changes.map((c) => c.o)).toEqual([{ '4': '' }, { '4': null }]);
    expect(changes[0]?.v[1]).toBe('12345678901234567890.1234567890');
  });
});
