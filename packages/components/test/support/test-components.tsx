import { defineComponentMeta } from '@fw/core';
import { useImperativeHandle, useRef, type ReactElement } from 'react';
import { registerComponent, type HostProps, type Registry } from '../../src/contract.ts';
import { containerComponents } from '../../src/containers/index.ts';

const leaf = (type: string) =>
  defineComponentMeta({
    type,
    displayName: type,
    category: 'display',
    container: false,
    defaultSize: { width: 100, height: 20 },
    props: {},
    bindings: {},
    events: {},
  });

export const renderCounts = new Map<string, number>();

/** Shows `text` and counts how often it renders. */
function Probe({ id, props, design }: HostProps<{ text?: string }>): ReactElement {
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
  return (
    <span className="fw-probe" data-testid={id} data-design={String(design)}>
      {props.text}
    </span>
  );
}

function Field({ id, handleRef }: HostProps): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(handleRef, () => ({ focus: () => input.current?.focus() }), []);
  return <input aria-label={id} ref={input} />;
}

function Pusher({ id, write, fire }: HostProps): ReactElement {
  return (
    <button
      onClick={() => {
        write('value', 'v');
        fire('push', { a: 1 });
      }}
    >
      {id}
    </button>
  );
}

function RowPusher({ id, write }: HostProps): ReactElement {
  return <button onClick={() => write('value', 'r', 7)}>{`${id} row`}</button>;
}

function Boom({ props }: HostProps<{ message?: string }>): ReactElement {
  throw new Error(props.message ?? 'boom');
}

export const testRegistry: Registry = {
  ...containerComponents,
  Probe: registerComponent(leaf('Probe'), Probe),
  Field: registerComponent(leaf('Field'), Field),
  Pusher: registerComponent(leaf('Pusher'), Pusher),
  RowPusher: registerComponent(leaf('RowPusher'), RowPusher),
  Boom: registerComponent(leaf('Boom'), Boom),
};
