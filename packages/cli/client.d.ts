// Types for importing a form file when the project uses the fwForms() Vite plugin.
// Reference it from a .d.ts in the project: /// <reference types="@fw/cli/client" />
declare module '*.form.json' {
  import type { FormEntry } from '@fw/core';
  const entry: FormEntry;
  export default entry;
}
