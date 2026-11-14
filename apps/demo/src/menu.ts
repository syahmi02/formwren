import type { MenuItem } from '@fw/components';

// The form files load when a screen is first opened.
export const menu: readonly MenuItem[] = [
  { key: 'employees', title: 'Employees', load: () => import('./forms/EmployeeEdit.form.json').then((m) => m.default) },
  { key: 'employee-list', title: 'Employee list', load: () => import('./forms/EmployeeList.form.json').then((m) => m.default) },
  { key: 'departments', title: 'Departments', load: () => import('./forms/DepartmentEmployees.form.json').then((m) => m.default) },
];

/** The hash routes stay as deep links. Each opens its screen as the first tab. */
export const hashRoutes: Readonly<Record<string, string>> = {
  '': 'employees',
  '#list': 'employee-list',
  '#dept': 'departments',
};
