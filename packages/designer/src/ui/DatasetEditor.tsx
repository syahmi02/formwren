import { COLUMN_TYPES, type ColumnDefinition, type ColumnType, type ComponentMeta, type DatasetDefinition, type FormDefinition } from '@fw/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Command } from '../model/index.ts';
import { CommitText } from './fields.tsx';
import * as ops from './ops.ts';

export interface DatasetEditorProps {
  definition: FormDefinition | null;
  editable: boolean;
  metas: Readonly<Record<string, ComponentMeta>>;
  run(command: Command): void;
}

const numberOrUndefined = (text: string): number | undefined | 'bad' => {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'bad';
};

/** Turns the text of a sample cell into a value of the column's type. Empty text leaves the key out. */
function cellValue(column: ColumnDefinition, text: string): { value: unknown } | { error: string } | { omit: true } {
  const t = text.trim();
  if (t === '') return { omit: true };
  switch (column.type) {
    case 'int': {
      const n = Number(t);
      return Number.isSafeInteger(n) ? { value: n } : { error: `"${column.id}" takes a whole number.` };
    }
    case 'float': {
      const n = Number(t);
      return Number.isFinite(n) ? { value: n } : { error: `"${column.id}" takes a number.` };
    }
    case 'boolean':
      return t === 'true' || t === 'false' ? { value: t === 'true' } : { error: `"${column.id}" takes true or false.` };
    default:
      return { value: text };
  }
}

const showCell = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/** The form's Datasets: their columns with typed fields, and a small grid of sample rows. */
export function DatasetEditor({ definition, editable, metas, run }: DatasetEditorProps): ReactElement {
  const datasets = definition?.datasets ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A renamed Dataset is the one at the same place, so follow the place when the id is gone. A removed
  // one leaves its neighbour, which is the next best thing to show.
  const lastIndex = useRef(0);
  const current: DatasetDefinition | undefined = datasets.find((d) => d.id === pick) ?? datasets[Math.min(lastIndex.current, datasets.length - 1)];
  useEffect(() => {
    if (!current) return;
    lastIndex.current = datasets.indexOf(current);
    if (current.id !== pick) setPick(current.id);
  });

  const disabled = !editable;
  return (
    <div className="dz-datasets" role="region" aria-label="Datasets">
      <div className="dz-datasets__bar">
        <label className="dz-field__label" htmlFor="dz-dataset-pick">
          Dataset
        </label>
        <select id="dz-dataset-pick" className="dz-input" value={current?.id ?? ''} onChange={(event) => setPick(event.target.value)} disabled={datasets.length === 0}>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id}
            </option>
          ))}
        </select>
        <button type="button" className="dz-btn" disabled={disabled} onClick={() => run(ops.addDataset())}>
          Add Dataset
        </button>
        <button type="button" className="dz-btn" disabled={disabled || !current} onClick={() => current && run(ops.removeDataset(metas, current.id))}>
          Delete
        </button>
      </div>
      {problem ? (
        <p className="dz-field__error" role="alert">
          {problem}
        </p>
      ) : null}
      {!current ? <p className="dz-empty">The form has no Datasets yet.</p> : <One dataset={current} metas={metas} disabled={disabled} run={run} setProblem={setProblem} />}
    </div>
  );
}

function One({ dataset, metas, disabled, run, setProblem }: { dataset: DatasetDefinition; metas: Readonly<Record<string, ComponentMeta>>; disabled: boolean; run(command: Command): void; setProblem(message: string | null): void }): ReactElement {
  const id = dataset.id;
  const rows = dataset.sampleRows ?? [];
  return (
    <>
      <section className="dz-section" aria-label="Dataset settings">
        <div className="dz-field">
          <label className="dz-field__label" htmlFor="dz-ds-id">
            id
          </label>
          <div className="dz-field__control">
            <CommitText id="dz-ds-id" value={id} disabled={disabled} onCommit={(text) => void run(ops.renameDataset(metas, id, text.trim()))} />
          </div>
        </div>
        <div className="dz-field">
          <label className="dz-field__label" htmlFor="dz-ds-keys">
            keys
          </label>
          <div className="dz-field__control">
            <CommitText
              id="dz-ds-keys"
              value={(dataset.keys ?? []).join(', ')}
              disabled={disabled}
              placeholder="column, column"
              onCommit={(text) => void run(ops.setDatasetOptions(id, { keys: text.split(',').map((k) => k.trim()).filter(Boolean) }))}
            />
          </div>
          <small className="dz-field__help">The columns that identify a row.</small>
        </div>
        <div className="dz-field">
          <label className="dz-field__label" htmlFor="dz-ds-confirm">
            confirmUnsaved
          </label>
          <div className="dz-field__control">
            <input id="dz-ds-confirm" type="checkbox" className="dz-check" checked={dataset.confirmUnsaved === true} disabled={disabled} onChange={(event) => run(ops.setDatasetOptions(id, { confirmUnsaved: event.target.checked }))} />
          </div>
          <small className="dz-field__help">Ask before the form closes with unsaved changes.</small>
        </div>
      </section>

      <section className="dz-section" aria-label="Columns">
        <h3>Columns</h3>
        <div className="dz-tablewrap">
          <table className="dz-table">
            <thead>
              <tr>
                {['id', 'type', 'label', 'size', 'precision', 'scale', 'required', ''].map((h, i) => (
                  <th key={i} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataset.columns.map((column, index) => (
                <ColumnRow key={index} dataset={id} metas={metas} column={column} index={index} count={dataset.columns.length} disabled={disabled} run={run} setProblem={setProblem} />
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="dz-btn" disabled={disabled} onClick={() => run(ops.addColumn(id))}>
          Add column
        </button>
      </section>

      <section className="dz-section" aria-label="Sample rows">
        <h3>Sample rows</h3>
        <p className="dz-note">Shown in the designer in place of the initial rows. The preview and the running form use the initial rows, and the data that service calls bring.</p>
        {rows.length > 0 ? (
          <div className="dz-tablewrap">
            <table className="dz-table">
              <thead>
                <tr>
                  {dataset.columns.map((c) => (
                    <th key={c.id} scope="col">
                      {c.id}
                    </th>
                  ))}
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {dataset.columns.map((c) => (
                      <td key={c.id}>
                        <CommitText
                          id={`dz-sample-${r}-${c.id}`}
                          label={`Row ${r + 1}, ${c.id}`}
                          value={showCell(row[c.id])}
                          disabled={disabled}
                          onCommit={(text) => {
                            const parsed = cellValue(c, text);
                            if ('error' in parsed) {
                              setProblem(parsed.error);
                              return parsed.error;
                            }
                            setProblem(null);
                            run(ops.setSampleCell(id, r, c.id, 'omit' in parsed ? undefined : parsed.value));
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      <button type="button" className="dz-iconbtn" disabled={disabled} aria-label={`Remove sample row ${r + 1}`} onClick={() => run(ops.removeSampleRow(id, r))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <button type="button" className="dz-btn" disabled={disabled} onClick={() => run(ops.addSampleRow(id))}>
          Add sample row
        </button>
      </section>
    </>
  );
}

function ColumnRow({ dataset, metas, column, index, count, disabled, run, setProblem }: { dataset: string; metas: Readonly<Record<string, ComponentMeta>>; column: ColumnDefinition; index: number; count: number; disabled: boolean; run(command: Command): void; setProblem(message: string | null): void }): ReactElement {
  const name = column.id;
  const number = (prop: 'size' | 'precision' | 'scale', relevant: boolean): ReactElement =>
    relevant ? (
      <CommitText
        id={`dz-col-${name}-${prop}`}
        label={`${name} ${prop}`}
        value={column[prop] === undefined ? '' : String(column[prop])}
        disabled={disabled}
        onCommit={(text) => {
          const n = numberOrUndefined(text);
          if (n === 'bad') return 'Enter a number.';
          setProblem(null);
          run(ops.setColumn(dataset, name, { [prop]: n }));
        }}
      />
    ) : (
      <span aria-hidden="true">–</span>
    );
  return (
    <tr>
      <td>
        <CommitText id={`dz-col-${name}-id`} label={`${name} id`} value={name} disabled={disabled} onCommit={(text) => void run(ops.renameColumn(metas, dataset, name, text.trim()))} />
      </td>
      <td>
        <select className="dz-input" aria-label={`${name} type`} value={column.type} disabled={disabled} onChange={(event) => run(ops.setColumn(dataset, name, { type: event.target.value as ColumnType }))}>
          {COLUMN_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td>
        <CommitText id={`dz-col-${name}-label`} label={`${name} label`} value={column.label ?? ''} disabled={disabled} onCommit={(text) => void run(ops.setColumn(dataset, name, { label: text === '' ? undefined : text }))} />
      </td>
      <td>{number('size', column.type === 'string')}</td>
      <td>{number('precision', column.type === 'decimal')}</td>
      <td>{number('scale', column.type === 'decimal')}</td>
      <td>
        <input type="checkbox" className="dz-check" aria-label={`${name} required`} checked={column.required === true} disabled={disabled} onChange={(event) => run(ops.setColumn(dataset, name, { required: event.target.checked }))} />
      </td>
      <td className="dz-table__actions">
        <button type="button" className="dz-iconbtn" aria-label={`Move column ${name} up`} disabled={disabled || index === 0} onClick={() => run(ops.moveColumn(dataset, name, -1))}>
          ↑
        </button>
        <button type="button" className="dz-iconbtn" aria-label={`Move column ${name} down`} disabled={disabled || index === count - 1} onClick={() => run(ops.moveColumn(dataset, name, 1))}>
          ↓
        </button>
        <button type="button" className="dz-iconbtn" aria-label={`Delete column ${name}`} disabled={disabled} onClick={() => run(ops.removeColumn(metas, dataset, name))}>
          ×
        </button>
      </td>
    </tr>
  );
}
