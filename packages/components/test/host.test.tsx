// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormView } from '../src/host/index.tsx';
import { createFakeForm, def } from './support/fake-form.ts';
import { renderCounts, testRegistry } from './support/test-components.tsx';

afterEach(cleanup);
beforeEach(() => renderCounts.clear());

describe('FormView', () => {
  it('renders the component tree inside div.fw-form sized from the definition', () => {
    const fake = createFakeForm(
      [
        def('a', 'Probe', { text: 'alpha' }),
        def('p', 'Panel', { title: 'Group' }, { children: [def('b', 'Probe', { text: 'beta' })] }),
      ],
      { size: { width: 640, height: 480 } },
    );
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const root = container.querySelector('div.fw-form') as HTMLElement;
    expect(root.style.width).toBe('640px');
    expect(root.style.height).toBe('480px');
    expect(screen.getByTestId('a').textContent).toBe('alpha');
    expect(root.querySelector('section.fw-panel .fw-panel__body .fw-host [data-testid="b"]')?.textContent).toBe('beta');
  });

  it('positions each host absolutely from its layout edges, as numbers', () => {
    const fake = createFakeForm([
      def('a', 'Probe', {}, { layout: { left: 10, top: 20, width: 100, height: 30 } }),
      def('b', 'Probe', {}, { layout: { left: 5, right: 7, bottom: 9, height: 12 } }),
    ]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const [a, b] = Array.from(container.querySelectorAll<HTMLElement>('.fw-host'));
    expect(a!.style.position).toBe('absolute');
    expect([a!.style.left, a!.style.top, a!.style.width, a!.style.height]).toEqual(['10px', '20px', '100px', '30px']);
    expect(a!.style.right).toBe('');
    expect([b!.style.left, b!.style.right, b!.style.bottom, b!.style.height]).toEqual(['5px', '7px', '9px', '12px']);
    expect(b!.style.top).toBe('');
    expect(b!.style.width).toBe('');
  });

  it('passes plain props, the id and design=false to the component', () => {
    const fake = createFakeForm([def('a', 'Probe', { text: 'x' })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    expect(screen.getByTestId('a').dataset.design).toBe('false');
  });

  it('shows prop updates in the DOM', () => {
    const fake = createFakeForm([def('a', 'Probe', { text: 'one' })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    act(() => fake.model('a').setProps({ text: 'two' }));
    expect(screen.getByTestId('a').textContent).toBe('two');
  });

  it('shows layout changes and remounts only on a type change', () => {
    const fake = createFakeForm([def('a', 'Probe', { text: 'x' }), def('b', 'Probe', { text: 'y' })]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const before = screen.getByTestId('a');
    act(() => fake.model('a').patchDefinition({ layout: { left: 50, top: 0, width: 10, height: 10 } }));
    expect(screen.getByTestId('a')).toBe(before);
    expect((container.querySelector('[data-id="a"]') as HTMLElement).style.left).toBe('50px');

    act(() => fake.model('a').patchDefinition({ type: 'Field' }));
    expect(screen.queryByTestId('a')).toBeNull();
    expect(screen.getByLabelText('a')).toBeTruthy();
    expect(renderCounts.get('b')).toBe(1);
  });

  it('re-renders only the host whose props changed', () => {
    const defs = Array.from({ length: 300 }, (_, i) => def(`c${i}`, 'Probe', { text: String(i) }));
    const fake = createFakeForm(defs);
    render(<FormView form={fake.form} registry={testRegistry} />);
    expect(renderCounts.size).toBe(300);
    renderCounts.clear();
    act(() => fake.model('c42').setProps({ text: 'changed' }));
    expect([...renderCounts.entries()]).toEqual([['c42', 1]]);
    renderCounts.clear();
    // Setting the same value keeps the same snapshot, so nothing renders.
    act(() => fake.model('c42').setProps({ text: 'changed' }));
    expect(renderCounts.size).toBe(0);
  });

  it('does not re-render children when a container re-renders, nor the container when a child changes', () => {
    const fake = createFakeForm([def('p', 'Panel', { title: 'T' }, { children: [def('k', 'Probe', { text: 'x' })] })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    renderCounts.clear();
    act(() => fake.model('p').setProps({ title: 'U' }));
    expect(screen.getByRole('heading').textContent).toBe('U');
    expect(renderCounts.size).toBe(0);
    act(() => fake.model('k').setProps({ text: 'y' }));
    expect(renderCounts.get('k')).toBe(1);
  });

  it('sets the handle after commit, clears it on unmount, and runs queued focus', () => {
    const fake = createFakeForm([def('f', 'Field')]);
    // Called before React has committed, so it is queued.
    fake.model('f').focus();
    expect(fake.model('f').handle).toBeNull();
    const view = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(fake.model('f').handle).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('f'));
    view.unmount();
    expect(fake.model('f').handle).toBeNull();
  });

  it('routes write and fire to the model', async () => {
    const fake = createFakeForm([def('p', 'Pusher', {}, { bind: { value: 'ds.col' } })]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('button'));
    expect(fake.model('p').writes).toEqual([{ prop: 'value', value: 'v' }]);
    expect(fake.model('p').fires).toEqual([{ event: 'push', detail: { a: 1 } }]);
    expect(fake.model('p').props.peek().value).toBe('v');
  });

  it('passes rowId through to the model', async () => {
    const fake = createFakeForm([def('p', 'RowPusher')]);
    render(<FormView form={fake.form} registry={testRegistry} />);
    await userEvent.click(screen.getByRole('button'));
    expect(fake.model('p').writes).toEqual([{ prop: 'value', value: 'r', rowId: 7 }]);
  });

  it('honours z in the host style', () => {
    const fake = createFakeForm([def('a', 'Probe', {}, { z: 5 }), def('b', 'Probe')]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect((container.querySelector('[data-id="a"]') as HTMLElement).style.zIndex).toBe('5');
    expect((container.querySelector('[data-id="b"]') as HTMLElement).style.zIndex).toBe('');
    act(() => fake.model('b').patchDefinition({ z: 2 }));
    expect((container.querySelector('[data-id="b"]') as HTMLElement).style.zIndex).toBe('2');
  });

  it('contains a failing component and reports it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeForm([def('ok', 'Probe', { text: 'fine' }), def('bad', 'Boom', { message: 'it broke' })]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(screen.getByTestId('ok').textContent).toBe('fine');
    const box = container.querySelector('.fw-host__error') as HTMLElement;
    expect(box.textContent).toBe('it broke');
    expect(fake.errors).toHaveLength(1);
    expect(fake.errors[0]!.where).toBe('component bad');
    expect((fake.errors[0]!.error as Error).message).toBe('it broke');
    spy.mockRestore();
  });

  it('draws a labelled placeholder for unknown types and keeps the rest running', () => {
    const fake = createFakeForm([def('g', 'Grid'), def('a', 'Probe', { text: 'still here' }), def('t', 'toString')]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    const boxes = Array.from(container.querySelectorAll('.fw-host__placeholder'));
    expect(boxes.map((b) => b.textContent)).toEqual(['Grid', 'toString']);
    expect(screen.getAllByRole('note').map((n) => n.textContent)).toEqual(['Grid', 'toString']);
    expect(screen.getByTestId('a').textContent).toBe('still here');
  });

  it('adds inert and design=true in design mode', () => {
    const fake = createFakeForm([def('a', 'Probe')], { mode: 'design' });
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(container.querySelector('.fw-host')!.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('a').dataset.design).toBe('true');
  });

  it('has no inert in run mode', () => {
    const fake = createFakeForm([def('a', 'Probe')]);
    const { container } = render(<FormView form={fake.form} registry={testRegistry} />);
    expect(container.querySelector('.fw-host')!.hasAttribute('inert')).toBe(false);
  });
});
