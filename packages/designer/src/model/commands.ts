/** Designer commands: each turns the current form into the next one. They never touch text. */
import type { ComponentDefinition, FormDefinition, LayoutDefinition } from '@fw/core';
import { CommandError, ID_PATTERN, componentIds, findComponent, mapComponent, type Command } from './command-base.ts';
import { datasetCommands } from './datasets.ts';
import { gridCommands } from './grid-columns.ts';
import { moveLayout, resizeLayout, type ResizeHandle, type ResizeOptions } from './layout.ts';
import { structureCommands } from './structure.ts';

export { CommandError, componentIds, findComponent, type Command, type Found } from './command-base.ts';

/** The record with `key` set, or removed if `value` is undefined. An emptied record is removed from its owner by the caller. */
function withKey<V>(record: Readonly<Record<string, V>> | undefined, key: string, value: V | undefined): Record<string, V> | undefined {
  if (value === undefined) {
    if (!record || !Object.hasOwn(record, key)) return record as undefined;
    const rest = { ...record };
    delete rest[key];
    return rest;
  }
  return { ...record, [key]: value };
}

function setRecord(component: ComponentDefinition, field: 'props' | 'events' | 'bind', key: string, value: unknown): ComponentDefinition {
  const current = component[field] as Record<string, unknown> | undefined;
  const next = withKey(current, key, value);
  if (next === current) return component;
  const out: ComponentDefinition = { ...component };
  if (next && Object.keys(next).length > 0) out[field] = next as never;
  else delete out[field];
  return out;
}

function asList(ids: string | readonly string[]): readonly string[] {
  return typeof ids === 'string' ? [ids] : ids;
}

/** Drops ids that sit inside another listed component, since moving the outer one already moves them. */
function outermost(form: FormDefinition, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return ids.filter((id) => {
    const found = findComponent(form, id);
    return found !== undefined && !found.ancestors.some((ancestor) => wanted.has(ancestor));
  });
}

const basicCommands = {
  /**
   * Moves components by whole pixels, keeping their layout edges. A component nested in another
   * moves with it, so it isn't moved again.
   */
  move(ids: string | readonly string[], dx: number, dy: number): Command {
    const list = asList(ids);
    return {
      label: list.length === 1 ? `Move ${list[0]}` : `Move ${list.length} components`,
      run(form) {
        let next = form;
        for (const id of list) if (!findComponent(form, id)) throw new CommandError(`There is no component "${id}"`);
        for (const id of outermost(form, list)) {
          next = mapComponent(next, id, (component) => ({ ...component, layout: moveLayout(component.layout, dx, dy) }));
        }
        return next;
      },
    };
  },

  /** Drags a handle by (dx, dy), keeping the layout's edges and a minimum size. */
  resize(id: string, handle: ResizeHandle, dx: number, dy: number, options?: ResizeOptions): Command {
    return {
      label: `Resize ${id}`,
      run: (form) => mapComponent(form, id, (component) => ({ ...component, layout: resizeLayout(component.layout, handle, dx, dy, options) })),
    };
  },

  /** Sets layout edges. A key with `undefined` removes that edge. Other keys stay. */
  setLayout(id: string, edges: { [K in keyof LayoutDefinition]?: number | undefined }): Command {
    return {
      label: `Change layout of ${id}`,
      run: (form) =>
        mapComponent(form, id, (component) => {
          const layout: LayoutDefinition = { ...component.layout };
          for (const [key, value] of Object.entries(edges)) {
            if (value === undefined) delete layout[key];
            else if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommandError(`"${key}" must be a number`);
            else layout[key] = value;
          }
          return { ...component, layout };
        }),
    };
  },

  /** Sets one prop, or removes it if `value` is undefined. */
  setProp(id: string, name: string, value: unknown): Command {
    return {
      label: `Change ${name} of ${id}`,
      run: (form) => mapComponent(form, id, (component) => setRecord(component, 'props', name, value)),
    };
  },

  /** Renames a component. Refuses a name that is invalid or already used by another component. */
  setId(id: string, newId: string): Command {
    return {
      label: `Rename ${id} to ${newId}`,
      run(form) {
        if (!ID_PATTERN.test(newId)) throw new CommandError(`"${newId}" isn't a valid id. Use letters, digits and underscores, not starting with a digit`);
        if (newId === id) return form;
        if (componentIds(form).includes(newId)) throw new CommandError(`The id "${newId}" is already used by another component`);
        return mapComponent(form, id, (component) => {
          // Keep `id` where it is in the object, so the text diff is one line.
          const next: ComponentDefinition = { ...component };
          next.id = newId;
          return next;
        });
      },
    };
  },

  /** Deletes components and everything inside them. Unknown ids are ignored. */
  delete(ids: string | readonly string[]): Command {
    const list = new Set(asList(ids));
    return {
      label: list.size === 1 ? `Delete ${[...list][0]}` : `Delete ${list.size} components`,
      run(form) {
        let changed = false;
        const prune = (components: readonly ComponentDefinition[]): ComponentDefinition[] => {
          const out: ComponentDefinition[] = [];
          for (const component of components) {
            if (list.has(component.id)) {
              changed = true;
              continue;
            }
            if (!component.children) {
              out.push(component);
              continue;
            }
            const children = prune(component.children);
            out.push(children.length === component.children.length && children.every((child, i) => child === (component.children as ComponentDefinition[])[i]) ? component : { ...component, children });
          }
          return out;
        };
        const components = prune(form.components);
        return changed ? { ...form, components } : form;
      },
    };
  },

  /** Sets the handler name for an event, or removes it if `handler` is undefined. */
  setEvent(id: string, event: string, handler: string | undefined): Command {
    return {
      label: `Change ${event} handler of ${id}`,
      run: (form) => mapComponent(form, id, (component) => setRecord(component, 'events', event, handler === '' ? undefined : handler)),
    };
  },

  /** Sets a binding (`dataset.column` or a Dataset id), or removes it if `value` is undefined. */
  setBinding(id: string, key: string, value: string | undefined): Command {
    return {
      label: `Change ${key} binding of ${id}`,
      run: (form) => mapComponent(form, id, (component) => setRecord(component, 'bind', key, value === '' ? undefined : value)),
    };
  },
} as const;

export const commands = { ...basicCommands, ...structureCommands, ...datasetCommands, ...gridCommands } as const;
