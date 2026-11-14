import type { ComponentMeta, FormDefinition } from '@fw/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

export interface OutlineActions {
  select(id: string): void;
  reparent(id: string, parentId: string | null, index?: number): void;
  reorder(id: string, delta: -1 | 1): void;
  moveInto(id: string): void;
  moveOut(id: string): void;
  remove(id: string): void;
  /** Renames. Returns a message if the new id isn't allowed, or null if it was taken. */
  rename(id: string, newId: string): string | null;
}

export interface OutlineProps {
  definition: FormDefinition | null;
  metas: Readonly<Record<string, ComponentMeta>>;
  selectedId: string | null;
  /** Ids that aren't visible on the canvas now (a Tabs page that isn't shown, a closed Dialog). */
  hidden: ReadonlySet<string>;
  editable: boolean;
  actions: OutlineActions;
}

interface Row {
  id: string;
  type: string;
  depth: number;
  parentId: string | null;
  index: number;
  siblings: number;
  container: boolean;
}

type Zone = 'before' | 'into' | 'after';

const DRAG_THRESHOLD = 4;

/** The components as a tree, in order. Select, rename, reorder and move between containers, by pointer or keyboard. */
export function Outline({ definition, metas, selectedId, hidden, editable, actions }: OutlineProps): ReactElement {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (list: FormDefinition['components'], depth: number, parentId: string | null): void => {
      list.forEach((c, index) => {
        if (typeof c !== 'object' || c === null) return;
        out.push({ id: c.id, type: c.type, depth, parentId, index, siblings: list.length, container: metas[c.type]?.container === true });
        walk(Array.isArray(c.children) ? c.children : [], depth + 1, c.id);
      });
    };
    if (definition && Array.isArray(definition.components)) walk(definition.components, 0, null);
    return out;
  }, [definition, metas]);

  const treeRef = useRef<HTMLUListElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; started: boolean; target: { id: string; zone: Zone } | null } | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);
  const dropRef = useRef<{ id: string; zone: Zone } | null>(null);
  const latest = useRef({ rows, actions });
  latest.current = { rows, actions };
  /**
   * After a keyboard command, focus belongs on a row again once the form has changed. It is only given
   * if focus is still in the tree or nowhere, so it never takes focus from a field somewhere else, and
   * a command that changed nothing leaves nothing behind.
   */
  const pending = useRef<{ id: string; until: number } | null>(null);
  const want = (id: string): void => {
    pending.current = { id, until: Date.now() + 1500 };
  };
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    const active = document.activeElement;
    const free = !active || active === document.body || treeRef.current?.contains(active);
    if (!free || Date.now() > p.until) {
      pending.current = null;
      return;
    }
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(p.id)}"]`);
    if (row) {
      pending.current = null;
      row.focus();
    }
  });

  // Dragging a row onto another: into a container, or before or after it.
  useEffect(() => {
    if (!drag) return;
    const move = (event: globalThis.PointerEvent): void => {
      const g = dragRef.current;
      if (!g) return;
      if (!g.started && Math.hypot(event.clientX - g.x, event.clientY - g.y) >= DRAG_THRESHOLD) {
        g.started = true;
        setDrag((d) => (d ? { ...d, started: true } : d));
      }
    };
    const up = (): void => {
      const g = dragRef.current;
      const target = dropRef.current;
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      if (!g?.started || !target || target.id === g.id) return;
      const { rows: all, actions: act } = latest.current;
      const to = all.find((r) => r.id === target.id);
      if (!to) return;
      if (target.zone === 'into') act.reparent(g.id, to.id);
      else {
        // The index counts the rows as they are now. The component comes out first, so a move down inside the same parent lands one place earlier.
        const from = all.find((r) => r.id === g.id);
        const wanted = to.index + (target.zone === 'after' ? 1 : 0);
        act.reparent(g.id, to.parentId, from && from.parentId === to.parentId && from.index < wanted ? wanted - 1 : wanted);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag !== null]);

  const renameDone = useRef(true);
  const startRename = (id: string): void => {
    if (!editable) return;
    renameDone.current = false;
    setRenaming(id);
    setDraft(id);
    setProblem(null);
  };
  const finishRename = (commit: boolean): void => {
    const id = renaming;
    if (!id || renameDone.current) return;
    renameDone.current = true;
    if (!commit || draft === id) {
      setRenaming(null);
      setProblem(null);
      return;
    }
    const message = actions.rename(id, draft.trim());
    if (message) {
      setProblem(message);
      renameDone.current = false;
    } else {
      setRenaming(null);
      setProblem(null);
      want(draft.trim());
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: Row, at: number): void => {
    if (event.target !== event.currentTarget) return;
    const go = (to: Row | undefined): void => {
      if (!to) return;
      event.preventDefault();
      want(to.id);
      actions.select(to.id);
    };
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (event.altKey) {
          event.preventDefault();
          if (editable) {
            want(row.id);
            actions.reorder(row.id, event.key === 'ArrowUp' ? -1 : 1);
          }
        } else go(rows[at + (event.key === 'ArrowUp' ? -1 : 1)]);
        break;
      case 'ArrowRight':
        if (event.altKey) {
          event.preventDefault();
          if (editable) {
            want(row.id);
            actions.moveInto(row.id);
          }
        } else if (row.container) go(rows[at + 1]?.parentId === row.id ? rows[at + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (event.altKey) {
          event.preventDefault();
          if (editable) {
            want(row.id);
            actions.moveOut(row.id);
          }
        } else go(rows.find((r) => r.id === row.parentId));
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows.at(-1));
        break;
      case 'F2':
      case 'Enter':
        event.preventDefault();
        startRename(row.id);
        break;
      case 'Delete':
        event.preventDefault();
        if (editable) {
          const next = rows[at + 1] ?? rows[at - 1];
          if (next) {
            actions.select(next.id);
            want(next.id);
          }
          actions.remove(row.id);
        }
        break;
    }
  };

  const zoneOf = (event: { clientY: number; currentTarget: Element }, row: Row): Zone => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height > 0) {
      const f = (event.clientY - rect.top) / rect.height;
      if (f < 0.25) return 'before';
      if (f > 0.75) return 'after';
    }
    return row.container ? 'into' : 'after';
  };

  const selectedRow = rows.find((r) => r.id === selectedId);
  const tabStop = selectedRow?.id ?? rows[0]?.id;

  return (
    <div className="dz-outline" role="region" aria-label="Outline">
      <div className="dz-outline__tools" role="toolbar" aria-label="Arrange the selected component">
        {[
          { label: 'Up', title: 'Move up (Alt+Up)', run: () => selectedId && actions.reorder(selectedId, -1), off: !selectedRow || selectedRow.index === 0 },
          { label: 'Down', title: 'Move down (Alt+Down)', run: () => selectedId && actions.reorder(selectedId, 1), off: !selectedRow || selectedRow.index === selectedRow.siblings - 1 },
          { label: 'Move into', title: 'Move into the container above (Alt+Right)', run: () => selectedId && actions.moveInto(selectedId), off: !selectedRow },
          { label: 'Move out', title: 'Move out of its container (Alt+Left)', run: () => selectedId && actions.moveOut(selectedId), off: !selectedRow || selectedRow.parentId === null },
        ].map((tool) => (
          <button key={tool.label} type="button" className="dz-btn" title={tool.title} disabled={!editable || tool.off} onClick={() => void tool.run()}>
            {tool.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <p className="dz-empty">The form has no components.</p> : null}
      <ul ref={treeRef} className="dz-tree" role="tree" aria-label="Components">
        {rows.map((row, at) => {
          const target = drag?.started && drag.target?.id === row.id ? drag.target.zone : undefined;
          return (
            <li
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={row.id === selectedId}
              aria-expanded={row.container ? true : undefined}
              aria-label={`${row.id}, ${metas[row.type]?.displayName ?? row.type}${hidden.has(row.id) ? ', not shown on the canvas' : ''}`}
              tabIndex={row.id === tabStop ? 0 : -1}
              className="dz-tree__row"
              data-id={row.id}
              data-hidden={hidden.has(row.id) || undefined}
              data-drop={target}
              data-dragging={drag?.started && drag.id === row.id ? true : undefined}
              style={{ paddingLeft: 8 + row.depth * 16 }}
              onKeyDown={(event) => onKeyDown(event, row, at)}
              onClick={() => {
                if (!dragRef.current?.started) actions.select(row.id);
              }}
              onDoubleClick={() => startRename(row.id)}
              onPointerDown={(event) => {
                if (event.button !== 0 || !editable || renaming === row.id || (event.target as HTMLElement).tagName === 'INPUT') return;
                dragRef.current = { id: row.id, x: event.clientX, y: event.clientY, started: false };
                setDrag({ id: row.id, started: false, target: null });
              }}
              onPointerMove={(event) => {
                if (!dragRef.current?.started) return;
                const zone = zoneOf(event, row);
                dropRef.current = { id: row.id, zone };
                setDrag((d) => (d && (d.target?.id !== row.id || d.target.zone !== zone) ? { ...d, target: { id: row.id, zone } } : d));
              }}
            >
              {renaming === row.id ? (
                <span className="dz-tree__rename">
                  <input
                    className="dz-input"
                    aria-label={`New id for ${row.id}`}
                    autoFocus
                    value={draft}
                    aria-invalid={problem !== null || undefined}
                    onChange={(event) => setDraft(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => finishRename(true)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        finishRename(true);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        finishRename(false);
                        want(row.id);
                        treeRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(row.id)}"]`)?.focus();
                      }
                    }}
                  />
                  {problem ? (
                    <small className="dz-field__error" role="alert">
                      {problem}
                    </small>
                  ) : null}
                </span>
              ) : (
                <>
                  <span className="dz-tree__id">{row.id}</span>
                  <span className="dz-tree__type">{metas[row.type]?.displayName ?? row.type}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
