/** Snapping maths for dragging and resizing (step 6, decision 5). Pure: no DOM, no model. */
import { MIN_SIZE, type ResizeHandle } from './layout.ts';

/** A box in the parent's coordinates, the same space as its siblings. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapOptions {
  /** The boxes to line up with: the moving component's siblings. */
  siblings: readonly Rect[];
  /** The grid size in pixels. Defaults to 8. 0 turns grid snapping off. */
  grid?: number;
  /** How close, in pixels, an edge must come to a target to snap. Defaults to 5. */
  threshold?: number;
  /** True while Alt is held: nothing snaps and there are no guides. */
  disabled?: boolean;
  /** Resizing never snaps a size below this. Defaults to `MIN_SIZE`. */
  min?: number;
}

/**
 * A guide line to draw. `axis: 'x'` is a vertical line at x = `position`, running from y = `from`
 * to y = `to`. `axis: 'y'` is a horizontal line at y = `position`, from x = `from` to x = `to`.
 */
export interface Guide {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
  /** What it lines up with. Grid snaps draw no guide, so this is always a sibling feature. */
  kind: 'edge' | 'centre';
}

export interface SnapResult {
  /** The deltas to use instead of the raw ones. Whole numbers. */
  dx: number;
  dy: number;
  guides: Guide[];
}

export const DEFAULT_GRID = 8;
export const DEFAULT_THRESHOLD = 5;

interface Target {
  position: number;
  /** The sibling it comes from, or null for a grid line. */
  from: Rect | null;
  kind: 'edge' | 'centre';
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** The sibling targets on one axis: each box's start edge, centre and end edge. */
function siblingTargets(siblings: readonly Rect[], axis: 'x' | 'y'): Target[] {
  const out: Target[] = [];
  for (const box of siblings) {
    const start = axis === 'x' ? box.x : box.y;
    const size = axis === 'x' ? box.width : box.height;
    out.push({ position: start, from: box, kind: 'edge' }, { position: start + size / 2, from: box, kind: 'centre' }, { position: start + size, from: box, kind: 'edge' });
  }
  return out;
}

interface Best {
  /** The change to add to the delta. */
  offset: number;
  targets: Target[];
}

/**
 * The smallest change that puts one of `features` on a sibling target, within the threshold. Every
 * target the winning change lands on is kept, for the guides.
 */
function bestSnap(features: readonly number[], siblings: readonly Target[], threshold: number): Best | null {
  let offset: number | null = null;
  for (const feature of features) {
    for (const target of siblings) {
      const candidate = target.position - feature;
      if (Math.abs(candidate) <= threshold && (offset === null || Math.abs(candidate) < Math.abs(offset))) offset = candidate;
    }
  }
  if (offset === null) return null;
  const chosen = offset;
  const targets = siblings.filter((target) => features.some((feature) => Math.abs(target.position - feature - chosen) < 1e-9));
  return { offset: chosen, targets };
}

/** The grid snap for one feature: the change that puts it on the nearest grid line. */
function gridOffset(feature: number, grid: number): number {
  return Math.round(feature / grid) * grid - feature;
}

/**
 * Chooses the change on one axis. `features` are the moving positions (after the raw delta), and
 * `gridFeature` is the one that also snaps to the grid. Returns the offset to add, with the sibling targets it landed on.
 */
function snapAxis(features: readonly number[], gridFeature: number | undefined, siblings: readonly Target[], grid: number, threshold: number): Best | null {
  const bySibling = bestSnap(features, siblings, threshold);
  if (bySibling) return bySibling;
  if (gridFeature !== undefined && grid > 0) {
    const offset = gridOffset(gridFeature, grid);
    if (Math.abs(offset) <= threshold) return { offset, targets: [] };
  }
  return null;
}

function guidesFor(axis: 'x' | 'y', best: Best | null, box: Rect): Guide[] {
  if (!best) return [];
  // One line for each position and kind, long enough to reach the box and every sibling it lines up with.
  const lines = new Map<string, Guide>();
  const span = (rect: Rect): [number, number] => (axis === 'x' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width]);
  for (const target of best.targets) {
    if (!target.from) continue;
    const key = `${target.position}|${target.kind}`;
    const [from, to] = span(target.from);
    const line = lines.get(key);
    if (line) {
      line.from = Math.min(line.from, from);
      line.to = Math.max(line.to, to);
    } else {
      const [boxFrom, boxTo] = span(box);
      lines.set(key, { axis, position: target.position, from: Math.min(from, boxFrom), to: Math.max(to, boxTo), kind: target.kind });
    }
  }
  return [...lines.values()];
}

function offsetRect(box: Rect, dx: number, dy: number): Rect {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}

/**
 * Snaps a move. The box's left, centre and right line up with sibling edges and centres, and the
 * top, centre and bottom likewise. If nothing is close, its left and top go to the grid. Each axis
 * is decided on its own. With `disabled`, the deltas are only rounded.
 */
export function snapMove(box: Rect, dx: number, dy: number, options: SnapOptions): SnapResult {
  const rawX = whole(dx);
  const rawY = whole(dy);
  if (options.disabled) return { dx: rawX, dy: rawY, guides: [] };
  const grid = options.grid ?? DEFAULT_GRID;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const moved = offsetRect(box, rawX, rawY);
  const bx = snapAxis([moved.x, moved.x + moved.width / 2, moved.x + moved.width], moved.x, siblingTargets(options.siblings, 'x'), grid, threshold);
  const by = snapAxis([moved.y, moved.y + moved.height / 2, moved.y + moved.height], moved.y, siblingTargets(options.siblings, 'y'), grid, threshold);
  const outX = whole(rawX + (bx?.offset ?? 0));
  const outY = whole(rawY + (by?.offset ?? 0));
  const final = offsetRect(box, outX, outY);
  return { dx: outX, dy: outY, guides: [...guidesFor('x', bx, final), ...guidesFor('y', by, final)] };
}

/**
 * Snaps a resize. Only the edges the handle drags can snap: to sibling edges and centres, or else
 * to the grid. The result never leaves the box smaller than the minimum.
 */
export function snapResize(box: Rect, handle: ResizeHandle, dx: number, dy: number, options: SnapOptions): SnapResult {
  const rawX = whole(dx);
  const rawY = whole(dy);
  if (options.disabled) return { dx: rawX, dy: rawY, guides: [] };
  const grid = options.grid ?? DEFAULT_GRID;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const min = options.min ?? MIN_SIZE;

  const axis = (kind: 'x' | 'y', raw: number): { delta: number; best: Best | null } => {
    const dragsEnd = kind === 'x' ? handle.includes('e') : handle.includes('s');
    const dragsStart = kind === 'x' ? handle.includes('w') : handle.includes('n');
    if (!dragsEnd && !dragsStart) return { delta: 0, best: null };
    const start = kind === 'x' ? box.x : box.y;
    const size = kind === 'x' ? box.width : box.height;
    const edge = dragsEnd ? start + size + raw : start + raw;
    const best = snapAxis([edge], edge, siblingTargets(options.siblings, kind), grid, threshold);
    let delta = raw + (best?.offset ?? 0);
    // Keep the minimum size, and drop the snap (and its guide) if it was in the way.
    const grown = dragsEnd ? size + delta : size - delta;
    if (grown < min && size >= min) {
      delta = dragsEnd ? min - size : size - min;
      return { delta: whole(delta), best: null };
    }
    return { delta: whole(delta), best };
  };

  const x = axis('x', rawX);
  const y = axis('y', rawY);
  // The box after the resize, for the span of the guide lines.
  let final = { ...box };
  if (handle.includes('e')) final = { ...final, width: box.width + x.delta };
  if (handle.includes('w')) final = { ...final, x: box.x + x.delta, width: box.width - x.delta };
  if (handle.includes('s')) final = { ...final, height: box.height + y.delta };
  if (handle.includes('n')) final = { ...final, y: box.y + y.delta, height: box.height - y.delta };
  return { dx: x.delta, dy: y.delta, guides: [...guidesFor('x', x.best, final), ...guidesFor('y', y.best, final)] };
}
