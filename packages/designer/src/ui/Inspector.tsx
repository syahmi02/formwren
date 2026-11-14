import type { ComponentDefinition, ComponentMeta, FormDefinition, PropMeta } from '@fw/core';
import type { Diagnostic } from '@fw/format';
import { useState, type ReactElement } from 'react';
import { commands, type BindingChoice, type Command } from '../model/index.ts';
import { CommitText, Field } from './fields.tsx';
import { GridEditor } from './GridEditor.tsx';

export interface InspectorProps {
  component: ComponentDefinition | null;
  meta: ComponentMeta | undefined;
  /** Every id in the form, so a new id can be checked. */
  allIds: readonly string[];
  diagnostics: readonly Diagnostic[];
  editable: boolean;
  /** The whole form, for the binding choices and the Grid columns. */
  definition: FormDefinition | null;
  /** What a binding key can point at, from the model. */
  bindingChoices(key: string): BindingChoice[];
  /** Opens the text editor, for what is only edited there. */
  openTextEditor?: (() => void) | undefined;
  /** Runs a command, as one undo step. */
  onCommand(command: Command): void;
  onRename(newId: string): void;
}

const EDGES = ['left', 'top', 'right', 'bottom', 'width', 'height'] as const;

const isExpression = (value: unknown): value is string => typeof value === 'string' && value.startsWith('=');

/** Text that is either empty (take the value away), an `=` expression, or a number. */
export function parseNumberOrExpression(text: string): { value: number | string | undefined } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined };
  if (trimmed.startsWith('=')) return { value: trimmed };
  const number = Number(trimmed);
  return Number.isFinite(number) ? { value: number } : { error: 'Enter a number, or an expression that starts with =.' };
}

export function Inspector({ component, meta, allIds, diagnostics, editable, definition, bindingChoices, openTextEditor, onCommand, onRename }: InspectorProps): ReactElement {
  if (!component) {
    return (
      <aside className="dz-inspector" aria-label="Inspector">
        <p className="dz-empty">Select a component on the canvas to edit it.</p>
      </aside>
    );
  }
  const disabled = !editable;
  return (
    <aside className="dz-inspector" aria-label="Inspector">
      <h2 className="dz-inspector__title">
        {component.id} <span className="dz-inspector__type">{meta?.displayName ?? component.type}</span>
      </h2>
      {!meta ? <p className="dz-note">This component type has no description, so only its id, layout, bindings and events can be edited.</p> : null}

      {diagnostics.length > 0 ? (
        <section className="dz-section" aria-label="Problems">
          <h3>Problems</h3>
          <ul className="dz-diagnostics">
            {diagnostics.map((d, index) => (
              <li key={index} data-severity={d.severity}>
                <strong>{d.severity === 'error' ? 'Error' : 'Warning'}:</strong> {d.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="dz-section" aria-label="Identity and layout">
        <h3>Layout</h3>
        <TextRow
          label="id"
          value={component.id}
          disabled={disabled}
          onCommit={(text) => {
            const id = text.trim();
            if (id === '') return 'An id is required.';
            // The same rule as the model's, so the message appears beside the field.
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return 'Use letters, digits and underscores, and don\'t start with a digit.';
            if (id !== component.id && allIds.includes(id)) return `Another component already uses the id "${id}".`;
            onRename(id);
          }}
        />
        {EDGES.map((edge) => (
          <TextRow
            key={edge}
            label={edge}
            value={component.layout[edge] === undefined ? '' : String(component.layout[edge])}
            disabled={disabled}
            numeric
            onCommit={(text) => {
              const parsed = text.trim() === '' ? undefined : Number(text);
              if (parsed !== undefined && !Number.isFinite(parsed)) return 'Enter a number, or leave it empty.';
              onCommand(commands.setLayout(component.id, { [edge]: parsed }));
            }}
          />
        ))}
      </section>

      {component.type === 'Grid' ? <GridEditor component={component} definition={definition} editable={editable} run={onCommand} openTextEditor={openTextEditor} /> : null}

      {meta && Object.keys(meta.props).length > 0 ? (
        <section className="dz-section" aria-label="Properties">
          <h3>Properties</h3>
          {Object.entries(meta.props).map(([name, propMeta]) => (
            <PropEditor
              key={name}
              name={name}
              meta={propMeta}
              value={component.props?.[name]}
              disabled={disabled}
              onSet={(value) => onCommand(commands.setProp(component.id, name, value))}
            />
          ))}
        </section>
      ) : null}

      {meta && Object.keys(meta.bindings).length > 0 ? (
        <section className="dz-section" aria-label="Bindings">
          <h3>Bindings</h3>
          {Object.entries(meta.bindings).map(([key, kind]) => (
            <BindingRow
              key={key}
              name={key}
              kind={kind}
              value={component.bind?.[key] ?? ''}
              choices={bindingChoices(key)}
              disabled={disabled}
              onSet={(value) => onCommand(commands.setBinding(component.id, key, value))}
            />
          ))}
        </section>
      ) : null}

      {meta && Object.keys(meta.events).length > 0 ? (
        <section className="dz-section" aria-label="Events">
          <h3>Events</h3>
          {Object.entries(meta.events).map(([name, eventMeta]) => (
            <TextRow
              key={name}
              label={`${name} (event)`}
              description={`${eventMeta.description} Enter the name of a handler.`}
              value={component.events?.[name] ?? ''}
              disabled={disabled}
              onCommit={(text) => {
                const value = text.trim();
                onCommand(commands.setEvent(component.id, name, value === '' ? undefined : value));
              }}
            />
          ))}
        </section>
      ) : null}
    </aside>
  );
}

interface TextRowProps {
  label: string;
  value: string;
  description?: string;
  disabled: boolean;
  numeric?: boolean;
  multiline?: boolean;
  /** Return a message to refuse the text. */
  onCommit(text: string): string | null | void;
}

function TextRow({ label, value, description, disabled, numeric, multiline, onCommit }: TextRowProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} {...(description ? { description } : {})} error={error}>
      {({ inputId, describedBy }) => (
        <CommitText id={inputId} value={value} disabled={disabled} describedBy={describedBy} invalid={error !== null} onError={setError} onCommit={onCommit} {...(multiline ? { multiline } : {})} {...(numeric ? { placeholder: 'auto' } : {})} />
      )}
    </Field>
  );
}

interface BindingRowProps {
  name: string;
  kind: 'column' | 'dataset';
  value: string;
  choices: readonly BindingChoice[];
  disabled: boolean;
  onSet(value: string | undefined): void;
}

/** A binding: pick from what the form has, or type any value (such as one that isn't there yet). */
function BindingRow({ name, kind, value, choices, disabled, onSet }: BindingRowProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const known = choices.some((c) => c.value === value);
  return (
    <Field label={`${name} (binding)`} description={kind === 'dataset' ? 'A Dataset id.' : 'A column, written dataset.column.'} error={error}>
      {({ inputId, describedBy }) => (
        <span className="dz-field__row">
          <CommitText id={inputId} value={value} disabled={disabled} describedBy={describedBy} invalid={error !== null} onError={setError} onCommit={(text) => onSet(text.trim() === '' ? undefined : text.trim())} />
          <select
            className="dz-input dz-picker"
            aria-label={`Pick ${kind === 'dataset' ? 'a Dataset' : 'a column'} for ${name}`}
            value={known ? value : ''}
            disabled={disabled || choices.length === 0}
            onChange={(event) => onSet(event.target.value === '' ? undefined : event.target.value)}
          >
            <option value="">{known ? '(none)' : 'Pick…'}</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </span>
      )}
    </Field>
  );
}

interface PropEditorProps {
  name: string;
  meta: PropMeta;
  value: unknown;
  disabled: boolean;
  /** Sets the prop, or takes it away with undefined. */
  onSet(value: unknown): void;
}

const describe = (meta: PropMeta): string => (meta.default === undefined ? meta.description : `${meta.description} Default: ${JSON.stringify(meta.default)}.`);

function PropEditor({ name, meta, value, disabled, onSet }: PropEditorProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [expression, setExpression] = useState(false);
  const description = describe(meta);
  const clearButton =
    value !== undefined && !disabled ? (
      <button type="button" className="dz-iconbtn" aria-label={`Remove the value of ${name}`} title="Remove the value" onClick={() => onSet(undefined)}>
        ×
      </button>
    ) : null;

  switch (meta.kind) {
    case 'string':
      return (
        <Field label={name} description={description} error={error}>
          {({ inputId, describedBy }) => (
            <CommitText id={inputId} value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)} disabled={disabled} describedBy={describedBy} onError={setError} onCommit={(text) => onSet(text === '' ? undefined : text)} />
          )}
        </Field>
      );
    case 'number':
    case 'boolean':
    case 'enum': {
      const showText = expression || (meta.kind === 'boolean' ? typeof value === 'string' : isExpression(value));
      const toggle = !disabled && !(isExpression(value)) ? (
        <button type="button" className="dz-iconbtn" aria-pressed={expression} aria-label={`Use an expression for ${name}`} title="Use an = expression" onClick={() => setExpression(!expression)}>
          =
        </button>
      ) : null;
      return (
        <Field label={name} description={description} error={error}>
          {({ inputId, describedBy }) => (
            <span className="dz-field__row">
              {meta.kind === 'number' || showText ? (
                <CommitText
                  id={inputId}
                  value={value === undefined ? '' : String(value)}
                  disabled={disabled}
                  describedBy={describedBy}
                  invalid={error !== null}
                  onError={setError}
                  onCommit={(text) => {
                    if (meta.kind !== 'number' && text.trim() !== '' && !text.trim().startsWith('=')) return 'An expression starts with =.';
                    const parsed = parseNumberOrExpression(text);
                    if ('error' in parsed) return parsed.error;
                    setExpression(false);
                    onSet(parsed.value);
                  }}
                />
              ) : meta.kind === 'boolean' ? (
                <input
                  id={inputId}
                  type="checkbox"
                  className="dz-check"
                  checked={typeof value === 'boolean' ? value : meta.default === true}
                  disabled={disabled}
                  aria-describedby={describedBy}
                  onChange={(event) => onSet(event.target.checked)}
                />
              ) : (
                <select id={inputId} className="dz-input" value={typeof value === 'string' ? value : ''} disabled={disabled} aria-describedby={describedBy} onChange={(event) => onSet(event.target.value === '' ? undefined : event.target.value)}>
                  <option value="">{meta.default === undefined ? '(not set)' : `(default: ${String(meta.default)})`}</option>
                  {(meta.values ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
              {toggle}
              {clearButton}
            </span>
          )}
        </Field>
      );
    }
    case 'options':
      return <OptionsEditor name={name} value={value} disabled={disabled} description={description} onSet={onSet} />;
    case 'json':
    default:
      return (
        <Field label={name} description={`${description} Written as JSON.`} error={error}>
          {({ inputId, describedBy }) => (
            <CommitText
              id={inputId}
              multiline
              value={value === undefined ? '' : JSON.stringify(value, null, 2)}
              disabled={disabled}
              describedBy={describedBy}
              invalid={error !== null}
              onError={setError}
              onCommit={(text) => {
                if (text.trim() === '') return onSet(undefined);
                try {
                  onSet(JSON.parse(text) as unknown);
                } catch {
                  return 'This is not valid JSON.';
                }
              }}
            />
          )}
        </Field>
      );
  }
}

interface OptionItem {
  value: unknown;
  label: unknown;
}

function OptionsEditor({ name, value, disabled, description, onSet }: { name: string; value: unknown; disabled: boolean; description: string; onSet(value: unknown): void }): ReactElement {
  // Something that isn't a list, such as an = expression, is kept as text.
  if (value !== undefined && !Array.isArray(value)) {
    return (
      <Field label={name} description={description}>
        {({ inputId, describedBy }) => <CommitText id={inputId} value={String(value)} disabled={disabled} describedBy={describedBy} onCommit={(text) => onSet(text === '' ? undefined : text)} />}
      </Field>
    );
  }
  const items = (value ?? []) as OptionItem[];
  const write = (next: OptionItem[]): void => onSet(next.length === 0 ? undefined : next);
  return (
    <fieldset className="dz-options">
      <legend>{name}</legend>
      <small className="dz-field__help">{description}</small>
      {items.map((item, index) => (
        <div className="dz-options__row" key={index}>
          <CommitText
            id={`${name}-value-${index}`}
            label={`${name} option ${index + 1} value`}
            value={item.value === undefined || item.value === null ? '' : String(item.value)}
            disabled={disabled}
            placeholder="value"
            onCommit={(text) => write(items.map((o, i) => (i === index ? { ...o, value: typeof o.value === 'number' && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text } : o)))}
          />
          <CommitText
            id={`${name}-label-${index}`}
            label={`${name} option ${index + 1} label`}
            value={item.label === undefined || item.label === null ? '' : String(item.label)}
            disabled={disabled}
            placeholder="label"
            onCommit={(text) => write(items.map((o, i) => (i === index ? { ...o, label: text } : o)))}
          />
          {disabled ? null : (
            <button type="button" className="dz-iconbtn" aria-label={`Remove option ${index + 1} of ${name}`} onClick={() => write(items.filter((_, i) => i !== index))}>
              ×
            </button>
          )}
        </div>
      ))}
      {disabled ? null : (
        <button type="button" className="dz-btn" onClick={() => write([...items, { value: '', label: '' }])}>
          Add option
        </button>
      )}
    </fieldset>
  );
}
