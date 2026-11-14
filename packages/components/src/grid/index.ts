import { registerComponent, type Registry } from '../contract.ts';
import { gridMetas } from '../meta/grid.ts';
import { GridView } from './GridView.tsx';

export const gridComponents: Registry = {
  Grid: registerComponent(gridMetas.Grid!, GridView),
};
