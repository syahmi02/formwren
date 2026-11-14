import { readFileSync } from 'node:fs';
import { createForm, fixtureTransport, type DsxRequest, type FormInstance, type FormModule } from '@fw/core';
import { openFormText, validateForm, type FormDefinition } from '@fw/format';
import { componentMetas } from '@fw/components/meta';
import { describe, expect, it } from 'vitest';
import { fixtures } from '../../../apps/demo/src/fixtures.ts';

// The demo's form and script, run with no React and no browser. This checks the form file and the
// script against the real runtime and the fixture transport.
const folder = new URL('../../../apps/demo/src/forms/', import.meta.url);
const opened = openFormText(readFileSync(new URL('EmployeeEdit.form.json', folder), 'utf8'));
if (opened.status !== 'ok') throw new Error(opened.message);
const definition = opened.value as unknown as FormDefinition;

async function openDemo(requests: DsxRequest[] = []): Promise<FormInstance> {
  // The path is built at run time so type checking doesn't need the generated .form.gen.ts file.
  const script = new URL('EmployeeEdit.form.ts', folder).href;
  const module = ((await import(/* @vite-ignore */ script)) as { default: FormModule }).default;
  const errors: unknown[] = [];
  const inner = fixtureTransport(fixtures);
  const form = createForm(definition, {
    module,
    transport: {
      send: (request, options) => {
        requests.push(request);
        return inner.send(request, options);
      },
    },
    onError: (error, where) => errors.push(`${where}: ${String(error)}`),
  });
  await form.init();
  expect(errors).toEqual([]);
  return form;
}

const labelText = (form: FormInstance, id: string): unknown => form.getComponent(id)?.props.peek().text;

async function settle(form: FormInstance): Promise<void> {
  for (let i = 0; i < 100 && form.context.vars.busy === true; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('demo form file', () => {
  it('passes every check, against the real component metas', () => {
    expect(validateForm(definition, { components: componentMetas })).toEqual([]);
  });
});

describe('demo form at run time', () => {
  it('loads departments and 25 employees on init', async () => {
    const form = await openDemo();
    const { dsEmp, dsDept } = form.context.ds as Record<string, { rowCount: number }>;
    expect(dsDept?.rowCount).toBe(5);
    expect(dsEmp?.rowCount).toBe(25);
    expect(form.context.vars.message).toBe('Found 25 employees');
  });

  it('shows the row position and an exact total', async () => {
    const form = await openDemo();
    expect(labelText(form, 'rowInfo')).toBe('Row 1 of 25');
    const total = fixtures['hr.emp.search'];
    if (typeof total !== 'function') throw new Error('expected a function fixture');
    const rows = total({ dsx: 1, txId: 't', service: 'hr.emp.search' }).datasets?.list?.rows ?? [];
    // Add the salaries as whole micro-units, so no double is involved.
    const micro = rows.reduce((sum, row) => sum + BigInt(String(row[5]).replace('.', '')), 0n);
    const digits = micro.toString().padStart(7, '0');
    expect(labelText(form, 'totalLabel')).toBe(`Total salary: ${digits.slice(0, -6)}.${digits.slice(-6)}`);
  });

  it('moves the current row with Next and Previous, and disables them at the ends', async () => {
    const form = await openDemo();
    const click = (id: string) => form.getComponent(id)?.fire('click');
    const disabled = (id: string) => form.getComponent(id)?.props.peek().disabled;
    expect(disabled('prevButton')).toBe(true);
    expect(disabled('nextButton')).toBe(false);
    click('nextButton');
    click('nextButton');
    expect(labelText(form, 'rowInfo')).toBe('Row 3 of 25');
    expect(disabled('prevButton')).toBe(false);
    click('prevButton');
    expect(labelText(form, 'rowInfo')).toBe('Row 2 of 25');
    expect(form.getComponent('nameInput')?.props.peek().value).toBe('Benjamin Hughes');
  });

  it('writes an edit to the current row and sends only the changed row', async () => {
    const requests: DsxRequest[] = [];
    const form = await openDemo(requests);
    form.getComponent('nextButton')?.fire('click');
    expect(form.getComponent('nameInput')?.write('value', 'Benjamin Hughes Jr')).toBe(true);
    const { dsEmp } = form.context.ds as Record<string, { rowStatus(index: number): string; hasChanges(): boolean }>;
    expect(dsEmp?.rowStatus(1)).toBe('updated');

    form.getComponent('saveButton')?.fire('click');
    await settle(form);
    const save = requests.find((request) => request.service === 'hr.emp.save');
    expect(save?.datasets?.emp?.changes).toHaveLength(1);
    expect(save?.datasets?.emp?.changes?.[0]).toMatchObject({ s: 'U' });
    expect(form.context.vars.message).toBe('Saved 1 row');
    expect(dsEmp?.hasChanges()).toBe(false);
  });

  it('saves a decimal edit exactly as typed', async () => {
    const form = await openDemo();
    expect(form.getComponent('salaryInput')?.write('value', '81234.123457')).toBe(true);
    expect((form.context.ds as Record<string, { getValue(i: number, c: string): unknown }>).dsEmp?.getValue(0, 'salary')).toBe('81234.123457');
  });

  it('reverts edits', async () => {
    const form = await openDemo();
    form.getComponent('nameInput')?.write('value', 'Someone Else');
    form.getComponent('revertButton')?.fire('click');
    const { dsEmp } = form.context.ds as Record<string, { hasChanges(): boolean }>;
    expect(dsEmp?.hasChanges()).toBe(false);
    expect(form.getComponent('nameInput')?.props.peek().value).toBe('Alice Carter');
    expect(form.context.vars.message).toBe('Changes reverted');
  });

  it('searches by name', async () => {
    const form = await openDemo();
    const { dsCond, dsEmp } = form.context.ds as Record<string, { rowCount: number; setValue(i: number, c: string, v: unknown): unknown }>;
    dsCond?.setValue(0, 'keyword', 'an');
    form.getComponent('searchButton')?.fire('click');
    await settle(form);
    const found = dsEmp?.rowCount ?? 0;
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThan(25);
    expect(form.context.vars.message).toBe(`Found ${found} employees`);
  });
});

describe('demo form: searching with unsaved edits', () => {
  it('does not replace the edits, and says why', async () => {
    const requests: DsxRequest[] = [];
    const form = await openDemo(requests);
    form.getComponent('nameInput')?.write('value', 'Edited Name');
    const before = requests.length;

    form.getComponent('searchButton')?.fire('click');
    await settle(form);

    expect(requests.length).toBe(before);
    expect(form.context.vars.message).toBe('Save or revert your changes first');
    expect(form.getComponent('nameInput')?.props.peek().value).toBe('Edited Name');
  });

  it('searches again once the edits are saved', async () => {
    const requests: DsxRequest[] = [];
    const form = await openDemo(requests);
    form.getComponent('nameInput')?.write('value', 'Edited Name');
    form.getComponent('saveButton')?.fire('click');
    await settle(form);
    form.getComponent('searchButton')?.fire('click');
    await settle(form);
    expect(requests.filter((request) => request.service === 'hr.emp.search')).toHaveLength(2);
  });

  it('has no search on change, only on submit and the button', () => {
    const events = definition.components.flatMap((c) => [c, ...(c.children ?? [])]).find((c) => c.id === 'keywordInput')?.events;
    expect(events).toEqual({ submit: 'onSearch' });
  });
});
