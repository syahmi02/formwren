import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ColumnDefinition, ComponentDefinition, FormDefinition, TypedValue } from '@fw/format';

const VALUE_TYPES: Readonly<Record<string, string>> = {
  string: 'string',
  date: 'string',
  datetime: 'string',
  decimal: 'string',
  int: 'number',
  float: 'number',
  boolean: 'boolean',
};

const FORM_SUFFIX = '.form.json';

/** Names the generated file declares or imports itself, plus the words a type can't be called. */
const RESERVED = new Set([
  'FwDataset', 'FwFormModule', 'FwAssert', 'fwScript',
  'any', 'unknown', 'never', 'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'undefined', 'null', 'void',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'while', 'with', 'implements', 'interface', 'let', 'package',
  'private', 'protected', 'public', 'static', 'yield', 'await', 'async', 'type', 'namespace', 'module', 'declare', 'is',
  'keyof', 'readonly', 'infer', 'asserts', 'abstract', 'as', 'satisfies', 'unique', 'global', 'of', 'out', 'accessor',
]);

export function isFormFile(path: string): boolean {
  return path.endsWith(FORM_SUFFIX);
}

/** The generated file beside a form. Throws for any file that isn't `*.form.json`, so no other file can be overwritten. */
export function genPathOf(formPath: string): string {
  if (!isFormFile(formPath)) throw new Error(`"${formPath}" is not a *.form.json file, so it has no generated types file`);
  return formPath.slice(0, -'.json'.length) + '.gen.ts';
}

/** `EmpSearch.form.json` gives `EmpSearch`. Characters that can't be in a type name become `_`. Throws if the result can't be a type name. */
export function typeNameOf(formPath: string): string {
  const file = formPath.split(/[\\/]/).pop() ?? '';
  const name = file.replace(/\.form\.(json|gen\.ts)$/, '').replace(/[^A-Za-z0-9_$]/g, '_');
  const result = name === '' ? 'Form' : /^[0-9]/.test(name) ? `_${name}` : name;
  if (RESERVED.has(result)) {
    throw new Error(`"${result}" can't be used as a type name, so ${file} can't have generated types. Rename the file`);
  }
  return result;
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

const valueType = (type: string): string => VALUE_TYPES[type] ?? 'unknown';

/** An object type with exactly these members. With none it has no members at all, so `form.vars.nope` doesn't compile. */
function objectType(entries: readonly (readonly [string, string])[]): string {
  return entries.length === 0 ? '{ [K in never]: never }' : `{ ${entries.map(([name, type]) => `${key(name)}: ${type}`).join('; ')} }`;
}

/** Without a default, a variable holds null until it is set, and a param is undefined when the caller gave none. */
function typedMapType(map: Record<string, TypedValue> | undefined, missing: 'null' | 'undefined'): string {
  return objectType(
    Object.entries(map ?? {}).map(([name, typed]) => {
      const hasDefault = typed.default !== undefined && typed.default !== null;
      return [name, hasDefault ? valueType(typed.type) : `${valueType(typed.type)} | ${missing}`] as const;
    }),
  );
}

/** A result is always given in full by the form that closes, so its members have no `undefined` or `null`. */
const resultType = (map: Record<string, TypedValue>): string =>
  objectType(Object.entries(map).map(([name, typed]) => [name, valueType(typed.type)] as const));

const columnsType = (columns: readonly ColumnDefinition[]): string =>
  objectType(columns.map((column) => [column.id, valueType(column.type)] as const));

function collectHandlers(components: readonly ComponentDefinition[], into: Set<string>): void {
  for (const component of components) {
    for (const handler of Object.values(component.events ?? {})) into.add(handler);
    if (component.children) collectHandlers(component.children, into);
  }
}

/** Every handler name the form file mentions, in code unit order so the result never depends on locale. */
export function handlerNames(form: FormDefinition): string[] {
  const names = new Set<string>(Object.values(form.events ?? {}));
  collectHandlers(form.components, names);
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** How the generated file imports the script: beside the form, without its extension. Null if the script isn't a .ts or .tsx file. */
export function scriptImportOf(script: unknown): string | null {
  if (typeof script !== 'string' || !/\.tsx?$/.test(script)) return null;
  const path = script.replace(/\\/g, '/').replace(/\.tsx?$/, '');
  return path.startsWith('.') || path.startsWith('/') ? path : `./${path}`;
}

/** Escapes text for use inside a single-quoted TypeScript string, so the form's `script` value can never end the string early. */
function quoteInner(text: string): string {
  return JSON.stringify(text).slice(1, -1).replace(/'/g, "\\'");
}

/** The text of a `.form.gen.ts` file. The same form always gives exactly the same text. Throws if the file name can't be a type name. */
export function generateFormTypes(form: FormDefinition, formPath: string): string {
  const datasets = form.datasets ?? [];
  const handlers = handlerNames(form);
  const name = typeNameOf(formPath);
  const scriptImport = scriptImportOf(form.script);
  const lines = [
    `// Generated from ${formPath.split(/[\\/]/).pop()}. Do not edit: changes are overwritten.`,
    // Each import is only written when used, which keeps projects that turn on noUnusedLocals happy.
    ...(datasets.length > 0 ? ["import type { Dataset as FwDataset } from '@fw/core';"] : []),
    ...(scriptImport ? ["import type { FormModule as FwFormModule } from '@fw/core';", `import type fwScript from '${quoteInner(scriptImport)}';`] : []),
    '',
    `export type ${name} = {`,
  ];
  if (datasets.length === 0) {
    lines.push('  datasets: { [K in never]: never };');
  } else {
    lines.push('  datasets: {');
    for (const dataset of datasets) lines.push(`    ${key(dataset.id)}: FwDataset<${columnsType(dataset.columns)}>;`);
    lines.push('  };');
  }
  lines.push(
    `  variables: ${typedMapType(form.variables, 'null')};`,
    `  params: ${typedMapType(form.params, 'undefined')};`,
    ...(form.result ? [`  result: ${resultType(form.result)};`] : []),
    `  handlers: ${handlers.length === 0 ? 'never' : handlers.map((handler) => `'${handler}'`).join(' | ')};`,
    '};',
  );
  if (scriptImport) {
    // The script must default-export defineForm<Name>(...). An untyped or differently typed export is not the same type, so this stops compiling.
    lines.push(
      '',
      'type FwAssert<T extends true> = T;',
      `export type ${name}ScriptCheck = FwAssert<[typeof fwScript] extends [FwFormModule<${name}>] ? ([FwFormModule<${name}>] extends [typeof fwScript] ? true : false) : false>;`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Writes the file only if its content would change. Returns true if it wrote. */
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeFileSync(path, content);
  return true;
}

/** Regenerates the types beside a form file. Returns true if the file changed. */
export function writeFormTypes(formPath: string, form: FormDefinition): boolean {
  return writeIfChanged(genPathOf(formPath), generateFormTypes(form, formPath));
}
