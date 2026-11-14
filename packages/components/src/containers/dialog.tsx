import type { CSSProperties, ReactElement } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { useComponentModel, useSignal } from '../host/index.tsx';
import { componentMetas } from '../meta/index.ts';
import { useWrittenState } from './bound.ts';

interface DialogProps {
  open?: boolean;
  title?: string;
}

export function DialogView({ id, props, write, fire, design, children }: HostProps<DialogProps>): ReactElement | null {
  const [open, setOpen] = useWrittenState('open', props.open === true, write);
  const title = typeof props.title === 'string' && props.title !== '' ? props.title : undefined;
  const { layout } = useSignal(useComponentModel().definition);
  // The dialog is portalled out of its host, so the host's size doesn't reach it. Fall back to the default size.
  const fallback = componentMetas.Dialog!.defaultSize;
  const frame: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: typeof layout.width === 'number' ? layout.width : fallback.width,
    height: typeof layout.height === 'number' ? layout.height : fallback.height,
    maxWidth: '100vw',
    maxHeight: '100vh',
  };
  const body = (
    // Fills the space under the title and is positioned, so children can be placed inside it.
    <div className="fw-dialog__body" style={{ position: 'relative', flex: '1 1 0', minHeight: 0 }}>
      {children}
    </div>
  );

  // In design mode a modal would trap the designer, so an open dialog is drawn in place.
  if (design) {
    if (!open) return null;
    return (
      <section className="fw-dialog" aria-label={title ?? id} style={frame}>
        {title && <h2 className="fw-dialog__title">{title}</h2>}
        {body}
      </section>
    );
  }

  return (
    <ModalOverlay
      className="fw-dialog__overlay"
      isOpen={open}
      onOpenChange={(next) => {
        if (next) return;
        setOpen(false, () => fire('close'));
      }}
    >
      <Modal className="fw-dialog__modal">
        <Dialog className="fw-dialog" aria-label={title ? undefined : id} style={frame}>
          {title && (
            <Heading slot="title" className="fw-dialog__title">
              {title}
            </Heading>
          )}
          {body}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
