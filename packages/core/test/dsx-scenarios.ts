/**
 * Builds the golden vectors' requests with the real client encoder, so a vector file can't drift
 * from what the client sends. Run `UPDATE_VECTORS=1 pnpm exec vitest run packages/core/test/tx-vectors.test.ts`
 * to rewrite the request files, then review the diff. Responses are written by hand.
 */
import { Dataset, type ColumnDef, type TxCallOptions } from '../src/index.ts';

export const empColumns: ColumnDef[] = [
  { id: 'empNo', type: 'string', size: 10 },
  { id: 'empName', type: 'string', size: 50 },
  { id: 'salary', type: 'decimal', precision: 12, scale: 0 },
  { id: 'ver', type: 'int', version: true },
];

export function makeEmp(id = 'dsEmp'): Dataset {
  return new Dataset({
    id,
    columns: empColumns,
    keys: ['empNo'],
    initialRows: [
      ['E1001', 'Minju Kim', '5200000', 7],
      ['E0999', 'Seojun Park', '3900000', 3],
      ['E1002', 'Ara Cho', '4000000', 1],
    ],
  });
}

export function makeDept(): Dataset {
  return new Dataset({
    id: 'dsDept',
    columns: [
      { id: 'deptCode', type: 'string', size: 4 },
      { id: 'deptName', type: 'string', size: 30 },
    ],
    keys: ['deptCode'],
    initialRows: [
      ['D010', 'Sales'],
      ['D020', 'Ops'],
    ],
  });
}

export const typesColumns: ColumnDef[] = [
  { id: 'id', type: 'int' },
  { id: 'amount', type: 'decimal', precision: 30, scale: 10 },
  { id: 'day', type: 'date' },
  { id: 'stamp', type: 'datetime' },
  { id: 'note', type: 'string', size: 40 },
  { id: 'count', type: 'int' },
];

/** The rows of `qa_types` after `p4-types-save`, which `p4-types-update` and `p4-types-load` start from. */
export const typesRows = [
  [1, '12345678901234567890.1234567890', '2024-02-29', '2024-02-29T23:59:59.123456', '', 9007199254740991],
  [2, '-0.0000000001', '1999-12-31', '2000-01-01T00:00:00.000', null, -9007199254740991],
  [3, '0.10', null, null, ' padded ', 0],
] as const;

export function makeTypes(rows: 'empty' | 'loaded' = 'loaded'): Dataset {
  return new Dataset({
    id: 'dsT',
    columns: typesColumns,
    keys: ['id'],
    initialRows: rows === 'empty' ? [] : typesRows.map((row) => [...row]),
  });
}

export interface Built {
  datasets: Record<string, Dataset>;
  call: TxCallOptions;
}

/** Vectors whose request comes from the client. The others have a hand-written request. */
export const scenarios: Record<string, () => Built> = {
  'search-emp': () => {
    const dsEmp = new Dataset({ id: 'dsEmp', columns: empColumns, keys: ['empNo'] });
    return { datasets: { dsEmp }, call: { service: 'hr.emp.search', params: { deptCode: 'D010' }, outputs: { dsEmp } } };
  },

  'save-emp-changed': () => {
    const dsEmp = makeEmp();
    dsEmp.setValue(0, 'empName', 'Minji Kim');
    dsEmp.deleteRow(1);
    dsEmp.addRow({ empName: 'Jun Lee', salary: '4100000' });
    return {
      datasets: { dsEmp },
      call: { service: 'hr.emp.save', params: { deptCode: 'D010' }, inputs: { dsEmp: { dataset: dsEmp, rows: 'changed' } } },
    };
  },

  'save-emp-conflict': () => {
    const dsEmp = makeEmp();
    dsEmp.setValueById(0, 'empName', 'Minji Kim');
    dsEmp.setValueById(2, 'empName', 'Ara C.');
    return { datasets: { dsEmp }, call: { service: 'hr.emp.save', inputs: { dsEmp: { dataset: dsEmp, rows: 'changed' } } } };
  },

  'replace-emp-conflict': () => {
    const dsEmp = makeEmp();
    dsEmp.sort([{ column: 'empNo', descending: true }]);
    dsEmp.deleteRow(dsEmp.indexOfRow(0)); // E1001 (id 0) is deleted, so ids are [1, 2] and positions are [0, 1]
    return { datasets: { dsEmp }, call: { service: 'hr.emp.replace', inputs: { dsEmp } } };
  },

  'save-two-datasets': () => {
    const dsEmp = makeEmp();
    const dsDept = makeDept();
    dsEmp.setValueById(0, 'empName', 'Minji Kim');
    dsDept.deleteRow(1);
    dsDept.addRow({ deptName: 'HR' });
    return {
      datasets: { dsEmp, dsDept },
      call: { service: 'hr.org.save', inputs: { dsEmp: { dataset: dsEmp, rows: 'changed' }, dsDept: { dataset: dsDept, rows: 'changed' } } },
    };
  },

  'dept-conflict-all-columns': () => {
    const dsDept = makeDept();
    dsDept.setValueById(0, 'deptName', 'Sales EU');
    dsDept.setValueById(1, 'deptName', 'Ops EU');
    return { datasets: { dsDept }, call: { service: 'hr.dept.save', inputs: { dsDept: { dataset: dsDept, rows: 'changed' } } } };
  },

  'insert-generated-key': () => {
    const dsDept = makeDept();
    dsDept.addRow({ deptName: 'Legal' });
    dsDept.addRow({ deptName: 'Finance' });
    return { datasets: { dsDept }, call: { service: 'hr.dept.save', inputs: { dsDept: { dataset: dsDept, rows: 'changed' } } } };
  },

  'save-emp-invalid': () => {
    const dsEmp = makeEmp();
    dsEmp.setValueById(0, 'empName', 'Minji Kim');
    dsEmp.addRow({ salary: '5200000.5' }); // no name, and a fraction in a scale-0 decimal
    return { datasets: { dsEmp }, call: { service: 'hr.emp.save', inputs: { dsEmp: { dataset: dsEmp, rows: 'changed' } } } };
  },

  'unknown-service': () => ({ datasets: {}, call: { service: 'hr.nope.save' } }),

  'unknown-column': () => {
    const dsEmp = new Dataset({
      id: 'dsEmp',
      columns: [...empColumns, { id: 'bonus', type: 'decimal', precision: 12, scale: 0 }],
      keys: ['empNo'],
      initialRows: [['E1001', 'Minju Kim', '5200000', 7, '100']],
    });
    dsEmp.setValueById(0, 'empName', 'Minji Kim');
    return { datasets: { dsEmp }, call: { service: 'hr.emp.save', inputs: { dsEmp: { dataset: dsEmp, rows: 'changed' } } } };
  },

  'p4-types-save': () => {
    const dsT = makeTypes('empty');
    for (const [id, amount, day, stamp, note, count] of typesRows) dsT.addRow({ id, amount, day, stamp, note, count });
    return { datasets: { dsT }, call: { service: 'qa.types.save', inputs: { dsT: { dataset: dsT, rows: 'changed' } } } };
  },

  'p4-types-update': () => {
    const dsT = makeTypes();
    dsT.setValueById(0, 'note', null); // '' to null
    dsT.setValueById(1, 'note', ''); // null to ''
    return { datasets: { dsT }, call: { service: 'qa.types.save', inputs: { dsT: { dataset: dsT, rows: 'changed' } } } };
  },

  'p4-types-load': () => {
    const dsT = new Dataset({ id: 'dsT', columns: typesColumns, keys: ['id'] });
    return { datasets: { dsT }, call: { service: 'qa.types.list', outputs: { dsT } } };
  },
};

/** Vectors with a hand-written request, which the client could never build. */
export const rawRequests = ['malformed-structure', 'not-json'] as const;
