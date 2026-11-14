// @vitest-environment jsdom
import { createForm, type FormDefinition } from '@fw/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FormView } from '../src/host/index.tsx';
import { testRegistry } from './support/test-components.tsx';

afterEach(cleanup);

const page = (id: string, title: string) => ({ id, type: 'Panel', layout: { left: 0, top: 0, right: 0, bottom: 0 }, props: { title } });

const definition: FormDefinition = {
  formatVersion: 1,
  id: 'f',
  variables: { show: { type: 'boolean', default: true }, tab: { type: 'int', default: 0 } },
  components: [
    { id: 'dlg', type: 'Dialog', layout: { width: 300, height: 200 }, props: { open: '=vars.show', title: 'Hello' } },
    {
      id: 'tabs',
      type: 'Tabs',
      layout: { left: 0, top: 0, width: 300, height: 200 },
      props: { selectedIndex: '=vars.tab' },
      children: [page('p1', 'One'), page('p2', 'Two'), page('p3', 'Three')],
    },
  ],
};

const rethrow = (error: unknown): never => {
  throw error;
};

describe('containers driven by expressions, with the real createForm', () => {
  it('Dialog closes on Esc, then reopens when the expression changes again', async () => {
    const form = createForm(definition, { onError: rethrow });
    render(<FormView form={form} registry={testRegistry} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => {
      form.context.vars.show = false;
    });
    act(() => {
      form.context.vars.show = true;
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('Tabs follows the expression again after the user picked a tab', async () => {
    const form = createForm(definition, { onError: rethrow });
    render(<FormView form={form} registry={testRegistry} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
    act(() => {
      form.context.vars.tab = 2;
    });
    expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('aria-selected')).toBe('true');
  });
});
