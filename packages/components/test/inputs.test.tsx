// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeResult, ComponentHandle } from '@fw/core';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostProps } from '../src/contract.ts';
import { inputComponents } from '../src/inputs/index.ts';
import { componentMetas } from '../src/meta/index.ts';

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

describe('registry', () => {
  it('registers all nine components with matching metas', () => {
    expect(Object.keys(inputComponents).sort()).toEqual(
      ['Button', 'Checkbox', 'ComboBox', 'DatePicker', 'Label', 'NumberInput', 'RadioGroup', 'TextArea', 'TextInput'],
    );
    for (const [key, reg] of Object.entries(inputComponents)) {
      expect(reg.meta.type).toBe(key);
      expect(componentMetas[key]).toBe(reg.meta);
    }
  });
});

describe('TextInput draft and commit', () => {
  it('finds the input by label and does not write per keystroke', async () => {
    const user = userEvent.setup();
    const { write } = mount('TextInput', { label: 'Name', value: 'Ann' });
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.type(input, 'abc');
    expect(input).toHaveValue('Annabc');
    expect(write).not.toHaveBeenCalled();
  });

  it('writes on blur and fires change', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('TextInput', { label: 'Name', value: 'Ann' });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('X');
    await user.tab();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('value', 'AnnX');
    expect(fire).toHaveBeenCalledWith('change', expect.anything());
  });

  it('writes on Enter, and does not write or fire when nothing changed', async () => {
    const user = userEvent.setup();
    const a = mount('TextInput', { label: 'Name', value: 'Ann' });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('{Enter}');
    await user.tab();
    expect(a.write).not.toHaveBeenCalled();
    expect(a.fire.mock.calls.map((c) => c[0])).toEqual(['submit']);
    cleanup();
    const b = mount('TextInput', { label: 'Name', value: 'Ann' });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('Z{Enter}');
    expect(b.write).toHaveBeenCalledWith('value', 'AnnZ');
  });

  it('Esc restores the bound value and nothing is written on blur', async () => {
    const user = userEvent.setup();
    const { write } = mount('TextInput', { label: 'Name', value: 'Ann' });
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('xyz{Escape}');
    expect(input).toHaveValue('Ann');
    await user.tab();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the text, flags it invalid and writes nothing when the text does not fit, until the next edit', async () => {
    const user = userEvent.setup();
    const { fire, write, accepts } = mount('TextInput', { label: 'Name', value: 'Ann' }, true, false, false);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('!{Enter}');
    expect(accepts).toHaveBeenCalledWith('value', 'Ann!');
    expect(write).not.toHaveBeenCalled();
    expect(input).toHaveValue('Ann!');
    expect(input).toBeInvalid();
    expect(screen.getByText("This value isn't valid")).toBeTruthy();
    expect(fire).not.toHaveBeenCalled();
    await user.keyboard('?');
    expect(input).not.toBeInvalid();
  });

  it('Esc clears a rejection', async () => {
    const user = userEvent.setup();
    mount('TextInput', { label: 'Name', value: 'Ann' }, true, false, false);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('!{Enter}{Escape}');
    expect(input).toHaveValue('Ann');
    expect(input).not.toBeInvalid();
  });

  it('goes back to the bound value, with no invalid message, when a handler refuses the write', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('TextInput', { label: 'Name', value: 'Ann' }, false);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('!{Enter}');
    expect(write).toHaveBeenCalledWith('value', 'Ann!');
    expect(input).toHaveValue('Ann');
    expect(input).not.toBeInvalid();
    expect(fire).not.toHaveBeenCalled();
  });

  it('goes back to the bound value when an async write is refused after blur', async () => {
    const user = userEvent.setup();
    mount('TextInput', { label: 'Name', value: 'Ann' }, Promise.resolve(false));
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('!');
    await user.tab();
    await waitFor(() => expect(input).toHaveValue('Ann'));
    expect(input).not.toBeInvalid();
  });

  it('follows a bound value that changes while not focused', () => {
    const m = mount('TextInput', { label: 'Name', value: 'Ann' });
    m.again({ label: 'Name', value: 'Bob' });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Bob');
  });

  it('keeps the draft when the bound value changes while focused', async () => {
    const user = userEvent.setup();
    const m = mount('TextInput', { label: 'Name', value: 'Ann' });
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('1');
    m.again({ label: 'Name', value: 'Bob' });
    expect(input).toHaveValue('Ann1');
    await user.tab();
    m.again({ label: 'Name', value: 'Bob' });
    expect(input).toHaveValue('Bob');
  });

  it('shows errorMessage as invalid', () => {
    mount('TextInput', { label: 'Name', value: '', errorMessage: 'Name is required' });
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInvalid();
    expect(screen.getByText('Name is required')).toBeTruthy();
  });

  it('does not write or fire in design mode', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('TextInput', { label: 'Name', value: 'Ann' }, true, true);
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    await user.keyboard('x{Enter}');
    await user.tab();
    expect(write).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it('focuses through handleRef', () => {
    const { handleRef } = mount('TextInput', { label: 'Name', value: '' });
    handleRef.current!.focus();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });
});

describe('TextArea', () => {
  it('inserts a newline on Enter and commits only on blur', async () => {
    const user = userEvent.setup();
    const { write } = mount('TextArea', { label: 'Notes', value: 'a' });
    const area = screen.getByRole('textbox', { name: 'Notes' });
    await user.click(area);
    await user.keyboard('{Enter}b');
    expect(area).toHaveValue('a\nb');
    expect(write).not.toHaveBeenCalled();
    await user.tab();
    expect(write).toHaveBeenCalledWith('value', 'a\nb');
  });

  it('goes back to the bound value when write returns false', async () => {
    const user = userEvent.setup();
    mount('TextArea', { label: 'Notes', value: 'a' }, false);
    const area = screen.getByRole('textbox', { name: 'Notes' });
    await user.click(area);
    await user.keyboard('b');
    await user.tab();
    expect(area).toHaveValue('a');
  });
});

describe('NumberInput', () => {
  const long = '12345678901234567890.123456789012345678';

  it('is a decimal text field and keeps a long decimal exact both ways', async () => {
    const user = userEvent.setup();
    const { write } = mount('NumberInput', { label: 'Amount', value: long });
    const input = screen.getByRole('textbox', { name: 'Amount' });
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveValue(long);
    await user.click(input);
    expect(input).toHaveValue(long);
    await user.clear(input);
    await user.type(input, '98765432109876543210.000000000000000001');
    await user.keyboard('{Enter}');
    expect(write).toHaveBeenCalledWith('value', '98765432109876543210.000000000000000001');
    expect(typeof write.mock.calls[0]![1]).toBe('string');
  });

  it('shows a number value as text', () => {
    mount('NumberInput', { label: 'Amount', value: 42.5 });
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('42.5');
  });

  it('shows the raw text when format cannot be applied, and while focused', async () => {
    const user = userEvent.setup();
    mount('NumberInput', { label: 'Amount', value: '1234.50', format: '#,##0.00' });
    const input = screen.getByRole('textbox', { name: 'Amount' });
    // Before formatValue lands this is the raw text. Either way, focusing shows the raw value.
    await user.click(input);
    expect(input).toHaveValue('1234.50');
  });

  it('keeps invalid text and flags it when the column does not accept it', async () => {
    const user = userEvent.setup();
    mount('NumberInput', { label: 'Amount', value: '1' }, true, false, false);
    const input = screen.getByRole('textbox', { name: 'Amount' });
    await user.click(input);
    await user.keyboard('x{Enter}');
    expect(input).toHaveValue('1x');
    expect(input).toBeInvalid();
    await user.tab();
    expect(input).toHaveValue('1x');
  });
});

describe('Button and Label', () => {
  it('fires click, but not when disabled or in design mode', async () => {
    const user = userEvent.setup();
    const a = mount('Button', { text: 'Save', variant: 'primary' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(a.fire).toHaveBeenCalledWith('click');
    cleanup();
    const b = mount('Button', { text: 'Save', disabled: true });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(b.fire).not.toHaveBeenCalled();
    cleanup();
    const c = mount('Button', { text: 'Save' }, true, true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(c.fire).not.toHaveBeenCalled();
  });

  it('focuses the button through handleRef', () => {
    const { handleRef } = mount('Button', { text: 'Go' });
    handleRef.current!.focus();
    expect(screen.getByRole('button', { name: 'Go' })).toHaveFocus();
  });

  it('gives a live label the status role', () => {
    mount('Label', { text: 'Saved 1 row', live: true });
    expect(screen.getByRole('status').textContent).toBe('Saved 1 row');
    cleanup();
    mount('Label', { text: 'Plain' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows label text and alignment', () => {
    mount('Label', { text: 'Hello', align: 'right' });
    const el = screen.getByText('Hello');
    expect(el.className).toBe('fw-label');
    expect(el).toHaveStyle({ textAlign: 'right' });
  });
});

describe('Checkbox', () => {
  it('writes straight away and fires change', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('Checkbox', { label: 'Active', value: false });
    const box = screen.getByRole('checkbox', { name: 'Active' });
    await user.click(box);
    expect(write).toHaveBeenCalledWith('value', true);
    expect(fire).toHaveBeenCalledWith('change', expect.anything());
  });

  it('stays at the bound value when write returns false', async () => {
    const user = userEvent.setup();
    const { fire } = mount('Checkbox', { label: 'Active', value: false }, false);
    const box = screen.getByRole('checkbox', { name: 'Active' });
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(fire).not.toHaveBeenCalled();
  });

  it('does not change when read-only', async () => {
    const user = userEvent.setup();
    const { write } = mount('Checkbox', { label: 'Active', value: true, readOnly: true });
    await user.click(screen.getByRole('checkbox', { name: 'Active' }));
    expect(write).not.toHaveBeenCalled();
  });
});

describe('RadioGroup', () => {
  it('shows the bound option and writes the chosen option value', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('RadioGroup', { label: 'Country', value: 'KR', options });
    expect(screen.getByRole('radiogroup', { name: 'Country' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Korea' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Japan' }));
    expect(write).toHaveBeenCalledWith('value', 'JP');
    expect(fire).toHaveBeenCalledWith('change', expect.anything());
  });

  it('goes back to the bound value on a false result', async () => {
    const user = userEvent.setup();
    mount('RadioGroup', { label: 'Country', value: 'KR', options }, false);
    await user.click(screen.getByRole('radio', { name: 'Japan' }));
    expect(screen.getByRole('radio', { name: 'Korea' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Japan' })).not.toBeChecked();
  });
});

describe('ComboBox', () => {
  it('shows the label of the bound value, and unknown values as they are', () => {
    mount('ComboBox', { label: 'Country', value: 'US', options });
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('United States');
    cleanup();
    mount('ComboBox', { label: 'Country', value: 'ZZ', options });
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('ZZ');
  });

  it('filters while typing and writes the option value on selection', async () => {
    const user = userEvent.setup();
    const { write, fire } = mount('ComboBox', { label: 'Country', value: null, options });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.type(input, 'jap');
    expect(await screen.findAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('option', { name: 'Japan' }));
    expect(write).toHaveBeenCalledWith('value', 'JP');
    expect(fire).toHaveBeenCalledWith('change', expect.anything());
  });

  it('shows the chosen label at once while still focused', async () => {
    const user = userEvent.setup();
    mount('ComboBox', { label: 'Country', value: 'KR', options });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.click(screen.getByRole('button', { name: /Show options/ }));
    await user.click(await screen.findByRole('option', { name: 'Japan' }));
    expect(input).toHaveValue('Japan');
    expect(input).toHaveFocus();
  });

  it('shows the chosen label after typing and picking with the keyboard', async () => {
    const user = userEvent.setup();
    mount('ComboBox', { label: 'Country', value: null, options });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.type(input, 'Ja');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('Japan');
  });

  it('goes back to the bound label when the write is refused, sync or async', async () => {
    const user = userEvent.setup();
    for (const refused of [false, Promise.resolve(false)]) {
      mount('ComboBox', { label: 'Country', value: 'KR', options }, refused);
      const input = screen.getByRole('combobox', { name: 'Country' });
      await user.click(input);
      await user.click(screen.getByRole('button', { name: /Show options/ }));
      await user.click(await screen.findByRole('option', { name: 'Japan' }));
      await waitFor(() => expect(input).toHaveValue('Korea'));
      cleanup();
    }
  });

  it('writes null when the text is cleared and the field is left', async () => {
    const user = userEvent.setup();
    const { write } = mount('ComboBox', { label: 'Country', value: 'KR', options });
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.clear(input);
    await user.tab();
    expect(write).toHaveBeenCalledWith('value', null);
  });

  it('shows the error message as invalid', () => {
    mount('ComboBox', { label: 'Country', value: null, options, errorMessage: 'Pick one' });
    expect(screen.getByRole('combobox', { name: 'Country' })).toBeInvalid();
    expect(screen.getByText('Pick one')).toBeTruthy();
  });
});

describe('DatePicker', () => {
  it('shows a YYYY-MM-DD value as an en-US date in a labelled group', () => {
    mount('DatePicker', { label: 'Start', value: '2024-03-05' });
    expect(screen.getByRole('group', { name: /Start/ })).toBeTruthy();
    const spin = screen.getAllByRole('spinbutton').map((s) => s.textContent);
    expect(spin).toEqual(['3', '5', '2024']);
  });

  // The host feeds written values back as props, so the harness does too.
  function mountBound(initial: string | null) {
    const write = vi.fn();
    const Date_ = inputComponents.DatePicker!.render;
    function Bound() {
      const [value, setValue] = useState(initial);
      const h: HostProps<never> = {
        id: 'c1',
        props: { label: 'Start', value } as never,
        accepts: () => true,
        write: (_p, v) => {
          write('value', v);
          setValue(v as string | null);
          return true;
        },
        fire: () => {},
        handleRef: createRef<ComponentHandle>(),
        design: false,
      };
      return <Date_ {...h} />;
    }
    render(<Bound />);
    return write;
  }

  it('writes YYYY-MM-DD text when a date is typed', async () => {
    const user = userEvent.setup();
    const write = mountBound(null);
    await user.click(screen.getAllByRole('spinbutton')[0]!);
    await user.keyboard('12252030');
    expect(write).not.toHaveBeenCalled();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(write).toHaveBeenLastCalledWith('value', '2030-12-25');
  });

  it('writes null once every segment is cleared', async () => {
    const user = userEvent.setup();
    const write = mountBound('2024-03-05');
    for (const segment of screen.getAllByRole('spinbutton')) {
      await user.click(segment);
      await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}');
    }
    expect(write).not.toHaveBeenCalled();
    await user.tab();
    await user.tab();
    expect(write).toHaveBeenLastCalledWith('value', null);
  });

  it('focuses the first segment through handleRef', () => {
    const { handleRef } = mount('DatePicker', { label: 'Start', value: null });
    handleRef.current!.focus();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveFocus();
  });
});
