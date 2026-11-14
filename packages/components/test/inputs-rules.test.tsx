// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeResult, ComponentHandle } from '@fw/core';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostProps } from '../src/contract.ts';
import { inputComponents } from '../src/inputs/index.ts';

afterEach(cleanup);

// jest-dom isn't installed, so these are the few matchers this file needs.
expect.extend({
  toHaveValue(el: HTMLInputElement, v: string) {
    return { pass: el.value === v, message: () => `expected value ${JSON.stringify(v)}, got ${JSON.stringify(el.value)}` };
  },
  toBeInvalid(el: HTMLElement) {
    return { pass: el.getAttribute('aria-invalid') === 'true' || el.hasAttribute('data-invalid'), message: () => 'expected invalid' };
  },
  toBeChecked(el: HTMLInputElement) {
    return { pass: el.checked, message: () => 'expected checked' };
  },
  toHaveFocus(el: HTMLElement) {
    return { pass: el.ownerDocument.activeElement === el, message: () => 'expected focus' };
  },
  toHaveAttribute(el: HTMLElement, name: string, v: string) {
    return { pass: el.getAttribute(name) === v, message: () => `expected ${name}=${v}, got ${el.getAttribute(name)}` };
  },
  toHaveStyle(el: HTMLElement, style: Record<string, string>) {
    const bad = Object.entries(style).filter(([k, v]) => (el.style as unknown as Record<string, string>)[k] !== v);
    return { pass: bad.length === 0, message: () => `style mismatch ${JSON.stringify(bad)}` };
  },
});
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match Vitest's declaration
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveValue(v: string): R;
    toBeInvalid(): R;
    toBeChecked(): R;
    toHaveFocus(): R;
    toHaveAttribute(name: string, v: string): R;
    toHaveStyle(style: Record<string, string>): R;
  }
}

type Result = ChangeResult | ((v: unknown) => ChangeResult);

/**
 * Renders a component the way the host does: a successful write comes back as the new bound value.
 * `again` sets props from outside, like a Dataset change.
 */
function mount(type: string, props: Record<string, unknown>, result: Result = true, design = false, fits = true) {
  const Comp = inputComponents[type]!.render;
  const write = vi.fn((_prop: string, v: unknown, _row?: number): ChangeResult => (typeof result === 'function' ? result(v) : result));
  const accepts = vi.fn((_prop: string, _v: unknown) => fits);
  const fire = vi.fn();
  const handleRef = createRef<ComponentHandle>();
  let external: (next: Record<string, unknown>) => void = () => {};
  function Bound() {
    const [current, setCurrent] = useState(props);
    external = setCurrent;
    const h: HostProps<never> = {
      id: 'c1',
      props: current as never,
      write: (prop, v, row) => {
        const r = row === undefined ? write(prop, v) : write(prop, v, row);
        const apply = () =>
          setCurrent((p) => (row === undefined || row === p.boundRow ? { ...p, value: v, boundRevision: Number(p.boundRevision ?? 0) + 1 } : p));
        if (typeof r === 'boolean') {
          if (r) apply();
        } else {
          void r.then((ok) => {
            if (ok) apply();
          });
        }
        return r;
      },
      accepts,
      fire,
      handleRef,
      design,
    };
    return <Comp {...h} />;
  }
  const view = render(<Bound />);
  const again = (next: Record<string, unknown>) => act(() => external(next));
  return { write, accepts, fire, handleRef, again, view };
}

const options = [
  { value: 'KR', label: 'Korea' },
  { value: 'US', label: 'United States' },
  { value: 'JP', label: 'Japan' },
];


describe('stage 4 rules', () => {
  it('a focused TextInput with no edit never writes', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('TextInput', { label: 'Name', value: 'Ann' });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.tab();
    expect(write).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it('a read-only field never writes', async () => {
    const user = userEvent.setup();
    const { write } = mount('TextInput', { label: 'Name', value: 'Ann', readOnly: true });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('x{Enter}');
    await user.tab();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes a draft to the row it was typed on and shows the new row', async () => {
    const user = userEvent.setup();
    const m = mount('TextInput', { label: 'Name', value: 'Ann', boundRow: 1, boundRevision: 1 });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('X');
    m.again({ label: 'Name', value: 'Bob', boundRow: 2, boundRevision: 1 });
    expect(m.write).toHaveBeenCalledWith('value', 'AnnX', 1);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Bob');
  });

  it('TextInput fires submit on Enter after a commit, but not on blur', async () => {
    const user = userEvent.setup();
    const { fire } = mount('TextInput', { label: 'Name', value: 'Ann' });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('Z{Enter}');
    expect(fire.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['submit', 'change']));
    fire.mockClear();
    await user.keyboard('Y');
    await user.tab();
    expect(fire.mock.calls.map((c) => c[0])).not.toContain('submit');
  });

  it('does not submit when the text does not fit', async () => {
    const user = userEvent.setup();
    const { fire } = mount('TextInput', { label: 'Name', value: 'Ann' }, true, false, false);
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('Z{Enter}');
    expect(fire).not.toHaveBeenCalled();
  });

  it('names fields without a label from the placeholder or the id', () => {
    mount('TextInput', { value: '', placeholder: 'Search' });
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeTruthy();
    cleanup();
    mount('TextInput', { value: '' });
    expect(screen.getByRole('textbox', { name: 'c1' })).toBeTruthy();
    cleanup();
    mount('Checkbox', { value: false });
    expect(screen.getByRole('checkbox', { name: 'c1' })).toBeTruthy();
    cleanup();
    mount('RadioGroup', { value: null, options });
    expect(screen.getByRole('radiogroup', { name: 'c1' })).toBeTruthy();
  });

  it('marks required fields and gives the error text a title', () => {
    const { view } = mount('TextInput', { label: 'Name', value: '', required: true, errorMessage: 'A long message' });
    expect(view.container.querySelector('.fw-textinput')!.getAttribute('data-required')).toBe('true');
    expect(screen.getByText('A long message').getAttribute('title')).toBe('A long message');
  });

  it('NumberInput rejects values below min or above max without going through a double', async () => {
    const user = userEvent.setup();
    const { write } = mount('NumberInput', { label: 'Amount', value: '5', min: 0, max: '10.000000000000000001' });
    const input = screen.getByRole('textbox', { name: 'Amount' });
    await user.click(input);
    await user.clear(input);
    await user.keyboard('-0.000000000000000001{Enter}');
    expect(screen.getByText('Must be at least 0')).toBeTruthy();
    await user.clear(input);
    await user.keyboard('10.000000000000000002{Enter}');
    expect(screen.getByText('Must be at most 10.000000000000000001')).toBeTruthy();
    expect(input).toHaveValue('10.000000000000000002');
    expect(write).not.toHaveBeenCalled();
    await user.clear(input);
    await user.keyboard('10.000000000000000001{Enter}');
    expect(write).toHaveBeenCalledWith('value', '10.000000000000000001');
  });

  it('a disabled Button stays focusable and does not fire', async () => {
    const user = userEvent.setup();
    const m = mount('Button', { text: 'Go' });
    const button = screen.getByRole('button', { name: 'Go' });
    button.focus();
    m.again({ text: 'Go', disabled: true });
    expect(button).toHaveFocus();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('data-disabled')).toBe(true);
    expect(button.getAttribute('tabindex')).toBe('-1');
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(m.fire).not.toHaveBeenCalled();
  });

  it('RadioGroup with an unknown value is still reachable by keyboard', async () => {
    const user = userEvent.setup();
    mount('RadioGroup', { label: 'Country', value: 'ZZ', options });
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Korea' })).toHaveFocus();
  });

  it('ComboBox passing through a field with an empty label does not clear it', async () => {
    const user = userEvent.setup();
    const { write } = mount('ComboBox', { label: 'Country', value: 'ZZ', options: [{ value: 'ZZ', label: '' }] });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.tab();
    expect(write).not.toHaveBeenCalled();
  });

  it('ComboBox selects an option typed in full (any case) on leaving, and reverts other text', async () => {
    const user = userEvent.setup();
    const m = mount('ComboBox', { label: 'Country', value: 'KR', options });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'JAPAN');
    await user.tab();
    expect(m.write).toHaveBeenCalledWith('value', 'JP');
    cleanup();
    const n = mount('ComboBox', { label: 'Country', value: 'KR', options });
    const again = screen.getByRole('combobox', { name: 'Country' });
    await user.click(again);
    await user.clear(again);
    await user.type(again, 'Jap');
    await user.tab();
    expect(n.write).not.toHaveBeenCalled();
    expect(again).toHaveValue('Korea');
  });

  it('DatePicker writes nothing for a partial date and marks it invalid', async () => {
    const user = userEvent.setup();
    const m = mount('DatePicker', { label: 'Start', value: null });
    await user.click(screen.getAllByRole('spinbutton')[0]!);
    await user.keyboard('12');
    await user.tab();
    await user.tab();
    await user.tab();
    expect(m.write).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a complete date')).toBeTruthy();
  });

  it('DatePicker rejects dates outside min and max', async () => {
    const user = userEvent.setup();
    const m = mount('DatePicker', { label: 'Start', value: null, min: '2024-01-01', max: '2024-12-31' });
    await user.click(screen.getAllByRole('spinbutton')[0]!);
    await user.keyboard('01012020');
    await user.tab();
    await user.tab();
    await user.tab();
    expect(m.write).not.toHaveBeenCalled();
    expect(screen.getByText('Must be on or after 2024-01-01')).toBeTruthy();
  });

  it('DatePicker writes a calendar pick straight away', async () => {
    const user = userEvent.setup();
    const m = mount('DatePicker', { label: 'Start', value: '2024-03-05' });
    await user.click(screen.getByRole('button', { name: /Open calendar/ }));
    const cell = await screen.findByRole('button', { name: /March 12, 2024/ });
    await user.click(cell);
    expect(m.write).toHaveBeenCalledWith('value', '2024-03-12');
  });
});

describe('Checkbox and RadioGroup validation', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];

  it('Checkbox is announced as required and invalid, with the message as its description', () => {
    mount('Checkbox', { label: 'Active', value: false, required: true, errorMessage: 'Must be checked' });
    const box = screen.getByRole('checkbox', { name: 'Active' });
    expect(box.getAttribute('aria-required')).toBe('true');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const message = screen.getByText('Must be checked');
    expect(box.getAttribute('aria-describedby')).toBe(message.id);
    expect(message.getAttribute('title')).toBe('Must be checked');
    expect(document.querySelector('.fw-checkbox')!.getAttribute('data-required')).toBe('true');
  });

  it('Checkbox without a message or required is plain', () => {
    mount('Checkbox', { label: 'Active', value: false });
    const box = screen.getByRole('checkbox', { name: 'Active' });
    expect(box.getAttribute('aria-required')).toBeNull();
    expect(box.getAttribute('aria-invalid')).toBeNull();
    expect(box.getAttribute('aria-describedby')).toBeNull();
  });

  it('RadioGroup is announced as required and invalid, with the message as its description', () => {
    mount('RadioGroup', { label: 'Kind', value: null, options, required: true, errorMessage: 'Pick one' });
    const group = screen.getByRole('radiogroup', { name: 'Kind' });
    expect(group.getAttribute('aria-required')).toBe('true');
    expect(group.getAttribute('aria-invalid')).toBe('true');
    const message = screen.getByText('Pick one');
    expect((group.getAttribute('aria-describedby') ?? '').split(' ')).toContain(message.closest('[id]')!.id);
    expect(document.querySelector('.fw-radiogroup')!.getAttribute('data-required')).toBe('true');
  });

  it('RadioGroup without a message is not invalid', () => {
    mount('RadioGroup', { label: 'Kind', value: 'a', options });
    expect(screen.getByRole('radiogroup', { name: 'Kind' }).getAttribute('aria-invalid')).toBeNull();
  });

  it('every input reports required the same way: data-required on the root and aria-required on the control', () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['TextInput', { label: 'X', value: '' }, 'textbox', '.fw-textinput'],
      ['TextArea', { label: 'X', value: '' }, 'textbox', '.fw-textarea'],
      ['NumberInput', { label: 'X', value: '' }, 'textbox', '.fw-numberinput'],
      ['Checkbox', { label: 'X', value: false }, 'checkbox', '.fw-checkbox'],
      ['RadioGroup', { label: 'X', value: null, options }, 'radiogroup', '.fw-radiogroup'],
    ];
    for (const [type, props, role, root] of cases) {
      mount(type, { ...props, required: true });
      expect(document.querySelector(root)!.getAttribute('data-required'), type).toBe('true');
      expect(screen.getByRole(role, { name: 'X' }).getAttribute('aria-required'), type).toBe('true');
      cleanup();
    }
  });
});
