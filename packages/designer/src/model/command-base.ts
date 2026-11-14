/** Designer commands: each turns the current form into the next one. They never touch text. */
import type { ComponentDefinition, FormDefinition } from '@fw/core';
import { validateForm } from '@fw/format';

export interface Command {
  /** What the undo menu shows. */
  readonly label: string;
  /** Returns the next form. May return `form` itself (or an equal one) for "nothing to do". Throws `CommandError` to refuse. */
  run(form: FormDefinition): FormDefinition;
}

/** A command that can't be done, with a message the designer can show. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Where a component sits in the form. */
export interface Found {
  component: ComponentDefinition;
  /** The ancestors' ids, outermost first. */
  ancestors: readonly string[];
  /** The path of the component in the form, such as `components[1].children[0]`. */
  path: string;
}

/** A list from a value of any shape: anything that isn't an array is an empty list, so odd files can't make a walk throw. */
export function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function findComponent(form: FormDefinition, id: string): Found | undefined {
  const search = (list: readonly ComponentDefinition[], prefix: string, ancestors: readonly string[]): Found | undefined => {
    for (let i = 0; i < list.length; i++) {
      const component = list[i] as ComponentDefinition;
      if (!component || typeof component !== 'object') continue;
      const path = `${prefix}[${i}]`;
      if (component.id === id) return { component, ancestors, path };
      const inner = search(listOf<ComponentDefinition>(component.children), `${path}.children`, [...ancestors, component.id]);
      if (inner) return inner;
    }
    return undefined;
  };
  return search(listOf<ComponentDefinition>(form?.components), 'components', []);
}

/** Every component id in the form, in document order. */
export function componentIds(form: FormDefinition): string[] {
  const out: string[] = [];
  const walk = (list: readonly ComponentDefinition[]): void => {
    for (const component of list) {
      if (!component || typeof component !== 'object') continue;
      out.push(component.id);
      walk(listOf<ComponentDefinition>(component.children));
    }
  };
  walk(listOf<ComponentDefinition>(form?.components));
  return out;
}

/** Replaces one component, keeping everything else the same object. Throws `CommandError` for an unknown id. */
export function mapComponent(form: FormDefinition, id: string, change: (component: ComponentDefinition) => ComponentDefinition): FormDefinition {
  let found = false;
  const visit = (list: readonly ComponentDefinition[]): ComponentDefinition[] =>
    list.map((component) => {
      if (component.id === id) {
        found = true;
        return change(component);
      }
      if (!Array.isArray(component.children)) return component;
      const children = visit(component.children);
      return children.every((child, i) => child === (component.children as ComponentDefinition[])[i]) ? component : { ...component, children };
    });
  const components = visit(listOf<ComponentDefinition>(form.components) as ComponentDefinition[]);
  if (!found) throw new CommandError(`There is no component "${id}"`);
  return { ...form, components };
}


/** The messages of the errors a form has. */
function errorMessages(form: FormDefinition, metas: Parameters<typeof validateForm>[1]): Set<string> {
  return new Set(validateForm(form, metas).filter((d) => d.severity === 'error').map((d) => d.message));
}

/**
 * Refuses a change that leaves the form with an error it didn't have before, naming the errors.
 * Errors are compared by message, so moving things around doesn't count as new.
 */
export function assertNoNewErrors(before: FormDefinition, after: FormDefinition, metas?: Parameters<typeof validateForm>[1]): void {
  if (after === before) return;
  const had = errorMessages(before, metas);
  const created = [...errorMessages(after, metas)].filter((message) => !had.has(message));
  if (created.length > 0) throw new CommandError(`That would break the form: ${created.slice(0, 3).join('; ')}${created.length > 3 ? ` and ${created.length - 3} more` : ''}`);
}

/** Wraps a command so its result is checked with `assertNoNewErrors`. */
export function guarded(command: Command, metas?: Parameters<typeof validateForm>[1]): Command {
  return {
    label: command.label,
    run(form) {
      const next = command.run(form);
      assertNoNewErrors(form, next, metas);
      return next;
    },
  };
}

/** What a component, Dataset, column or Grid column id must look like. */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function requireId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new CommandError(`"${id}" isn't a valid ${kind} id. Use letters, digits and underscores, not starting with a digit`);
}

/** Round to whole pixels, so files never get stray fractions. */
export function whole(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}
