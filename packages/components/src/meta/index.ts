// React-free, so the CLI and designer can read it in Node. Each work package owns its own file.
import type { ComponentMeta } from '@fw/core';
import { containerMetas } from './containers.ts';
import { gridMetas } from './grid.ts';
import { inputMetas } from './inputs.ts';

export const componentMetas: Readonly<Record<string, ComponentMeta>> = { ...inputMetas, ...containerMetas, ...gridMetas };
