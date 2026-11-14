import { defineComponentMeta, type ComponentMeta } from '@fw/core';

const grid = defineComponentMeta({
  type: 'Grid',
  displayName: 'Grid',
  category: 'display',
  container: false,
  defaultSize: { width: 640, height: 320 },
  props: {
    columns: { kind: 'json', description: 'The column tracks, left to right: { id, width, frozen? }.' },
    headerRows: { kind: 'json', description: 'Header rows of cells. Cells can span rows and columns.' },
    recordRows: { kind: 'json', description: 'The cells of one record. Repeats for every Dataset row.' },
    footerRows: { kind: 'json', description: 'Footer rows. A cell with a `value` expression shows a total.' },
    readOnly: { kind: 'boolean', description: 'Shows the data but does not let the user change it.', default: false },
  },
  bindings: { dataset: 'dataset' },
  events: {
    cellChange: { description: 'Fires after the user changed a cell. The detail holds `rowId`, `column` and `value`.' },
    rowDoubleClick: { description: 'Fires when the user double-clicks a row. The detail holds `rowId`.' },
    rowActivate: { description: 'Fires when the user presses Enter on a cell that has no editor, or anywhere in a read-only Grid. The detail holds `rowId`.' },
  },
});

export const gridMetas: Readonly<Record<string, ComponentMeta>> = { Grid: grid };
