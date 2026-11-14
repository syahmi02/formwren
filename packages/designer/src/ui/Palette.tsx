import type { ComponentMeta } from '@fw/core';
import { useMemo, type ReactElement } from 'react';

export interface PaletteProps {
  metas: Readonly<Record<string, ComponentMeta>>;
  editable: boolean;
  /** Where a pick will go, for the hint under the list. */
  target: string;
  /** Adds one (a click, or Enter on a focused item). */
  onAdd(type: string): void;
  /** A press on an item, which may turn into a drag onto the canvas. */
  onDragStart(type: string): void;
}

const CATEGORIES: readonly { id: ComponentMeta['category']; title: string }[] = [
  { id: 'input', title: 'Inputs' },
  { id: 'action', title: 'Actions' },
  { id: 'display', title: 'Display' },
  { id: 'container', title: 'Containers' },
];

/** The component types, grouped by category. Press an item and drag it onto the canvas, or focus it and press Enter. */
export function Palette({ metas, editable, target, onAdd, onDragStart }: PaletteProps): ReactElement {
  const groups = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        ...category,
        items: Object.values(metas)
          .filter((meta) => meta.category === category.id)
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      })).filter((group) => group.items.length > 0),
    [metas],
  );
  return (
    <div className="dz-palette" role="region" aria-label="Component palette">
      <p className="dz-note">{editable ? `Drag onto the canvas, or press Enter to add into ${target}.` : 'The form is read-only.'}</p>
      {groups.map((group) => (
        <section key={group.id} className="dz-palette__group" aria-label={group.title}>
          <h3>{group.title}</h3>
          <ul className="dz-palette__list">
            {group.items.map((meta) => (
              <li key={meta.type}>
                <button
                  type="button"
                  className="dz-palette__item"
                  data-type={meta.type}
                  disabled={!editable}
                  title={`${meta.displayName}, ${meta.defaultSize.width} by ${meta.defaultSize.height}`}
                  onPointerDown={(event) => {
                    if (event.button === 0) onDragStart(meta.type);
                  }}
                  onClick={() => onAdd(meta.type)}
                >
                  {meta.displayName}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
