import { customService, tableService, type ColumnDecl, type Service, type TableDecl } from '@fw/server';

/** The smallest salary the list screen's save accepts, so its error path can be shown on demand. */
const MIN_SALARY = { value: '30000', message: 'Salary must be at least 30,000' };

const departmentColumns: ColumnDecl[] = [
  { id: 'code', type: 'string', size: 10, key: true, label: 'Code' },
  { id: 'name', type: 'string', size: 50, required: true, label: 'Name' },
  { id: 'ver', type: 'int', version: true },
];

function employeeColumns(withMin: boolean): ColumnDecl[] {
  return [
    { id: 'empNo', type: 'string', size: 10, key: true, label: 'No', generated: { sequence: 'employee', prefix: 'E', width: 3 } },
    { id: 'empName', type: 'string', size: 50, required: true, label: 'Name' },
    { id: 'dept', type: 'string', size: 10 },
    { id: 'level', type: 'string', size: 1 },
    { id: 'active', type: 'boolean' },
    { id: 'salary', type: 'decimal', precision: 14, scale: 6, label: 'Salary', ...(withMin ? { min: MIN_SALARY } : {}) },
    { id: 'hiredOn', type: 'date' },
    { id: 'ver', type: 'int', version: true },
  ];
}

const departmentTable: TableDecl = { table: 'department', columns: departmentColumns };
const employeeTable: TableDecl = { table: 'employee', columns: employeeColumns(false) };
const employeeTableChecked: TableDecl = { table: 'employee', columns: employeeColumns(true) };

/** Rows go out as they are in the table, so the output declaration has no `key` flag to send. */
const forOutput = (columns: ColumnDecl[]): ColumnDecl[] => columns.map(({ key: _key, generated: _generated, min: _min, ...rest }) => rest);
const employeeOut = forOutput(employeeColumns(false));
const departmentOut = forOutput(departmentColumns);

const EMPLOYEE_SELECT = 'SELECT empNo, empName, dept, level, active, salary, hiredOn, ver FROM employee';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const condition = (columns: ColumnDecl[]) => ({ columns, mode: 'rows' as const });

const departmentList = customService({
  id: 'hr.dept.list',
  outputs: { list: { columns: departmentOut } },
  handler: (ctx) => ({ datasets: { list: ctx.db.prepare('SELECT code, name, ver FROM department ORDER BY rowid').all() } }),
});

/** The edit screen's search: a name fragment in `cond.keyword`. */
const employeeSearch = customService({
  id: 'hr.emp.search',
  inputs: { cond: condition([{ id: 'keyword', type: 'string', size: 50 }]) },
  outputs: { list: { columns: employeeOut } },
  handler(ctx) {
    const keyword = text(ctx.input('cond').rows[0]?.values['keyword']);
    const rows = ctx.db.prepare(`${EMPLOYEE_SELECT} WHERE ? = '' OR instr(lower(empName), lower(?)) > 0 ORDER BY empNo`).all(keyword, keyword);
    return { datasets: { list: rows } };
  },
});

/** The list screen's search: a name fragment and an optional department. */
const employeeQuery = customService({
  id: 'hr.emp.query',
  inputs: {
    cond: condition([
      { id: 'empName', type: 'string', size: 50 },
      { id: 'dept', type: 'string', size: 10 },
    ]),
  },
  outputs: { list: { columns: employeeOut } },
  handler(ctx) {
    const values = ctx.input('cond').rows[0]?.values;
    const name = text(values?.['empName']);
    const dept = text(values?.['dept']);
    const rows = ctx.db
      .prepare(`${EMPLOYEE_SELECT} WHERE (? = '' OR instr(lower(empName), lower(?)) > 0) AND (? = '' OR dept = ?) ORDER BY empNo`)
      .all(name, name, dept, dept);
    return { datasets: { list: rows } };
  },
});

/** The master-detail screen: every department, and the employees of the department in `params.deptCode`. */
const withEmployees = customService({
  id: 'hr.dept.withEmployees',
  outputs: { dept: { columns: departmentOut }, emp: { columns: employeeOut } },
  handler(ctx) {
    const code = text(ctx.params['deptCode']);
    return {
      datasets: {
        dept: ctx.db.prepare('SELECT code, name, ver FROM department ORDER BY code').all(),
        emp: code === '' ? [] : ctx.db.prepare(`${EMPLOYEE_SELECT} WHERE dept = ? ORDER BY empNo`).all(code),
      },
    };
  },
});

/** The most rows a lookup returns. The popup says so when there were more, so the user narrows the search. */
const LOOKUP_LIMIT = 50;

/** The lookup popup's search: employees whose number starts with the text or whose name contains it, capped. */
const employeeLookup = customService({
  id: 'hr.emp.lookup',
  inputs: { cond: condition([{ id: 'keyword', type: 'string', size: 50 }]) },
  outputs: {
    list: {
      columns: [
        { id: 'empNo', type: 'string', size: 10 },
        { id: 'empName', type: 'string', size: 50 },
        { id: 'dept', type: 'string', size: 10 },
      ],
    },
  },
  handler(ctx) {
    const keyword = text(ctx.input('cond').rows[0]?.values['keyword']);
    // One extra row tells whether the cap cut the answer short.
    const rows = ctx.db
      .prepare(
        `SELECT empNo, empName, dept FROM employee
         WHERE ? = '' OR lower(substr(empNo, 1, length(?))) = lower(?) OR instr(lower(empName), lower(?)) > 0
         ORDER BY empNo LIMIT ?`,
      )
      .all(keyword, keyword, keyword, keyword, LOOKUP_LIMIT + 1);
    const more = rows.length > LOOKUP_LIMIT;
    return { datasets: { list: more ? rows.slice(0, LOOKUP_LIMIT) : rows }, params: { more } };
  },
});

const saved = (totals: { total: number }) => ({ saved: totals.total });

export const demoServices: Service[] = [
  departmentList,
  employeeSearch,
  employeeQuery,
  employeeLookup,
  tableService({ id: 'hr.emp.save', inputs: { emp: employeeTable }, result: saved }),
  tableService({ id: 'hr.emp.saveList', inputs: { emp: employeeTableChecked }, result: saved }),
  withEmployees,
  // Departments first, so a new department exists before its new employees are written.
  tableService({ id: 'hr.dept.saveAll', inputs: { dept: departmentTable, emp: employeeTable }, result: saved }),
];
