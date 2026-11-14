import type { ComponentDefinition, FormDefinition, GridProps } from '@fw/core';
import { useState, type ReactElement } from 'react';
import type { Command } from '../model/index.ts';
import { CommitText } from './fields.tsx';
import * as ops from './ops.ts';

export interface GridEditorProps {
  component: ComponentDefinition;
  definition: FormDefinition | null;
  editable: boolean;
  run(command: Command): void;
  openTextEditor?: (() => void) | undefined;
}

const EDITORS = ['text', 'number', 'dropdown', 'date', 'checkbox'] as const;

/** The columns of the selected Grid: width, header, field, format and editor, and adding, removing and moving. */
export function GridEditor({ component, definition, editable, run, openTextEditor }: GridEditorProps): ReactElement {
  const gridId = component.id;
  const props = component.props as Partial<GridProps> | undefined;
  const columns = ops.gridColumns(props);
  const merged = ops.gridHasMergedCells(props);
  const [problem, setProblem] = useState<string | null>(null);
  const bound = component.bind?.dataset;
  const fields = definition?.datasets?.find((d) => d.id === bound)?.columns.map((c) => c.id) ?? [];
  const disabled = !editable;

  return (
    <section className="dz-section dz-grideditor" aria-label="Grid columns">
      <h3>Grid columns</h3>
      {!bound ? <p className="dz-note">Bind the Grid to a Dataset to pick fields from its columns.</p> : null}
      {problem ? (
        <p className="dz-field__error" role="alert">
          {problem}
        </p>
      ) : null}
      <ol className="dz-gridcols">
        {columns.map((column) => {
          const builtIn = column.kind !== '';
          const label = (what: string): string => `Column ${column.index + 1} ${what}`;
          const numberCommit = (text: string): string | void => {
            const n = Number(text.trim());
            if (text.trim() === '' || !Number.isFinite(n)) {
              // The field keeps what was typed, so the reason is said beside the list.
              setProblem('Enter a width in pixels.');
              return 'Enter a width in pixels.';
            }
            setProblem(null);
            run(ops.setGridColumn(gridId, column.id, { width: n }));
          };
          return (
            <li key={column.index} className="dz-gridcol" aria-label={`Column ${column.index + 1}, ${column.id}`}>
              <div className="dz-gridcol__head">
                <strong>{column.index + 1}</strong>
                <span className="dz-gridcol__id">{builtIn ? `built-in: ${column.kind}` : column.id}</span>
                <span className="dz-gridcol__actions">
                  <button type="button" className="dz-iconbtn" aria-label={label('move left')} disabled={disabled || column.index === 0} onClick={() => run(ops.moveGridColumn(gridId, column.id, 'left'))}>
                    ←
                  </button>
                  <button type="button" className="dz-iconbtn" aria-label={label('move right')} disabled={disabled || column.index === columns.length - 1} onClick={() => run(ops.moveGridColumn(gridId, column.id, 'right'))}>
                    →
                  </button>
                  <button type="button" className="dz-iconbtn" aria-label={label('remove')} disabled={disabled || columns.length <= 1} onClick={() => run(ops.removeGridColumn(gridId, column.id))}>
                    ×
                  </button>
                </span>
              </div>
              <div className="dz-gridcol__fields">
                <label>
                  width
                  <CommitText id={`dz-gc-${column.index}-width`} label={label('width')} value={String(column.width)} disabled={disabled} onCommit={numberCommit} />
                </label>
                <label>
                  header
                  <CommitText id={`dz-gc-${column.index}-header`} label={label('header')} value={column.header} disabled={disabled} onCommit={(text) => void run(ops.setGridHeader(gridId, column.id, text))} />
                </label>
                <label>
                  field
                  <select className="dz-input" aria-label={label('field')} value={column.field} disabled={disabled || builtIn} onChange={(event) => run(ops.setGridColumn(gridId, column.id, { field: event.target.value === '' ? undefined : event.target.value }))}>
                    <option value="">(none)</option>
                    {[...new Set([...fields, ...(column.field && !fields.includes(column.field) ? [column.field] : [])])].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  format
                  <CommitText id={`dz-gc-${column.index}-format`} label={label('format')} value={column.format} disabled={disabled || builtIn} placeholder="#,##0.00" onCommit={(text) => void run(ops.setGridColumn(gridId, column.id, { format: text === '' ? undefined : text }))} />
                </label>
                <label>
                  editor
                  <select className="dz-input" aria-label={label('editor')} value={column.editor} disabled={disabled || builtIn} onChange={(event) => run(ops.setGridColumn(gridId, column.id, { editor: event.target.value === '' ? undefined : (event.target.value as (typeof EDITORS)[number]) }))}>
                    <option value="">(read-only)</option>
                    {EDITORS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" className="dz-btn" disabled={disabled} onClick={() => run(ops.addGridColumn(gridId))}>
        Add column
      </button>
      <p className="dz-note" data-testid="grid-merged-note">
        {merged ? 'This Grid has merged cells. ' : ''}Merged headers and cells are edited in the text editor only (JSON), and a column next to a merged cell can be refused.
      </p>
      {openTextEditor ? (
        <button type="button" className="dz-btn" onClick={openTextEditor}>
          Open text editor
        </button>
      ) : null}
    </section>
  );
}
