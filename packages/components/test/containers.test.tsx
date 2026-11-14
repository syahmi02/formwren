// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FormView } from '../src/host/index.tsx';
import { componentMetas } from '../src/meta/index.ts';
import { createFakeForm, def } from './support/fake-form.ts';
import { testRegistry } from './support/test-components.tsx';

afterEach(cleanup);

const pageLayout = { left: 0, top: 0, right: 0, bottom: 0 };
const pages = () => [
  def('one', 'Panel', { title: 'First' }, { layout: pageLayout, children: [def('t1', 'Probe', { text: 'in one' })] }),
  def('two', 'Panel', { title: 'Second' }, { layout: pageLayout, children: [def('t2', 'Probe', { text: 'in two' })] }),
  def('three', 'Panel', { title: 'Third' }, { layout: pageLayout, children: [def('t3', 'Probe', { text: 'in three' })] }),
];

describe('meta', () => {
  it('describes the containers without React', () => {
    for (const type of ['Panel', 'Tabs', 'Dialog']) {
      expect(componentMetas[type]?.container).toBe(true);
    }
    expect(componentMetas.Tabs!.bindings).toEqual({ selectedIndex: 'column' });
    expect(componentMetas.Dialog!.bindings).toEqual({ open: 'column' });
  });
});

describe('Panel', () => {
  it('renders a section with a heading and a body holding the children', () => {
    const fake = createFakeForm([def('p', 'Panel', { title: 'Details' }, { children: [def('a', 'Probe', { text: 'x' })] })]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const section = container.querySelector('section.fw-panel') as HTMLElement;
    expect(screen.getByRole('region', { name: 'Details' })).toBe(section);
    expect(section.querySelector('h2.fw-panel__title')?.textContent).toBe('Details');
    expect(section.querySelector('.fw-panel__body [data-testid="a"]')).not.toBeNull();
  });

  it('draws no heading without a title', () => {
    const fake = createFakeForm([def('p', 'Panel')]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(container.querySelector('.fw-panel__title')).toBeNull();
  });
});

describe('Tabs', () => {
  it('labels tabs from the pages and keeps every page mounted, hiding the inactive ones', () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 1 }, { children: pages() })]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    const panels = Array.from(container.querySelectorAll<HTMLElement>('.fw-tabs__panel'));
    expect(panels.map((p) => p.hidden)).toEqual([true, false, true]);
    expect(screen.getByTestId('t1').textContent).toBe('in one');
  });

  it('keeps hidden pages updated', () => {
    const fake = createFakeForm([def('tabs', 'Tabs', {}, { children: pages() })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    act(() => fake.model('t3').setProps({ text: 'fresh' }));
    expect(screen.getByTestId('t3').textContent).toBe('fresh');
    expect(screen.getByTestId('t3').closest('.fw-tabs__panel')!.hasAttribute('hidden')).toBe(true);
  });

  it('follows a changed title and a changed selectedIndex', () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 0 }, { children: pages() })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    act(() => fake.model('two').setProps({ title: 'Renamed' }));
    expect(screen.getByRole('tab', { name: 'Renamed' })).toBeTruthy();
    act(() => fake.model('tabs').setProps({ selectedIndex: 2 }));
    expect(screen.getByRole('tab', { name: 'Third' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('t3').closest('.fw-tabs__panel')!.hasAttribute('hidden')).toBe(false);
  });

  it('writes a bound selection and fires change when a tab is clicked', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 0 }, { bind: { selectedIndex: 'ds.tab' }, children: pages() })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Third' }));
    const tabs = fake.model('tabs');
    expect(tabs.writes).toEqual([{ prop: 'selectedIndex', value: 2 }]);
    expect(tabs.fires).toEqual([{ event: 'change', detail: { selectedIndex: 2 } }]);
    expect(screen.getByRole('tab', { name: 'Third' }).getAttribute('aria-selected')).toBe('true');
  });

  it('goes back to the bound value when the write is refused', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 0 }, { bind: { selectedIndex: 'ds.tab' }, children: pages() })]);
    fake.model('tabs').refuseWrites = true;
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true');
  });

  it('fires no change when the write is refused', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 0 }, { bind: { selectedIndex: 'ds.tab' }, children: pages() })]);
    fake.model('tabs').refuseWrites = true;
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(fake.model('tabs').fires).toEqual([]);
  });

  it('stays on the tab until an async write is accepted, then fires change', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', { selectedIndex: 0 }, { bind: { selectedIndex: 'ds.tab' }, children: pages() })]);
    let answer!: (ok: boolean) => void;
    fake.model('tabs').asyncWrite = new Promise<boolean>((resolve) => (answer = resolve));
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true');
    expect(fake.model('tabs').fires).toEqual([]);
    await act(async () => answer(true));
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    expect(fake.model('tabs').fires).toEqual([{ event: 'change', detail: { selectedIndex: 1 } }]);
  });

  it('switches on its own when selectedIndex is not bound', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', {}, { children: pages() })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
  });

  it('supports arrow, Home and End keys', async () => {
    const fake = createFakeForm([def('tabs', 'Tabs', {}, { children: pages() })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'First' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Second' }));
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Third' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true');
  });

  it('wires tabs to panels with ARIA', () => {
    const fake = createFakeForm([def('tabs', 'Tabs', {}, { children: pages() })]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const tab = screen.getByRole('tab', { name: 'First' });
    const panel = container.querySelector('.fw-tabs__panel') as HTMLElement;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
  });
});

describe('Dialog', () => {
  const dialogForm = (props: Record<string, unknown>, bound = true) =>
    createFakeForm([
      def('opener', 'Field'),
      def('dlg', 'Dialog', props, { ...(bound ? { bind: { open: 'ds.open' } } : {}), children: [def('inner', 'Probe', { text: 'inside' })] }),
    ]);

  it('shows nothing while closed', () => {
    const fake = dialogForm({ open: false, title: 'Confirm' });
    render(<FormView form={fake.form} registry={testRegistry} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('inner')).toBeNull();
  });

  it('opens as a labelled modal with its children', () => {
    const fake = dialogForm({ open: false, title: 'Confirm' });
    render(<FormView form={fake.form} registry={testRegistry} />);
    act(() => fake.model('dlg').setProps({ open: true }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog.classList.contains('fw-dialog')).toBe(true);
    expect(dialog.querySelector('[data-testid="inner"]')?.textContent).toBe('inside');
  });

  it('closes on Esc through write(open, false) and fires close', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' });
    render(<FormView form={fake.form} registry={testRegistry} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    const dlg = fake.model('dlg');
    expect(dlg.writes).toEqual([{ prop: 'open', value: false }]);
    expect(dlg.fires).toEqual([{ event: 'close', detail: undefined }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays open when the write is refused', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' });
    fake.model('dlg').refuseWrites = true;
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes by itself when open is not bound', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' }, false);
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('traps focus inside and returns it to the opener', async () => {
    const fake = createFakeForm([
      def('opener', 'Field'),
      def('dlg', 'Dialog', { open: false, title: 'Confirm' }, { bind: { open: 'ds.open' }, children: [def('f1', 'Field'), def('f2', 'Field')] }),
    ]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    const opener = screen.getByLabelText('opener');
    opener.focus();
    act(() => fake.model('dlg').setProps({ open: true }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const user = userEvent.setup();
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('sizes the dialog from the layout, with the default size as a fallback, and the body fills the rest', () => {
    const fake = createFakeForm([
      def('sized', 'Dialog', { open: true, title: 'A' }, { layout: { left: 0, top: 0, width: 520, height: 260 } }),
      def('plain', 'Dialog', { open: true, title: 'B' }, { layout: {} }),
    ]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    const [sized, plain] = Array.from(document.querySelectorAll<HTMLElement>('.fw-dialog'));
    expect([sized!.style.width, sized!.style.height]).toEqual(['520px', '260px']);
    expect([plain!.style.width, plain!.style.height]).toEqual(['400px', '300px']);
    const body = sized!.querySelector('.fw-dialog__body') as HTMLElement;
    expect(body.style.position).toBe('relative');
    expect(body.style.flex).toContain('1');
  });

  it('keeps a refused close open and fires no close event', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' });
    fake.model('dlg').refuseWrites = true;
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fake.model('dlg').fires).toEqual([]);
  });

  it('waits for an async answer: stays open and mounted, then closes and fires close', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' });
    let answer!: (ok: boolean) => void;
    fake.model('dlg').asyncWrite = new Promise<boolean>((resolve) => (answer = resolve));
    render(<FormView form={fake.form} registry={testRegistry} />);
    const inner = screen.getByTestId('inner');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('inner')).toBe(inner);
    expect(fake.model('dlg').fires).toEqual([]);
    await act(async () => answer(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.model('dlg').fires).toEqual([{ event: 'close', detail: undefined }]);
  });

  it('keeps the same children when an async refusal arrives', async () => {
    const fake = dialogForm({ open: true, title: 'Confirm' });
    let answer!: (ok: boolean) => void;
    fake.model('dlg').asyncWrite = new Promise<boolean>((resolve) => (answer = resolve));
    render(<FormView form={fake.form} registry={testRegistry} />);
    const inner = screen.getByTestId('inner');
    await userEvent.keyboard('{Escape}');
    await act(async () => answer(false));
    expect(screen.getByTestId('inner')).toBe(inner);
    expect(fake.model('dlg').fires).toEqual([]);
  });

  it('takes no space and catches no clicks in run mode, open or closed', () => {
    const fake = dialogForm({ open: false, title: 'Confirm' });
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const host = () => container.querySelector('[data-id="dlg"]') as HTMLElement;
    const check = () => {
      expect(host().style.pointerEvents).toBe('none');
      expect([host().style.width, host().style.height]).toEqual(['0px', '0px']);
    };
    check();
    act(() => fake.model('dlg').setProps({ open: true }));
    check();
  });

  it('keeps its box in design mode', () => {
    const fake = createFakeForm([def('dlg', 'Dialog', { open: true }, { layout: { left: 10, top: 20, width: 300, height: 200 } })], { mode: 'design' });
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const host = container.querySelector('[data-id="dlg"]') as HTMLElement;
    expect([host.style.left, host.style.width, host.style.pointerEvents]).toEqual(['10px', '300px', '']);
  });

  it('draws an open dialog in place, not modal, in design mode', () => {
    const fake = createFakeForm([def('dlg', 'Dialog', { open: true, title: 'Confirm' }, { children: [def('inner', 'Probe', { text: 'inside' })] })], {
      mode: 'design',
    });
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(container.querySelector('.fw-host section.fw-dialog [data-testid="inner"]')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
