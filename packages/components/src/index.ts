import { containerComponents } from './containers/index.ts';
import type { Registry } from './contract.ts';
import { gridComponents } from './grid/index.ts';
import { inputComponents } from './inputs/index.ts';

export * from './contract.ts';
export * from './host/index.tsx';

/** Every built-in component, by type. */
export const defaultRegistry: Registry = { ...inputComponents, ...containerComponents, ...gridComponents };
export * from './shell/index.ts';
