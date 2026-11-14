export * from './contract.ts';
export * from './definition.ts';
export * from './grid.ts';
export * from './meta.ts';
export { createForm, openForm } from './runtime.ts';

import type { FormModule, FormSetup, FormShape } from './contract.ts';

/** Wraps a form script's setup function. `T` is the generated shape, so names and types are checked. */
export function defineForm<T extends FormShape = FormShape>(setup: FormSetup<T>): FormModule<T> {
  return { setup };
}
