import { registerComponent, type Registry } from '../contract.ts';
import { containerMetas } from '../meta/containers.ts';
import { DialogView } from './dialog.tsx';
import { PanelView } from './panel.tsx';
import { TabsView } from './tabs.tsx';

export const containerComponents: Registry = {
  Panel: registerComponent(containerMetas.Panel!, PanelView),
  Tabs: registerComponent(containerMetas.Tabs!, TabsView),
  Dialog: registerComponent(containerMetas.Dialog!, DialogView, { portal: true }),
};
