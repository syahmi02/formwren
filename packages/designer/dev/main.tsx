import { componentMetas } from '@fw/components/meta';
import type { FormModule } from '@fw/core';
import '@fw/components/theme.css';
import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Designer } from '../src/ui/index.ts';
import { MemoryHost } from './memory-host.ts';

// The demo's forms, as text. `?form=EmployeeList` picks one. `?readOnly=1` opens it read-only.
const forms = import.meta.glob('../../../apps/demo/src/forms/*.form.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const byName = new Map(Object.entries(forms).map(([path, text]) => [path.split('/').pop()?.replace('.form.json', '') ?? path, text]));

const fixtureTexts = import.meta.glob('../../../apps/demo/src/forms/*.fixtures.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// The demo's form scripts, so the preview can run the real handlers.
const scripts = import.meta.glob('../../../apps/demo/src/forms/*.form.ts') as Record<string, () => Promise<{ default: FormModule }>>;
const find = <T,>(source: Record<string, T>, name: string, suffix: string): T | undefined => Object.entries(source).find(([path]) => path.endsWith(`/${name}${suffix}`))?.[1];

const params = new URLSearchParams(window.location.search);
const name = params.get('form') ?? 'EmployeeEdit';
const host = new MemoryHost({ fileName: `${name}.form.json`, text: byName.get(name) ?? '', readOnly: params.has('readOnly'), fixtures: find(fixtureTexts, name, '.fixtures.json') ?? null });
const loadScript = async (): Promise<FormModule | null> => (await find(scripts, name, '.form.ts')?.())?.default ?? null;

// For browser tests and for trying things from the console.
(window as unknown as { __host: MemoryHost }).__host = host;

function Shell(): ReactElement {
  const text = useSyncExternalStore(host.onDidChangeText, host.readText);
  const [showText, setShowText] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="dev-bar" role="toolbar" aria-label="Development host" style={{ display: 'flex', gap: 8, padding: '4px 12px', font: '12px system-ui', background: 'var(--fw-color-surface-hover)', color: 'var(--fw-color-text)' }}>
        <strong>Development host</strong>
        <button type="button" disabled={!host.canUndo} onClick={() => host.undo()}>
          Undo{host.undoLabel ? ` ${host.undoLabel}` : ''}
        </button>
        <button type="button" disabled={!host.canRedo} onClick={() => host.redo()}>
          Redo
        </button>
        <label>
          <input type="checkbox" checked={showText} onChange={(event) => setShowText(event.target.checked)} /> Show text
        </label>
        <span>
          Forms: {[...byName.keys()].map((n) => (
            <a key={n} href={`?form=${n}`} style={{ marginRight: 6 }}>
              {n}
            </a>
          ))}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Designer host={host} metas={componentMetas} loadScript={loadScript} />
        </div>
        {showText ? <textarea aria-label="Form text" value={text} onChange={(event) => host.setText(event.target.value)} style={{ width: 420, font: '12px ui-monospace, monospace' }} spellCheck={false} /> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Shell />);
