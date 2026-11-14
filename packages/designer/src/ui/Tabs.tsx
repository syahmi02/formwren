import { useId, useRef, type KeyboardEvent, type ReactElement } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

/** A row of tabs, as WAI-ARIA describes them: arrow keys move between them and show the panel. */
export function Tabs<T extends string>({ items, value, onChange, label, className }: { items: readonly TabItem<T>[]; value: T; onChange(id: T): void; label: string; className?: string }): ReactElement {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const keys: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const to = (((keys[event.key] as number) % items.length) + items.length) % items.length;
    const item = items[to] as TabItem<T>;
    onChange(item.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${item.id}"]`)?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className={`dz-tabs ${className ?? ''}`}>
      {items.map((item, at) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`${base}-${item.id}`}
          data-tab={item.id}
          aria-selected={item.id === value}
          aria-controls={`${base}-panel`}
          tabIndex={item.id === value ? 0 : -1}
          className="dz-tab"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => move(event, at)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
