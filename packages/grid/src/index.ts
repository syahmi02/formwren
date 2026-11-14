import type { GridHandle, GridOptions } from './contract.ts';
import { createSurface } from './engine/index.ts';
import { attachBehavior } from './interaction/index.ts';

export * from './contract.ts';

/** Creates a Grid inside `container`. It's plain DOM, with no framework. */
export function createGrid(container: HTMLElement, options: GridOptions): GridHandle {
  const surface = createSurface(container, options);
  const behavior = options.design ? null : attachBehavior(surface, options);
  return {
    update(next) {
      surface.update(next);
      behavior?.update();
    },
    focus(cell) {
      behavior?.focus(cell);
    },
    setReadOnly(readOnly) {
      behavior?.setReadOnly(readOnly);
    },
    destroy() {
      behavior?.destroy();
      surface.destroy();
    },
  };
}
