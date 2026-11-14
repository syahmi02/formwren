import { useId, type ReactElement } from 'react';
import type { HostProps } from '../contract.ts';

export function PanelView({ props, children }: HostProps<{ title?: string }>): ReactElement {
  const headingId = useId();
  const title = typeof props.title === 'string' && props.title !== '' ? props.title : undefined;
  return (
    <section className="fw-panel" aria-labelledby={title ? headingId : undefined}>
      {title && (
        <h2 className="fw-panel__title" id={headingId}>
          {title}
        </h2>
      )}
      {/* Positioned so that children are placed relative to the panel. */}
      <div className="fw-panel__body" style={{ position: 'relative' }}>
        {children}
      </div>
    </section>
  );
}
