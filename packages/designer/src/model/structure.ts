/** Commands that change the tree: add, re-parent, reorder. */
import type { ComponentDefinition, ComponentMeta, FormDefinition, LayoutDefinition } from '@fw/core';
import type { ComponentBox } from '../contract.ts';
import { CommandError, componentIds, findComponent, mapComponent, requireId, whole, type Command } from './command-base.ts';

export interface AddOptions {
  /** What each component type is, such as `componentMetas`. Needed for the size and to know which types hold children. */
  metas: Readonly<Record<string, ComponentMeta>>;
  /** Overrides the meta's default size. */
  size?: { width: number; height: number };
  /** Props to write. Nothing else is written, so the file stays short. */
  props?: Record<string, unknown>;
  /** Bindings to write. */
  bind?: Record<string, string>;
  /** Use this id, which must be free, instead of one made from the type. */
  id?: string;
}

/** An add command also knows the id it will give the new component for a given form. */
export interface AddCommand extends Command {
  /** The id the component gets when this runs on `form`. */
  newId(form: FormDefinition): string;
}

export interface ReparentOptions {
  /** The boxes the canvas reported. Without the boxes of the component and its new parent, the layout is kept as it is. */
  boxes?: readonly ComponentBox[];
  /** The form's size, used when the new parent is the form itself. Defaults to `form.size`. */
  formSize?: { width: number; height: number };
  /** What each type is. If given, the new parent must be a container. */
  metas?: Readonly<Record<string, ComponentMeta>>;
}

/** `textInput1` for a `TextInput`: the type with a lower-case first letter, then the first free number. */
export function uniqueId(form: FormDefinition, type: string): string {
  const base = type.replace(/^[A-Z]/, (head) => head.toLowerCase()).replace(/[^A-Za-z0-9_]/g, '_') || 'component';
  const used = new Set(componentIds(form));
  for (let n = 1; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

function childrenOf(form: FormDefinition, parentId: string | null): readonly ComponentDefinition[] {
  return parentId === null ? form.components : (findComponent(form, parentId)?.component.children ?? []);
}

/** Replaces the children list of a parent (null is the form), keeping untouched objects. */
function withChildren(form: FormDefinition, parentId: string | null, change: (list: readonly ComponentDefinition[]) => ComponentDefinition[]): FormDefinition {
  if (parentId === null) return { ...form, components: change(form.components) };
  return mapComponent(form, parentId, (parent) => {
    const children = change(parent.children ?? []);
    if (children.length === 0 && parent.children === undefined) return parent;
    return { ...parent, children };
  });
}

function requireContainer(form: FormDefinition, parentId: string | null, metas: Readonly<Record<string, ComponentMeta>> | undefined): void {
  if (parentId === null) return;
  const parent = findComponent(form, parentId);
  if (!parent) throw new CommandError(`There is no component "${parentId}"`);
  if (!metas) return;
  const meta = metas[parent.component.type];
  if (!meta) throw new CommandError(`"${parentId}" is a ${parent.component.type}, which this designer doesn't know`);
  if (!meta.container) throw new CommandError(`"${parentId}" is a ${meta.displayName}, which can't hold other components`);
}

/** The component built for `add`: only the layout, plus what the caller gave. Grids get the minimum the format needs. */
function build(form: FormDefinition, type: string, id: string, x: number, y: number, options: AddOptions): ComponentDefinition {
  const meta = options.metas[type];
  if (!meta) throw new CommandError(`Unknown component type "${type}"`);
  const size = options.size ?? meta.defaultSize;
  const layout: LayoutDefinition = { left: whole(x), top: whole(y), width: whole(size.width), height: whole(size.height) };
  const component: ComponentDefinition = { id, type, layout };
  const props: Record<string, unknown> = { ...options.props };
  const bind: Record<string, string> = { ...options.bind };
  if (type === 'Grid' && props.columns === undefined) {
    // A Grid needs a Dataset and one column to be valid, so start from the first Dataset's first column.
    const dataset = (bind.dataset !== undefined ? form.datasets?.find((d) => d.id === bind.dataset) : undefined) ?? form.datasets?.[0];
    const column = dataset?.columns[0];
    if (dataset && bind.dataset === undefined) bind.dataset = dataset.id;
    const trackId = column?.id ?? 'column1';
    props.columns = [{ id: trackId, width: 120 }];
    props.headerRows = [{ cells: [{ text: column?.label ?? trackId }] }];
    props.recordRows = [{ cells: [column ? { field: column.id } : {}] }];
  }
  if (Object.keys(props).length > 0) component.props = props;
  if (Object.keys(bind).length > 0) component.bind = bind;
  return component;
}

function removeFrom(form: FormDefinition, id: string): { form: FormDefinition; removed: ComponentDefinition; parentId: string | null; index: number } {
  const found = findComponent(form, id);
  if (!found) throw new CommandError(`There is no component "${id}"`);
  const parentId = found.ancestors.at(-1) ?? null;
  const index = childrenOf(form, parentId).findIndex((sibling) => sibling.id === id);
  const next = withChildren(form, parentId, (list) => list.filter((item) => item.id !== id));
  return { form: next, removed: found.component, parentId, index };
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.min(Math.max(Math.trunc(index), 0), length);
}

/** One layout axis moved into another parent, keeping the edges the layout has. */
function convertAxis(layout: LayoutDefinition, out: LayoutDefinition, axis: 'x' | 'y', rel: number, size: number, parentSize: number): void {
  const [start, end] = axis === 'x' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
  if (layout[start] !== undefined) out[start] = whole(rel);
  if (layout[end] !== undefined) out[end] = whole(parentSize - rel - size);
}

export const structureCommands = {
  /**
   * Adds a component at the end of a parent's children (or of the form), with its meta's default
   * size at `position`, relative to the parent. The parent must be a container. The command knows
   * the new id through `newId(form)`.
   */
  add(type: string, parentId: string | null, position: { x: number; y: number }, options: AddOptions): AddCommand {
    const newId = (form: FormDefinition): string => options.id ?? uniqueId(form, type);
    return {
      label: `Add ${options.metas[type]?.displayName ?? type}`,
      newId,
      run(form) {
        if (!options.metas[type]) throw new CommandError(`Unknown component type "${type}"`);
        requireContainer(form, parentId, options.metas);
        const id = newId(form);
        requireId('component', id);
        if (componentIds(form).includes(id)) throw new CommandError(`The id "${id}" is already used by another component`);
        const component = build(form, type, id, position.x, position.y, options);
        return withChildren(form, parentId, (list) => [...list, component]);
      },
    };
  },

  /**
   * Moves a component into another parent (null is the form) at `index` (default: the end),
   * converting its layout to the new parent's coordinates so it stays where it is on screen, when the
   * boxes allow. It keeps the edges it has. Refuses to move a component into itself or inside itself.
   */
  reparent(id: string, newParentId: string | null, index?: number, options: ReparentOptions = {}): Command {
    return {
      label: `Move ${id} into ${newParentId ?? 'the form'}`,
      run(form) {
        const found = findComponent(form, id);
        if (!found) throw new CommandError(`There is no component "${id}"`);
        if (newParentId !== null && (newParentId === id || findComponent({ ...form, components: [found.component] }, newParentId))) {
          throw new CommandError(`"${id}" can't go inside itself`);
        }
        requireContainer(form, newParentId, options.metas);
        const oldParentId = found.ancestors.at(-1) ?? null;
        const removed = removeFrom(form, id);
        let component = removed.removed;
        if (oldParentId !== newParentId) {
          const boxes = new Map((options.boxes ?? []).map((box) => [box.id, box]));
          const own = boxes.get(id);
          const formSize = options.formSize ?? form.size;
          const parentBox = newParentId === null ? undefined : boxes.get(newParentId);
          // Children sit in a container's content area, which can be smaller than its outer box.
          const target =
            newParentId === null
              ? formSize
                ? { x: 0, y: 0, ...formSize, visible: true }
                : undefined
              : parentBox && { ...(parentBox.content ?? parentBox), visible: parentBox.visible };
          // A box that is hidden (an unselected page, a closed dialog) has no real position, so keep the layout.
          if (own && own.visible !== false && target && target.visible !== false) {
            const layout: LayoutDefinition = { ...component.layout };
            convertAxis(component.layout, layout, 'x', own.x - target.x, own.width, target.width);
            convertAxis(component.layout, layout, 'y', own.y - target.y, own.height, target.height);
            component = { ...component, layout };
          }
        }
        const at = clampIndex(index, childrenOf(removed.form, newParentId).length);
        // Same parent and same place: nothing to write.
        if (oldParentId === newParentId && removed.index === at) return form;
        return withChildren(removed.form, newParentId, (list) => [...list.slice(0, at), component, ...list.slice(at)]);
      },
    };
  },

  /** Moves a component to `index` among its siblings. Changes focus and document order. */
  reorder(id: string, index: number): Command {
    return {
      label: `Reorder ${id}`,
      run(form) {
        const removed = removeFrom(form, id);
        const at = clampIndex(index, childrenOf(removed.form, removed.parentId).length);
        if (at === removed.index) return form;
        return withChildren(removed.form, removed.parentId, (list) => [...list.slice(0, at), removed.removed, ...list.slice(at)]);
      },
    };
  },
} as const;
