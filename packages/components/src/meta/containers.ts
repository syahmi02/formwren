import { defineComponentMeta, type ComponentMeta } from '@fw/core';

const panel = defineComponentMeta({
  type: 'Panel',
  displayName: 'Panel',
  category: 'container',
  container: true,
  defaultSize: { width: 300, height: 200 },
  props: { title: { kind: 'string', description: 'Heading shown above the contents.' } },
  bindings: {},
  events: {},
});

const tabs = defineComponentMeta({
  type: 'Tabs',
  displayName: 'Tabs',
  category: 'container',
  container: true,
  defaultSize: { width: 400, height: 300 },
  props: {
    selectedIndex: { kind: 'number', description: 'Zero-based index of the visible page.', default: 0 },
  },
  bindings: { selectedIndex: 'column' },
  events: { change: { description: 'The visible page changed. The detail holds `selectedIndex`.' } },
});

const dialog = defineComponentMeta({
  type: 'Dialog',
  displayName: 'Dialog',
  category: 'container',
  container: true,
  defaultSize: { width: 400, height: 300 },
  props: {
    open: { kind: 'boolean', description: 'Whether the dialog is showing.', default: false },
    title: { kind: 'string', description: 'Heading of the dialog.' },
  },
  bindings: { open: 'column' },
  events: { close: { description: 'The user closed the dialog, for example with Esc.' } },
});

export const containerMetas: Readonly<Record<string, ComponentMeta>> = { Panel: panel, Tabs: tabs, Dialog: dialog };
