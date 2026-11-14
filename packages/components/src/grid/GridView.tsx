import type { ComponentHandle, GridProps } from '@fw/core';
import { createGrid, type CellRef, type GridHandle } from '@fw/grid';
import { useEffect, useImperativeHandle, useMemo, useRef, type ReactElement } from 'react';
import type { HostProps } from '../contract.ts';
import { useComponentModel, useDatasetLookup, useErrorReporter, useSignal } from '../host/index.tsx';

interface GridHostProps {
  readOnly?: boolean;
}

/**
 * React's whole part in the Grid: one host element, and a `createGrid` call in an effect. The
 * structure comes from the model's definition, not from `HostProps.props`, because it is a
 * document, not a flat value. The Dataset, its rows and every cell stay outside React, so this
 * component renders on a definition or `readOnly` change and never on a data change.
 */
export function GridView({ props, handleRef, design }: HostProps<GridHostProps>): ReactElement {
  const model = useComponentModel();
  const lookup = useDatasetLookup();
  const reportError = useErrorReporter();
  const definition = useSignal(model.definition);
  const readOnly = props.readOnly === true;

  const p = definition.props ?? {};
  const columns = p.columns as GridProps['columns'] | undefined;
  const headerRows = p.headerRows as GridProps['headerRows'] | undefined;
  const recordRows = p.recordRows as GridProps['recordRows'] | undefined;
  const footerRows = p.footerRows as GridProps['footerRows'] | undefined;
  const gridProps = useMemo<GridProps>(
    () => ({
      columns: columns ?? [],
      recordRows: recordRows ?? [],
      ...(headerRows ? { headerRows } : {}),
      ...(footerRows ? { footerRows } : {}),
    }),
    [columns, headerRows, recordRows, footerRows],
  );
  // The Dataset is looked up inside the effect. Only the binding's id decides when to recreate.
  const datasetKey = definition.bind?.dataset ?? '';

  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridHandle | null>(null);
  // What the live Grid was last given, so the update effect skips the value it was created with.
  const appliedRef = useRef<GridProps | null>(null);
  const latest = useRef(gridProps);
  latest.current = gridProps;
  // A script can call focus before the Grid exists, because layout effects run first.
  const pendingFocus = useRef<{ cell?: CellRef } | null>(null);

  useImperativeHandle(
    handleRef,
    (): ComponentHandle => ({
      focus(cell?: CellRef) {
        if (gridRef.current) gridRef.current.focus(cell);
        else pendingFocus.current = cell ? { cell } : {};
      },
    }),
    [],
  );

  const fireRef = useRef(model.fire.bind(model));
  fireRef.current = model.fire.bind(model);

  useEffect(() => {
    const host = hostRef.current;
    const dataset = model.getBoundDataset();
    if (!host || !dataset) {
      if (!dataset) console.error(`Grid ${model.id} has no Dataset bound to bind.dataset`);
      return;
    }
    const handle = createGrid(host, {
      dataset,
      definition: latest.current,
      writeCell: (rowId, column, value) => model.writeCell(rowId, column, value),
      acceptsCell: (column, value) => model.acceptsCell(column, value),
      scope: model.cellScope(),
      resolveDataset: lookup,
      design,
      readOnly: readOnlyRef.current,
      fire: (event, detail) => fireRef.current(event, detail),
      reportError: (error, where) => reportError(error, `${model.id} (${where})`),
    });
    gridRef.current = handle;
    appliedRef.current = latest.current;
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending) handle.focus(pending.cell);
    return () => {
      gridRef.current = null;
      handle.destroy();
    };
    // readOnly is applied by its own effect, so locking the Grid doesn't rebuild it.
  }, [model, lookup, datasetKey, design]);

  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  useEffect(() => {
    gridRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    if (!gridRef.current || appliedRef.current === gridProps) return;
    appliedRef.current = gridProps;
    gridRef.current.update(gridProps);
  }, [gridProps]);

  return <div ref={hostRef} className="fw-gridhost" style={{ width: '100%', height: '100%' }} />;
}
