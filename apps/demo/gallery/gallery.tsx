import '@fw/components/theme.css';
import { FormView, defaultRegistry, type HostProps } from '@fw/components';
import { createForm, type FormDefinition } from '@fw/core';
import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/** The types FR-030 asks for. Any that the registry lacks are listed, not rendered. */
const EXPECTED = [
  'Label',
  'Button',
  'TextInput',
  'NumberInput',
  'TextArea',
  'Checkbox',
  'RadioGroup',
  'ComboBox',
  'DatePicker',
  'Panel',
  'Tabs',
  'Dialog',
];

const LONG_TEXT = 'A very long value that does not fit in the box: 12345678901234567890.123456789 and then some more words';
const OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
];

type Props = Record<string, unknown>;

interface Sample {
  type: string;
  title?: string;
  width: number;
  height: number;
  base: Props;
  long: Props;
}

const SAMPLES: Sample[] = [
  { type: 'Label', width: 160, height: 24, base: { text: 'Customer name' }, long: { text: LONG_TEXT } },
  { type: 'Button', title: 'Button', width: 100, height: 28, base: { text: 'Save' }, long: { text: LONG_TEXT } },
  {
    type: 'Button',
    title: 'Button (primary)',
    width: 100,
    height: 28,
    base: { text: 'Save', variant: 'primary' },
    long: { text: LONG_TEXT, variant: 'primary' },
  },
  { type: 'TextInput', width: 180, height: 28, base: { value: 'Acme Corp' }, long: { value: LONG_TEXT } },
  {
    type: 'TextInput',
    title: 'TextInput (label)',
    width: 180,
    height: 46,
    base: { label: 'Name', placeholder: 'Enter a name' },
    long: { label: 'Name', value: LONG_TEXT },
  },
  { type: 'NumberInput', width: 140, height: 28, base: { value: '1234.50' }, long: { value: '12345678901234567890.123456789' } },
  { type: 'TextArea', width: 180, height: 64, base: { value: 'Line one\nLine two' }, long: { value: LONG_TEXT.repeat(2) } },
  { type: 'Checkbox', width: 140, height: 24, base: { label: 'Active', value: true }, long: { label: LONG_TEXT, value: true } },
  {
    type: 'Checkbox',
    title: 'Checkbox (unchecked)',
    width: 140,
    height: 24,
    base: { label: 'Active', value: false },
    long: { label: LONG_TEXT, value: false },
  },
  {
    type: 'RadioGroup',
    width: 160,
    height: 76,
    base: { label: 'Status', value: 'open', options: OPTIONS },
    long: { label: 'Status', value: 'open', options: [{ value: 'a', label: LONG_TEXT }, ...OPTIONS] },
  },
  {
    type: 'ComboBox',
    width: 180,
    height: 28,
    base: { value: 'open', options: OPTIONS, placeholder: 'Choose' },
    long: { value: 'x', options: [{ value: 'x', label: LONG_TEXT }] },
  },
  { type: 'DatePicker', width: 160, height: 28, base: { value: '2026-03-05' }, long: { value: '2026-12-31' } },
  { type: 'Panel', width: 180, height: 64, base: { title: 'Details' }, long: { title: LONG_TEXT } },
];

const STATES = ['normal', 'focused', 'disabled', 'read-only', 'invalid', 'long value'] as const;
type State = (typeof STATES)[number];

function propsFor(sample: Sample, state: State): Props {
  switch (state) {
    case 'disabled':
      return { ...sample.base, disabled: true };
    case 'read-only':
      return { ...sample.base, readOnly: true };
    case 'invalid':
      return { ...sample.base, errorMessage: 'This value is not valid' };
    case 'long value':
      return sample.long;
    default:
      return sample.base;
  }
}

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.error === null ? this.props.children : <div className="fw-host__error">{this.state.error}</div>;
  }
}

/** Real focus can sit in one place only, so the "focused" column sets React Aria's focus attributes by hand. */
function forceFocusLook(root: HTMLElement): void {
  const target = root.querySelector<HTMLElement>(
    '[class*="__input"], button.fw-button, label.fw-checkbox, .fw-radiogroup__option, .fw-tabs__tab',
  );
  if (!target) return;
  target.setAttribute('data-focused', 'true');
  target.setAttribute('data-focus-visible', 'true');
  target.setAttribute('data-focus-within', 'true');
}

function Cell({ sample, state }: { sample: Sample; state: State }) {
  const ref = useRef<HTMLDivElement>(null);
  const registration = Object.hasOwn(defaultRegistry, sample.type) ? defaultRegistry[sample.type] : undefined;
  useEffect(() => {
    if (state === 'focused' && ref.current) forceFocusLook(ref.current);
  });
  if (!registration) return null;
  const Render = registration.render;
  const host: HostProps<Props> = {
    id: `${sample.type}-${state}`,
    props: propsFor(sample, state),
    write: () => true,
    accepts: () => true,
    fire: () => {},
    handleRef: () => {},
    design: false,
  };
  const boxStyle: CSSProperties = { position: 'absolute', left: 0, top: 0, width: sample.width, height: sample.height };
  return (
    <div ref={ref} className="fw-form" style={{ width: sample.width, height: sample.height + 16, background: 'transparent' }}>
      <div className="fw-host" style={boxStyle}>
        <Boundary>
          <Render {...(host as HostProps<never>)} />
        </Boundary>
      </div>
    </div>
  );
}

function Matrix({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <section data-fw-theme={theme} className="g-section">
      <h2>{theme === 'light' ? 'Light' : 'Dark'}</h2>
      <table className="g-table">
        <thead>
          <tr>
            <th>Component</th>
            {STATES.map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SAMPLES.filter((s) => Object.hasOwn(defaultRegistry, s.type)).map((sample, i) => (
            <tr key={i}>
              <th scope="row">{sample.title ?? sample.type}</th>
              {STATES.map((state) => (
                <td key={state}>
                  <Cell sample={sample} state={state} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}


function containerDefinition(open: boolean): FormDefinition {
  const page = (id: string, title: string, text: string): FormDefinition['components'][number] => ({
    id,
    type: 'Panel',
    layout: { left: 0, top: 0, right: 0, bottom: 0 },
    props: { title },
    children: [
      { id: `${id}L`, type: 'Label', layout: { left: 8, top: 14, width: 200, height: 24 }, props: { text } },
      { id: `${id}T`, type: 'TextInput', layout: { left: 8, top: 44, width: 200, height: 28 }, props: { value: 'Editable' } },
    ],
  });
  return {
    formatVersion: 1,
    id: 'gallery.Containers',
    size: { width: 420, height: 260 },
    components: [
      {
        id: 'tabs',
        type: 'Tabs',
        layout: { left: 0, top: 0, width: 300, height: 140 },
        children: [page('p1', 'General', 'First page'), page('p2', 'Address', 'Second page'), page('p3', 'Notes', 'Third page')],
      },
      {
        id: 'dlg',
        type: 'Dialog',
        layout: { left: 0, top: 150, width: 300, height: 100 },
        props: { open, title: 'Confirm delete' },
        children: [
          { id: 'dl', type: 'Label', layout: { left: 12, top: 12, width: 260, height: 24 }, props: { text: 'Delete this employee?' } },
          { id: 'db', type: 'Button', layout: { right: 12, bottom: 8, width: 88, height: 28 }, props: { text: 'Delete', variant: 'primary' } },
        ],
      },
    ],
  };
}

/** Real forms, so Tabs, Panel and Dialog have a host model. The Dialog is drawn in place by design mode. */
function Containers({ theme }: { theme: 'light' | 'dark' }) {
  const [form] = useState(() => createForm(containerDefinition(true), { mode: 'design' }));
  return (
    <section data-fw-theme={theme} className="g-section">
      <h2>{theme === 'light' ? 'Light' : 'Dark'}: Tabs, Panel and Dialog (design mode, drawn in place)</h2>
      <FormView form={form} registry={defaultRegistry} />
    </section>
  );
}

function ModalDemo() {
  const [form, setForm] = useState<ReturnType<typeof createForm> | null>(null);
  return (
    <>
      <button onClick={() => setForm(createForm(containerDefinition(true), {}))}>Open the real modal Dialog (Esc closes)</button>
      {form ? <FormView form={form} registry={defaultRegistry} /> : null}
    </>
  );
}

const PAGE_CSS = `
  body { margin: 0; font-family: var(--fw-font-family); font-size: var(--fw-font-size); background: var(--fw-color-canvas); color: var(--fw-color-text); }
  .g-page { padding: 16px; }
  .g-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .g-section { padding: 12px; margin-bottom: 16px; background: var(--fw-color-canvas); color: var(--fw-color-text); border: 1px solid var(--fw-color-border); border-radius: 6px; }
  .g-section h2 { margin: 0 0 8px; font-size: 15px; }
  .g-table { border-collapse: collapse; }
  .g-table th, .g-table td { padding: 6px 12px 6px 0; text-align: left; vertical-align: top; }
  .g-table thead th { color: var(--fw-color-text-muted); font-weight: 600; font-size: 12px; }
  .g-table tbody th { font-weight: 600; white-space: nowrap; padding-right: 16px; }
  .g-missing { color: var(--fw-color-danger); }
`;

function App() {
  const missing = EXPECTED.filter((t) => !Object.hasOwn(defaultRegistry, t));
  const [pageTheme, setPageTheme] = useState<'system' | 'light' | 'dark'>('system');
  useEffect(() => {
    // Popups render under <body>, so their theme is set on <html>.
    const el = document.documentElement;
    if (pageTheme === 'system') el.removeAttribute('data-fw-theme');
    else el.setAttribute('data-fw-theme', pageTheme);
  }, [pageTheme]);
  return (
    <div className="g-page">
      <style>{PAGE_CSS}</style>
      <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>Component gallery</h1>
      <div className="g-bar">
        <span>Page theme (also themes popups):</span>
        {(['system', 'light', 'dark'] as const).map((t) => (
          <label key={t}>
            <input type="radio" name="theme" checked={pageTheme === t} onChange={() => setPageTheme(t)} /> {t}
          </label>
        ))}
      </div>
      <p className={missing.length ? 'g-missing' : undefined}>
        {missing.length ? `Not in the registry yet: ${missing.join(', ')}` : 'All expected component types are registered.'}
      </p>
      <p style={{ color: 'var(--fw-color-text-muted)' }}>
        The focused column forces React Aria focus attributes. Tabs, Panel and Dialog are real forms at the bottom. Open a ComboBox or
        DatePicker to see the portalled popups.
      </p>
      <ModalDemo />
      <Matrix theme="light" />
      <Matrix theme="dark" />
      <Containers theme="light" />
      <Containers theme="dark" />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
