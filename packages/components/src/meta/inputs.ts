import { defineComponentMeta, type ComponentMeta, type PropMeta } from '@fw/core';

const disabled: PropMeta = { kind: 'boolean', description: 'Blocks all interaction.', default: false };
const readOnly: PropMeta = { kind: 'boolean', description: 'Shows the value but does not let the user change it.', default: false };
const required: PropMeta = { kind: 'boolean', description: 'Marks the field as required.', default: false };
const label: PropMeta = { kind: 'string', description: 'Visible label.', default: '' };
const placeholder: PropMeta = { kind: 'string', description: 'Hint shown while the field is empty.', default: '' };
const errorMessage: PropMeta = { kind: 'string', description: 'When set, the field is shown as invalid with this message.' };
const optionProps = {
  options: { kind: 'options', description: 'Static options, as { value, label } pairs.' },
  optionValue: { kind: 'string', description: 'Column of the options Dataset that holds the value.' },
  optionLabel: { kind: 'string', description: 'Column of the options Dataset that holds the text.' },
} as const satisfies Record<string, PropMeta>;
const change = { description: 'Fires after the user changed the bound value.' };
const size = (width: number, height: number) => ({ width, height });

const textProps = {
  label,
  value: { kind: 'string', description: 'The text, usually bound to a column.', default: '' },
  placeholder,
  maxLength: { kind: 'number', description: 'Longest text the user can type.' },
  required,
  disabled,
  readOnly,
  errorMessage,
} as const satisfies Record<string, PropMeta>;

const list: ComponentMeta[] = [
  defineComponentMeta({
    type: 'Label',
    displayName: 'Label',
    category: 'display',
    container: false,
    defaultSize: size(100, 24),
    props: {
      text: { kind: 'string', description: 'The text to show.', default: '' },
      align: { kind: 'enum', description: 'Horizontal alignment.', values: ['left', 'center', 'right'], default: 'left' },
      format: { kind: 'string', description: 'Display pattern for a bound number or date, such as "#,##0.00".' },
      live: { kind: 'boolean', description: 'Announce changes to screen readers, for status messages.', default: false },
    },
    bindings: { text: 'column' },
    events: {},
  }),
  defineComponentMeta({
    type: 'Button',
    displayName: 'Button',
    category: 'action',
    container: false,
    defaultSize: size(88, 28),
    props: {
      text: { kind: 'string', description: 'Button caption.', default: 'Button' },
      variant: { kind: 'enum', description: 'Visual emphasis.', values: ['default', 'primary'], default: 'default' },
      disabled,
    },
    bindings: {},
    events: { click: { description: 'Fires when the button is pressed.' } },
  }),
  defineComponentMeta({
    type: 'TextInput',
    displayName: 'Text input',
    category: 'input',
    container: false,
    defaultSize: size(200, 28),
    props: textProps,
    bindings: { value: 'column' },
    events: { change, submit: { description: 'Fires when the user presses Enter, after the value was committed.' } },
  }),
  defineComponentMeta({
    type: 'TextArea',
    displayName: 'Text area',
    category: 'input',
    container: false,
    defaultSize: size(240, 80),
    props: textProps,
    bindings: { value: 'column' },
    events: { change },
  }),
  defineComponentMeta({
    type: 'NumberInput',
    displayName: 'Number input',
    category: 'input',
    container: false,
    defaultSize: size(140, 28),
    props: {
      label,
      value: { kind: 'string', description: 'The number as text or a number, usually bound to a column.' },
      min: { kind: 'number', description: 'Smallest allowed value.' },
      max: { kind: 'number', description: 'Largest allowed value.' },
      format: { kind: 'string', description: 'Display pattern when not focused, such as "#,##0.00".' },
      required,
      disabled,
      readOnly,
      errorMessage,
    },
    bindings: { value: 'column' },
    events: { change },
  }),
  defineComponentMeta({
    type: 'Checkbox',
    displayName: 'Checkbox',
    category: 'input',
    container: false,
    defaultSize: size(140, 24),
    props: {
      label,
      value: { kind: 'boolean', description: 'Whether it is checked.', default: false },
      required,
      disabled,
      readOnly,
      errorMessage,
    },
    bindings: { value: 'column' },
    events: { change },
  }),
  defineComponentMeta({
    type: 'RadioGroup',
    displayName: 'Radio group',
    category: 'input',
    container: false,
    defaultSize: size(200, 56),
    props: {
      label,
      value: { kind: 'string', description: 'The selected option value.' },
      ...optionProps,
      orientation: { kind: 'enum', description: 'Layout of the options.', values: ['vertical', 'horizontal'], default: 'vertical' },
      required,
      disabled,
      readOnly,
      errorMessage,
    },
    bindings: { value: 'column', options: 'dataset' },
    events: { change },
  }),
  defineComponentMeta({
    type: 'ComboBox',
    displayName: 'Combo box',
    category: 'input',
    container: false,
    defaultSize: size(200, 28),
    props: {
      label,
      value: { kind: 'string', description: 'The selected option value.' },
      ...optionProps,
      placeholder,
      required,
      disabled,
      readOnly,
      errorMessage,
    },
    bindings: { value: 'column', options: 'dataset' },
    events: { change },
  }),
  defineComponentMeta({
    type: 'DatePicker',
    displayName: 'Date picker',
    category: 'input',
    container: false,
    defaultSize: size(160, 28),
    props: {
      label,
      value: { kind: 'string', description: 'A date as YYYY-MM-DD.' },
      min: { kind: 'string', description: 'Earliest date, as YYYY-MM-DD.' },
      max: { kind: 'string', description: 'Latest date, as YYYY-MM-DD.' },
      required,
      disabled,
      readOnly,
      errorMessage,
    },
    bindings: { value: 'column' },
    events: { change },
  }),
];

export const inputMetas: Readonly<Record<string, ComponentMeta>> = Object.fromEntries(list.map((m) => [m.type, m]));
