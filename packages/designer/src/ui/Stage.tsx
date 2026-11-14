import type { ComponentMeta, FormDefinition } from '@fw/core';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, type RefObject } from 'react';
import type { ComponentBox } from '../contract.ts';
import { findComponent, MIN_SIZE, snapMove, snapResize, type Guide, type ResizeHandle as Handle, type Rect } from '../model/index.ts';

const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The rectangle after dragging a handle, for drawing the live outline. */
function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x, y, width, height } = rect;
  if (handle.includes('e')) width = Math.max(MIN_SIZE, width + dx);
  if (handle.includes('w')) {
    const next = Math.min(width - MIN_SIZE, dx);
    x += next;
    width -= next;
  }
  if (handle.includes('s')) height = Math.max(MIN_SIZE, height + dy);
  if (handle.includes('n')) {
    const next = Math.min(height - MIN_SIZE, dy);
    y += next;
    height -= next;
  }
  return { x, y, width, height };
}

export interface DropSpec {
  type: string;
  parentId: string | null;
  left: number;
  top: number;
}

export interface StageActions {
  add(spec: DropSpec): void;
  move(id: string, dx: number, dy: number): void;
  resize(id: string, handle: Handle, dx: number, dy: number, box: ComponentBox): void;
  /** Moves the selection. Nudges in a burst merge into one undo step. */
  nudge(dx: number, dy: number): void;
  nudgeResize(id: string, dx: number, dy: number, box: ComponentBox): void;
  remove(id: string): void;
}

export interface StageProps {
  definition: FormDefinition | null;
  boxes: readonly ComponentBox[];
  width: number;
  height: number;
  selectedId: string | null;
  onSelect(id: string | null): void;
  editable: boolean;
  actions: StageActions;
  canvasUrl: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  metas: Readonly<Record<string, ComponentMeta>>;
  /** A component type being dragged in from the palette, or null. */
  drag: { type: string } | null;
  onDragEnd(): void;
}

/** Pixels the pointer must travel before a press on a component becomes a move. */
const DRAG_THRESHOLD = 3;

interface Gesture {
  kind: 'move' | 'resize';
  id: string;
  handle: Handle | null;
  startX: number;
  startY: number;
  box: ComponentBox;
  started: boolean;
  dx: number;
  dy: number;
}

interface Live {
  rect: Rect;
  guides: Guide[];
}

/** The deepest visible box under a point. Among boxes of the same depth, the later one is on top. */
export function hitTest(boxes: readonly ComponentBox[], x: number, y: number): ComponentBox | null {
  let best: ComponentBox | null = null;
  for (const box of boxes) {
    if (!box.visible || x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height) continue;
    if (!best || box.depth >= best.depth) best = box;
  }
  return best;
}

const CURSORS: Record<Handle, string> = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' };

function handleStyle(handle: Handle, box: Rect): { left: number; top: number } {
  const left = handle.includes('w') ? 0 : handle.includes('e') ? box.width : box.width / 2;
  const top = handle.includes('n') ? 0 : handle.includes('s') ? box.height : box.height / 2;
  return { left, top };
}

export function Stage({ definition, boxes, width, height, selectedId, onSelect, editable, actions, canvasUrl, iframeRef, metas, drag, onDragEnd }: StageProps): ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const visible = useMemo(() => boxes.filter((b) => b.visible), [boxes]);
  const byId = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const selectedBox = selected?.visible ? selected : undefined;

  // The order Tab walks: document order, for the components that are visible on the canvas.
  const order = useMemo(() => {
    if (!definition) return [] as string[];
    const ids: string[] = [];
    const walk = (list: FormDefinition['components']): void => {
      for (const c of list) {
        if (typeof c !== 'object' || c === null) continue;
        if (byId.get(c.id)?.visible) ids.push(c.id);
        walk(Array.isArray(c.children) ? c.children : []);
      }
    };
    if (Array.isArray(definition.components)) walk(definition.components);
    return ids;
  }, [definition, byId]);

  const [drop, setDrop] = useState<{ spec: DropSpec; rect: Rect; parent: Rect | null } | null>(null);

  // A gesture that was running when the form changed under it is over.
  useEffect(() => {
    gesture.current = null;
    setLive(null);
  }, [definition, editable]);

  // A component dragged in from the palette: its parent is the deepest container under the pointer (decision 4).
  const latest = useRef({ boxes, definition, metas, actions, onDragEnd });
  latest.current = { boxes, definition, metas, actions, onDragEnd };
  const dragType = drag?.type ?? null;
  useEffect(() => {
    if (dragType === null) {
      setDrop(null);
      return;
    }
    const target = (clientX: number, clientY: number): { spec: DropSpec; rect: Rect; parent: Rect | null } | null => {
      const overlay = overlayRef.current;
      if (!overlay) return null;
      const area = overlay.getBoundingClientRect();
      const x = clientX - area.left;
      const y = clientY - area.top;
      if (x < 0 || y < 0 || (area.width > 0 && x > area.width) || (area.height > 0 && y > area.height)) return null;
      const { boxes: all, definition: def, metas: kinds } = latest.current;
      let parent: ComponentBox | null = null;
      for (const b of all) {
        if (!b.visible || x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) continue;
        const type = def ? findComponent(def, b.id)?.component.type : undefined;
        if (type && kinds[type]?.container && (!parent || b.depth >= parent.depth)) parent = b;
      }
      // Positions inside a container count from its content box (inside its border and title), not its outer box.
      const frame = parent ? (parent.content ?? parent) : null;
      const origin = frame ?? { x: 0, y: 0 };
      const size = kinds[dragType]?.defaultSize ?? { width: 100, height: 24 };
      const left = Math.max(0, Math.round((x - origin.x) / 8) * 8);
      const top = Math.max(0, Math.round((y - origin.y) / 8) * 8);
      return {
        spec: { type: dragType, parentId: parent?.id ?? null, left, top },
        rect: { x: origin.x + left, y: origin.y + top, width: size.width, height: size.height },
        parent: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null,
      };
    };
    const move = (event: globalThis.PointerEvent): void => setDrop(target(event.clientX, event.clientY));
    const up = (event: globalThis.PointerEvent): void => {
      const hit = target(event.clientX, event.clientY);
      if (hit) latest.current.actions.add(hit.spec);
      latest.current.onDragEnd();
    };
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current.onDragEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      setDrop(null);
    };
  }, [dragType]);

  const point = (event: PointerEvent): { x: number; y: number } => {
    const rect = (overlayRef.current as HTMLDivElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** The box and its siblings in the parent's own coordinates, which is where the grid is. */
  const framed = (box: ComponentBox): { rect: Rect; siblings: Rect[]; origin: { x: number; y: number } } => {
    const parent = box.parentId ? byId.get(box.parentId) : undefined;
    const frame = parent ? (parent.content ?? parent) : undefined;
    const origin = frame ? { x: frame.x, y: frame.y } : { x: 0, y: 0 };
    const shift = (b: Rect): Rect => ({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height });
    return { rect: shift(box), siblings: visible.filter((b) => b.parentId === box.parentId && b.id !== box.id).map(shift), origin };
  };

  const updateLive = (g: Gesture, altKey: boolean): void => {
    const { rect, siblings, origin } = framed(g.box);
    const options = { siblings, disabled: altKey };
    const toForm = (guide: Guide): Guide => (guide.axis === 'x' ? { ...guide, position: guide.position + origin.x, from: guide.from + origin.y, to: guide.to + origin.y } : { ...guide, position: guide.position + origin.y, from: guide.from + origin.x, to: guide.to + origin.x });
    if (g.kind === 'move') {
      const snapped = snapMove(rect, g.dx, g.dy, options);
      g.dx = snapped.dx;
      g.dy = snapped.dy;
      setLive({ rect: { x: g.box.x + snapped.dx, y: g.box.y + snapped.dy, width: g.box.width, height: g.box.height }, guides: snapped.guides.map(toForm) });
    } else {
      const handle = g.handle as Handle;
      const snapped = snapResize(rect, handle, g.dx, g.dy, options);
      g.dx = snapped.dx;
      g.dy = snapped.dy;
      setLive({ rect: resizeRect(g.box, handle, snapped.dx, snapped.dy), guides: snapped.guides.map(toForm) });
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    overlayRef.current?.focus({ preventScroll: true });
    const { x, y } = point(event);
    const handleEl = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    let hit: ComponentBox | null = null;
    let handle: Handle | null = null;
    if (handleEl && selectedBox && editable) {
      hit = selectedBox;
      handle = handleEl.dataset.handle as Handle;
    } else {
      hit = hitTest(boxes, x, y);
      onSelect(hit?.id ?? null);
    }
    if (!hit || !editable) return;
    gesture.current = { kind: handle ? 'resize' : 'move', id: hit.id, handle, startX: event.clientX, startY: event.clientY, box: hit, started: false, dx: 0, dy: 0 };
    overlayRef.current?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g) {
      const { x, y } = point(event);
      setHoverId(hitTest(boxes, x, y)?.id ?? null);
      return;
    }
    const dx = Math.round(event.clientX - g.startX);
    const dy = Math.round(event.clientY - g.startY);
    if (!g.started && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    g.started = true;
    g.dx = dx;
    g.dy = dy;
    updateLive(g, event.altKey);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancel: boolean): void => {
    const g = gesture.current;
    gesture.current = null;
    setLive(null);
    overlayRef.current?.releasePointerCapture?.(event.pointerId);
    if (!g || !g.started || cancel) return;
    if (g.dx === 0 && g.dy === 0) return;
    if (g.kind === 'move') actions.move(g.id, g.dx, g.dy);
    else actions.resize(g.id, g.handle as Handle, g.dx, g.dy, g.box);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    const key = event.key;
    if (key === 'Escape') {
      if (gesture.current) {
        gesture.current = null;
        setLive(null);
      } else onSelect(null);
      event.preventDefault();
      return;
    }
    if (key === 'Tab') {
      const index = selectedId ? order.indexOf(selectedId) : -1;
      const next = event.shiftKey ? (index < 0 ? -1 : index - 1) : index + 1;
      const id = order[next];
      // At either end, Tab leaves the canvas, so it never traps the keyboard.
      if (id !== undefined) {
        onSelect(id);
        event.preventDefault();
      }
      return;
    }
    if (!selectedId) return;
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      if (editable) actions.remove(selectedId);
      return;
    }
    const step = event.shiftKey ? 8 : 1;
    const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
    if (!arrow) return;
    event.preventDefault();
    if (!editable) return;
    const [dx, dy] = arrow as [number, number];
    if (event.ctrlKey || event.metaKey) {
      if (selectedBox) actions.nudgeResize(selectedId, dx, dy, selectedBox);
    } else actions.nudge(dx, dy);
  };

  const selectedInfo = selectedId && definition ? findComponent(definition, selectedId)?.component : undefined;
  const announcement = selectedInfo
    ? `${selectedInfo.id}, ${selectedInfo.type}${selectedBox ? `, at ${selectedBox.x}, ${selectedBox.y}, size ${selectedBox.width} by ${selectedBox.height}` : ', not shown on the canvas'}`
    : 'Nothing selected';

  const hover = hoverId && hoverId !== selectedId ? byId.get(hoverId) : undefined;

  return (
    <div className="dz-stage" style={{ width, height }}>
      <iframe ref={iframeRef} className="dz-frame" title="Form canvas" src={canvasUrl} tabIndex={-1} sandbox="allow-scripts allow-same-origin" style={{ width, height }} />
      <div
        ref={overlayRef}
        className="dz-overlay"
        data-testid="overlay"
        data-editable={editable || undefined}
        tabIndex={0}
        role="group"
        aria-label="Form canvas. Tab moves between components. Arrow keys move the selected one, Shift for 8 pixels, Control to resize. Delete removes it. Escape clears the selection."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => setHoverId(null)}
        onKeyDown={onKeyDown}
      >
        {hover ? <div className="dz-hover" style={boxStyle(hover)} /> : null}
        {selectedBox ? (
          <div className="dz-selection" data-testid="selection" data-id={selectedBox.id} style={boxStyle(selectedBox)} data-dragging={live ? true : undefined}>
            {editable && !live
              ? HANDLES.map((handle) => (
                  <span key={handle} className="dz-handle" data-handle={handle} data-testid={`handle-${handle}`} style={{ ...handleStyle(handle, selectedBox), cursor: `${CURSORS[handle]}-resize` }} />
                ))
              : null}
          </div>
        ) : null}
        {drop ? (
          <>
            {drop.parent ? <div className="dz-droptarget" data-testid="drop-parent" style={boxStyle(drop.parent)} /> : null}
            <div className="dz-drop" data-testid="drop-indicator" style={boxStyle(drop.rect)}>
              <span className="dz-live__size">
                {drag?.type} in {drop.spec.parentId ?? 'the form'}
              </span>
            </div>
          </>
        ) : null}
        {live ? (
          <>
            <div className="dz-live" data-testid="live" style={boxStyle(live.rect)}>
              <span className="dz-live__size">
                {live.rect.width} × {live.rect.height}
              </span>
            </div>
            {live.guides.map((guide, index) => (
              <div
                key={index}
                className="dz-guide"
                data-axis={guide.axis}
                style={guide.axis === 'x' ? { left: guide.position, top: guide.from, height: guide.to - guide.from } : { top: guide.position, left: guide.from, width: guide.to - guide.from }}
              />
            ))}
          </>
        ) : null}
      </div>
      <div className="dz-sr" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function boxStyle(box: Rect): CSSProperties {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}
