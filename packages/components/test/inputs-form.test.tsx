// @vitest-environment jsdom
// Regression tests for the draft rules against the real createForm and FormView, not fakes.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createForm, type FormDefinition, type FormInstance } from '@fw/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormView } from '../src/host/index.tsx';
import { defaultRegistry } from '../src/index.ts';

afterEach(cleanup);

function definition(): FormDefinition {
  return {
    formatVersion: 1,
    id: 'test.Inputs',
    datasets: [
      {
        id: 'dsEmp',
        columns: [
          { id: 'name', type: 'string', size: 10 },
          { id: 'amount', type: 'decimal', precision: 12, scale: 2 },
        ],
        initialRows: [
          { name: 'Ann', amount: '1000' },
          { name: 'Bob', amount: '2000.50' },
        ],
      },
    ],
    components: [
      { id: 'name', type: 'TextInput', layout: {}, props: { label: 'Name' }, bind: { value: 'dsEmp.name' }, events: { change: 'onChange' } },
      {
        id: 'amount',
        type: 'NumberInput',
        layout: {},
        props: { label: 'Amount', min: 0 },
        bind: { value: 'dsEmp.amount' },
        events: { change: 'onAmount' },
      },
    ],
  } as unknown as FormDefinition;
}

function setup(handlers: Record<string, (...args: never[]) => unknown> = {}, def = definition()) {
  const form: FormInstance = createForm(def, { module: { setup: () => handlers as never }, onError: (e) => { throw e; } });
  render(<FormView form={form} registry={defaultRegistry} />);
  const ds = form.getDataset('dsEmp')!;
  const name = () => screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
  const amount = () => screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
  return { form, ds, name, amount };
}

describe('drafts against the real form', () => {
  it('a focused, untouched field never writes over a row that changed under it', async () => {
    const user = userEvent.setup();
    const { ds, name } = setup();
    await user.click(name());
    act(() => {
      ds.setValue(0, 'name', 'Zed');
    });
    await waitFor(() => expect(name().value).toBe('Zed'));
    await user.tab();
    expect(ds.getValue(0, 'name')).toBe('Zed');
    expect(ds.getValue(1, 'name')).toBe('Bob');
  });

  it('commits an edited draft to its own row when the current row moves, and shows the new row', async () => {
    const user = userEvent.setup();
    const { ds, name } = setup();
    await user.click(name());
    await user.keyboard('X');
    act(() => {
      ds.setCurrentIndex(1);
    });
    await waitFor(() => expect(name().value).toBe('Bob'));
    expect(ds.getValue(0, 'name')).toBe('AnnX');
    expect(ds.getValue(1, 'name')).toBe('Bob');
    await user.tab();
    expect(ds.getValue(1, 'name')).toBe('Bob');
  });

  it('discards a draft that does not fit when the row moves', async () => {
    const user = userEvent.setup();
    const { ds, amount } = setup();
    await user.click(amount());
    await user.keyboard('abc'); // not a number, so it can't be stored
    act(() => {
      ds.setCurrentIndex(1);
    });
    await waitFor(() => expect(amount().value).toBe('2000.50'));
    expect(ds.getValue(0, 'amount')).toBe('1000');
    expect(amount().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('Enter then blur commits once, and fires change once', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { ds, name } = setup({ onChange });
    
    await user.click(name());
    await user.keyboard('Z{Enter}');
    await user.tab();
    expect(ds.getValue(0, 'name')).toBe('AnnZ');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the stored form of a value after a commit, and fires no change when it is equal', async () => {
    const user = userEvent.setup();
    const onAmount = vi.fn();
    const { ds, amount } = setup({ onAmount });
    await user.click(amount());
    await user.clear(amount());
    await user.keyboard('1,000{Enter}');
    expect(ds.getValue(0, 'amount')).toBe('1000');
    expect(amount().value).toBe('1000');
    expect(onAmount).not.toHaveBeenCalled();
    await user.clear(amount());
    await user.keyboard('1000.00{Enter}');
    expect(onAmount).not.toHaveBeenCalled();
    await user.clear(amount());
    await user.keyboard('1500{Enter}');
    expect(onAmount).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(onAmount).toHaveBeenCalledTimes(1);
  });

  it('keeps text that does not fit, marks it invalid, and clears it on Esc', async () => {
    const user = userEvent.setup();
    const { ds, amount } = setup();
    await user.click(amount());
    await user.keyboard('abc{Enter}');
    expect(ds.getValue(0, 'amount')).toBe('1000');
    expect(amount().value).toBe('1000abc');
    expect(amount().getAttribute('aria-invalid')).toBe('true');
    await user.keyboard('{Escape}');
    expect(amount().value).toBe('1000');
    expect(amount().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('rejects an out-of-range number with a message, and keeps it on screen', async () => {
    const user = userEvent.setup();
    const { ds, amount } = setup();
    await user.click(amount());
    await user.clear(amount());
    await user.keyboard('-5{Enter}');
    expect(ds.getValue(0, 'amount')).toBe('1000');
    expect(amount().value).toBe('-5');
    expect(screen.getByText('Must be at least 0')).toBeTruthy();
  });

  it('clears rejected text when the row changes or the data is reverted', async () => {
    const user = userEvent.setup();
    const { ds, amount } = setup();
    await user.click(amount());
    await user.keyboard('abc{Enter}');
    expect(amount().getAttribute('aria-invalid')).toBe('true');
    act(() => {
      ds.setCurrentIndex(1);
    });
    await waitFor(() => expect(amount().value).toBe('2000.50'));
    expect(amount().getAttribute('aria-invalid')).not.toBe('true');
  });

  it('Esc with a draft restores it and does not reach an outer handler; Esc with none does', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const { name } = setup();
    document.addEventListener('keydown', outer);
    await user.click(name());
    await user.keyboard('X{Escape}');
    expect(name().value).toBe('Ann');
    expect(outer.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0);
    await user.keyboard('{Escape}');
    expect(outer.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(1);
    document.removeEventListener('keydown', outer);
  });

  it('does not fire change after unmount', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const def = definition();
    const form = createForm(def, { module: { setup: () => ({ onChange }) as never } });
    // Hold the write open with a handler that waits, then unmount before it settles.
    const ds = form.getDataset('dsEmp')!;
    let release!: () => void;
    ds.on('cellChanging', (e: { waitUntil(p: Promise<unknown>): void }) => {
      e.waitUntil(new Promise<void>((resolve) => (release = resolve)));
    });
    const view = render(<FormView form={form} registry={defaultRegistry} />);
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.keyboard('Q');
    await user.tab();
    view.unmount();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
  });
});
