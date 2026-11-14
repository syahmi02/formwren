import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { componentMetas } from '@fw/components/meta';
import {
  checkSchema,
  openFormText,
  validateForm,
  type CheckOptions,
  type ComponentDefinition,
  type Diagnostic,
  type FormDefinition,
  type OpenedForm,
} from '@fw/format';

export interface LocatedDiagnostic extends Diagnostic {
  /** 1-based line in the file, or the nearest parent's line if the place can't be found. */
  line: number;
}

export type Inspection =
  /** The file can't be read as a form at all: conflict markers or broken JSON. */
  | { status: 'unreadable'; kind: 'conflict' | 'invalid'; message: string; line: number }
  | {
      status: 'read';
      definition: FormDefinition;
      diagnostics: LocatedDiagnostic[];
      /** True if the structure is valid, which is all the type generator needs. */
      schemaValid: boolean;
    };

type Root = Extract<OpenedForm, { status: 'ok' }>['root'];

/** The metas the checks use, or nothing if none are registered, so a project with no metas isn't flooded with warnings. */
export function defaultCheckOptions(): CheckOptions {
  return Object.keys(componentMetas).length > 0 ? { components: componentMetas } : {};
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Finds the line of a path such as `components[2].props.label`. */
function lineOfPath(text: string, root: Root, path: string): number {
  let node: Root = root;
  let offset = root.offset;
  for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    let next: Root | undefined;
    if (key !== undefined) {
      const property = node.children?.find((child) => child.type === 'property' && child.children?.[0]?.value === key);
      const keyNode = property?.children?.[0];
      if (keyNode) offset = keyNode.offset;
      next = property?.children?.[1];
    } else {
      next = node.children?.[Number(index)];
      if (next) offset = next.offset;
    }
    if (!next) break;
    node = next;
  }
  return lineAt(text, offset);
}

export interface ScriptContext {
  /** The form file. */
  file: string;
  /** The project folder. A script can't reach outside it. */
  root: string;
}

function scriptDiagnostics(definition: FormDefinition, context: ScriptContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const error = (path: string, message: string) => out.push({ severity: 'error', path, message });
  const script = definition.script;
  if (script === undefined) {
    for (const key of Object.keys(definition.events ?? {})) {
      error(`events.${key}`, 'This form has handlers but no "script" to hold them');
    }
    const walk = (components: readonly ComponentDefinition[], path: string): void => {
      components.forEach((component, i) => {
        const where = `${path}[${i}]`;
        for (const key of Object.keys(component.events ?? {})) {
          error(`${where}.events.${key}`, 'This component has handlers but the form has no "script" to hold them');
        }
        if (component.children) walk(component.children, `${where}.children`);
      });
    };
    walk(definition.components, 'components');
    return out;
  }
  if (isAbsolute(script) || /^([A-Za-z]:|[\\/])/.test(script)) {
    error('script', 'The script must be a relative path');
    return out;
  }
  const target = resolve(dirname(context.file), script);
  const fromRoot = relative(context.root, target);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    error('script', 'The script must stay inside the project');
  } else if (!/\.tsx?$/.test(script)) {
    error('script', 'The script must be a .ts or .tsx file');
  } else if (!existsSync(target)) {
    error('script', `Script file not found: ${script}`);
  }
  return out;
}

/** Reads and checks the text of one form file. Never throws for bad content. With a context it also checks the script. */
export function inspectFormText(
  text: string,
  options: CheckOptions = defaultCheckOptions(),
  context?: ScriptContext,
): Inspection {
  const opened = openFormText(text);
  if (opened.status === 'conflict') return { status: 'unreadable', kind: 'conflict', message: opened.message, line: 1 };
  if (opened.status === 'invalid') {
    return { status: 'unreadable', kind: 'invalid', message: opened.message, line: opened.line };
  }
  const schemaValid = checkSchema(opened.value).length === 0;
  const found = validateForm(opened.value, options);
  if (schemaValid && context) found.push(...scriptDiagnostics(opened.value as unknown as FormDefinition, context));
  const diagnostics = found.map((diagnostic) => ({
    ...diagnostic,
    line: lineOfPath(text, opened.root, diagnostic.path),
  }));
  return { status: 'read', definition: opened.value as unknown as FormDefinition, diagnostics, schemaValid };
}

/** `path: message`, or just the message for a problem with the form as a whole. */
export function describe(diagnostic: Diagnostic): string {
  return diagnostic.path === '' ? diagnostic.message : `${diagnostic.path}: ${diagnostic.message}`;
}
