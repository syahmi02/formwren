import { describe, expect, it } from 'vitest';
import {
  createTxClient,
  Dataset,
  decodeOutput,
  encodeInput,
  fixtureTransport,
  TransactionError,
  type ColumnDef,
  type DsxRequest,
  type DsxResponse,
  type Transport,
} from '../src/index.ts';

const columns: ColumnDef[] = [
  { id: 'empNo', type: 'string', size: 10 },
  { id: 'empName', type: 'string', size: 50 },
  { id: 'salary', type: 'decimal', precision: 12, scale: 0 },
  { id: 'ver', type: 'int' },
];

function makeEmp(): Dataset {
  return new Dataset({
    id: 'dsEmp',
    columns,
    keys: ['empNo'],
    initialRows: [
      ['E1001', 'Minju Kim', '5200000', 7],
      ['E0999', 'Seojun Park', '3900000', 3],
      ['E1002', 'Ara Cho', '4000000', 1],
    ],
  });
}

function owner() {
  const controller = new AbortController();
  return { controller, owner: { signal: controller.signal } };
}

async function rejection(promise: Promise<unknown>): Promise<TransactionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    return error as TransactionError;
  }
  throw new Error('should have rejected');
}

const ok: DsxResponse = { status: { ok: true } };

describe('encodeInput', () => {
  it('sends every live row with ids, whatever the filter', () => {
    const ds = makeEmp();
    const hiddenId = ds.rowIdAt(0);
    ds.deleteRow(1); // E0999 is gone
    ds.setFilter((get) => get('empNo') !== 'E1001'); // E1001 is hidden but still live
    ds.sort([{ column: 'empNo', descending: true }]);
    expect(ds.rowCount).toBe(1);
    const encoded = encodeInput('dsEmp', ds);
    expect(encoded.changes).toBeUndefined();
    expect(encoded.rows).toHaveLength(2);
    expect(encoded.ids).toHaveLength(2);
    expect(encoded.ids).toContain(hiddenId);
    encoded.ids?.forEach((id, i) => {
      expect((encoded.rows?.[i] as unknown[])[0]).toBe(ds.getValueById(id, 'empNo'));
    });
    expect(encoded.rows?.map((r) => r[0])).toEqual(['E1001', 'E1002']);
    expect(encoded.columns.map((c) => [c.id, c.key])).toEqual([
      ['empNo', true],
      ['empName', undefined],
      ['salary', undefined],
      ['ver', undefined],
    ]);
    expect(encoded.columns[2]).toEqual({ id: 'salary', type: 'decimal', precision: 12, scale: 0 });
  });

  it('sends changes with string-keyed originals', () => {
    const ds = makeEmp();
    ds.setValue(0, 'empName', 'Minji Kim');
    ds.setValue(0, 'salary', '5300000');
    ds.deleteRow(1);
    const id = ds.addRow({ empName: 'New' });
    const encoded = encodeInput('dsEmp', { dataset: ds, rows: 'changed' });
    expect(encoded.rows).toBeUndefined();
    expect(encoded.changes).toEqual([
      { s: 'U', id: 0, v: ['E1001', 'Minji Kim', '5300000', 7], o: { '1': 'Minju Kim', '2': '5200000' } },
      { s: 'D', id: 1, v: ['E0999', 'Seojun Park', '3900000', 3] },
      { s: 'I', id: id, v: [null, 'New', null, null] },
    ]);
  });

  it('survives JSON', () => {
    const ds = makeEmp();
    ds.setValue(0, 'ver', 8);
    const encoded = encodeInput('dsEmp', { dataset: ds, rows: 'changed' });
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  });
});

describe('decodeOutput', () => {
  const response = {
    columns: [
      { id: 'salary', type: 'decimal' as const },
      { id: 'empNo', type: 'string' as const },
      { id: 'extra', type: 'string' as const },
      { id: 'empName', type: 'string' as const },
    ],
    rows: [['10', 'A1', 'x', 'Ann']],
  };

  it('maps by column id, ignores extra columns and nulls missing ones', () => {
    const ds = makeEmp();
    decodeOutput(response, ds);
    expect(ds.rowCount).toBe(1);
    expect([0, 1, 2, 3].map((c) => ds.getValue(0, (columns[c] as ColumnDef).id))).toEqual(['A1', 'Ann', '10', null]);
    expect(ds.hasChanges()).toBe(false);
  });

  it('appends when asked', () => {
    const ds = makeEmp();
    decodeOutput(response, ds, { append: true });
    expect(ds.rowCount).toBe(4);
  });

  it('rejects bad values with bad-response and leaves the target alone', () => {
    const ds = makeEmp();
    ds.setValue(0, 'empName', 'edited');
    const bad = { ...response, rows: [['10', 'A1', 'x', 'Ann'], ['not a number', 'A2', 'x', 'Bob']] };
    let error: unknown;
    try {
      decodeOutput(bad, ds);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as TransactionError).code).toBe('bad-response');
    expect(ds.rowCount).toBe(3);
    expect(ds.getValue(0, 'empName')).toBe('edited');
    expect(ds.rowStatus(0)).toBe('updated');
  });

  it('rejects rows with the wrong width', () => {
    const ds = makeEmp();
    expect(() => decodeOutput({ columns: response.columns, rows: [['1']] }, ds)).toThrow(TransactionError);
    expect(ds.rowCount).toBe(3);
  });
});

describe('fixtureTransport', () => {
  const signal = new AbortController().signal;
  const request = (service: string): DsxRequest => ({ dsx: 1, txId: 't', service });

  it('answers by service and copies responses', async () => {
    const fixture: DsxResponse = { status: { ok: true }, params: { n: 1 } };
    const transport = fixtureTransport({ 'a.b': fixture });
    const first = await transport.send(request('a.b'), { signal });
    (first.params as Record<string, unknown>)['n'] = 99;
    const second = await transport.send(request('a.b'), { signal });
    expect(second.params).toEqual({ n: 1 });
    expect(fixture.params).toEqual({ n: 1 });
  });

  it('answers unknown services with unknown-service', async () => {
    const response = await fixtureTransport({}).send(request('nope'), { signal });
    expect(response.status.ok).toBe(false);
    expect(response.status.code).toBe('unknown-service');
    const proto = await fixtureTransport({}).send(request('constructor'), { signal });
    expect(proto.status.code).toBe('unknown-service');
  });

  it('gives functions a JSON copy of the request', async () => {
    let seen: DsxRequest | undefined;
    const transport = fixtureTransport({
      'a.b': (r) => {
        seen = r;
        return ok;
      },
    });
    const original: DsxRequest = { dsx: 1, txId: 't', service: 'a.b', params: { keep: 1, drop: undefined } };
    await transport.send(original, { signal });
    expect(seen).not.toBe(original);
    expect(seen?.params).toEqual({ keep: 1 });
    expect('drop' in (seen?.params ?? {})).toBe(false);
  });

  it('honours abort before and during the delay', async () => {
    const transport = fixtureTransport({ 'a.b': ok }, { delayMs: 500 });
    const early = new AbortController();
    early.abort();
    await expect(transport.send(request('a.b'), { signal: early.signal })).rejects.toBeTruthy();
    const late = new AbortController();
    const started = Date.now();
    const pending = transport.send(request('a.b'), { signal: late.signal });
    setTimeout(() => late.abort(), 10);
    await expect(pending).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('createTxClient: search', () => {
  it('fills an output and returns status and params', async () => {
    const dsEmp = makeEmp();
    const dsOther = makeEmp();
    const client = createTxClient(
      fixtureTransport({
        'hr.emp.search': (request) => ({
          status: { ok: true },
          params: { echoed: request.params?.['deptCode'] },
          datasets: {
            dsEmp: { columns: [{ id: 'empNo', type: 'string' }, { id: 'empName', type: 'string' }], rows: [['E1', 'One'], ['E2', 'Two']] },
            dsMore: { columns: [{ id: 'empNo', type: 'string' }], rows: [['E3']] },
          },
        }),
      }),
      owner().owner,
    );
    const result = await client.call({
      service: 'hr.emp.search',
      params: { deptCode: 'D010' },
      outputs: { dsEmp, dsMore: { dataset: dsOther, mode: 'append' } },
    });
    expect(result).toEqual({ status: { ok: true }, params: { echoed: 'D010' }, skippedOutputs: [] });
    expect(dsEmp.rowCount).toBe(2);
    expect(dsEmp.getValue(1, 'empName')).toBe('Two');
    expect(dsEmp.getValue(1, 'salary')).toBe(null);
    expect(dsOther.rowCount).toBe(4);
    expect(dsEmp.hasChanges()).toBe(false);
  });

  it('gives each attempt a unique txId', async () => {
    const ids: string[] = [];
    const transport: Transport = {
      async send(request) {
        ids.push(request.txId);
        return ok;
      },
    };
    const client = createTxClient(transport, owner().owner);
    await client.call({ service: 's.a' });
    await client.call({ service: 's.a' });
    await client.call({ service: 's.b' });
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('rejects without a transport', async () => {
    const error = await rejection(createTxClient(undefined, owner().owner).call({ service: 'a.b' }));
    expect(error.code).toBe('no-transport');
  });

  it('rejects when an output is missing from the response, without touching anything', async () => {
    const dsEmp = makeEmp();
    const dsMore = makeEmp();
    const client = createTxClient(
      fixtureTransport({
        'a.b': { status: { ok: true }, datasets: { dsEmp: { columns: [{ id: 'empNo', type: 'string' }], rows: [['E9']] } } },
      }),
      owner().owner,
    );
    const error = await rejection(client.call({ service: 'a.b', outputs: { dsEmp, dsMore } }));
    expect(error.code).toBe('bad-response');
    expect(error.committed).toBe(true);
    expect(dsEmp.rowCount).toBe(3);
  });
});

describe('createTxClient: save', () => {
  function editedEmp(): Dataset {
    const ds = makeEmp();
    ds.setValue(0, 'empName', 'Minji Kim');
    ds.deleteRow(1);
    ds.addRow({ empName: 'Jun Lee', salary: '4100000' });
    return ds;
  }

  it('round-trips I, U and D and lands applied values', async () => {
    const ds = editedEmp();
    let sent: DsxRequest | undefined;
    const client = createTxClient(
      fixtureTransport({
        'hr.emp.save': (request) => {
          sent = request;
          return {
            status: { ok: true },
            applied: { dsEmp: { '0': { ver: 8 }, '3': { empNo: 'E1003', ver: 1 } } },
          };
        },
      }),
      owner().owner,
    );
    await client.call({ service: 'hr.emp.save', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } });

    expect(sent?.datasets?.['dsEmp']?.changes?.map((c) => c.s)).toEqual(['U', 'D', 'I']);
    expect(ds.hasChanges()).toBe(false);
    expect(ds.deletedRows()).toEqual([]);
    expect(ds.rowCount).toBe(3);
    expect(ds.getValue(0, 'ver')).toBe(8);
    expect(ds.getValue(0, 'empName')).toBe('Minji Kim');
    expect(ds.getValue(2, 'empNo')).toBe('E1003');
    expect(ds.getValue(2, 'ver')).toBe(1);
    expect(ds.rowStatus(0)).toBe('normal');
    expect(ds.rowStatus(2)).toBe('normal');
  });

  it('sends what it accepts, so edits made during the save are kept', async () => {
    const ds = editedEmp();
    const transport: Transport = {
      async send() {
        // The user types while the request is in flight.
        ds.setValue(0, 'empName', 'Minji K.');
        ds.setValue(2, 'empName', 'Jun L.');
        return { status: { ok: true }, applied: { dsEmp: { '0': { ver: 8 } } } };
      },
    };
    await createTxClient(transport, owner().owner).call({
      service: 'hr.emp.save',
      inputs: { dsEmp: { dataset: ds, rows: 'changed' } },
    });
    expect(ds.getValue(0, 'empName')).toBe('Minji K.');
    expect(ds.rowStatus(0)).toBe('updated');
    expect(ds.getValue(0, 'ver')).toBe(8);
    expect(ds.getOriginalValue(0, 'empName')).toBe('Minji Kim');
    expect(ds.rowStatus(2)).toBe('updated');
    expect(ds.getValue(2, 'empName')).toBe('Jun L.');
    // the next save sends only what is still unsaved
    const next = encodeInput('dsEmp', { dataset: ds, rows: 'changed' });
    expect(next.changes?.map((c) => c.s)).toEqual(['U', 'U']);
  });

  it('keeps edits and row status when the server reports failure', async () => {
    const ds = editedEmp();
    const before = encodeInput('dsEmp', { dataset: ds, rows: 'changed' });
    const client = createTxClient(
      fixtureTransport({
        'hr.emp.save': {
          status: { ok: false, code: 'conflict', message: 'Changed by someone else' },
          errors: [{ dataset: 'dsEmp', id: 0, column: 'empName', code: 'conflict', message: 'Row 0 conflicts' }],
          applied: { dsEmp: { '0': { ver: 99 } } },
        },
      }),
      owner().owner,
    );
    const error = await rejection(client.call({ service: 'hr.emp.save', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }));
    expect(error.code).toBe('conflict');
    expect(error.committed).toBe(false);
    expect(error.message).toBe('Changed by someone else');
    expect(error.rowErrors).toEqual([{ dataset: 'dsEmp', id: 0, column: 'empName', code: 'conflict', message: 'Row 0 conflicts' }]);
    expect(encodeInput('dsEmp', { dataset: ds, rows: 'changed' })).toEqual(before);
    expect(ds.rowStatus(0)).toBe('updated');
    expect(ds.getValue(0, 'ver')).toBe(7);
    expect(ds.deletedRows()).toEqual([1]);
  });

  it('does not apply outputs on failure', async () => {
    const out = makeEmp();
    const client = createTxClient(
      fixtureTransport({
        'a.b': { status: { ok: false }, datasets: { dsEmp: { columns: [{ id: 'empNo', type: 'string' }], rows: [] } } },
      }),
      owner().owner,
    );
    const error = await rejection(client.call({ service: 'a.b', outputs: { dsEmp: out } }));
    expect(error.code).toBe('server-error');
    expect(out.rowCount).toBe(3);
  });

  it('turns a transport failure into network and keeps edits', async () => {
    const ds = editedEmp();
    const transport: Transport = {
      async send() {
        throw new Error('socket closed');
      },
    };
    const error = await rejection(
      createTxClient(transport, owner().owner).call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }),
    );
    expect(error.code).toBe('network');
    expect(error.message).toBe('socket closed');
    expect(ds.hasChanges()).toBe(true);
    expect(ds.rowStatus(0)).toBe('updated');
  });

  it('rejects a response without a status', async () => {
    const transport: Transport = { send: async () => ({}) as DsxResponse };
    const error = await rejection(createTxClient(transport, owner().owner).call({ service: 'a.b' }));
    expect(error.code).toBe('bad-response');
  });

  it('accepts the save but applies no output when one output is bad', async () => {
    const ds = editedEmp();
    const good = makeEmp();
    const bad = makeEmp();
    const client = createTxClient(
      fixtureTransport({
        'a.b': {
          status: { ok: true },
          datasets: {
            good: { columns: [{ id: 'empNo', type: 'string' }], rows: [['G1']] },
            bad: { columns: [{ id: 'ver', type: 'int' }], rows: [['x']] },
          },
        },
      }),
      owner().owner,
    );
    const error = await rejection(
      client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } }, outputs: { good, bad } }),
    );
    expect(error.code).toBe('bad-response');
    expect(error.committed).toBe(true);
    expect(good.rowCount).toBe(3);
    expect(bad.rowCount).toBe(3);
    expect(ds.hasChanges()).toBe(false);
    // a retry has nothing to send, so no row is saved twice
    expect(encodeInput('dsEmp', { dataset: ds, rows: 'changed' }).changes).toEqual([]);
  });

  it('accepts the save when an applied value is bad, without half-applying', async () => {
    const ds = editedEmp();
    const newId = ds.rowIdAt(2);
    const client = createTxClient(
      fixtureTransport({
        'a.b': { status: { ok: true }, applied: { dsEmp: { [ds.rowIdAt(0)]: { ver: 8 }, [newId]: { ver: 'seven' } } } },
      }),
      owner().owner,
    );
    const error = await rejection(client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }));
    expect(error.code).toBe('bad-response');
    expect(error.committed).toBe(true);
    expect(ds.hasChanges()).toBe(false);
    expect(ds.getValue(0, 'ver')).toBe(7);
    expect(encodeInput('dsEmp', { dataset: ds, rows: 'changed' }).changes).toEqual([]);
  });

  it('rejects an applied entry for a row that was not sent, still accepting the save', async () => {
    const ds = editedEmp();
    const client = createTxClient(
      fixtureTransport({ 'a.b': { status: { ok: true }, applied: { dsEmp: { [ds.rowIdAt(1)]: { ver: 8 } } } } }),
      owner().owner,
    );
    const error = await rejection(client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }));
    expect(error.committed).toBe(true);
    expect(ds.hasChanges()).toBe(false);
  });

  it('rejects a second changed save of one Dataset through another service', async () => {
    const ds = editedEmp();
    const sent: DsxRequest[] = [];
    const transport = fixtureTransport(
      {
        'hr.emp.save': (r) => (sent.push(r), { status: { ok: true } }),
        'hr.emp.saveAgain': (r) => (sent.push(r), { status: { ok: true } }),
      },
      { delayMs: 30 },
    );
    const client = createTxClient(transport, owner().owner);
    const first = client.call({ service: 'hr.emp.save', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } });
    const error = await rejection(client.call({ service: 'hr.emp.saveAgain', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }));
    expect(error.code).toBe('duplicate');
    const other = await rejection(
      createTxClient(transport, owner().owner).call({ service: 'hr.emp.save', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } }),
    );
    expect(other.code).toBe('duplicate');
    await first;
    expect(sent).toHaveLength(1);
    await expect(client.call({ service: 'hr.emp.saveAgain', inputs: { dsEmp: ds } })).resolves.toBeTruthy();
  });

  it('releases the Dataset lock after a failure', async () => {
    const ds = editedEmp();
    const client = createTxClient(fixtureTransport({}), owner().owner);
    const input = { dsEmp: { dataset: ds, rows: 'changed' as const } };
    expect((await rejection(client.call({ service: 'x.y', inputs: input }))).code).toBe('unknown-service');
    expect((await rejection(client.call({ service: 'x.z', inputs: input }))).code).toBe('unknown-service');
  });

  it('waits for an edit still deciding in an async handler', async () => {
    const ds = makeEmp();
    let decide!: (value: boolean) => void;
    ds.on('cellChanging', (event) => {
      event.waitUntil(new Promise<boolean>((resolve) => (decide = resolve)));
    });
    const pendingEdit = ds.setValue(0, 'empName', 'Deferred');
    let sent: DsxRequest | undefined;
    const client = createTxClient(
      fixtureTransport({ 'a.b': (r) => ((sent = r), { status: { ok: true } }) }),
      owner().owner,
    );
    const call = client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toBeUndefined();
    decide(true);
    await pendingEdit;
    await call;
    expect(sent?.datasets?.['dsEmp']?.changes?.map((c) => [c.s, c.v[1]])).toEqual([['U', 'Deferred']]);
  });

  it('can be aborted while waiting for a deferred edit', async () => {
    const ds = makeEmp();
    ds.on('cellChanging', (event) => event.waitUntil(new Promise(() => undefined)));
    void ds.setValue(0, 'empName', 'Never');
    const o = owner();
    const pending = createTxClient(fixtureTransport({ 'a.b': ok }), o.owner).call({
      service: 'a.b',
      inputs: { dsEmp: { dataset: ds, rows: 'changed' } },
    });
    setTimeout(() => o.controller.abort(), 10);
    expect((await rejection(pending)).code).toBe('aborted');
  });

  it('does not replace edits made during its own save, and names the output', async () => {
    const ds = editedEmp();
    const other = makeEmp();
    const transport: Transport = {
      async send() {
        ds.setValue(0, 'empName', 'Typed during save');
        const dsx = { columns: [{ id: 'empNo', type: 'string' as const }], rows: [['S1']] };
        return { status: { ok: true }, datasets: { dsEmp: dsx, other: dsx } };
      },
    };
    const result = await createTxClient(transport, owner().owner).call({
      service: 'a.b',
      inputs: { dsEmp: { dataset: ds, rows: 'changed' } },
      outputs: { dsEmp: ds, other },
    });
    expect(result.skippedOutputs).toEqual(['dsEmp']);
    expect(ds.getValue(0, 'empName')).toBe('Typed during save');
    expect(ds.rowStatus(0)).toBe('updated');
    expect(other.rowCount).toBe(1);
  });

  it('replaces an input Dataset used as output when nothing changed during the save', async () => {
    const ds = editedEmp();
    const client = createTxClient(
      fixtureTransport({ 'a.b': { status: { ok: true }, datasets: { dsEmp: { columns: [{ id: 'empNo', type: 'string' }], rows: [['S1']] } } } }),
      owner().owner,
    );
    const result = await client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } }, outputs: { dsEmp: ds } });
    expect(result.skippedOutputs).toEqual([]);
    expect(ds.rowCount).toBe(1);
  });
});

describe('createTxClient: abort, timeout and duplicates', () => {
  it('aborts on the owner signal and keeps edits', async () => {
    const o = owner();
    const ds = makeEmp();
    ds.setValue(0, 'empName', 'x');
    const client = createTxClient(fixtureTransport({ 'a.b': ok }, { delayMs: 500 }), o.owner);
    const pending = client.call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } } });
    setTimeout(() => o.controller.abort(), 10);
    const error = await rejection(pending);
    expect(error.code).toBe('aborted');
    expect(ds.rowStatus(0)).toBe('updated');
  });

  it('aborts on options.signal, even if the transport ignores its signal', async () => {
    const stubborn: Transport = { send: () => new Promise(() => undefined) };
    const own = new AbortController();
    const pending = createTxClient(stubborn, owner().owner).call({ service: 'a.b', signal: own.signal });
    setTimeout(() => own.abort(), 10);
    expect((await rejection(pending)).code).toBe('aborted');
  });

  it('rejects at once if a signal is already aborted', async () => {
    const o = owner();
    o.controller.abort();
    let called = false;
    const transport: Transport = {
      async send() {
        called = true;
        return ok;
      },
    };
    expect((await rejection(createTxClient(transport, o.owner).call({ service: 'a.b' }))).code).toBe('aborted');
    expect(called).toBe(false);
  });

  it('times out', async () => {
    const client = createTxClient(fixtureTransport({ 'a.b': ok }, { delayMs: 500 }), owner().owner);
    const started = Date.now();
    const error = await rejection(client.call({ service: 'a.b', timeoutMs: 20 }));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('rejects a second call to a running service, then allows it again', async () => {
    const client = createTxClient(fixtureTransport({ 'a.b': ok, 'a.c': ok }, { delayMs: 30 }), owner().owner);
    const first = client.call({ service: 'a.b' });
    const duplicate = await rejection(client.call({ service: 'a.b' }));
    expect(duplicate.code).toBe('duplicate');
    await expect(client.call({ service: 'a.c' })).resolves.toBeTruthy();
    await first;
    await expect(client.call({ service: 'a.b' })).resolves.toBeTruthy();
  });

  it('frees the service after a failure', async () => {
    const client = createTxClient(fixtureTransport({}), owner().owner);
    expect((await rejection(client.call({ service: 'x.y' }))).code).toBe('unknown-service');
    expect((await rejection(client.call({ service: 'x.y' }))).code).toBe('unknown-service');
  });
});

describe('outcomeUnknown', () => {
  it('is false for an abort or timeout before anything was sent, and for a server failure', async () => {
    const never: Transport = { send: () => new Promise(() => undefined) };
    const ds = makeEmp();
    ds.setValueById(0, 'empName', 'X');
    // The transport is never reached while the call waits for a deferred edit that never settles.
    const stuck = ds as unknown as { settled: () => Promise<void> };
    stuck.settled = () => new Promise(() => undefined);
    const { owner: o1 } = owner();
    const early = await rejection(createTxClient(never, o1).call({ service: 'a.b', inputs: { dsEmp: { dataset: ds, rows: 'changed' } }, timeoutMs: 20 }));
    expect(early.code).toBe('timeout');
    expect(early.outcomeUnknown).toBe(false);

    const failed = await rejection(
      createTxClient({ send: async () => ({ status: { ok: false, code: 'conflict' } }) }, o1).call({ service: 'a.c' }),
    );
    expect(failed.outcomeUnknown).toBe(false);
  });

  it('is true for a timeout and an abort after sending, and for a transport that throws', async () => {
    const never: Transport = { send: () => new Promise(() => undefined) };
    const { owner: o } = owner();
    const timeout = await rejection(createTxClient(never, o).call({ service: 'a.b', timeoutMs: 20 }));
    expect(timeout.code).toBe('timeout');
    expect(timeout.outcomeUnknown).toBe(true);

    const controller = new AbortController();
    const pending = rejection(createTxClient(never, o).call({ service: 'a.d', signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const aborted = await pending;
    expect(aborted.code).toBe('aborted');
    expect(aborted.outcomeUnknown).toBe(true);

    const thrown = await rejection(createTxClient({ send: async () => Promise.reject(new Error('boom')) }, o).call({ service: 'a.e' }));
    expect(thrown.code).toBe('network');
    expect(thrown.outcomeUnknown).toBe(true);
  });
});
