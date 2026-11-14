import type { DsxColumn, DsxRequest, DsxResponse, FixtureResponse } from '@fw/core';

const DEPARTMENTS = [
  ['ENG', 'Engineering'],
  ['SAL', 'Sales'],
  ['HR', 'Human Resources'],
  ['FIN', 'Finance'],
  ['OPS', 'Operations'],
] as const;

const NAMES = [
  'Alice Carter', 'Benjamin Hughes', 'Clara Jennings', 'Daniel Foster', 'Eleanor Brooks',
  'Frederick Mills', 'Grace Sullivan', 'Henry Parker', 'Isabel Reed', 'Jonathan Bailey',
  'Katherine Ward', 'Liam Murphy', 'Margaret Cole', 'Nathan Price', 'Olivia Hayes',
  'Patrick Russell', 'Quinn Ellis', 'Rebecca Stone', 'Samuel Wright', 'Teresa Grant',
  'Umar Khan', 'Victoria Lane', 'William Doyle', 'Xavier Moore', 'Yvonne Fisher',
];

const EMPLOYEE_COLUMNS: DsxColumn[] = [
  { id: 'empNo', type: 'string', size: 10 },
  { id: 'empName', type: 'string', size: 50 },
  { id: 'dept', type: 'string', size: 10 },
  { id: 'level', type: 'string', size: 1 },
  { id: 'active', type: 'boolean' },
  { id: 'salary', type: 'decimal', precision: 14, scale: 6 },
  { id: 'hiredOn', type: 'date' },
];

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Salaries are decimal text with six places, so a double would lose digits. Everything is derived from the index. */
const EMPLOYEES = NAMES.map((name, i) => [
  `E${pad(i + 1, 3)}`,
  name,
  DEPARTMENTS[i % DEPARTMENTS.length]?.[0] ?? 'ENG',
  'ABC'[i % 3] ?? 'A',
  i % 7 !== 6,
  `${48000 + i * 1733}.${pad((i * 7919 + 104729) % 1_000_000, 6)}`,
  `${2012 + (i % 12)}-${pad((i * 5) % 12 + 1, 2)}-${pad((i * 11) % 28 + 1, 2)}`,
]);

function search(request: DsxRequest): DsxResponse {
  const keyword = String(request.datasets?.cond?.rows?.[0]?.[0] ?? '').trim().toLowerCase();
  const rows = EMPLOYEES.filter((row) => keyword === '' || String(row[1]).toLowerCase().includes(keyword));
  return { status: { ok: true }, datasets: { list: { columns: EMPLOYEE_COLUMNS, rows } } };
}

/** The list screen's search: a name fragment and an optional department. The rows come back in the same columns as the edit screen. */
function query(request: DsxRequest): DsxResponse {
  const cond = request.datasets?.cond;
  const read = (id: string): string => {
    const at = cond?.columns.findIndex((column) => column.id === id) ?? -1;
    return at < 0 ? '' : String(cond?.rows?.[0]?.[at] ?? '').trim();
  };
  const name = read('empName').toLowerCase();
  const dept = read('dept');
  const rows = EMPLOYEES.filter((row) => (name === '' || String(row[1]).toLowerCase().includes(name)) && (dept === '' || row[2] === dept));
  return { status: { ok: true }, datasets: { list: { columns: EMPLOYEE_COLUMNS, rows } } };
}

/** The smallest salary the list screen's save accepts. A lower one fails the save, so the error path can be shown on demand. */
const MIN_SALARY = 30000;

function saveList(request: DsxRequest): DsxResponse {
  const emp = request.datasets?.emp;
  const salaryAt = emp?.columns.findIndex((column) => column.id === 'salary') ?? -1;
  const changes = emp?.changes ?? [];
  const errors = changes
    .filter((change) => change.s !== 'D' && Number(change.v[salaryAt] ?? MIN_SALARY) < MIN_SALARY)
    .map((change) => ({ dataset: 'emp', id: change.id, column: 'salary', code: 'range', message: `Salary must be at least ${MIN_SALARY.toLocaleString('en-US')}` }));
  if (errors.length > 0) {
    return { status: { ok: false, code: 'validation', message: `${errors.length} ${errors.length === 1 ? 'row was' : 'rows were'} rejected` }, errors };
  }
  return { status: { ok: true }, params: { saved: changes.length } };
}

/** Saved responses for the services the demo calls. */
export const fixtures: Record<string, FixtureResponse> = {
  'hr.dept.list': {
    status: { ok: true },
    datasets: {
      list: {
        columns: [
          { id: 'code', type: 'string', size: 10 },
          { id: 'name', type: 'string', size: 50 },
        ],
        rows: DEPARTMENTS.map(([code, name]) => [code, name]),
      },
    },
  },
  'hr.emp.search': search,
  'hr.emp.query': query,
  'hr.emp.saveList': saveList,
  'hr.emp.save': (request) => ({
    status: { ok: true },
    params: { saved: request.datasets?.emp?.changes?.length ?? 0 },
  }),
};
